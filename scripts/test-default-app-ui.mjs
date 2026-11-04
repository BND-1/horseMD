// 默认打开方式 (#170), Settings › 通用: the row says which app opens .md,
// 「设为默认」 asks main (here a stand-in state file, HORSEMD_TEST_DEFAULT_APP —
// the real macOS / Windows dialogs need a person) and the row follows; an
// unpackaged run without the stand-in hides the row (it would make
// node_modules' Electron the default).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await mkdtemp(join(tmpdir(), 'horsemd-default-app-'))
const stateFile = join(root, 'default-app.json')
const port = 29830 + process.pid % 50
let app = null

const openGeneral = () => app.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => e && e.getBoundingClientRect().width > 0
  const t0 = Date.now()
  while (!document.querySelector('.tabs, .welcome') && Date.now() - t0 < 15000) await sleep(100)
  ;[...document.querySelectorAll('button')].filter(visible).find((b) => /settings|设置/i.test(b.title || b.textContent || '')).click()
  await sleep(400)
  ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /general|通用/i.test(b.textContent || '')).click()
  await sleep(800)
  return true
})()`)
const row = () => app.evaluate(`(() => {
  const r = document.querySelector('.hm-default-app')
  return r && {
    status: r.querySelector('[data-default-app-status]').dataset.defaultAppStatus,
    desc: r.querySelector('.settings-row-desc').textContent,
    button: r.querySelector('[data-default-app-set]').textContent.trim(),
    disabled: r.querySelector('[data-default-app-set]').disabled,
    toasts: [...document.querySelectorAll('.hm-toast-msg')].map((n) => n.textContent)
  }
})()`)

try {
  // 1. Unpackaged, no stand-in: no row. (An installed app, HM_TEST_APP_EXE,
  // is packaged: the row shows there and reads the real system.)
  if (!process.env.HM_TEST_APP_EXE) {
    app = await launchBuiltElectron({ profileDir: join(root, 'p1'), port, appArgs: ['--horsemd-input-trace'] })
    await openGeneral()
    await sleep(800)
    assert.equal(await row(), null, 'the row shows in an unpackaged run')
    await stopBuiltElectron(app, { removeProfile: true })
  }

  // 2. Another app is the default → named; 设为默认 → HorseMD.
  await writeFile(stateFile, JSON.stringify({ isDefault: false, current: 'Typora' }))
  app = await launchBuiltElectron({
    profileDir: join(root, 'p2'), port, appArgs: ['--horsemd-input-trace'],
    env: { ...process.env, HORSEMD_TEST_DEFAULT_APP: stateFile }
  })
  await openGeneral()
  let r = null
  for (let i = 0; i < 50 && !r; i++) { r = await row(); if (!r) await sleep(100) }
  assert.ok(r, 'no default-app row')
  assert.equal(r.status, 'other')
  assert.match(r.desc, /现在双击 \.md 文件会用「Typora」打开/)
  assert.equal(r.button, '设为默认')
  assert.equal(r.disabled, false)
  await app.evaluate("document.querySelector('[data-default-app-set]').click()")
  for (let i = 0; i < 50; i++) { r = await row(); if (r?.status === 'default') break; await sleep(100) }
  assert.equal(r.status, 'default')
  assert.match(r.desc, /双击 \.md 文件会用 HorseMD 打开/)
  assert.equal(r.button, '已是默认')
  assert.equal(r.disabled, true)
  assert.ok(r.toasts.some((m) => /已把 HorseMD 设为 \.md 文件的默认打开方式/.test(m)), `no confirmation toast: ${r.toasts}`)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { isDefault: true, current: '' })

  // 3. Changed elsewhere (system settings) → read again on focus.
  await writeFile(stateFile, JSON.stringify({ isDefault: false, current: 'Visual Studio Code' }))
  await app.evaluate("window.dispatchEvent(new Event('focus'))")
  for (let i = 0; i < 50; i++) { r = await row(); if (r?.status === 'other') break; await sleep(100) }
  assert.match(r.desc, /「Visual Studio Code」/)

  console.log(`PASS default app UI${process.env.HM_TEST_APP_EXE ? ' (installed app)' : ': hidden unpackaged'}; names the current app, 设为默认 → 已是默认 + toast, re-read on focus`)
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
