import { createServer } from 'node:http'
import { createApp } from './app.mjs'
import { createBilling, parsePrices } from './billing.mjs'
import { openDb } from './db.mjs'
import { createMailer } from './mailer.mjs'
import { createStorage } from './storage.mjs'

// Entry point: configuration comes only from the environment
// (docs/official-sync-api.md › Server configuration).
// An empty variable counts as unset.
const env = (name, fallback = '') => String(process.env[name] ?? '').trim() || fallback

function fatal(message) {
  console.error(`[account] ${message}`)
  process.exit(1)
}

const secret = process.env.HM_ACCOUNT_SECRET || ''
if (secret.length < 32) fatal('HM_ACCOUNT_SECRET 必须设置，且至少 32 个字符（例如 `openssl rand -base64 48`）。')

const port = Number(env('HM_ACCOUNT_PORT', '8790'))
if (!Number.isInteger(port) || port < 0 || port > 65535) fatal('HM_ACCOUNT_PORT 不是有效的端口号。')
const host = env('HM_ACCOUNT_HOST', '127.0.0.1')
const dbPath = env('HM_ACCOUNT_DB', './data/account.db')
const origins = env('HM_ACCOUNT_ORIGINS', 'https://horsemd.yangsir.net').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)

let mailer
let billing
let storage
try {
  mailer = createMailer({
    driver: env('HM_MAIL', 'log'),
    logFile: env('HM_MAIL_LOG'),
    resendKey: env('HM_RESEND_KEY'),
    from: env('HM_MAIL_FROM')
  })
  billing = createBilling({
    env: env('HM_PADDLE_ENV', 'production'),
    apiKey: env('HM_PADDLE_API_KEY'),
    clientToken: env('HM_PADDLE_CLIENT_TOKEN'),
    webhookSecret: env('HM_PADDLE_WEBHOOK_SECRET'),
    prices: parsePrices(env('HM_PADDLE_PRICES'))
  })
  storage = createStorage({
    endpoint: env('HM_STORAGE_ENDPOINT'),
    publicEndpoint: env('HM_STORAGE_PUBLIC_ENDPOINT'),
    region: env('HM_STORAGE_REGION', 'us-east-1'),
    bucket: env('HM_STORAGE_BUCKET'),
    accessKey: env('HM_STORAGE_ACCESS_KEY'),
    secretKey: env('HM_STORAGE_SECRET_KEY'),
    stsEndpoint: env('HM_STORAGE_STS_ENDPOINT'),
    roleArn: env('HM_STORAGE_ROLE_ARN')
  })
} catch (error) {
  fatal(error.message)
}

const db = openDb(dbPath)
const app = createApp({
  db,
  config: { secret, origins, trustProxy: env('HM_TRUST_PROXY') === '1' },
  mailer,
  storage,
  billing
})

const server = createServer(app)
server.requestTimeout = 30_000
server.headersTimeout = 15_000

// Usage sweep: once shortly after start, then hourly.
const HOUR = 3600 * 1000
const firstSweep = setTimeout(() => app.sweepUsage(), 60_000)
firstSweep.unref()
const sweepTimer = setInterval(() => app.sweepUsage(), HOUR)
sweepTimer.unref()

server.listen(port, host, () => {
  const address = server.address()
  console.log(`[account] listening on http://${address.address}:${address.port}`)
  console.log(`[account] db ${dbPath} · mail ${mailer.driver} · storage ${storage ? `${storage.endpoint} / ${storage.bucket}` : '未配置'} · paddle ${billing.enabled ? billing.environment : '未配置'}`)
})

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`[account] ${signal}, shutting down`)
  clearTimeout(firstSweep)
  clearInterval(sweepTimer)
  let dbClosed = false
  const finish = (code) => {
    if (!dbClosed) {
      dbClosed = true
      try { db.close() } catch { /* already closed */ }
    }
    process.exit(code)
  }
  server.close(() => finish(0))
  server.closeIdleConnections?.()
  // Requests still running after 10 s are cut off.
  setTimeout(() => {
    server.closeAllConnections?.()
    finish(0)
  }, 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
