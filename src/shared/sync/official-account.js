// HorseMD 同步: the client of our own account service
// (docs/official-sync-api.md), shared by desktop and phones. The account
// service holds the account, subscription and usage, and hands out storage
// credentials that expire within an hour and reach only users/<uid>/. Files
// still go straight to object storage through S3Provider, sealed on the
// device (EncryptedProvider) when the folder is encrypted.

export const OFFICIAL_SERVER = 'https://api.horsemd.yangsir.net'
export const OFFICIAL_PROVIDER_ID = 'horsemd'

// Storage credentials are renewed this long before they expire: a throttled
// sync can sit between requests for many minutes.
const RENEW_BEFORE_MS = 5 * 60 * 1000
// Access tokens are renewed a minute early (clock skew, slow requests).
const ACCESS_RENEW_BEFORE_MS = 60 * 1000

export class OfficialAccountError extends Error {
  constructor(code, message, { status = 0, retryAfter = null } = {}) {
    super(message || '账号服务出错，请稍后再试。')
    this.code = code || 'server'
    this.status = status
    this.retryAfter = retryAfter
  }
}

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '')

export function normalizeServer(value) {
  const server = trimSlash(value) || OFFICIAL_SERVER
  let url
  try { url = new URL(server) } catch { throw new OfficialAccountError('bad-request', '账号服务地址无效。') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OfficialAccountError('bad-request', '账号服务必须使用 HTTPS。')
  }
  return server
}

// Plain-HTTP storage is accepted only on this machine (development MinIO).
export function isLoopbackUrl(value) {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname) } catch { return false }
}

export function createAccountClient({ request, server = OFFICIAL_SERVER }) {
  const base = normalizeServer(server)
  const call = async (method, path, { body, accessToken } = {}) => {
    let response
    try {
      response = await request(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (error) {
      throw new OfficialAccountError('network', `连不上 HorseMD 账号服务：${error?.message || error}`)
    }
    let json = null
    try { json = JSON.parse(await response.text()) } catch { /* not JSON: a proxy page */ }
    if (response.ok && json?.ok) return json
    // Over IPC only the message survives: the wait goes into it.
    if (json?.error === 'rate-limited' && Number(json.retryAfter) > 0 && !/\d+\s*秒/.test(json.message || '')) {
      json.message = `${json.message || '请求太频繁。'}请 ${Math.ceil(Number(json.retryAfter))} 秒后再试。`
    }
    throw new OfficialAccountError(
      json?.error || (response.status === 401 ? 'unauthorized' : 'server'),
      json?.message || `账号服务出错（HTTP ${response.status}）。`,
      { status: response.status, retryAfter: json?.retryAfter ?? null }
    )
  }
  return {
    server: base,
    startLogin: (email) => call('POST', '/v1/auth/email/start', { body: { email } }),
    verify: (email, code, device) => call('POST', '/v1/auth/email/verify', { body: { email, code, device } }),
    refresh: (refreshToken) => call('POST', '/v1/auth/refresh', { body: { refreshToken } }),
    logout: (refreshToken) => call('POST', '/v1/auth/logout', { body: { refreshToken } }),
    me: (accessToken) => call('GET', '/v1/me', { accessToken }),
    storageCredentials: (accessToken) => call('POST', '/v1/storage/credentials', { body: {}, accessToken })
  }
}

// One logged-in connection. The refresh token rotates on every use, so
// renewals are serialized (two at once would present a rotated token, which
// the service treats as theft and ends the session) and every new one is
// written back to the credential store before it is used.
export class OfficialSession {
  constructor({ client, loadRefreshToken, saveRefreshToken, now = () => Date.now() }) {
    this.client = client
    this.loadRefreshToken = loadRefreshToken
    this.saveRefreshToken = saveRefreshToken
    this.now = now
    this.access = null
    this.renewing = null
    this.storage = null
    this.storageRenewing = null
  }

  async renew() {
    if (!this.renewing) {
      this.renewing = (async () => {
        const refreshToken = await this.loadRefreshToken()
        if (!refreshToken) throw new OfficialAccountError('refresh-invalid', '请重新登录 HorseMD 同步。')
        const result = await this.client.refresh(refreshToken)
        await this.saveRefreshToken(result.refreshToken)
        this.access = { token: result.accessToken, expiresAt: Date.parse(result.accessExpiresAt) || this.now() + 50 * 60 * 1000 }
        return this.access.token
      })().finally(() => { this.renewing = null })
    }
    return this.renewing
  }

  async accessToken() {
    if (this.access && this.access.expiresAt - ACCESS_RENEW_BEFORE_MS > this.now()) return this.access.token
    return this.renew()
  }

  // Calls `fn(accessToken)`; an access token the service refuses is renewed
  // once (revoked elsewhere, clock skew).
  async authed(fn) {
    try {
      return await fn(await this.accessToken())
    } catch (error) {
      if (error?.code !== 'unauthorized') throw error
      this.access = null
      return fn(await this.renew())
    }
  }

  me() {
    return this.authed((token) => this.client.me(token))
  }

  // The current storage grant, renewed 5 minutes before it expires.
  // `maxAgeMs`: also renew one older than that — a sync run asks at its
  // start, so a plan that ended or filled up turns read-only on the next
  // run instead of when the hour-long credentials expire.
  async storageGrant({ force = false, maxAgeMs = Infinity } = {}) {
    const fresh = this.storage && this.storage.expiresAtMs - RENEW_BEFORE_MS > this.now() && this.now() - this.storage.fetchedAt <= maxAgeMs
    if (!force && fresh) return this.storage
    if (!this.storageRenewing) {
      this.storageRenewing = this.authed((token) => this.client.storageCredentials(token))
        .then((grant) => {
          this.storage = { ...grant, fetchedAt: this.now(), expiresAtMs: Date.parse(grant.expiresAt) || this.now() + 50 * 60 * 1000 }
          return this.storage
        })
        .finally(() => { this.storageRenewing = null })
    }
    return this.storageRenewing
  }

  // For SignatureV4: an async credential provider, asked before each
  // signature, so a long sync keeps working across renewals.
  credentialProvider() {
    return async () => {
      const grant = await this.storageGrant()
      return { accessKeyId: grant.accessKeyId, secretAccessKey: grant.secretAccessKey, sessionToken: grant.sessionToken }
    }
  }

  async logout() {
    const refreshToken = await this.loadRefreshToken()
    this.access = null
    this.storage = null
    if (refreshToken) await this.client.logout(refreshToken)
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}
