import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

// Constant-time string comparison. Unequal lengths still run one compare so
// the time does not depend on where the strings differ.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length !== y.length) {
    timingSafeEqual(x, x)
    return false
  }
  return timingSafeEqual(x, y)
}

export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')
export const hmacHex = (key, value) => createHmac('sha256', key).update(value).digest('hex')

// Login codes are 6 digits: a plain SHA-256 of one would be reversed by
// trying all million values, so the hash is keyed by the server secret.
export const codeHash = (secret, email, code) => hmacHex(secret, `code:${email}:${code}`)
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

export const newRefreshToken = () => randomBytes(32).toString('base64url')
export const newId = (prefix, bytes = 12) => `${prefix}${randomBytes(bytes).toString('hex')}`

const sign = (secret, body) => createHmac('sha256', secret).update(`v1.${body}`).digest('base64url')

// v1.<base64url JSON { sub, sid, exp }>.<base64url HMAC-SHA256>; exp in
// unix seconds.
export function signAccessToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `v1.${body}.${sign(secret, body)}`
}

export function verifyAccessToken(token, secret, nowSeconds) {
  if (typeof token !== 'string' || token.length > 2048) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  if (!safeEqual(parts[2], sign(secret, parts[1]))) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || !Number.isFinite(payload.exp)) return null
  if (payload.exp <= nowSeconds) return null
  return payload
}
