// 0.13.175 trace (04:03:17) repro + fix verification: a quote's ordered list
// with a NESTED sub-list under the last item; typing in the nested item then
// Enter Enter (exit the nested empty item) must stay warning-free. The exit
// family's raw row resolver cannot map nested rows — it now releases the
// journal to legacy (whose candidate validates) instead of failing closed.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-nested-exit-${process.pid}`
const port = Number(process.env.CDP_PORT || 13600 + (process.pid % 40))
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const key = (k, code) => pressKey(app.send, { key: k, code: code || k, delayMs: 35 })
let app = null
try {
  const dir = join(root, 'd')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 's.md')
  await writeFile(file, '', 'utf8')
  app = await launchBuiltElectron({ profileDir: join(dir, 'p'), port, appArgs: [file, '--horsemd-input-trace'] })
  const waitFor = async (check, msg, n = 80) => {
    for (let i = 0; i < n; i += 1) { const v = await check(); if (v) return v; await sleep(150) }
    throw new Error(msg)
  }
  await waitFor(() => app.evaluate('(() => !![...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent))()'), 'mount')
  await sleep(2500)
  const pt = await app.evaluate('(() => { const e = [...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 90) } })()')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt, button: 'left', clickCount: 1 })
  await sleep(300)
  for (let a = 0; a < 10; a += 1) {
    await typeTextLikeUser(app.send, '测试', { delayMs: 25 })
    await sleep(500)
    if (await app.evaluate('(() => [...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent)?.textContent.includes("测试"))()')) break
  }
  await key('Enter', 'Enter'); await sleep(250)
  // quote via marker in paragraph then list rows via markers (matches user flow)
  await typeTextLikeUser(app.send, '> 啊诶话费', { delayMs: 40 })
  await key('Enter', 'Enter'); await sleep(250)
  await typeTextLikeUser(app.send, '> 1. 阿尔金', { delayMs: 40 })
  await key('Enter', 'Enter'); await sleep(220)
  await typeTextLikeUser(app.send, '> 2. 起来叫', { delayMs: 40 })
  await key('Enter', 'Enter'); await sleep(220)
  await typeTextLikeUser(app.send, '> 3. 阿芬', { delayMs: 40 })
  await key('Enter', 'Enter'); await sleep(220)
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 40 }); await sleep(220)
  await typeTextLikeUser(app.send, '啊额法', { delayMs: 40 })
  await sleep(400)
  await app.evaluate(`(() => {
    const t = window.__hmSourceIntegrityTrace
    if (!Array.isArray(t)) window.__hmSourceIntegrityTrace = []
    else t.length = 0
    document.querySelectorAll('[class*="toast"]').forEach((n) => n.remove())
  })()`)
  // Enter on the nested item (new empty nested item), Enter again to exit it
  await key('Enter', 'Enter'); await sleep(260)
  await key('Enter', 'Enter'); await sleep(1300)
  const dump = await app.evaluate(`(() => ({
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || ''),
    bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-2).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
    text: ([...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent)?.innerText || '').slice(0, 240)
  }))()`)
  console.log(JSON.stringify(dump, null, 1))
  assert.equal(dump.toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(dump.toasts)}`)
  assert.equal(dump.bad.length, 0, `integrity failures: ${JSON.stringify(dump.bad)}`)
  console.log('PASS blockquote nested-list exit: typing + Enter Enter in a quote-nested sub-list stays warning-free')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
