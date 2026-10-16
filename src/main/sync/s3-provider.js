import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'node:crypto'

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false })
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value]
const clean = (value) => String(value || '').replace(/^\/+|\/+$/g, '')
// encodeURIComponent deliberately leaves !'()* unescaped, while SigV4's
// canonical URI permits only RFC 3986 unreserved characters unescaped.
// Keep this encoding identical for the request URL and signing input.
const encodePathSegment = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

function parseList(xml) {
  const root = parser.parse(xml)?.ListBucketResult || {}
  return [
    ...asArray(root.Contents).map((entry) => ({ href: entry.Key, isDirectory: false, etag: String(entry.ETag || '').replace(/^"|"$/g, ''), size: Number(entry.Size || 0) })),
    ...asArray(root.CommonPrefixes).map((entry) => ({ href: entry.Prefix, isDirectory: true, etag: null, size: 0 }))
  ]
}

async function failureCode(response) {
  try {
    const body = await response.text()
    const code = parser.parse(body)?.Error?.Code
    return code ? ` ${code}` : ''
  } catch {
    return ''
  }
}

export class S3Provider {
  constructor({ endpoint, bucket, region, accessKeyId, secretAccessKey, request, prefix = '', allowInsecure = false, userAgent = '' }) {
    const url = new URL(endpoint)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('S3 Endpoint 无效。')
    if (url.protocol !== 'https:' && !allowInsecure) throw new Error('S3 连接必须使用 HTTPS。')
    if (!bucket || !region || !accessKeyId || !secretAccessKey) throw new Error('请填写完整的 S3 连接信息。')
    this.endpoint = url
    this.bucket = bucket
    this.prefix = clean(prefix)
    this.request = request
    this.userAgent = String(userAgent || '').trim()
    // object keys are encoded segment-by-segment before both signing and
    // net.fetch. Escaping again here turns a Chinese filename's `%E4...` into
    // `%25E4...` in the canonical request and MinIO rejects the signature.
    this.signer = new SignatureV4({ credentials: { accessKeyId, secretAccessKey }, region, service: 's3', sha256: Sha256, uriEscapePath: false })
  }

  objectKey(path = '') { return [this.prefix, clean(path)].filter(Boolean).join('/') }

  async signedRequest(method, path = '', { headers = {}, body = null, query = {} } = {}) {
    const key = this.objectKey(path)
    const base = new URL(this.endpoint)
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodePathSegment(this.bucket)}${key ? `/${key.split('/').map(encodePathSegment).join('/')}` : ''}`
    for (const [name, value] of Object.entries(query)) if (value != null) base.searchParams.set(name, value)
    const signed = await this.signer.sign(new HttpRequest({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method,
      path: base.pathname,
      query: Object.fromEntries(base.searchParams),
      headers: { host: base.host, ...(this.userAgent ? { 'user-agent': this.userAgent } : {}), ...headers },
      body
    }))
    // SigV4 must include Host in the canonical request. Electron net.fetch,
    // however, rejects callers setting this controlled header. The URL yields
    // the identical Host header on the wire, so strip it only after signing.
    const { host, ...requestHeaders } = signed.headers
    return this.request(base.toString(), { method, headers: requestHeaders, body })
  }

  async testConnection() {
    const response = await this.signedRequest('GET', '', { query: { 'list-type': '2', 'max-keys': '1' } })
    if (!response.ok) throw new Error(`S3 连接失败（HTTP ${response.status}${await failureCode(response)}）。请检查 Endpoint、Bucket、Region 和权限。`)
    const probePath = `HorseMD/.connection-check/${randomUUID()}`
    let revision = null
    try {
      revision = (await this.put(probePath, Buffer.alloc(0), { createOnly: true })).revision
      await this.delete(probePath, { revision })
    } catch (error) {
      if (revision) {
        try { await this.delete(probePath, { revision }) } catch { /* preserve the useful original error */ }
      }
      throw new Error(`S3 上传权限验证失败：${error?.message || error}`)
    }
    return { ok: true }
  }

  async get(path) {
    const response = await this.signedRequest('GET', path)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`S3 下载失败（HTTP ${response.status}${await failureCode(response)}）。`)
    return { bytes: Buffer.from(await response.arrayBuffer()), revision: response.headers.get('etag')?.replace(/^"|"$/g, '') || null }
  }

  async put(path, bytes, { revision = null, createOnly = false, contentType = 'application/octet-stream' } = {}) {
    const headers = { 'content-type': contentType }
    if (revision) headers['if-match'] = `"${revision}"`
    if (createOnly) headers['if-none-match'] = '*'
    const response = await this.signedRequest('PUT', path, { headers, body: bytes })
    if (response.status === 412) throw new Error('远端文件已被其他设备修改，请重新同步。')
    // Some deployed MinIO releases return NoSuchKey for If-None-Match: *
    // against a missing object, although S3 permits that initial create. Do a
    // second read before the compatibility retry: never overwrite an object
    // that appeared while the first request was in flight.
    if (createOnly && response.status === 404 && await failureCode(response) === ' NoSuchKey') {
      if (await this.get(path)) throw new Error('远端文件已被其他设备创建，请重新同步。')
      return this.put(path, bytes, { contentType })
    }
    if (!response.ok) throw new Error(`S3 上传失败（HTTP ${response.status}${await failureCode(response)}）。`)
    return { revision: response.headers.get('etag')?.replace(/^"|"$/g, '') || null }
  }

  async delete(path, { revision = null } = {}) {
    const response = await this.signedRequest('DELETE', path, { headers: revision ? { 'if-match': `"${revision}"` } : {} })
    if ([200, 204, 404].includes(response.status)) return true
    if (response.status === 412) throw new Error('远端文件已被其他设备修改，请重新同步。')
    throw new Error(`S3 删除失败（HTTP ${response.status}${await failureCode(response)}）。`)
  }

  async list(path = '') {
    const prefix = this.objectKey(path)
    const response = await this.signedRequest('GET', '', { query: { 'list-type': '2', prefix: prefix ? `${prefix}/` : '', delimiter: '/' } })
    if (!response.ok) throw new Error(`S3 无法列出同步目录（HTTP ${response.status}${await failureCode(response)}）。`)
    return parseList(await response.text()).map((entry) => ({ ...entry, href: entry.href.replace(new RegExp(`^${this.prefix ? `${this.prefix}/` : ''}`), '') }))
  }
}
