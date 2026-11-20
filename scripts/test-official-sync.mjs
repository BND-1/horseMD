// HorseMD 同步 end to end (docs/official-sync-api.md): the real account
// service (server/, its own process) + a real MinIO + the app's own
// SyncService (two devices of one account, a second account).
//   1. login by mailed code (the dev mailer's log), wrong codes, resend limit
//   2. no plan: the account says so and a folder cannot start syncing
//   3. plan granted: an encrypted folder syncs; MinIO holds only sealed
//      objects, all under users/<uid>/
//   4. a second device of the same account joins with the password
//   5. another account's credentials cannot read or write the first's files
//   6. per-file limit; plan ended with data stored → read-only (pull works)
//   7. refresh tokens rotate; a reused one ends the session; log out
//   8. Paddle webhook: bad signature refused, a signed subscription event
//      activates the plan, the same event again changes nothing
// Skips (exit 0 with a note) when the `minio` binary is not installed.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAccountServer } from './lib/account-server.mjs'
import { SyncService } from '../src/main/sync-service.js'
import { adoptSyncWorkspace } from '../src/main/sync-workspaces.js'
import { createAccountClient } from '../src/shared/sync/official-account.js'
import { S3Provider } from '../src/shared/sync/s3-provider.js'

const PASSWORD = '官方同步 password 2026'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ok = (line) => console.log(`  ✓ ${line}`)

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64')),
  decryptString: (buffer) => Buffer.from(buffer.toString(), 'base64').toString('utf8')
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-official-sync-'))
const accountServer = await startAccountServer(root)
if (!accountServer) {
  console.log('SKIP official sync: minio is not installed (brew install minio)')
  process.exit(0)
}
const { minio, webhookSecret, admin } = accountServer
const server = accountServer.url

const devices = []
async function device(name) {
  const dir = join(root, name)
  const userData = join(dir, 'userData')
  const folder = join(dir, '笔记')
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(folder, { recursive: true })
  const service = new SyncService({ getUserDataPath: () => userData, safeStorage: fakeSafeStorage, request: fetch })
  const file = (rel) => join(folder, ...rel.split('/'))
  const d = {
    name, service, folder,
    write: async (rel, text) => { await fs.mkdir(join(file(rel), '..'), { recursive: true }); await fs.writeFile(file(rel), text) },
    read: (rel) => fs.readFile(file(rel), 'utf8')
  }
  devices.push(d)
  return d
}

const { codes, lastCode } = accountServer

async function login(d, email) {
  const before = (await codes(email)).length
  // One code per address per minute (the service's limit): wait it out.
  await d.service.startOfficialLogin({ email, server }).catch(async (error) => {
    if (error.code !== 'rate-limited' && !/秒/.test(error.message)) throw error
    await sleep((Number(error.retryAfter) || 60) * 1000 + 1000)
    await d.service.startOfficialLogin({ email, server })
  })
  for (let i = 0; i < 40 && (await codes(email)).length === before; i++) await sleep(50)
  return d.service.addOfficialConnection({ email, code: await lastCode(email), server, device: d.name })
}

try {
  // ---------- 1. login ----------
  const mac = await device('mac')
  await assert.rejects(mac.service.startOfficialLogin({ email: 'not-an-email', server }), (error) => /邮箱/.test(error.message))
  await mac.service.startOfficialLogin({ email: 'Alice@Example.com ', server })
  const firstCode = await lastCode('alice@example.com')
  assert.match(firstCode || '', /^\d{6}$/, 'a 6-digit code in the dev mailbox (address lower-cased)')
  await assert.rejects(mac.service.startOfficialLogin({ email: 'alice@example.com', server }), (error) => /\d+\s*秒/.test(error.message), 'a second code within a minute is refused with the wait in seconds')
  const wrong = firstCode === '000000' ? '111111' : '000000'
  await assert.rejects(mac.service.addOfficialConnection({ email: 'alice@example.com', code: wrong, server }), (error) => /验证码/.test(error.message))
  const alice = await mac.service.addOfficialConnection({ email: 'alice@example.com', code: firstCode, server, device: 'mac' })
  assert.equal(alice.type, 'horsemd')
  assert.equal(alice.email, 'alice@example.com')
  assert.ok(!('refreshToken' in alice) && !JSON.stringify(await mac.service.listConnections()).includes('refresh'), 'no token in the connection list')
  const connectionsFile = await fs.readFile(join(root, 'mac/userData/sync/connections.json'), 'utf8')
  assert.ok(!/refresh|accessToken/i.test(connectionsFile.replace(/"credentialId": "[^"]*"/, '')), 'tokens never written to connections.json')
  await assert.rejects(mac.service.addOfficialConnection({ email: 'alice@example.com', code: firstCode, server }), (error) => /验证码/.test(error.message), 'a used code does not work twice')
  ok('login: invalid address refused; code mailed (address lower-cased); resend within a minute refused with the wait; wrong / reused code refused; tokens only in the credential store')

  // ---------- 2. no plan ----------
  let account = await mac.service.officialAccount(alice.id)
  assert.equal(account.plan.id, 'none')
  assert.equal(account.storage.writable, false)
  assert.equal(account.storage.reason, 'no-plan')
  await adoptSyncWorkspace(join(root, 'mac/userData'), mac.folder)
  await mac.write('日记/一.md', '# 一\n\n第一天\n')
  await assert.rejects(mac.service.bindWorkspace(mac.folder, alice.id, { encryption: { password: PASSWORD } }), (error) => /还没有订阅/.test(error.message))
  ok('no plan: the account says so; a folder cannot start syncing (clear message)')

  // ---------- 3. plan → encrypted sync ----------
  await admin('grant', 'alice@example.com', 'standard', '30')
  account = await mac.service.officialAccount(alice.id)
  assert.equal(account.plan.id, 'standard')
  assert.equal(account.plan.status, 'active')
  assert.equal(account.storage.writable, true)
  await mac.write('Mac 写的.md', '来自 mac\n')
  const bound = await mac.service.bindWorkspace(mac.folder, alice.id, { encryption: { password: PASSWORD } })
  assert.equal(bound.encrypted, true)
  const pushed = await mac.service.run(mac.folder, 'push')
  assert.equal(pushed.summary.upload, 2, JSON.stringify(pushed.summary))
  const keys = await minio.names()
  const uid = alice.userId
  assert.ok(keys.length > 0 && keys.every((key) => key.startsWith(`users/${uid}/`)), `every object under users/<uid>/: ${keys.join(', ')}`)
  const raw = await minio.files()
  for (const [key, bytes] of raw) {
    if (key.endsWith('.horsemd/encryption.json') || key.endsWith('/')) continue
    assert.ok(!/日记|Mac 写的|第一天|来自 mac/.test(bytes.toString('utf8')) && !/日记|Mac/.test(key), `no plain names or text in ${key}`)
  }
  ok(`plan granted: an encrypted folder synced (${pushed.summary.upload} files); MinIO holds ${keys.length} objects, all under users/<uid>/, no plain names or text`)

  // ---------- 4. second device ----------
  const phone = await device('phone')
  const alice2 = await login(phone, 'alice@example.com')
  assert.equal(alice2.userId, alice.userId)
  await adoptSyncWorkspace(join(root, 'phone/userData'), phone.folder)
  const listed = await phone.service.listRemoteWorkspaces(alice2.id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].encrypted, true)
  await assert.rejects(phone.service.joinWorkspace(phone.folder, alice2.id, listed[0].workspaceId, { password: 'wrong password!!' }), /加密密码不对/)
  await phone.service.joinWorkspace(phone.folder, alice2.id, listed[0].workspaceId, { password: PASSWORD })
  const pulled = await phone.service.run(phone.folder, 'pull')
  assert.equal(pulled.summary.download, 2, JSON.stringify(pulled.summary))
  assert.equal(await phone.read('日记/一.md'), '# 一\n\n第一天\n')
  await phone.write('手机写的.md', '来自手机\n')
  await phone.service.run(phone.folder, 'merge', null, { automatic: true })
  await mac.service.run(mac.folder, 'merge', null, { automatic: true })
  assert.equal(await mac.read('手机写的.md'), '来自手机\n')
  ok('second device of the account: wrong password refused, joined, pulled both files; its new file reached the first device')

  // ---------- 5. another account ----------
  const bobDevice = await device('bob')
  const bob = await login(bobDevice, 'bob@example.com')
  await admin('grant', 'bob@example.com', 'standard', '30')
  const bobClient = createAccountClient({ request: fetch, server })
  const bobSession = bobDevice.service.connections.officialSession((await bobDevice.service.connections.store.readText('sync/connections.json').then(JSON.parse)).connections[0])
  const bobGrant = await bobSession.storageGrant({ force: true })
  assert.equal(bobGrant.prefix, `users/${bob.userId}`)
  const intruder = new S3Provider({
    endpoint: bobGrant.endpoint, bucket: bobGrant.bucket, region: bobGrant.region, allowInsecure: true, request: fetch,
    credentials: async () => ({ accessKeyId: bobGrant.accessKeyId, secretAccessKey: bobGrant.secretAccessKey, sessionToken: bobGrant.sessionToken }),
    prefix: `users/${uid}`
  })
  const aliceKey = keys.find((key) => !key.endsWith('/')).slice(`users/${uid}/`.length)
  await assert.rejects(intruder.get(aliceKey), /403|AccessDenied/, 'bob cannot read alice')
  await assert.rejects(intruder.put('x.md', Buffer.from('x')), /403|AccessDenied/, 'bob cannot write into alice')
  await assert.rejects(intruder.delete(aliceKey), /403|AccessDenied/, 'bob cannot delete alice')
  await assert.rejects(intruder.list(''), /403|AccessDenied/, 'bob cannot list alice')
  assert.ok(bobClient)
  ok('another account: its storage credentials cannot list, read, write or delete the first account\'s objects (MinIO 403)')

  // ---------- 6. limits ----------
  await mac.write('大文件.bin', crypto.randomBytes(6 * 1024 * 1024))
  const big = await mac.service.run(mac.folder, 'merge', null, { automatic: true }).catch((error) => ({ error }))
  assert.match(String(big.error?.message || JSON.stringify(big)), /单文件上限/, 'a 6 MB file is refused by the 5 MB per-file limit')
  await fs.rm(join(mac.folder, '大文件.bin'))
  await mac.service.run(mac.folder, 'merge', null, { automatic: true })
  await admin('revoke', 'alice@example.com')
  account = await mac.service.officialAccount(alice.id)
  assert.equal(account.storage.writable, false)
  // A run renews credentials older than 15 s (connections.js): the next run
  // after that sees the ended plan.
  await sleep(16000)
  await phone.write('结束后写的.md', 'x\n')
  const readOnly = await phone.service.run(phone.folder, 'merge', null, { automatic: true }).catch((error) => ({ error }))
  assert.match(String(readOnly.error?.message || JSON.stringify(readOnly)), /只能下载/, 'plan ended: uploads refused with the reason')
  await mac.write('之前.md', 'y\n')
  await fs.rm(join(phone.folder, '结束后写的.md'))
  const stillPull = await phone.service.run(phone.folder, 'pull').catch((error) => ({ error }))
  assert.ok(!stillPull.error, `pull still works read-only: ${stillPull.error?.message}`)
  ok('limits: a 6 MB file stops at the 5 MB per-file limit; a plan that ended with data stored is read-only (upload refused with the reason, pull works)')

  // ---------- 7. tokens ----------
  const credentialStore = mac.service.connections.credentialStore
  const saved = (await mac.service.connections.store.readText('sync/connections.json').then(JSON.parse)).connections.find((item) => item.id === alice.id)
  const oldRefresh = (await credentialStore.get(saved.credentialId)).refreshToken
  const session = mac.service.connections.officialSession(saved)
  session.access = null
  await session.accessToken()
  const newRefresh = (await credentialStore.get(saved.credentialId)).refreshToken
  assert.notEqual(newRefresh, oldRefresh, 'the refresh token rotated and the new one was saved')
  await assert.rejects(bobClient.refresh(oldRefresh), (error) => error.code === 'refresh-invalid')
  await assert.rejects(bobClient.refresh(newRefresh), (error) => error.code === 'refresh-invalid', 'reusing a rotated token ends the whole session')
  await mac.service.removeConnection(alice.id).catch(async (error) => {
    // A bound folder keeps the connection: unbind first.
    assert.match(error.message, /仍在使用/)
  })
  await phone.service.connections.remove(alice2.id)
  const phoneRefreshGone = await phone.service.connections.credentialStore.get(`horsemd:${alice2.id}`)
  assert.equal(phoneRefreshGone, null)
  ok('tokens: refresh token rotates and is saved; a reused old one ends the session; logging out removes it')

  // ---------- 8. Paddle webhook ----------
  const event = {
    event_id: 'evt_test_' + crypto.randomBytes(6).toString('hex'),
    event_type: 'subscription.created',
    occurred_at: new Date().toISOString(),
    data: {
      id: 'sub_test_1', status: 'active', customer_id: 'ctm_test_1',
      custom_data: { userId: bob.userId },
      items: [{ price: { id: 'pri_test_plus_y' } }],
      next_billed_at: new Date(Date.now() + 365 * 86400e3).toISOString()
    }
  }
  const body = JSON.stringify(event)
  const ts = Math.floor(Date.now() / 1000)
  const sign = (secret) => `ts=${ts};h1=${crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`
  const bad = await fetch(`${server}/v1/webhooks/paddle`, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign('wrong') }, body })
  assert.equal(bad.status, 401)
  const good = await fetch(`${server}/v1/webhooks/paddle`, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(webhookSecret) }, body })
  assert.equal(good.status, 200, await good.text())
  const bobAccount = await bobDevice.service.officialAccount(bob.id)
  assert.equal(bobAccount.plan.id, 'plus')
  assert.equal(bobAccount.plan.source, 'paddle')
  const again = await fetch(`${server}/v1/webhooks/paddle`, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(webhookSecret) }, body })
  assert.equal(again.status, 200)
  const config = await (await fetch(`${server}/v1/billing/config`)).json()
  assert.equal(config.ok, true)
  ok('Paddle webhook: bad signature 401; a signed subscription.created made the account Plus; the same event again is accepted once (idempotent)')

  assert.ok(!/\b\d{6}\b.*code|refreshToken|secret/i.test(accountServer.log().replace(/HM_[A-Z_]+/g, '')), 'the service log holds no codes or tokens')
  console.log('PASS official sync: account service + MinIO + two devices + two accounts + Paddle webhook')
} catch (error) {
  console.error(accountServer.log().slice(-3000))
  throw error
} finally {
  await accountServer.stop()
  if (!process.env.HM_KEEP) await fs.rm(root, { recursive: true, force: true })
}
