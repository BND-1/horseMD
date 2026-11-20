import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'

// SigV4 canonical form encodes everything but RFC 3986 unreserved
// characters; encodeURIComponent leaves !'()* alone. The URL we send must
// use the same spelling as the string we sign.
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
const queryString = (query) => Object.keys(query).sort().map((key) => `${encode(key)}=${encode(query[key])}`).join('&')

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  return ENTITIES[entity.toLowerCase()] ?? match
})
// The responses we read are flat and well known (STS AssumeRoleResponse,
// ListBucketResult), so a tag regex is enough.
const tag = (xml, name) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? decodeXml(match[1].trim()) : null
}

const userPrefix = (userId) => `users/${userId}`

// Session policy for one user's credentials (docs/official-sync-api.md):
// list only under the user's prefix, read / delete always, write only
// while the plan allows it.
export function sessionPolicy(bucket, userId, writable) {
  const prefix = userPrefix(userId)
  const objectActions = ['s3:GetObject', 's3:DeleteObject', ...(writable ? ['s3:PutObject'] : [])]
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { 's3:prefix': [`${prefix}/*`, prefix] } }
      },
      {
        Effect: 'Allow',
        Action: objectActions,
        Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`]
      }
    ]
  }
}

// null when the storage is not configured (the service still runs: login,
// /v1/me and billing work; credentials answer `server`).
export function createStorage({ endpoint, publicEndpoint, region = 'us-east-1', bucket, accessKey, secretKey, stsEndpoint, roleArn, fetch = globalThis.fetch } = {}) {
  if (!endpoint || !bucket || !accessKey || !secretKey) return null
  const storageUrl = new URL(endpoint)
  const stsUrl = new URL(stsEndpoint || endpoint)
  const credentials = { accessKeyId: accessKey, secretAccessKey: secretKey }
  // Paths are built already encoded (see `encode`), so the S3 signer must
  // not encode them again.
  const s3Signer = new SignatureV4({ credentials, region, service: 's3', sha256: Sha256, uriEscapePath: false })
  const stsSigner = new SignatureV4({ credentials, region, service: 'sts', sha256: Sha256 })

  async function signedFetch(signer, baseUrl, { method, path, query = {}, headers = {}, body, timeout = 30000 }) {
    const target = new URL(baseUrl)
    const pathname = path ?? (target.pathname || '/')
    const signed = await signer.sign(new HttpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      method,
      path: pathname,
      query,
      headers: { host: target.host, ...headers },
      body
    }))
    // fetch sets Host from the URL (and refuses a caller-set one); it is the
    // same value that was signed.
    const { host, ...requestHeaders } = signed.headers
    const search = queryString(query)
    return fetch(`${target.origin}${pathname}${search ? `?${search}` : ''}`, {
      method,
      headers: requestHeaders,
      body,
      signal: AbortSignal.timeout(timeout)
    })
  }

  const bucketPath = `${storageUrl.pathname.replace(/\/$/, '')}/${encode(bucket)}`

  return {
    endpoint: publicEndpoint || endpoint,
    region,
    bucket,
    prefixFor: userPrefix,

    // STS AssumeRole (2011-06-15). MinIO accepts it signed with the admin
    // keys at the storage endpoint and ignores RoleArn.
    async assumeRole({ userId, writable, durationSeconds = 3600 }) {
      const params = {
        Action: 'AssumeRole',
        Version: '2011-06-15',
        DurationSeconds: String(durationSeconds),
        Policy: JSON.stringify(sessionPolicy(bucket, userId, writable)),
        RoleSessionName: `hm-${userId}`.slice(0, 64)
      }
      if (roleArn) params.RoleArn = roleArn
      const body = Object.entries(params).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&')
      const response = await signedFetch(stsSigner, stsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
        timeout: 15000
      })
      const xml = await response.text()
      if (!response.ok) throw new Error(`STS AssumeRole 失败（HTTP ${response.status}${tag(xml, 'Code') ? ` ${tag(xml, 'Code')}` : ''}）`)
      const block = new RegExp('<Credentials>([\\s\\S]*?)</Credentials>').exec(xml)?.[1] || ''
      const accessKeyId = tag(block, 'AccessKeyId')
      const secretAccessKey = tag(block, 'SecretAccessKey')
      const sessionToken = tag(block, 'SessionToken')
      const expiration = tag(block, 'Expiration')
      if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new Error('STS AssumeRole 的回应里没有完整的凭证。')
      const expiresMs = Date.parse(expiration)
      return {
        accessKeyId,
        secretAccessKey,
        sessionToken,
        expiresAt: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : expiration
      }
    },

    // ListObjectsV2 with the admin keys, every page; sums the object sizes.
    async measurePrefix(prefix) {
      let bytes = 0
      let objects = 0
      let token = null
      do {
        const query = { 'list-type': '2', prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) }
        const response = await signedFetch(s3Signer, storageUrl, { method: 'GET', path: bucketPath, query })
        const xml = await response.text()
        if (!response.ok) throw new Error(`统计用量失败（HTTP ${response.status}${tag(xml, 'Code') ? ` ${tag(xml, 'Code')}` : ''}）`)
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          objects++
          bytes += Number(tag(match[1], 'Size')) || 0
        }
        const truncated = String(tag(xml, 'IsTruncated') || '').toLowerCase() === 'true'
        const next = truncated ? tag(xml, 'NextContinuationToken') : null
        if (truncated && (!next || next === token)) throw new Error('统计用量失败：列表没有下一页的标记。')
        token = next
      } while (token)
      return { bytes, objects }
    }
  }
}
