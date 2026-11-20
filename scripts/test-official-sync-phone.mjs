// HorseMD 同步 on a real Android phone (manual device test): the phone app's
// own sync API (native HorseHttp, Keystore secure store, WebCrypto) logs in
// to the real account service and syncs an encrypted folder through MinIO
// with the service's temporary credentials (session token header); this
// computer's SyncService, as a second device of the same account, joins and
// trades files with it. adb reverse puts the service and MinIO on the phone's
// 127.0.0.1. Debug build under its own package (see test-sync-e2ee-phone.mjs):
//   HM_PHONE_SERIAL=<adb serial> HM_PHONE_APK=<app-debug.apk> \
//     node scripts/test-official-sync-phone.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { connectCdp, sleep } from './lib/cdp.mjs'
import { startAccountServer } from './lib/account-server.mjs'
import { SyncService } from '../src/main/sync-service.js'
import { adoptSyncWorkspace } from '../src/main/sync-workspaces.js'

const run = promisify(execFile)
const serial = process.env.HM_PHONE_SERIAL
const apk = process.env.HM_PHONE_APK || ''
const pkg = process.env.HM_PHONE_PACKAGE || 'com.horsemd.app.e2ee'
if (!serial) throw new Error('HM_PHONE_SERIAL is required')
assert.ok(pkg !== 'com.horsemd.app', 'never the real app: use a debug build with its own package name')
const adb = async (...args) => (await run('adb', ['-s', serial, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
const CDP_PORT = 9342
const EMAIL = 'phone-test@example.com'
const PASSWORD = '手机官方同步 pass 2026'
const ok = (line) => console.log(`  ✓ ${line}`)
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text).toString('base64')),
  decryptString: (buffer) => Buffer.from(buffer.toString(), 'base64').toString()
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-official-phone-'))
const account = await startAccountServer(join(root, 'service'))
assert.ok(account, 'MinIO is needed')
const ports = [new URL(account.url).port, new URL(account.minio.connection.endpoint).port]
let phone = null

try {
  for (const port of ports) await adb('reverse', `tcp:${port}`, `tcp:${port}`)
  if (apk) await adb('install', '-r', apk)
  await adb('shell', 'pm', 'clear', pkg)
  await adb('shell', 'am', 'start', '-W', '-n', `${pkg}/com.horsemd.app.MainActivity`)
  let pid = ''
  for (let i = 0; i < 40 && !pid; i += 1) { pid = (await adb('shell', 'pidof', pkg).catch(() => '')).trim(); if (!pid) await sleep(250) }
  assert.ok(pid, 'app running')
  let socket = ''
  for (let i = 0; i < 40 && !socket; i += 1) {
    socket = (await adb('shell', 'cat', '/proc/net/unix')).split('\n').map((l) => l.trim().split(/\s+/).pop()).find((n) => n === `@webview_devtools_remote_${pid}`) || ''
    if (!socket) await sleep(250)
  }
  assert.ok(socket, 'WebView debugging socket (a debug build?)')
  await adb('forward', `tcp:${CDP_PORT}`, `localabstract:${socket.slice(1)}`)
  phone = await connectCdp({ port: CDP_PORT, attempts: 80 })
  const ev = (expression) => phone.evaluate(`(async () => { ${expression} })()`)
  await ev(`const t0 = Date.now(); while (!window.api?.syncStartOfficialLogin && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200)); if (!window.api?.syncStartOfficialLogin) throw new Error('no official sync api')`)

  // ---------- the phone logs in ----------
  const before = (await account.codes(EMAIL)).length
  await ev(`await window.api.syncStartOfficialLogin({ email: ${JSON.stringify(EMAIL)}, server: ${JSON.stringify(account.url)} })`)
  const code = await account.nextCode(EMAIL, before)
  const connection = await ev(`return await window.api.syncAddOfficialConnection({ email: ${JSON.stringify(EMAIL)}, code: ${JSON.stringify(code)}, server: ${JSON.stringify(account.url)} })`)
  assert.equal(connection.type, 'horsemd')
  const noPlan = await ev(`return await window.api.syncOfficialAccount(${JSON.stringify(connection.id)})`)
  assert.equal(noPlan.plan.id, 'none')
  ok(`phone: logged in with the mailed code over native HTTP (device "${noPlan.user ? 'ok' : '?'}"); the account shows no plan`)

  // ---------- plan → the phone pushes an encrypted folder ----------
  await account.admin('grant', EMAIL, 'standard', '30')
  await ev(`await window.api.writeFile('HorseMD/手机官方.md', '# 手机官方\\n\\nphone official 42\\n')`)
  await ev(`await window.api.syncAdoptWorkspace('HorseMD')`)
  const bound = await ev(`return await window.api.syncBindWorkspaceConnection('HorseMD', ${JSON.stringify(connection.id)}, { encryption: { password: ${JSON.stringify(PASSWORD)} } })`)
  assert.equal(bound.encrypted, true)
  const pushed = await ev(`return await window.api.syncRun('HorseMD', 'push')`)
  assert.ok(pushed.summary.upload >= 1, JSON.stringify(pushed.summary))
  const names = await account.minio.names()
  assert.ok(names.length && names.every((key) => key.startsWith(`users/${connection.userId}/`)), names.join(', '))
  for (const [key, bytes] of await account.minio.files()) {
    if (key.endsWith('encryption.json') || key.endsWith('/')) continue
    assert.ok(!/手机官方|phone official/.test(key + bytes.toString('utf8')), `sealed: ${key}`)
  }
  ok(`phone: plan granted → encrypted folder pushed (${pushed.summary.upload} files) with the temporary credentials; MinIO holds ${names.length} sealed objects under users/<uid>/`)

  // ---------- the computer, same account, joins ----------
  const userData = join(root, 'mac-userData')
  const folder = join(root, 'mac-笔记')
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(folder, { recursive: true })
  const mac = new SyncService({ getUserDataPath: () => userData, safeStorage: fakeSafeStorage, request: fetch })
  const n = (await account.codes(EMAIL)).length
  await sleep(61000) // one code per address per minute
  await mac.startOfficialLogin({ email: EMAIL, server: account.url })
  const macConnection = await mac.addOfficialConnection({ email: EMAIL, code: await account.nextCode(EMAIL, n), server: account.url })
  await adoptSyncWorkspace(userData, folder)
  const listed = await mac.listRemoteWorkspaces(macConnection.id)
  assert.equal(listed.length, 1)
  await mac.joinWorkspace(folder, macConnection.id, listed[0].workspaceId, { password: PASSWORD })
  await mac.run(folder, 'pull')
  assert.equal(await fs.readFile(join(folder, '手机官方.md'), 'utf8'), '# 手机官方\n\nphone official 42\n')
  await fs.writeFile(join(folder, '电脑写的.md'), '来自电脑\n')
  await mac.run(folder, 'merge', null, { automatic: true })
  await ev(`await window.api.syncRun('HorseMD', 'merge', { automatic: true })`)
  assert.equal(await ev(`return (await window.api.readFile('HorseMD/电脑写的.md')).content ?? (await window.api.readFile('HorseMD/电脑写的.md'))`), '来自电脑\n')
  ok('computer (same account) joined with the password, read the phone\'s file; its new file reached the phone')
  console.log(`PASS official sync on the phone (${serial})`)
} catch (error) {
  console.error(account.log().slice(-1500))
  throw error
} finally {
  phone?.close?.()
  await adb('forward', '--remove', `tcp:${CDP_PORT}`).catch(() => {})
  for (const port of ports) await adb('reverse', '--remove', `tcp:${port}`).catch(() => {})
  if (!process.env.HM_PHONE_KEEP) await adb('uninstall', pkg).catch(() => {})
  await account.stop()
  await fs.rm(root, { recursive: true, force: true })
}
