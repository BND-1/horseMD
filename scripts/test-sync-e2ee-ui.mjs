// End-to-end encrypted sync in the real app (Settings › 云同步,
// SyncEncryption.jsx), two app instances = two devices, one in-memory S3:
//   A: 端到端加密 on, a short / mismatched password is refused in place,
//      the right one creates the encrypted workspace and pushes; the folder
//      shows 端到端加密; the cloud holds only the key file + opaque objects.
//   B: 继续 lists 加入已加密的云端工作区; a wrong password is refused in
//      place (nothing changes), the right one joins and downloads.
//   A: 修改加密密码 (wrong old refused; right one changes it); B keeps syncing.
//   Another device replaces the key: A's automatic sync stops, the folder
//   shows the password box (e2ee-key-changed) and the status bar 需要确认;
//   the new key's password unlocks it.
// Screenshots of each state go to HM_E2EE_SHOTS (a folder) when set.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'
import { startMockS3 } from './lib/mock-s3-server.mjs'
import { createKeyFile } from '../src/shared/sync/sync-crypto.js'

const PASSWORD = 'horse-正确密码-2026'
const NEW_PASSWORD = 'changed-新密码-2026'
const STRANGER = 'stranger key 98765'
const SECRET = '季度机密.md'
const SECRET_TEXT = '# 季度机密\n\nrevenue 1234567\n'

const tempBase = process.platform === 'darwin' ? homedir() : tmpdir()
const root = await mkdtemp(join(tempBase, '.horsemd-e2ee-ui-'))
const shots = process.env.HM_E2EE_SHOTS || ''
const s3 = await startMockS3()
const folderA = join(root, 'A-笔记')
const folderB = join(root, 'B-笔记')
const basePort = 29700 + process.pid % 50
const apps = []

const waitFor = async (check, message, ms = 20000) => {
  const started = Date.now()
  let last
  while (Date.now() - started < ms) {
    last = await check()
    if (last) return last
    await sleep(150)
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}

async function launch(name, folder, port) {
  step(`${name}: starting the app`)
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${name}`), port, appArgs: [folder] })
  app.name = name
  apps.push(app)
  await app.evaluate(`(async () => {
    const t0 = Date.now()
    while (!document.querySelector('.tabs, .welcome') && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100))
  })()`)
  const { type, ...connection } = s3.connection
  step(`${name}: app up, adding the connection`)
  const added = await app.evaluate(`(async () => (await window.api.syncAddS3Connection(${JSON.stringify({ ...connection, name: 'Mock S3' })}))?.id)()`)
  assert.ok(added, `${name}: connection saved`)
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const visible = (e) => e && e.getBoundingClientRect().width > 0
    ;[...document.querySelectorAll('button')].filter(visible).find((b) => /settings|设置/i.test(b.title || b.textContent || '')).click()
    await sleep(400)
    ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /云同步|cloud sync/i.test(b.textContent || '')).click()
    await sleep(600)
  })()`)
  // The folder (opened in the workspace) → 开启同步, as a user does.
  await waitFor(() => app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.sync-folder-row')].find((r) => r.textContent.includes(${JSON.stringify(basename(folder))}))
    const button = row && [...row.querySelectorAll('button')].find((b) => /开启同步|Enable/.test(b.textContent))
    if (!button) return false
    button.click()
    return true
  })()`), `${name}: 开启同步`)
  // Automatic sync off while setting up (its start-up run would race the
  // clicks); A turns it on again for the last part.
  await setAuto(app, false)
  return app
}

const setAuto = (app, on) => app.evaluate(`(async () => {
  const toggle = document.querySelector('.sync-auto .hm-toggle')
  if (!toggle) throw new Error('no auto-sync switch')
  if ((toggle.getAttribute('aria-checked') === 'true') !== ${on}) toggle.click()
  await new Promise((r) => setTimeout(r, 300))
  return toggle.getAttribute('aria-checked')
})()`)

const shot = async (app, name) => {
  if (!shots) return
  await mkdir(shots, { recursive: true })
  await sleep(300)
  // A hidden background window may never answer (Windows): skip the shot.
  const image = await Promise.race([app.send('Page.captureScreenshot', { format: 'png', fromSurface: true }), sleep(5000).then(() => null)])
  if (!image) { step(`screenshot ${name} skipped (no frame)`); return }
  await writeFile(join(shots, `${name}.png`), Buffer.from(image.data ?? image.result?.data ?? '', 'base64'))
}

// Click the first visible button whose text matches.
const click = (app, selector, pattern) => app.evaluate(`(() => {
  const re = new RegExp(${JSON.stringify(pattern)})
  const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.getBoundingClientRect().width > 0 && re.test(b.textContent || b.getAttribute('aria-label') || ''))
  if (!button) return false
  button.scrollIntoView({ block: 'center' })
  button.click()
  return true
})()`)

async function type(app, selector, text) {
  const found = await app.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    input.scrollIntoView({ block: 'center' })
    input.focus()
    input.select?.()
    return document.activeElement === input
  })()`)
  assert.ok(found, `input ${selector}`)
  await typeTextLikeUser(app.send, text, { delayMs: 3 })
}

const ui = (app) => app.evaluate(`(() => {
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
    preview: !!q('.sync-plan-preview'),
    confirm: text('.sync-plan-preview .settings-action-btn'),
    unlock: q('.sync-e2ee-unlock')?.dataset.reason || '',
    unlockTitle: q('.sync-e2ee-unlock strong')?.textContent || '',
    change: !!q('.sync-e2ee-change'),
    busy: !!q('.sync-state-icon.syncing'),
    done: !!q('.sync-state-icon.complete'),
    remoteReset: !!q('.sync-preview[role=dialog]'),
    notice: text('.sync-notice, .settings-notice, [class*=notice]').join(' | '),
    status: q('.hm-sync-status, [class*=sync-status]')?.textContent?.trim() || '',
    folders: (q('.sync-folder-list')?.innerText || '(no folder list) ' + (q('.settings-view, .settings-page, main')?.innerText || '').slice(0, 300)).slice(0, 400)
  }
})()`)

// Progress on stderr (a hang on another machine shows where it stopped).
const step = (label) => process.stderr.write(`  … ${new Date().toISOString().slice(11, 19)} ${label}\n`)
const objectNames = async () => [...(await s3.files()).keys()]

try {
  await mkdir(folderA, { recursive: true })
  await mkdir(folderB, { recursive: true })
  await mkdir(join(folderA, '客户名单'), { recursive: true })
  await writeFile(join(folderA, SECRET), SECRET_TEXT)
  await writeFile(join(folderA, '客户名单', '王先生.md'), 'phone 13800000000\n')

  // ---------- A: turn encryption on ----------
  step('launch A')
  const a = await launch('A', folderA, basePort)
  step('A launched')
  await waitFor(async () => (await ui(a)).choice, 'A: encryption choice under the folder').catch(async (error) => { console.log(JSON.stringify(await ui(a), null, 1)); throw error })
  await shot(a, '01-a-choice-off')
  assert.ok(await a.evaluate(`(() => { const t = document.querySelector('.sync-e2ee-choice .hm-toggle'); t.click(); return true })()`))
  await waitFor(async () => (await ui(a)).choiceOn, 'A: password fields shown')
  // Too short → refused in place, nothing in the cloud.
  await type(a, '.sync-e2ee-choice input[id$=-password]', 'short')
  await type(a, '.sync-e2ee-choice input[id$=-confirm]', 'short')
  assert.ok(await click(a, '.sync-folder-actions button', '继续|Continue'))
  await waitFor(async () => /至少要 8/.test((await ui(a)).choiceError), 'A: short password explained')
  assert.equal((await objectNames()).filter((k) => k.includes('/.horsemd/encryption.json')).length, 0)
  // Mismatch → refused.
  await type(a, '.sync-e2ee-choice input[id$=-password]', PASSWORD)
  await type(a, '.sync-e2ee-choice input[id$=-confirm]', PASSWORD + 'x')
  assert.ok(await click(a, '.sync-folder-actions button', '继续|Continue'))
  await waitFor(async () => /不一样/.test((await ui(a)).choiceError), 'A: mismatch explained')
  await shot(a, '02-a-choice-mismatch')
  await type(a, '.sync-e2ee-choice input[id$=-confirm]', PASSWORD)
  assert.ok(await click(a, '.sync-folder-actions button', '继续|Continue'))
  step('A: password entered')
  // New workspace → push preview → confirm.
  await waitFor(async () => (await ui(a)).confirm.length > 0, 'A: upload confirmation')
  await shot(a, '03-a-push-preview')
  assert.ok(await click(a, '.sync-plan-preview .settings-action-btn', '.'))
  await waitFor(async () => { const s = await ui(a); return !s.busy && s.badge.length > 0 && !s.preview }, 'A: encrypted + synced', 30000)
  await shot(a, '04-a-encrypted-badge')
  const keysA = await objectNames()
  const workspaceKey = keysA.find((k) => k.endsWith('/.horsemd/encryption.json'))
  assert.ok(workspaceKey, `key file in the cloud: ${keysA.join(', ')}`)
  const prefix = workspaceKey.replace(/\.horsemd\/encryption\.json$/, '')
  const sealed = keysA.filter((k) => k.startsWith(prefix) && k !== workspaceKey)
  assert.ok(sealed.length >= 3, `manifest + 2 files: ${sealed.join(', ')}`)
  for (const key of sealed) {
    assert.match(key.slice(prefix.length), /^o\/[0-9a-f]{64}$/, key)
    const bytes = (await s3.files()).get(key)
    assert.equal(bytes.subarray(0, 4).toString(), 'HMX1')
    for (const word of ['季度机密', 'revenue', '客户名单', '王先生', '13800000000']) assert.ok(!bytes.includes(Buffer.from(word)), `${word} readable in ${key}`)
  }
  for (const word of ['季度机密', '客户名单', '王先生']) assert.ok(!keysA.join('\n').includes(word), `${word} in a cloud name`)
  console.log('  ✓ A: short / mismatched password refused in place; the right one encrypts + pushes; the cloud holds only opaque sealed objects')

  // ---------- B: join with the password ----------
  step('launch B')
  const b = await launch('B', folderB, basePort + 1)
  step('B launched')
  assert.ok(await click(b, '.sync-folder-actions button', '继续|Continue'))
  await waitFor(async () => (await ui(b)).remote.some((t) => /加入已加密/.test(t)), 'B: encrypted cloud workspace listed')
  await shot(b, '05-b-remote-list')
  assert.ok(await click(b, '.sync-remote-choice', '加入已加密'))
  await waitFor(async () => (await ui(b)).joinForm, 'B: password form for the join')
  const markerBefore = await readFile(join(folderB, '.horsemd', 'workspace.json'), 'utf8')
  await type(b, '.sync-e2ee-join input[type=password]', 'not the password')
  assert.ok(await click(b, '.sync-e2ee-join button[type=submit]', '.'))
  await waitFor(async () => (await ui(b)).formErrors.some((t) => /加密密码不对/.test(t)), 'B: wrong password explained', 15000)
  await shot(b, '06-b-wrong-password')
  assert.equal(await readFile(join(folderB, '.horsemd', 'workspace.json'), 'utf8'), markerBefore, 'B: a wrong password changed nothing')
  await type(b, '.sync-e2ee-join input[type=password]', PASSWORD)
  assert.ok(await click(b, '.sync-e2ee-join button[type=submit]', '.'))
  await waitFor(async () => (await ui(b)).confirm.length > 0, 'B: download confirmation', 15000)
  assert.ok(await click(b, '.sync-plan-preview .settings-action-btn', '.'))
  await waitFor(async () => existsSync(join(folderB, SECRET)) && existsSync(join(folderB, '客户名单', '王先生.md')), 'B: files downloaded', 30000)
  assert.equal(await readFile(join(folderB, SECRET), 'utf8'), SECRET_TEXT)
  await waitFor(async () => { const s = await ui(b); return !s.busy && s.badge.length > 0 }, 'B: badge')
  await shot(b, '07-b-joined')
  console.log('  ✓ B: lists the encrypted workspace; a wrong password is refused in place and changes nothing; the right one joins and downloads')

  step('A: change password')
  // ---------- A: change the password ----------
  assert.ok(await click(a, '.sync-e2ee-password-btn', '.'))
  await waitFor(async () => (await ui(a)).change, 'A: change-password form')
  await type(a, '.sync-e2ee-change input[id$=-old]', 'wrong old password')
  await type(a, '.sync-e2ee-change input[id$=-password]', NEW_PASSWORD)
  await type(a, '.sync-e2ee-change input[id$=-confirm]', NEW_PASSWORD)
  assert.ok(await click(a, '.sync-e2ee-change button[type=submit]', '.'))
  await waitFor(async () => (await ui(a)).formErrors.some((t) => /加密密码不对/.test(t)), 'A: wrong old password explained', 15000)
  await shot(a, '08-a-change-wrong-old')
  await type(a, '.sync-e2ee-change input[id$=-old]', PASSWORD)
  assert.ok(await click(a, '.sync-e2ee-change button[type=submit]', '.'))
  await waitFor(async () => !(await ui(a)).change, 'A: form closes after the change', 15000)
  const keyFile = JSON.parse((await s3.files()).get(workspaceKey).toString())
  // B (key unchanged) keeps syncing with no prompt.
  await writeFile(join(folderA, '改密码后.md'), 'after\n')
  const runA = await a.evaluate(`window.api.syncRun(${JSON.stringify(folderA)}, 'merge', { automatic: true })`)
  assert.ok(!runA.needsConfirmation, JSON.stringify(runA))
  const runB = await b.evaluate(`window.api.syncRun(${JSON.stringify(folderB)}, 'merge', { automatic: true })`)
  assert.ok(!runB.needsConfirmation, JSON.stringify(runB))
  assert.equal(await readFile(join(folderB, '改密码后.md'), 'utf8'), 'after\n')
  assert.equal(keyFile.format, 'horsemd-e2ee')
  console.log('  ✓ A: change password (wrong old refused in place); B keeps syncing without a prompt')

  step('key replaced')
  // ---------- another device replaces the key ----------
  const { keyFile: strangerKey } = await createKeyFile(STRANGER, { iterations: 1000 })
  const before = await objectNames()
  await s3.write(workspaceKey, Buffer.from(JSON.stringify(strangerKey)))
  await writeFile(join(folderA, '等待中.md'), 'should wait\n')
  assert.equal(await setAuto(a, true), 'true')
  await a.evaluate('globalThis.__hmAutoSyncTick?.()')
  await waitFor(async () => (await ui(a)).unlock === 'e2ee-key-changed', 'A: automatic sync stops with the password box', 20000)
  assert.deepEqual((await objectNames()).sort(), before.sort(), 'A wrote nothing with a replaced key')
  const stateA = await ui(a)
  assert.match(stateA.unlockTitle, /更换/)
  await shot(a, '09-a-key-changed')
  await type(a, '.sync-e2ee-unlock input[type=password]', PASSWORD)
  assert.ok(await click(a, '.sync-e2ee-unlock button[type=submit]', '.'))
  await waitFor(async () => (await ui(a)).formErrors.some((t) => /加密密码不对/.test(t)), 'A: old password does not open the new key', 15000)
  await type(a, '.sync-e2ee-unlock input[type=password]', STRANGER)
  assert.ok(await click(a, '.sync-e2ee-unlock button[type=submit]', '.'))
  // The new key opens an empty cloud workspace: the usual remote-reset choice.
  await waitFor(async () => { const s = await ui(a); return !s.unlock && s.remoteReset }, 'A: unlocked → the cloud-reset choice', 20000)
  await shot(a, '10-a-after-unlock')
  console.log('  ✓ replaced key: automatic sync stops (e2ee-key-changed) and writes nothing; the old password is refused; the new one unlocks into the cloud-reset choice')
} finally {
  for (const app of apps) await stopBuiltElectron(app).catch(() => {})
  await s3.stop()
  await rm(root, { recursive: true, force: true })
}
console.log('PASS e2ee sync UI: encrypt + push, join with password, change password, replaced key → password box (two app instances, mock S3)')
