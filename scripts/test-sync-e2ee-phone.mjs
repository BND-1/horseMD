// End-to-end encrypted sync on a real Android phone (manual device test):
// the phone app's WebView (WebCrypto, native HorseHttp, Keystore-backed
// secure store) and this computer's SyncService share one encrypted
// workspace on a real Apache WebDAV server (adb reverse → the phone's
// 127.0.0.1). Needs a DEBUG build (WebView debugging on), installed under its
// own package name so the phone's real HorseMD stays untouched, e.g. a debug
// build with `applicationIdSuffix ".e2ee"`:
//   HM_PHONE_SERIAL=<adb serial> HM_PHONE_APK=<app-debug.apk> \
//     node scripts/test-sync-e2ee-phone.mjs
// HM_PHONE_PACKAGE (default com.horsemd.app.e2ee); HM_PHONE_SHOTS=<dir> saves
// screenshots of the phone's 云同步 page; HM_PHONE_KEEP=1 leaves the test
// app installed. Only that package's data is cleared / removed.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { connectCdp, sleep } from './lib/cdp.mjs'
import { startApacheDav } from './lib/apache-dav.mjs'
import { SyncService } from '../src/main/sync-service.js'
import { adoptSyncWorkspace } from '../src/main/sync-workspaces.js'

const run = promisify(execFile)
const serial = process.env.HM_PHONE_SERIAL
const apk = process.env.HM_PHONE_APK || ''
const pkg = process.env.HM_PHONE_PACKAGE || 'com.horsemd.app.e2ee'
const shots = process.env.HM_PHONE_SHOTS || ''
if (!serial) throw new Error('HM_PHONE_SERIAL is required')
assert.ok(pkg !== 'com.horsemd.app', 'never the real app: use a debug build with its own package name')
const adb = async (...args) => (await run('adb', ['-s', serial, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
const DAV_PORT = 18555
const CDP_PORT = 9339
const PASSWORD = '手机加密 password 2026'
const NEW_PASSWORD = 'changed on the computer 99'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text).toString('base64')),
  decryptString: (buffer) => Buffer.from(buffer.toString(), 'base64').toString()
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-e2ee-phone-'))
const dav = await startApacheDav(join(root, 'dav'), { port: DAV_PORT })
assert.ok(dav, 'Apache DAV is needed')
let phone = null
const results = []
const ok = (line) => { results.push(line); console.log(`  ✓ ${line}`) }

async function screenshot(name) {
  if (!shots) return
  await fs.mkdir(shots, { recursive: true })
  const { stdout } = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  await fs.writeFile(join(shots, `${name}.png`), stdout)
}

try {
  await adb('reverse', `tcp:${DAV_PORT}`, `tcp:${DAV_PORT}`)
  if (apk) await adb('install', '-r', apk)
  await adb('shell', 'pm', 'clear', pkg)
  await adb('shell', 'am', 'start', '-W', '-n', `${pkg}/com.horsemd.app.MainActivity`)
  let pid = ''
  for (let i = 0; i < 40 && !pid; i += 1) { pid = (await adb('shell', 'pidof', pkg)).trim(); if (!pid) await sleep(250) }
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
  await ev(`const t0 = Date.now(); while (!window.api?.syncAddWebDavConnection && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200)); if (!window.api?.syncAddWebDavConnection) throw new Error('no sync api')`)
  const info = await ev(`return { ua: navigator.userAgent, secure: isSecureContext, subtle: !!crypto?.subtle, origin: location.origin }`)
  assert.equal(info.subtle, true, `WebCrypto on the phone: ${JSON.stringify(info)}`)
  ok(`phone WebView: secure context ${info.secure}, WebCrypto present (${info.origin}; ${info.ua.match(/Chrome\/[\d.]+/)?.[0]})`)

  // The key derivation the app uses (PBKDF2-SHA256, 600 000) on this phone.
  const kdfMs = await ev(`
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('x'), 'PBKDF2', false, ['deriveBits'])
    const t0 = performance.now()
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 600000 }, base, 256)
    return Math.round(performance.now() - t0)`)
  ok(`PBKDF2-SHA256 600 000 rounds on the phone: ${kdfMs} ms`)

  // ---------- the phone creates the encrypted workspace ----------
  await ev(`await window.api.writeFile('HorseMD/手机机密.md', '# 手机机密\\n\\nphone secret 777\\n')`)
  await ev(`await window.api.writeFile('HorseMD/购物清单.md', '- 牛奶\\n- 面包\\n')`)
  const connectionId = await ev(`return (await window.api.syncAddWebDavConnection({ name: 'mini DAV', endpoint: 'http://127.0.0.1:${DAV_PORT}/', username: '', password: '', allowInsecure: true })).id`)
  await ev(`await window.api.syncAdoptWorkspace('HorseMD')`)
  const bindMs = await ev(`const t0 = performance.now(); const e = await window.api.syncBindWorkspaceConnection('HorseMD', ${JSON.stringify(connectionId)}, { encryption: { password: ${JSON.stringify(PASSWORD)} } }); if (!e.encrypted) throw new Error('not encrypted'); return Math.round(performance.now() - t0)`)
  const pushed = await ev(`return await window.api.syncRun('HorseMD', 'push')`)
  assert.ok(pushed.summary.upload >= 2, JSON.stringify(pushed.summary))
  ok(`phone: encrypted workspace created (${bindMs} ms incl. the key) and pushed ${pushed.summary.upload} files`)

  const leakScan = async (label) => {
    const names = (await dav.names()).join('\n')
    for (const word of ['手机机密', '购物清单', '电脑写的', 'manifest']) assert.ok(!names.includes(word), `${label}: "${word}" in a cloud name`)
    for (const [key, bytes] of await dav.files()) {
      if (key.includes('.connection-check')) continue
      if (key.endsWith('.horsemd/encryption.json')) continue
      assert.equal(bytes.subarray(0, 4).toString(), 'HMX1', `${label}: ${key}`)
      for (const word of ['phone secret', '牛奶', 'from the computer', 'workspaceId']) assert.ok(!bytes.includes(Buffer.from(word)), `${label}: "${word}" in ${key}`)
    }
  }
  await leakScan('after the phone push')
  ok('server disk: only the key file + opaque sealed objects')

  // ---------- this computer joins ----------
  const userData = join(root, 'computer-userData')
  const folder = join(root, 'computer-笔记')
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(folder, { recursive: true })
  const computer = new SyncService({ getUserDataPath: () => userData, safeStorage: fakeSafeStorage, request: fetch })
  await adoptSyncWorkspace(userData, folder)
  const conn = await computer.addWebDavConnection({ name: 'dav', endpoint: `http://127.0.0.1:${DAV_PORT}/`, allowInsecure: true })
  const [remote] = await computer.listRemoteWorkspaces(conn.id)
  assert.equal(remote?.encrypted, true)
  await assert.rejects(computer.joinWorkspace(folder, conn.id, remote.workspaceId, { password: 'wrong wrong' }), /加密密码不对/)
  await computer.joinWorkspace(folder, conn.id, remote.workspaceId, { password: PASSWORD })
  await computer.run(folder, 'pull')
  assert.equal(await fs.readFile(join(folder, '手机机密.md'), 'utf8'), '# 手机机密\n\nphone secret 777\n')
  ok('computer: sees an encrypted workspace, wrong password refused, right one joins and reads the phone\'s files')

  // ---------- edits both ways ----------
  await fs.writeFile(join(folder, '购物清单.md'), '- 牛奶\n- 面包\n- 鸡蛋（电脑写的）\n')
  await fs.writeFile(join(folder, '电脑写的.md'), 'from the computer\n')
  await computer.run(folder, 'merge', null, { automatic: true })
  const phoneRun = await ev(`return await window.api.syncRun('HorseMD', 'merge', { automatic: true })`)
  assert.ok(!phoneRun.needsConfirmation, JSON.stringify(phoneRun))
  const phoneList = await ev(`const r = await window.api.readFile('HorseMD/购物清单.md'); return typeof r === 'string' ? r : r?.content`)
  assert.equal(phoneList, '- 牛奶\n- 面包\n- 鸡蛋（电脑写的）\n')
  const phoneNew = await ev(`const r = await window.api.readFile('HorseMD/电脑写的.md'); return typeof r === 'string' ? r : r?.content`)
  assert.equal(phoneNew, 'from the computer\n')
  await ev(`await window.api.writeFile('HorseMD/手机机密.md', '# 手机机密\\n\\nphone secret 777\\n\\n手机又改了\\n')`)
  await ev(`await window.api.syncRun('HorseMD', 'merge', { automatic: true })`)
  await computer.run(folder, 'merge', null, { automatic: true })
  assert.match(await fs.readFile(join(folder, '手机机密.md'), 'utf8'), /手机又改了/)
  await leakScan('after edits both ways')
  ok('edits both ways: computer → phone (changed + new file), phone → computer')

  // ---------- the computer changes the password: the phone is not asked ----------
  await computer.changeEncryptionPassword(folder, PASSWORD, NEW_PASSWORD)
  await fs.writeFile(join(folder, '改密码后.md'), 'after\n')
  await computer.run(folder, 'merge', null, { automatic: true })
  const afterChange = await ev(`return await window.api.syncRun('HorseMD', 'merge', { automatic: true })`)
  assert.ok(!afterChange.needsConfirmation, JSON.stringify(afterChange))
  ok('computer changed the password: the phone keeps syncing without asking')

  // ---------- the phone forgets the folder and joins again ----------
  await ev(`await window.api.syncRemoveWorkspace('HorseMD')`)
  await ev(`await window.api.syncAdoptWorkspace('HorseMD')`)
  const listed = await ev(`return await window.api.syncListRemoteWorkspaces(${JSON.stringify(connectionId)})`)
  assert.equal(listed.find((w) => w.workspaceId === remote.workspaceId)?.encrypted, true, JSON.stringify(listed))
  const wrong = await ev(`try { await window.api.syncJoinWorkspace('HorseMD', ${JSON.stringify(connectionId)}, ${JSON.stringify(remote.workspaceId)}, { password: ${JSON.stringify(PASSWORD)} }); return 'joined' } catch (e) { return String(e.message || e) }`)
  assert.match(wrong, /加密密码不对/, 'the old password no longer opens it')
  await ev(`await window.api.syncJoinWorkspace('HorseMD', ${JSON.stringify(connectionId)}, ${JSON.stringify(remote.workspaceId)}, { password: ${JSON.stringify(NEW_PASSWORD)} })`)
  const rejoined = await ev(`return await window.api.syncRun('HorseMD', 'merge', { automatic: true })`)
  assert.ok(!rejoined.needsConfirmation, JSON.stringify(rejoined))
  const afterText = await ev(`const r = await window.api.readFile('HorseMD/改密码后.md'); return typeof r === 'string' ? r : r?.content`)
  assert.equal(afterText, 'after\n')
  ok('phone: stop syncing removes the key; rejoining refuses the old password, accepts the new one, files keep flowing')

  // ---------- the phone's 云同步 page ----------
  if (shots) {
    await ev(`location.reload()`).catch(() => {})
    await sleep(3500)
    phone.ws.close()
    phone = await connectCdp({ port: CDP_PORT, attempts: 80 })
    const opened = await phone.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const visible = (e) => e && e.getBoundingClientRect().width > 0
      const t0 = Date.now()
      while (!document.querySelector('.app') && Date.now() - t0 < 15000) await sleep(200)
      await sleep(1000)
      // The status bar's sync item opens Settings › 云同步; else the drawer's
      // 云空间 title does.
      let target = [...document.querySelectorAll('.hm-sync-status')].find(visible)
      if (!target) {
        ;[...document.querySelectorAll('button')].find((b) => visible(b) && /菜单|menu|sidebar|侧栏/i.test(b.getAttribute('aria-label') || b.title || ''))?.click()
        await sleep(600)
        target = [...document.querySelectorAll('.sidebar[data-variant=cloud] .sidebar-title, .sidebar[data-variant=cloud] [class*=status]')].find(visible)
      }
      target?.click()
      await sleep(900)
      if (!document.querySelector('.sync-folder-list')) {
        ;[...document.querySelectorAll('button')].find((b) => visible(b) && /^(设置|Settings)$/.test((b.getAttribute('aria-label') || b.title || b.textContent || '').trim()))?.click()
        await sleep(700)
        ;[...document.querySelectorAll('.settings-nav-item, button, [role=tab]')].find((b) => visible(b) && /云同步|Cloud sync/i.test(b.textContent || ''))?.click()
        await sleep(900)
      }
      return document.querySelector('.sync-folder-list') ? true
        : [...document.querySelectorAll('button')].filter(visible).map((b) => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 20)).join(' | ')
    })()`)
    assert.equal(opened, true, 'the phone opened Settings › 云同步')
    await phone.evaluate(`(() => { const row = document.querySelector('.sync-workspace-item'); row?.scrollIntoView({ block: 'start' }); return true })()`)
    await sleep(500)
    await screenshot('phone-sync-page')
    await phone.evaluate(`(async () => { document.querySelector('.sync-e2ee-password-btn')?.click(); await new Promise((r) => setTimeout(r, 500)); document.querySelector('.sync-e2ee-change')?.scrollIntoView({ block: 'center' }); return true })()`)
    await sleep(500)
    await screenshot('phone-change-password')
  }
} finally {
  try { phone?.ws.close() } catch {}
  await adb('forward', '--remove', `tcp:${CDP_PORT}`).catch(() => {})
  await adb('reverse', '--remove', `tcp:${DAV_PORT}`).catch(() => {})
  await adb('shell', 'am', 'force-stop', pkg).catch(() => {})
  if (!process.env.HM_PHONE_KEEP) await adb('uninstall', pkg).catch(() => {})
  await dav.stop()
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`PASS e2ee sync on a real phone (${serial}): ${results.length} checks`)
