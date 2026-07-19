import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'node:crypto'

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text'
})

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])
const text = (value) => (typeof value === 'object' ? value?.['#text'] || '' : value || '')

function collectResponses(value, output = []) {
  if (!value || typeof value !== 'object') return output
  for (const [key, child] of Object.entries(value)) {
    if (key === 'response') output.push(...asArray(child))
    else collectResponses(child, output)
  }
  return output
}

export function parsePropfind(xml) {
  const responses = collectResponses(parser.parse(xml))
  return responses.map((response) => {
    const propstats = asArray(response.propstat)
    const prop = propstats.find((item) => / 2\d\d /.test(text(item.status)))?.prop || {}
    const type = prop.resourcetype || {}
    return {
      href: decodeURIComponent(text(response.href)),
      etag: String(text(prop.getetag) || '').replace(/^"|"$/g, '') || null,
      isDirectory: Object.prototype.hasOwnProperty.call(type, 'collection'),
      size: Number(text(prop.getcontentlength) || 0)
    }
  })
}

function normalizeEndpoint(endpoint, { allowInsecure = false } = {}) {
  const url = new URL(endpoint)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头。')
  if (url.protocol !== 'https:' && !allowInsecure) throw new Error('WebDAV 连接必须使用 HTTPS。')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

function encodePath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

export class WebDavProvider {
  constructor({ endpoint, username, password, request, allowInsecure = false, prefix = '' }) {
    if (typeof request !== 'function') throw new Error('WebDAV requires a network request function.')
    this.baseUrl = normalizeEndpoint(endpoint, { allowInsecure })
    this.request = request
    this.prefix = String(prefix || '').replace(/^\/+|\/+$/g, '')
    this.authorization = username || password
      ? `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`
      : null
  }

  urlFor(path = '') {
    return new URL(encodePath([this.prefix, path].filter(Boolean).join('/')), this.baseUrl).toString()
  }

  headers(extra = {}) {
    return {
      ...(this.authorization ? { authorization: this.authorization } : {}),
      ...extra
    }
  }

  async requestPath(path, init = {}) {
    return this.request(this.urlFor(path), {
      ...init,
      headers: this.headers(init.headers)
    })
  }

  async testConnection() {
    const response = await this.requestPath('', {
      method: 'PROPFIND',
      headers: { Depth: '0' }
    })
    if (![200, 207].includes(response.status)) {
      throw new Error(`WebDAV 连接失败（HTTP ${response.status}）。请检查地址、账号和权限。`)
    }
    const probePath = `HorseMD/.connection-check/${randomUUID()}`
    let revision = null
    try {
      revision = (await this.put(probePath, Buffer.alloc(0), { createOnly: true })).revision
      await this.delete(probePath, { revision })
    } catch (error) {
      if (revision) {
        try { await this.delete(probePath, { revision }) } catch { /* preserve the useful original error */ }
      }
      throw new Error(`WebDAV 上传权限验证失败：${error?.message || error}`)
    }
    return { ok: true }
  }

  async stat(path) {
    const response = await this.requestPath(path, { method: 'PROPFIND', headers: { Depth: '0' } })
    if (response.status === 404) return null
    if (![200, 207].includes(response.status)) throw new Error(`WebDAV 无法读取文件信息（HTTP ${response.status}）。`)
    return parsePropfind(await response.text())[0] || null
  }

  async list(path = '') {
    const response = await this.requestPath(path, { method: 'PROPFIND', headers: { Depth: '1' } })
    if (response.status === 404) return []
    if (![200, 207].includes(response.status)) throw new Error(`WebDAV 无法列出同步目录（HTTP ${response.status}）。`)
    return parsePropfind(await response.text())
  }

  async get(path) {
    const response = await this.requestPath(path, { method: 'GET' })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`WebDAV 下载失败（HTTP ${response.status}）。`)
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      revision: response.headers.get('etag')?.replace(/^"|"$/g, '') || null
    }
  }

  async ensureDirectory(path) {
    const segments = String(path || '').split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      const response = await this.requestPath(current, { method: 'MKCOL' })
      if (![200, 201, 204, 405].includes(response.status)) {
        throw new Error(`WebDAV 无法创建同步目录（HTTP ${response.status}）。`)
      }
    }
  }

  async put(path, bytes, { revision = null, createOnly = false, contentType = 'application/octet-stream' } = {}) {
    const slash = String(path).lastIndexOf('/')
    if (slash > 0) await this.ensureDirectory(String(path).slice(0, slash))
    const headers = { 'content-type': contentType }
    if (revision) headers['if-match'] = `"${revision}"`
    if (createOnly) headers['if-none-match'] = '*'
    const response = await this.requestPath(path, { method: 'PUT', headers, body: bytes })
    if (response.status === 412) throw new Error('远端文件已被其他设备修改，请重新同步。')
    if (!response.ok) throw new Error(`WebDAV 上传失败（HTTP ${response.status}）。`)
    const writtenRevision = response.headers.get('etag')?.replace(/^"|"$/g, '') || null
    // Apache DAV and several self-hosted servers omit ETag on PUT. Fetch the
    // metadata immediately so the next sync still has a conditional revision.
    if (writtenRevision) return { revision: writtenRevision }
    return { revision: (await this.stat(path))?.etag || null }
  }

  async delete(path, { revision = null } = {}) {
    const headers = revision ? { 'if-match': `"${revision}"` } : {}
    const response = await this.requestPath(path, { method: 'DELETE', headers })
    if ([200, 204, 404].includes(response.status)) return true
    if (response.status === 412) throw new Error('远端文件已被其他设备修改，请重新同步。')
    throw new Error(`WebDAV 删除失败（HTTP ${response.status}）。`)
  }
}
