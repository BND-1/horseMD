// A real HorseMD 同步 account service (server/, its own process) on a real
// MinIO, for tests. Codes go to the dev mailer's log (HM_MAIL=log); the
// admin CLI grants / revokes plans. Returns null when MinIO is not installed.
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startMinio } from './minio-server.mjs'

const run = promisify(execFile)
const repo = new URL('../..', import.meta.url).pathname
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

export async function startAccountServer(root, { paddle = {} } = {}) {
  const minio = await startMinio(join(root, 'minio'))
  if (!minio) return null
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const mailLog = join(root, 'mail.jsonl')
  const webhookSecret = 'pdl_ntfset_test_' + crypto.randomBytes(8).toString('hex')
  const env = {
    ...process.env,
    HM_ACCOUNT_PORT: String(port),
    HM_ACCOUNT_HOST: '127.0.0.1',
    HM_ACCOUNT_DB: join(root, 'account.db'),
    HM_ACCOUNT_SECRET: crypto.randomBytes(32).toString('hex'),
    HM_STORAGE_ENDPOINT: minio.connection.endpoint,
    HM_STORAGE_REGION: 'us-east-1',
    HM_STORAGE_BUCKET: minio.connection.bucket,
    HM_STORAGE_ACCESS_KEY: minio.connection.accessKeyId,
    HM_STORAGE_SECRET_KEY: minio.connection.secretAccessKey,
    HM_STORAGE_STS_ENDPOINT: minio.connection.endpoint,
    HM_MAIL: 'log',
    HM_MAIL_LOG: mailLog,
    HM_PADDLE_ENV: 'sandbox',
    HM_PADDLE_WEBHOOK_SECRET: webhookSecret,
    HM_PADDLE_PRICES: 'standard:month:pri_test_standard_m,plus:year:pri_test_plus_y',
    ...paddle
  }
  const child = spawn(process.execPath, [join(repo, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const stop = async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)])
    }
    await minio.stop()
  }
  try {
    let up = false
    for (let i = 0; i < 100 && !up; i++) {
      if (child.exitCode != null) throw new Error(`account service exited:\n${log}`)
      try { up = (await fetch(`${url}/v1/health`)).ok } catch { /* not yet */ }
      if (!up) await sleep(100)
    }
    if (!up) throw new Error(`account service did not start:\n${log}`)
  } catch (error) {
    await stop()
    throw error
  }
  const codes = async (email) => {
    const text = await fs.readFile(mailLog, 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.email === email).map((item) => String(item.code))
  }
  return {
    url,
    minio,
    webhookSecret,
    env,
    log: () => log,
    codes,
    lastCode: async (email) => (await codes(email)).at(-1),
    // Wait for the (count + 1)-th code to this address.
    nextCode: async (email, count) => {
      for (let i = 0; i < 100; i++) {
        const list = await codes(email)
        if (list.length > count) return list.at(-1)
        await sleep(50)
      }
      throw new Error(`no code mailed to ${email}`)
    },
    admin: (...args) => run(process.execPath, [join(repo, 'server/admin.mjs'), ...args], { env }),
    stop
  }
}
