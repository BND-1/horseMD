import { createStore } from './db.mjs'
import { normalizeEmail } from './email.mjs'
import { iso, planState, storageStatus } from './plans.mjs'
import { codeHash, newCode, newRefreshToken, safeEqual, sha256Hex, signAccessToken, verifyAccessToken } from './tokens.mjs'

// The HTTP API of docs/official-sync-api.md. Everything outside (database,
// clock, mail, storage, Paddle) is passed in so tests can use fakes.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const BODY_LIMIT = 64 * 1024
const CODE_TTL = 10 * MINUTE
const CODE_ATTEMPTS = 5
const SEND_GAP = MINUTE
const SENDS_PER_EMAIL_HOUR = 5
const SENDS_PER_IP_HOUR = 20
const ACCESS_TTL = HOUR
const REFRESH_TTL = 180 * DAY
const USAGE_MAX_AGE = 10 * MINUTE
const CREDENTIAL_SECONDS = 3600

const STATUS = {
  'bad-request': 400,
  'invalid-email': 400,
  'rate-limited': 429,
  'code-invalid': 400,
  'code-expired': 400,
  'code-attempts': 400,
  unauthorized: 401,
  'refresh-invalid': 401,
  'no-plan': 402,
  'over-quota': 402,
  'billing-unavailable': 503,
  'not-found': 404,
  server: 500
}

const MESSAGES = {
  'bad-request': '请求格式不对。',
  'invalid-email': '邮箱地址格式不对，请检查后再试。',
  'rate-limited': '操作太频繁，请稍后再试。',
  'code-invalid': '验证码不对，请检查后再试。',
  'code-expired': '验证码已过期，请重新获取。',
  'code-attempts': '验证码输错次数太多，请重新获取。',
  unauthorized: '登录状态已过期。',
  'refresh-invalid': '登录已失效，请重新登录。',
  'no-plan': '还没有开通 HorseMD 同步。',
  'over-quota': '同步空间已用完。',
  'billing-unavailable': '付款功能暂未开放。',
  'not-found': '找不到请求的内容。',
  server: '服务器出了点问题，请稍后再试。'
}

export class ApiError extends Error {
  constructor(code, message = MESSAGES[code], extra = {}, status = STATUS[code] || 500) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

const fail = (code, message, extra) => new ApiError(code, message || MESSAGES[code], extra)

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new ApiError('bad-request', '请求内容太大。', {}, 413))
      return
    }
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        reject(new ApiError('bad-request', '请求内容太大。', {}, 413))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolveBody(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

function parseJson(raw) {
  if (!raw.length) return {}
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw fail('bad-request')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('bad-request')
  return value
}

const cleanDevice = (value) => (typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null
  : null)

export function createApp({ db, config = {}, mailer, storage = null, billing = null, now = Date.now, log = console } = {}) {
  const secret = config.secret || ''
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('HM_ACCOUNT_SECRET 必须设置，且至少 32 个字符。')
  if (!mailer) throw new Error('createApp 需要 mailer。')
  const store = createStore(db)
  const origins = new Set(config.origins?.length ? config.origins : ['https://horsemd.yangsir.net'])
  const trustProxy = config.trustProxy === true

  function clientIp(req) {
    if (trustProxy) {
      const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      if (first) return first.slice(0, 64)
    }
    return req.socket?.remoteAddress || 'unknown'
  }

  function corsHeaders(origin) {
    if (!origin || !(origins.has(origin) || LOCAL_ORIGIN.test(origin))) return { vary: 'Origin' }
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      vary: 'Origin'
    }
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(text),
      ...headers
    })
    res.end(text)
  }

  // ---- auth helpers

  function issueTokens(user, sessionId, refreshToken, t) {
    const exp = Math.floor((t + ACCESS_TTL) / SECOND)
    return {
      accessToken: signAccessToken({ sub: user.id, sid: sessionId, exp }, secret),
      accessExpiresAt: iso(exp * SECOND),
      refreshToken,
      user: { id: user.id, email: user.email }
    }
  }

  function requireUser(req) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''))
    if (!match) throw fail('unauthorized')
    const payload = verifyAccessToken(match[1], secret, Math.floor(now() / SECOND))
    if (!payload) throw fail('unauthorized')
    // A logged-out session stops working at once, not after its access
    // token's hour.
    const session = store.sessionById(payload.sid)
    if (!session || session.revoked_at != null || session.user_id !== payload.sub) throw fail('unauthorized')
    const user = store.userById(payload.sub)
    if (!user) throw fail('unauthorized')
    return user
  }

  // Sliding windows over the send log; the answer is the longest wait.
  function rateLimitWait(email, ip, t) {
    let wait = 0
    const byEmail = store.sendTimes('email', email, t - HOUR)
    if (byEmail.length) wait = Math.max(wait, byEmail[byEmail.length - 1] + SEND_GAP - t)
    if (byEmail.length >= SENDS_PER_EMAIL_HOUR) wait = Math.max(wait, byEmail[byEmail.length - SENDS_PER_EMAIL_HOUR] + HOUR - t)
    const byIp = store.sendTimes('ip', ip, t - HOUR)
    if (byIp.length >= SENDS_PER_IP_HOUR) wait = Math.max(wait, byIp[byIp.length - SENDS_PER_IP_HOUR] + HOUR - t)
    return wait > 0 ? Math.ceil(wait / SECOND) : 0
  }

  // ---- usage

  const measuring = new Map()
  function measureUsage(userId) {
    if (!storage) return Promise.reject(new Error('storage not configured'))
    if (measuring.has(userId)) return measuring.get(userId)
    const run = (async () => {
      const { bytes, objects } = await storage.measurePrefix(`${storage.prefixFor(userId)}/`)
      store.setUsage(userId, bytes, objects, now())
      return store.getUsage(userId)
    })().finally(() => measuring.delete(userId))
    measuring.set(userId, run)
    return run
  }

  let sweeping = false
  async function sweepUsage() {
    if (sweeping) return
    sweeping = true
    try {
      try { store.prune(now()) } catch (error) { log.error(`[account] prune: ${error.message}`) }
      if (!storage) return
      for (const userId of store.usageUserIds()) {
        try {
          await measureUsage(userId)
        } catch (error) {
          log.error(`[account] usage ${userId}: ${error.message}`)
        }
      }
    } finally {
      sweeping = false
    }
  }

  function usageView(row) {
    return { bytes: row?.bytes ?? 0, objects: row?.objects ?? 0, measuredAt: iso(row?.measured_at ?? null) }
  }

  // ---- routes

  const routes = {
    'GET /v1/health': async () => ({}),

    'POST /v1/auth/email/start': async ({ json, ip }) => {
      const body = await json()
      const email = normalizeEmail(body.email)
      if (!email) throw fail('invalid-email')
      const t = now()
      const retryAfter = rateLimitWait(email, ip, t)
      if (retryAfter) throw fail('rate-limited', `发送太频繁，请 ${retryAfter} 秒后再试。`, { retryAfter })
      const code = newCode()
      store.transaction(() => {
        store.putCode(email, codeHash(secret, email, code), t + CODE_TTL, t)
        store.recordSend(email, ip, t)
      })
      try {
        await mailer.send({ email, code })
      } catch (error) {
        store.deleteCode(email)
        log.error(`[account] mail: ${error.message}`)
        throw fail('server', '验证码邮件发送失败，请稍后再试。')
      }
      return { expiresIn: CODE_TTL / SECOND }
    },

    'POST /v1/auth/email/verify': async ({ json }) => {
      const body = await json()
      const email = normalizeEmail(body.email)
      if (!email) throw fail('invalid-email')
      const code = typeof body.code === 'string' || typeof body.code === 'number' ? String(body.code).trim() : ''
      const t = now()
      const row = store.getCode(email)
      if (!row) throw fail('code-invalid', '验证码不对或已失效，请重新获取。')
      if (row.attempts >= CODE_ATTEMPTS) throw fail('code-attempts')
      if (row.expires_at <= t) {
        store.deleteCode(email)
        throw fail('code-expired')
      }
      if (!/^\d{6}$/.test(code) || !safeEqual(row.code_hash, codeHash(secret, email, code))) {
        const attempts = store.bumpCodeAttempts(email)
        if (attempts >= CODE_ATTEMPTS) throw fail('code-attempts')
        throw fail('code-invalid', undefined, { attemptsLeft: CODE_ATTEMPTS - attempts })
      }
      const refreshToken = newRefreshToken()
      const { user, sessionId } = store.transaction(() => {
        store.deleteCode(email)
        const user = store.userByEmail(email) || store.createUser(email, t)
        const sessionId = store.createSession({ userId: user.id, device: cleanDevice(body.device), refreshHash: sha256Hex(refreshToken), now: t, expiresAt: t + REFRESH_TTL })
        return { user, sessionId }
      })
      return issueTokens(user, sessionId, refreshToken, t)
    },

    'POST /v1/auth/refresh': async ({ json }) => {
      const body = await json()
      if (typeof body.refreshToken !== 'string' || !body.refreshToken) throw fail('bad-request')
      if (body.refreshToken.length > 256) throw fail('refresh-invalid')
      const t = now()
      const oldHash = sha256Hex(body.refreshToken)
      const row = store.refreshByHash(oldHash)
      if (!row) throw fail('refresh-invalid')
      if (row.rotated_at != null) {
        // A rotated token came back: someone else holds a copy. End the
        // whole session (OAuth 2.0 Security BCP, refresh token rotation).
        store.revokeSession(row.session_id, t)
        throw fail('refresh-invalid')
      }
      if (row.revoked_at != null || row.expires_at <= t) throw fail('refresh-invalid')
      const user = store.userById(row.user_id)
      if (!user) throw fail('refresh-invalid')
      const refreshToken = newRefreshToken()
      store.transaction(() => store.rotateRefresh({ oldHash, newHash: sha256Hex(refreshToken), sessionId: row.session_id, now: t, expiresAt: t + REFRESH_TTL }))
      return issueTokens(user, row.session_id, refreshToken, t)
    },

    'POST /v1/auth/logout': async ({ json }) => {
      const body = await json()
      if (typeof body.refreshToken !== 'string' || !body.refreshToken) throw fail('bad-request')
      if (body.refreshToken.length <= 256) {
        const row = store.refreshByHash(sha256Hex(body.refreshToken))
        if (row) store.revokeSession(row.session_id, now())
      }
      return {}
    },

    'GET /v1/me': async ({ req }) => {
      const user = requireUser(req)
      const state = planState(store.getPlan(user.id), now())
      const usage = store.getUsage(user.id)
      return {
        user: { id: user.id, email: user.email, createdAt: iso(user.created_at) },
        plan: state.plan,
        usage: usageView(usage),
        storage: storageStatus(state, usage?.bytes ?? 0)
      }
    },

    'POST /v1/storage/credentials': async ({ req }) => {
      const user = requireUser(req)
      if (!storage) throw fail('server', '同步存储还没有配置。')
      let usage = store.getUsage(user.id)
      const before = planState(store.getPlan(user.id), now())
      // Measure when the last count is old, and also whenever it would deny
      // something: "nothing stored" for a user without a plan (files uploaded
      // since must stay downloadable) or "full" (files deleted since free
      // the space at once).
      const denies = usage && (before.active ? usage.bytes >= before.plan.storageBytes : usage.bytes === 0 && usage.objects === 0)
      if (!usage || denies || now() - usage.measured_at >= USAGE_MAX_AGE) {
        try {
          usage = await measureUsage(user.id)
        } catch (error) {
          log.error(`[account] usage ${user.id}: ${error.message}`)
          // Without any measurement we cannot tell "no plan, nothing
          // stored" from "no plan, data to download".
          if (!usage) throw fail('server', '暂时无法读取同步空间，请稍后再试。')
        }
      }
      const state = planState(store.getPlan(user.id), now())
      const stored = (usage?.bytes ?? 0) > 0 || (usage?.objects ?? 0) > 0
      if (!state.active && !stored) throw fail('no-plan')
      const { writable } = storageStatus(state, usage?.bytes ?? 0)
      const credentials = await storage.assumeRole({ userId: user.id, writable, durationSeconds: CREDENTIAL_SECONDS })
      return {
        endpoint: storage.endpoint,
        region: storage.region,
        bucket: storage.bucket,
        prefix: storage.prefixFor(user.id),
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        expiresAt: credentials.expiresAt,
        writable,
        fileBytes: state.plan.fileBytes
      }
    },

    'GET /v1/billing/config': async () => (billing ? billing.config() : { enabled: false }),

    'POST /v1/billing/portal': async ({ req }) => {
      const user = requireUser(req)
      if (!billing?.enabled) throw fail('billing-unavailable')
      if (!user.paddle_customer_id) throw fail('not-found', '还没有付款记录。')
      const plan = store.getPlan(user.id)
      const subscriptionIds = plan?.source === 'paddle' && plan.subscription_id ? [plan.subscription_id] : []
      try {
        return { url: await billing.portalUrl(user.paddle_customer_id, subscriptionIds) }
      } catch (error) {
        log.error(`[account] paddle portal: ${error.message}`)
        throw fail('server', '暂时打不开账单页面，请稍后再试。')
      }
    },

    'POST /v1/webhooks/paddle': async ({ req, raw }) => {
      if (!billing?.hasWebhookSecret) throw fail('billing-unavailable')
      const body = await raw()
      if (!billing.verifySignature(req.headers['paddle-signature'], body, now())) throw fail('unauthorized', '签名不对。')
      const event = parseJson(body)
      const result = billing.handleEvent({ store, event, now: now() })
      if (result.error) throw fail(result.error)
      return result
    }
  }

  const knownPaths = new Set(Object.keys(routes).map((key) => key.slice(key.indexOf(' ') + 1)))

  async function handle(req, res) {
    const cors = corsHeaders(req.headers.origin)
    let path = '/'
    try {
      path = new URL(req.url || '/', 'http://localhost').pathname
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const route = routes[`${req.method} ${path}`]
      if (!route) {
        if (knownPaths.has(path)) throw new ApiError('bad-request', '不支持这个请求方法。', {}, 405)
        throw fail('not-found')
      }
      let rawPromise = null
      const raw = () => (rawPromise ||= readBody(req, BODY_LIMIT))
      const result = await route({ req, ip: clientIp(req), raw, json: async () => parseJson(await raw()) })
      send(res, 200, { ok: true, ...result }, cors)
    } catch (error) {
      if (error instanceof ApiError) {
        const headers = { ...cors }
        if (error.extra?.retryAfter) headers['retry-after'] = String(error.extra.retryAfter)
        // A body we stopped reading: close the connection instead of
        // draining it.
        if (error.status === 413) headers.connection = 'close'
        send(res, error.status, { ok: false, error: error.code, message: error.message, ...error.extra }, headers)
        return
      }
      // Messages here come from our own code / storage / Paddle responses
      // and never carry tokens or codes.
      log.error(`[account] ${req.method} ${path}: ${error?.stack || error}`)
      send(res, 500, { ok: false, error: 'server', message: MESSAGES.server }, cors)
    }
  }

  handle.store = store
  handle.sweepUsage = sweepUsage
  handle.measureUsage = measureUsage
  return handle
}
