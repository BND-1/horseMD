import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'node:crypto'
import { RequestPacer, throttleHint } from './request-pacer.js'

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false })
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value]
const clean = (value) => String(value || '').replace(/^\/+|\/+$/g, '')
// encodeURIComponent deliberately leaves !'()* unescaped, while SigV4's
// canonical URI permits only RFC 3986 unreserved characters unescaped.
// Keep this encoding identical for the request URL and signing input.
const encodePathSegment = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

function parseList(xml) {
  const root = parser.parse(xml)?.ListBucketResult || {}
  const entries = [
    ...asArray(root.Contents).map((entry) => ({ href: entry.Key, isDirectory: false, etag: String(entry.ETag || '').replace(/^"|"$/g, ''), size: Number(entry.Size || 0) })),
    ...asArray(root.CommonPrefixes).map((entry) => ({ href: entry.Prefix, isDirectory: true, etag: null, size: 0 }))
  ]
  const truncated = String(root.IsTruncated ?? '').toLowerCase() === 'true'
  return { entries, truncated, nextToken: root.NextContinuationToken ? String(root.NextContinuationToken) : null }
}

// 数据胶囊 (s3.cstcloud.cn) binds an access key to the client chosen when it
// was created and answers 401 with an empty body for any other User-Agent.
const authHint = (status) => (status === 401 || status === 403
  ? '；部分服务（如数据胶囊）只接受创建密钥时选择的客户端，请在连接设置的「User-Agent」里填写对应的客户端标识（例如 rclone）'
  : '')

async function failureCode(response) {
  const hint = throttleHint(response.status) + authHint(response.status)
  try {
    const body = await response.text()
    const code = parser.parse(body)?.Error?.Code
    return (code ? ` ${code}` : '') + hint
  } catch {
    return hint
  }
}

export class S3Provider {
  constructor({ endpoint, bucket, region, accessKeyId, secretAccessKey, request, prefix = '', allowInsecure = false, userAgent = '', pacer = new RequestPacer() }) {
    const url = new URL(endpoint)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('S3 Endpoint 无效。')
    if (url.protocol !== 'https:' && !allowInsecure) throw new Error('S3 连接必须使用 HTTPS。')
    if (!bucket || !region || !accessKeyId || !secretAccessKey) throw new Error('请填写完整的 S3 连接信息。')
    this.endpoint = url
    this.bucket = bucket
    this.prefix = clean(prefix)
    this.request = request
    this.userAgent = String(userAgent || '').trim()
    this.pacer = pacer
    // object keys are encoded segment-by-segment before both signing and
    // net.fetch. Escaping again here turns a Chinese filename's `%E4...` into
    // `%25E4...` in the canonical request and MinIO rejects the signature.
    this.signer = new SignatureV4({ credentials: { accessKeyId, secretAccessKey }, region, service: 's3', sha256: Sha256, uriEscapePath: false })
  }

  objectKey(path = '') { return [this.prefix, clean(path)].filter(Boolean).join('/') }

  // Every attempt is signed anew (fresh x-amz-date) by the pacer's retry.
  async signedRequest(method, path = '', options = {}) {
    return this.pacer.run(() => this.signedRequestOnce(method, path, options), { write: method === 'PUT', quick: options.quick === true })
  }

  async signedRequestOnce(method, path = '', { headers = {}, body = null, query = {}, bucketLevel = false, directory = false } = {}) {
    const key = bucketLevel ? '' : this.objectKey(path)
    const base = new URL(this.endpoint)
    // `directory`: the "path/" folder marker (S3 has no directories).
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodePathSegment(this.bucket)}${key ? `/${key.split('/').map(encodePathSegment).join('/')}${directory ? '/' : ''}` : ''}`
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
    // A bucket-level request: with a prefix configured, `GET /bucket/prefix`
    // would read an object of that name (404 NoSuchKey) instead of listing.
    const response = await this.signedRequest('GET', '', { quick: true, bucketLevel: true, query: { 'list-type': '2', 'max-keys': '1', ...(this.prefix ? { prefix: `${this.prefix}/` } : {}) } })
    if (!response.ok) throw new Error(`S3 连接失败（HTTP ${response.status}${await failureCode(response)}）。请检查 Endpoint、Bucket、Region 和权限。`)
    const probePath = `HorseMD/.connection-check/${randomUUID()}`
    let revision = null
    try {
      const uploaded = await this.put(probePath, Buffer.alloc(0), { createOnly: true, quick: true })
      // Listing worked (the key is valid) but the service throttles uploads
      // right now (数据胶囊 locks uploads for ~20 min after ~200). Waiting
      // here would freeze「测试并保存」; the sync itself waits it out.
      if (uploaded.throttled) return { ok: true, uploadThrottled: true }
      revision = uploaded.revision
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

  async put(path, bytes, { revision = null, createOnly = false, contentType = 'application/octet-stream', quick = false } = {}) {
    const headers = { 'content-type': contentType }
    if (revision) headers['if-match'] = `"${revision}"`
    if (createOnly) headers['if-none-match'] = '*'
    const response = await this.signedRequest('PUT', path, { headers, body: bytes, quick })
    if (quick && (response.status === 429 || response.status === 503)) return { revision: null, throttled: true }
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

  // Empty folder: a zero-byte object whose key ends in "/" — what the AWS
  // console, rclone and S3 browsers create and show as a folder. Removing it
  // never touches objects inside the folder.
  async createDirectory(path) {
    const response = await this.signedRequest('PUT', path, { directory: true, headers: { 'content-type': 'application/x-directory' }, body: Buffer.alloc(0) })
    if (!response.ok) throw new Error(`S3 无法创建空文件夹“${path}”（HTTP ${response.status}${await failureCode(response)}）。`)
    return true
  }

  // Only while the folder is really empty. Some S3 services treat DELETE of
  // "folder/" as a recursive delete: 数据胶囊 (s3.cstcloud.cn, measured
  // 2026-10-24) removed every object under the folder, even when no marker
  // existed. So list first, and delete only when nothing but the marker is
  // left; otherwise leave the cloud as it is (returns false).
  async removeDirectory(path) {
    const marker = `${this.objectKey(path)}/`
    const listed = await this.signedRequest('GET', '', { bucketLevel: true, query: { 'list-type': '2', prefix: marker, 'max-keys': '2' } })
    if (!listed.ok) throw new Error(`S3 无法检查空文件夹“${path}”（HTTP ${listed.status}${await failureCode(listed)}）。`)
    const { entries } = parseList(await listed.text())
    if (entries.some((entry) => entry.href !== marker)) return false
    if (entries.length === 0) return true
    const response = await this.signedRequest('DELETE', path, { directory: true })
    if ([200, 204, 404].includes(response.status)) return true
    throw new Error(`S3 无法删除空文件夹“${path}”（HTTP ${response.status}${await failureCode(response)}）。`)
  }

  async delete(path, { revision = null } = {}) {
    const response = await this.signedRequest('DELETE', path, { headers: revision ? { 'if-match': `"${revision}"` } : {} })
    if ([200, 204, 404].includes(response.status)) return true
    if (response.status === 412) throw new Error('远端文件已被其他设备修改，请重新同步。')
    throw new Error(`S3 删除失败（HTTP ${response.status}${await failureCode(response)}）。`)
  }

  async list(path = '') {
    const prefix = this.objectKey(path)
    const entries = []
    let token = null
    // One page is at most 1000 keys: follow IsTruncated, or a folder with
    // more files would silently lose the rest.
    for (let page = 0; page < 10000; page += 1) {
      const query = { 'list-type': '2', prefix: prefix ? `${prefix}/` : '', delimiter: '/', ...(token ? { 'continuation-token': token } : {}) }
      const response = await this.signedRequest('GET', '', { bucketLevel: true, query })
      if (!response.ok) throw new Error(`S3 无法列出同步目录（HTTP ${response.status}${await failureCode(response)}）。`)
      const result = parseList(await response.text())
      entries.push(...result.entries)
      if (!result.truncated || !result.nextToken || result.nextToken === token) break
      token = result.nextToken
    }
    return entries.map((entry) => ({ ...entry, href: entry.href.replace(new RegExp(`^${this.prefix ? `${this.prefix}/` : ''}`), '') }))
  }
}
