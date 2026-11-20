// End-to-end encrypted sync through the phone's OWN Settings › 云同步 page on
// a real Android phone (manual device test), with real input: every button is
// a touch (CDP Input.dispatchTouchEvent at its centre), every password typed
// character by character into the field the touch focused. Same setup as
// test-sync-e2ee-phone.mjs (debug build under its own package, real Apache
// WebDAV through adb reverse); the computer side is this machine's SyncService.
//   1. phone: 开启同步 → 端到端加密 on → short / mismatched password refused in
//      place → the right one → confirm the upload; the computer joins with
//      that password and reads the phone's files; the server holds only
//      sealed objects.
//   2. phone: stop syncing (the key leaves the phone) → 开启同步 → 继续 →
//      加入已加密的云端工作区 → wrong password refused → right one → confirm;
//      the computer's new file arrives.
//   3. phone: the lock button → 修改加密密码 (wrong old refused); the computer
//      keeps syncing unasked; a fresh computer joins only with the new one.
//   4. another device replaces the cloud key: the phone's 双向同步 stops with
//      the password box (e2ee-key-changed), writes nothing; the phone's own
//      password is refused there, the new key's password unlocks it.
//   HM_PHONE_SERIAL=<adb serial> HM_PHONE_APK=<app-debug.apk> HM_PHONE_SHOTS=<dir> \
//     node scripts/test-sync-e2ee-phone-ui.mjs
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
import { createKeyFile } from '../src/shared/sync/sync-crypto.js'

const run = promisify(execFile)
const serial = process.env.HM_PHONE_SERIAL
const apk = process.env.HM_PHONE_APK || ''
const pkg = process.env.HM_PHONE_PACKAGE || 'com.horsemd.app.e2ee'
const shots = process.env.HM_PHONE_SHOTS || ''
if (!serial) throw new Error('HM_PHONE_SERIAL is required')
assert.ok(pkg !== 'com.horsemd.app', 'never the real app: use a debug build with its own package name')
const adb = async (...args) => (await run('adb', ['-s', serial, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
const DAV_PORT = 18556
const CDP_PORT = 9340
const PASSWORD = '手机界面 pass 2026'
const NEW_PASSWORD = '手机上改的新密码 77'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text).toString('base64')),
  decryptString: (buffer) => Buffer.from(buffer.toString(), 'base64').toString()
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-e2ee-phone-ui-'))
const dav = await startApacheDav(join(root, 'dav'), { port: DAV_PORT })
assert.ok(dav, 'Apache DAV is needed')
let phone = null
let shotIndex = 0
const results = []
const ok = (line) => { results.push(line); console.log(`  ✓ ${line}`) }
const step = (label) => process.stderr.write(`  … ${new Date().toISOString().slice(11, 19)} ${label}\n`)

async function screenshot(name) {
  if (!shots) return
  await fs.mkdir(shots, { recursive: true })
  await sleep(400)
  const { stdout } = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  shotIndex += 1
  await fs.writeFile(join(shots, `${String(shotIndex).padStart(2, '0')}-${name}.png`), stdout)
}

const ev = (expression) => phone.evaluate(`(async () => { ${expression} })()`)

const waitFor = async (check, message, ms = 20000) => {
  const started = Date.now()
  let last
  while (Date.now() - started < ms) {
    last = await check()
    if (last) return last
    await sleep(200)
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}

// Scroll the first visible element matching selector (+ text pattern) into
// the middle and return its centre in CSS pixels; null when none.
const locate = (selector, pattern = '') => ev(`
  const re = new RegExp(${JSON.stringify(pattern)})
  const label = (e) => e.textContent || e.getAttribute('aria-label') || e.title || ''
  // Only what a finger can reach: on screen after scrolling, and the
  // element itself (not a sheet / backdrop above it) at its centre.
  for (const el of [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getBoundingClientRect().width > 0 && re.test(label(e)))) {
    el.scrollIntoView({ block: 'center' })
    await new Promise((r) => setTimeout(r, 350))
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
    const hit = document.elementFromPoint(x, y)
    if (hit && (hit === el || el.contains(hit) || hit.closest('label') === el.closest('label'))) return { x, y }
  }
  return null`)

async function tap(selector, pattern = '', what = selector) {
  const point = await waitFor(() => locate(selector, pattern), `on screen: ${what}`, 15000).catch(async (error) => {
    await screenshot(`missing-${what.replace(/[^\p{L}\p{N}]+/gu, '_')}`).catch(() => {})
    const seen = await ev(`return [...document.querySelectorAll('button, [role=button], [role=tab], a, .settings-nav-item')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.className.toString().split(' ')[0] + ':' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 16)).join(' | ')`).catch(() => '')
    throw new Error(`${error.message}\n  visible: ${seen}`)
  })
  await phone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] })
  await sleep(70)
  await phone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(350)
}

// Touch the field, then type into whatever the touch focused.
async function typeInto(selector, text) {
  await tap(selector, '', selector)
  const focused = await ev(`const a = document.activeElement; return a?.matches?.(${JSON.stringify(selector)}) ? (a.select?.(), true) : (a?.outerHTML || '').slice(0, 120)`)
  assert.equal(focused, true, `the touch focused ${selector}`)
  for (const character of [...text]) {
    await phone.send('Input.insertText', { text: character })
    await sleep(15)
  }
}

const ui = () => ev(`
  const q = (s) => document.querySelector(s)
  const text = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent.trim())
  return {
    choice: !!q('.sync-e2ee-choice'),
    choiceOn: !!q('.sync-e2ee-choice.on'),
    choiceError: q('.sync-e2ee-choice .sync-e2ee-error')?.textContent || '',
    formErrors: text('.sync-e2ee-form .sync-e2ee-error'),
    badge: text('.sync-e2ee-badge'),
    remote: text('.sync-remote-choice'),
    joinForm: !!q('.sync-e2ee-join .sync-e2ee-form'),
    confirm: text('.sync-plan-preview .settings-action-btn'),
    preview: !!q('.sync-plan-preview'),
    change: !!q('.sync-e2ee-change'),
    unlock: q('.sync-e2ee-unlock')?.dataset.reason || '',
    remoteReset: !!q('.sync-preview[role=dialog]'),
    busy: !!q('.sync-state-icon.syncing'),
    enable: [...document.querySelectorAll('.sync-folder-row button')].some((b) => /开启同步/.test(b.textContent)),
    folders: (q('.sync-folder-list')?.innerText || '').slice(0, 300)
  }`)

const phoneRead = async (path) => ev(`const r = await window.api.readFile(${JSON.stringify(path)}); return typeof r === 'string' ? r : r?.content`)

async function computerDevice(name) {
  const userData = join(root, `${name}-userData`)
  const folder = join(root, `${name}-笔记`)
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(folder, { recursive: true })
  const service = new SyncService({ getUserDataPath: () => userData, safeStorage: fakeSafeStorage, request: fetch })
  await adoptSyncWorkspace(userData, folder)
  const conn = await service.addWebDavConnection({ name: 'dav', endpoint: `http://127.0.0.1:${DAV_PORT}/`, allowInsecure: true })
  return { service, folder, conn }
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
  await ev(`const t0 = Date.now(); while (!(window.api?.syncAddWebDavConnection && document.querySelector('.app')) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200))`)

  // Setup (not under test): two notes in the library and the server connection.
  await ev(`await window.api.writeFile('HorseMD/手机日记.md', '# 手机日记\\n\\nphone diary 4242\\n')`)
  await ev(`await window.api.writeFile('HorseMD/待办.md', '- 交房租\\n')`)
  await ev(`await window.api.syncAddWebDavConnection({ name: 'mini Apache', endpoint: 'http://127.0.0.1:${DAV_PORT}/', username: '', password: '', allowInsecure: true })`)

  // ---------- 1. the phone turns encryption on ----------
  step('open Settings › 云同步')
  // Phones: 更多 (status bar) → 设置 in the sheet.
  await tap('.status-btn', '更多', '更多')
  await tap('button, [role=menuitem], li', '^\\s*(设置|Settings)\\s*$', '设置')
  await tap('.settings-nav-item', '云同步', '云同步')
  await waitFor(async () => (await ui()).enable, 'the library row offers 开启同步')
  await screenshot('sync-page')
  await tap('.sync-folder-row button', '开启同步', '开启同步')
  await waitFor(async () => (await ui()).choice, 'encryption choice under the folder')
  // Automatic sync off while setting up (as the desktop UI test does).
  const auto = await ev(`return document.querySelector('.sync-auto .hm-toggle')?.getAttribute('aria-checked')`)
  if (auto === 'true') await tap('.sync-auto .hm-toggle', '', '自动同步 switch')
  await screenshot('choice-off')
  await tap('.sync-e2ee-choice .hm-toggle', '', '端到端加密 switch')
  await waitFor(async () => (await ui()).choiceOn, 'password fields shown')
  await typeInto('.sync-e2ee-choice input[id$=-password]', 'short')
  await typeInto('.sync-e2ee-choice input[id$=-confirm]', 'short')
  await tap('.sync-folder-actions button', '继续', '继续')
  await waitFor(async () => /至少要 8/.test((await ui()).choiceError), 'short password explained')
  await screenshot('short-password')
  assert.equal((await dav.names()).some((name) => name.endsWith('encryption.json')), false, 'nothing in the cloud after a short password')
  await typeInto('.sync-e2ee-choice input[id$=-password]', PASSWORD)
  await typeInto('.sync-e2ee-choice input[id$=-confirm]', PASSWORD + '!')
  await tap('.sync-folder-actions button', '继续', '继续')
  await waitFor(async () => /不一样/.test((await ui()).choiceError), 'mismatch explained')
  await screenshot('mismatch')
  await typeInto('.sync-e2ee-choice input[id$=-confirm]', PASSWORD)
  await tap('.sync-folder-actions button', '继续', '继续')
  step('password accepted, waiting for the upload confirmation')
  await waitFor(async () => (await ui()).confirm.length > 0, 'upload confirmation', 30000)
  await screenshot('push-preview')
  await tap('.sync-plan-preview .settings-action-btn', '.', 'confirm upload')
  await waitFor(async () => { const s = await ui(); return !s.busy && !s.preview && s.badge.length > 0 }, 'encrypted + synced', 40000)
  await screenshot('encrypted-badge')
  const names = await dav.names()
  for (const word of ['手机日记', '待办', 'manifest']) assert.ok(!names.join('\n').includes(word), `"${word}" in a cloud name`)
  for (const [key, bytes] of await dav.files()) {
    if (key.includes('.connection-check') || key.endsWith('.horsemd/encryption.json')) continue
    assert.equal(bytes.subarray(0, 4).toString(), 'HMX1', key)
    for (const word of ['phone diary', '交房租', 'workspaceId']) assert.ok(!bytes.includes(Buffer.from(word)), `"${word}" readable in ${key}`)
  }
  const computer = await computerDevice('computer')
  const [remote] = await computer.service.listRemoteWorkspaces(computer.conn.id)
  assert.equal(remote?.encrypted, true)
  await assert.rejects(computer.service.joinWorkspace(computer.folder, computer.conn.id, remote.workspaceId, { password: PASSWORD + '!' }), /加密密码不对/)
  await computer.service.joinWorkspace(computer.folder, computer.conn.id, remote.workspaceId, { password: PASSWORD })
  await computer.service.run(computer.folder, 'pull')
  assert.equal(await fs.readFile(join(computer.folder, '手机日记.md'), 'utf8'), '# 手机日记\n\nphone diary 4242\n')
  ok('phone UI: 端到端加密 on; short and mismatched passwords refused in place (nothing written); the right one encrypts + uploads; the computer joins with that password and reads the files; the server holds only sealed objects')

  // ---------- 2. stop syncing, then join the encrypted workspace by hand ----------
  step('stop syncing on the phone')
  await fs.writeFile(join(computer.folder, '电脑新写的.md'), 'written on the computer\n')
  await computer.service.run(computer.folder, 'merge', null, { automatic: true })
  await tap('button[aria-label=停止管理]', '', '停止管理 (stop syncing)')
  await waitFor(async () => (await ui()).enable, 'the row offers 开启同步 again')
  await tap('.sync-folder-row button', '开启同步', '开启同步')
  await waitFor(async () => (await ui()).choice, 'choice under the folder')
  const autoAgain = await ev(`return document.querySelector('.sync-auto .hm-toggle')?.getAttribute('aria-checked')`)
  if (autoAgain === 'true') await tap('.sync-auto .hm-toggle', '', '自动同步 switch')
  await tap('.sync-folder-actions button', '继续', '继续')
  await waitFor(async () => (await ui()).remote.some((t) => /加入已加密/.test(t)), 'encrypted cloud workspace listed', 20000)
  await screenshot('remote-list')
  await tap('.sync-remote-choice', '加入已加密', '加入已加密的云端工作区')
  await waitFor(async () => (await ui()).joinForm, 'join password form')
  await typeInto('.sync-e2ee-join input[type=password]', 'wrong password 1')
  await tap('.sync-e2ee-join button[type=submit]', '.', 'join')
  await waitFor(async () => (await ui()).formErrors.some((t) => /加密密码不对/.test(t)), 'wrong password explained', 20000)
  await screenshot('join-wrong-password')
  await typeInto('.sync-e2ee-join input[type=password]', PASSWORD)
  await tap('.sync-e2ee-join button[type=submit]', '.', 'join')
  await waitFor(async () => (await ui()).confirm.length > 0, 'download confirmation after joining', 30000).catch(async (error) => {
    await screenshot('after-join')
    throw new Error(`${error.message}\n  ui: ${JSON.stringify(await ui())}`)
  })
  await screenshot('join-preview')
  await tap('.sync-plan-preview .settings-action-btn', '.', 'confirm')
  await waitFor(async () => (await phoneRead('HorseMD/电脑新写的.md').catch(() => null)) === 'written on the computer\n', 'the computer\'s file reached the phone', 40000)
  await waitFor(async () => { const s = await ui(); return !s.busy && s.badge.length > 0 }, 'badge after joining')
  await screenshot('joined')
  ok('phone UI: stop syncing → 开启同步 → 加入已加密的云端工作区; a wrong password is refused in place; the right one joins and the computer\'s new file arrives')

  // ---------- 3. change the password on the phone ----------
  step('change the password on the phone')
  await tap('.sync-e2ee-password-btn', '', '锁 (修改加密密码)')
  await waitFor(async () => (await ui()).change, 'change-password form')
  await typeInto('.sync-e2ee-change input[id$=-old]', 'not the old one')
  await typeInto('.sync-e2ee-change input[id$=-password]', NEW_PASSWORD)
  await typeInto('.sync-e2ee-change input[id$=-confirm]', NEW_PASSWORD)
  await tap('.sync-e2ee-change button[type=submit]', '.', 'change')
  await waitFor(async () => (await ui()).formErrors.some((t) => /加密密码不对/.test(t)), 'wrong old password explained', 20000).catch(async (error) => {
    await screenshot('after-change-submit')
    throw new Error(`${error.message}\n  ui: ${JSON.stringify(await ui())}\n  form: ${await ev(`return document.querySelector('.sync-e2ee-change')?.outerHTML.slice(0, 1500)`)}`)
  })
  await screenshot('change-wrong-old')
  await typeInto('.sync-e2ee-change input[id$=-old]', PASSWORD)
  await tap('.sync-e2ee-change button[type=submit]', '.', 'change')
  await waitFor(async () => !(await ui()).change, 'form closes after the change', 20000)
  await screenshot('changed')
  await fs.writeFile(join(computer.folder, '改密码之后.md'), 'after the change\n')
  const keptSyncing = await computer.service.run(computer.folder, 'merge', null, { automatic: true })
  assert.ok(!keptSyncing.needsConfirmation, JSON.stringify(keptSyncing))
  const fresh = await computerDevice('fresh')
  await assert.rejects(fresh.service.joinWorkspace(fresh.folder, fresh.conn.id, remote.workspaceId, { password: PASSWORD }), /加密密码不对/)
  await fresh.service.joinWorkspace(fresh.folder, fresh.conn.id, remote.workspaceId, { password: NEW_PASSWORD })
  await fresh.service.run(fresh.folder, 'pull')
  assert.equal(await fs.readFile(join(fresh.folder, '改密码之后.md'), 'utf8'), 'after the change\n')
  ok('phone UI: 修改加密密码 (wrong old refused in place); the computer keeps syncing unasked; a fresh computer needs the new password')

  // ---------- 4. the cloud key is replaced: the phone's unlock box ----------
  step('replace the cloud key')
  const STRANGER = '另一台设备的新密钥 55'
  const keyPath = (await dav.names()).find((name) => name.startsWith(`HorseMD/${remote.workspaceId}/`) && name.endsWith('.horsemd/encryption.json'))
  assert.ok(keyPath, 'key file on the server')
  await dav.write(keyPath, Buffer.from(JSON.stringify((await createKeyFile(STRANGER, { iterations: 1000 })).keyFile)))
  await ev(`await window.api.writeFile('HorseMD/等着.md', 'must wait\\n')`)
  const before4 = (await dav.names()).sort()
  const viewportBefore = await ev(`return Math.round(window.visualViewport ? visualViewport.height : innerHeight)`)
  await tap('button[aria-label=双向同步]', '', '双向同步')
  await waitFor(async () => (await ui()).unlock === 'e2ee-key-changed', 'the password box (e2ee-key-changed)', 30000)
  // The box focuses its field and is scrolled onto the page.
  await sleep(1500)
  const field = await ev(`const i = document.querySelector('.sync-e2ee-unlock input[type=password]'); const r = i.getBoundingClientRect(); const vv = window.visualViewport; return { focused: document.activeElement === i, top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: Math.round(vv ? vv.height : innerHeight) }`)
  await screenshot('key-changed')
  console.log(`    unlock field: ${JSON.stringify({ ...field, viewportBefore, inner: await ev('return innerHeight') })}`)
  assert.ok(field.focused && field.top >= 0 && field.bottom <= field.viewport, `the unlock field is focused and on the page: ${JSON.stringify(field)}`)
  assert.deepEqual((await dav.names()).sort(), before4, 'nothing written with a replaced key')
  await typeInto('.sync-e2ee-unlock input[type=password]', NEW_PASSWORD)
  // The touch opened the keyboard: the WebView must shrink above it and the
  // field stay inside (on the Huawei — Android 10, WebView 114 — the keyboard
  // used to cover the box: MainActivity.installKeyboardResize).
  await sleep(1200)
  const typing = await ev(`const i = document.querySelector('.sync-e2ee-unlock input[type=password]'); const r = i.getBoundingClientRect(); return { inner: innerHeight, top: Math.round(r.top), bottom: Math.round(r.bottom) }`)
  await screenshot('unlock-keyboard')
  console.log(`    keyboard up: ${JSON.stringify({ ...typing, viewportBefore })}`)
  assert.ok(typing.inner < viewportBefore - 150 && typing.top >= 0 && typing.bottom <= typing.inner, `the keyboard shrinks the page and the field stays above it: ${JSON.stringify({ ...typing, viewportBefore })}`)
  await tap('.sync-e2ee-unlock button[type=submit]', '.', 'unlock')
  await waitFor(async () => (await ui()).formErrors.some((t) => /加密密码不对/.test(t)), 'the phone\'s own password does not open the new key', 20000)
  await screenshot('unlock-wrong')
  await typeInto('.sync-e2ee-unlock input[type=password]', STRANGER)
  await tap('.sync-e2ee-unlock button[type=submit]', '.', 'unlock')
  await waitFor(async () => { const s = await ui(); return !s.unlock && (s.remoteReset || s.confirm.length > 0) }, 'unlocked → the next choice', 30000)
  await screenshot('unlocked')
  ok('phone UI: a replaced cloud key stops 双向同步 with the password box and writes nothing; the old password is refused there, the new key\'s one unlocks')
} finally {
  try { phone?.ws.close() } catch {}
  await adb('forward', '--remove', `tcp:${CDP_PORT}`).catch(() => {})
  await adb('reverse', '--remove', `tcp:${DAV_PORT}`).catch(() => {})
  await adb('shell', 'am', 'force-stop', pkg).catch(() => {})
  if (!process.env.HM_PHONE_KEEP) await adb('uninstall', pkg).catch(() => {})
  await dav.stop()
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`PASS e2ee sync through the phone's Settings UI (${serial}): ${results.length} checks`)
