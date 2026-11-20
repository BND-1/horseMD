// HorseMD 同步 in the real app (Settings › 云同步, SyncOfficial.jsx) against
// the real account service + MinIO (lib/account-server.mjs):
//   1. no connection yet: the service list opens with HorseMD 同步 first
//   2. its login: a bad address is refused in place; 发送验证码 → the code
//      (from the dev mailbox) typed into the code field → 登录 → the
//      connection card shows the email and 还没有订阅
//   3. a plan granted on the service: the card shows 标准版 and usage
//   4. the workspace folder → 开启同步: encryption is ON by default for
//      HorseMD 同步; the password twice → the folder syncs; MinIO holds only
//      sealed objects under users/<uid>/
// Screenshots go to HM_OFFICIAL_SHOTS (a folder) when set.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'
import { startAccountServer } from './lib/account-server.mjs'

const PASSWORD = '官方同步-界面-2026'
const EMAIL = 'ui-test@example.com'
const tempBase = process.platform === 'darwin' ? homedir() : tmpdir()
const root = await mkdtemp(join(tempBase, '.horsemd-official-ui-'))
const shots = process.env.HM_OFFICIAL_SHOTS || ''
const step = (label) => process.stderr.write(`  … ${new Date().toISOString().slice(11, 19)} ${label}\n`)
const ok = (line) => console.log(`  ✓ ${line}`)

const account = await startAccountServer(join(root, 'service'))
if (!account) {
  console.log('SKIP official sync UI: minio is not installed')
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}

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

let app = null
const ev = (expression) => app.evaluate(expression)
const shot = async (name) => {
  if (!shots) return
  await mkdir(shots, { recursive: true })
  await sleep(300)
  const image = await app.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(shots, `${name}.png`), Buffer.from(image.data ?? image.result?.data ?? '', 'base64'))
}
const click = (selector, pattern = '') => ev(`(() => {
  const re = new RegExp(${JSON.stringify(pattern)})
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.getBoundingClientRect().width > 0 && !b.disabled && re.test(b.textContent || b.getAttribute('aria-label') || ''))
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  el.click()
  return true
})()`)
async function type(selector, text) {
  const focused = await ev(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    input.scrollIntoView({ block: 'center' })
    input.focus()
    input.select?.()
    return document.activeElement === input
  })()`)
  assert.ok(focused, `input ${selector}`)
  await typeTextLikeUser(app.send, text, { delayMs: 3 })
}
const openCloudSync = () => ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => e && e.getBoundingClientRect().width > 0
  if (!document.querySelector('.settings-nav-item')) {
    ;[...document.querySelectorAll('button')].filter(visible).find((b) => /settings|设置/i.test(b.title || b.textContent || '')).click()
    await sleep(400)
  }
  ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /通用|general/i.test(b.textContent || '')).click()
  await sleep(200)
  ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /云同步|cloud sync/i.test(b.textContent || '')).click()
  await sleep(600)
  return true
})()`)
const text = (selector) => ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.innerText.trim()).join(' | ')`)

try {
  const folder = join(root, '官方同步笔记')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, '机密.md'), '# 机密\n\n只给自己看\n')
  step('starting the app')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port: 29760 + process.pid % 40,
    appArgs: [folder],
    env: { ...process.env, HORSEMD_SYNC_SERVER: account.url }
  })
  await ev(`(async () => { const t0 = Date.now(); while (!document.querySelector('.tabs, .welcome') && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100)) })()`)
  await openCloudSync()

  // 1. the service list, HorseMD 同步 first
  const rows = await waitFor(() => ev(`[...document.querySelectorAll('.sync-provider-gallery .sync-provider-row')].map((r) => r.dataset.provider)`).then((list) => list.length ? list : null), 'service list')
  assert.equal(rows[0], 'horsemd', `HorseMD 同步 first: ${rows.join(', ')}`)
  await shot('1-gallery')
  ok(`no connection yet: the service list opens with HorseMD 同步 first (${rows.length} services)`)

  // 2. login
  assert.ok(await click('.sync-provider-row[data-provider=horsemd]'))
  await waitFor(() => ev(`!!document.querySelector('#synco-email')`), 'login form')
  await type('#synco-email', 'not-an-email')
  assert.ok(await click('[data-synco-send]'))
  await waitFor(async () => /邮箱/.test(await text('.sync-official-login [role=alert]')), 'bad address refused in place')
  await type('#synco-email', EMAIL)
  const before = (await account.codes(EMAIL)).length
  assert.ok(await click('[data-synco-send]'))
  const code = await account.nextCode(EMAIL, before)
  await waitFor(() => ev(`!!document.querySelector('#synco-code')`), 'code field')
  const sentLine = await text('.sync-official-sent')
  assert.match(sentLine, new RegExp(EMAIL.replace('.', '\\.')))
  assert.match(await text('[data-synco-send]'), /\d+ 秒后可重发|Again in/, 'resend waits')
  await shot('2-code')
  await type('#synco-code', code)
  assert.ok(await click('[data-synco-login]'))
  const card = await waitFor(async () => {
    const value = await text('.sync-connection-card.official')
    return /还没有订阅/.test(value) ? value : null
  }, 'logged-in card with 还没有订阅', 30000)
  assert.match(card, new RegExp(EMAIL.replace('.', '\\.')))
  await shot('3-logged-in')
  ok('login: a bad address refused in place; code sent (resend waits); the code typed → logged in; the card shows the email and 还没有订阅')

  // 3. plan
  await account.admin('grant', EMAIL, 'standard', '30')
  await openCloudSync()
  const planCard = await waitFor(async () => {
    const value = await text('.sync-connection-card.official')
    return /标准版/.test(value) ? value : null
  }, 'card with 标准版', 20000)
  assert.match(planCard, /已用 .* \/ 1(\.0)? GB/)
  assert.ok(await ev(`!!document.querySelector('.sync-official-usage')`), 'usage bar')
  await shot('4-plan')
  ok(`plan granted: the card shows 标准版 and its usage (${planCard.replace(/\s+/g, ' ').slice(0, 80)}…)`)

  // 4. the folder, encryption on by default
  await waitFor(() => click('.sync-folder-row button', '开启同步|Enable'), '开启同步')
  const encryptionOn = await waitFor(() => ev(`!!document.querySelector('.sync-e2ee-choice.on')`), 'encryption choice on by default')
  assert.ok(encryptionOn)
  await shot('5-folder-encryption-default')
  await type('.sync-e2ee-choice input[id$=-password]', PASSWORD)
  await type('.sync-e2ee-choice input[id$=-confirm]', PASSWORD)
  await ev(`(() => { const s = document.querySelector('.sync-auto .hm-toggle'); if (s && s.getAttribute('aria-checked') === 'true') s.click() })()`)
  assert.ok(await click('.sync-folder-actions button', '继续|Continue'))
  // The plan preview of a first upload: confirm it.
  await waitFor(() => click('.sync-plan-preview .settings-action-btn', '.'), 'confirm the upload', 30000)
  await waitFor(async () => (await ev(`!!document.querySelector('.sync-e2ee-badge')`)), 'the folder shows 端到端加密', 30000)
  const objects = await waitFor(async () => {
    const names = await account.minio.names()
    return names.length >= 3 ? names : null
  }, 'objects in MinIO', 30000)
  const uid = await ev(`(async () => (await window.api.syncListConnections()).find((c) => c.type === 'horsemd')?.userId)()`)
  assert.ok(objects.every((key) => key.startsWith(`users/${uid}/`)), objects.join(', '))
  const raw = await account.minio.files()
  for (const [key, bytes] of raw) {
    if (key.endsWith('encryption.json') || key.endsWith('/')) continue
    assert.ok(!/机密|只给自己看/.test(key + bytes.toString('utf8')), `sealed: ${key}`)
  }
  await shot('6-synced')
  ok(`the folder: encryption on by default, the password twice → synced; MinIO holds ${objects.length} objects under users/<uid>/, none readable`)
  console.log('PASS official sync UI')
} catch (error) {
  await shot('failure').catch(() => {})
  console.error(account.log().slice(-2000))
  throw error
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await account.stop()
  if (!process.env.HM_KEEP) await rm(root, { recursive: true, force: true })
}
