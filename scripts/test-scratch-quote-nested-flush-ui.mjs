// 0.13.177 trace (04:46:23) repro: quote containing an ordered list with a
// nested sub-list; user deletes the last quote-list item's chars one by one,
// then the structural removal, then flushes (source toggle). The scratch
// flush's marker-preserving transform produced stray `>` lines that failed
// validation; the canonical fallback must now use the RAW canonical and stay
// warning-free.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-quote-nested-flush-${process.pid}`
const port = Number(process.env.CDP_PORT || 13660 + (process.pid % 25))
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

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
    await typeTextLikeUser(app.send, 'v', { delayMs: 25 })
    await sleep(500)
    if (await app.evaluate('(() => [...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent)?.textContent.includes("v"))()')) break
  }
  const enter = () => pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 35 })
  const tab = () => pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 40 })
  await enter(); await sleep(250)
  // top-level ordered list with a nested item
  await typeTextLikeUser(app.send, '1. 法卡', { delayMs: 40 })
  await enter(); await sleep(220)
  await typeTextLikeUser(app.send, '2. u户；', { delayMs: 40 })
  await enter(); await sleep(220)
  await tab(); await sleep(200)
  await typeTextLikeUser(app.send, '啊俄方好', { delayMs: 40 })
  await enter(); await enter(); await sleep(280)
  await typeTextLikeUser(app.send, '啊看了返回', { delayMs: 40 })
  await enter(); await enter(); await sleep(300)
  // quote with an ordered list + nested item
  await typeTextLikeUser(app.send, '> 爱返回', { delayMs: 40 })
  await enter(); await sleep(240)
  await typeTextLikeUser(app.send, '> 1. 阿芬', { delayMs: 40 })
  await enter(); await sleep(220)
  await typeTextLikeUser(app.send, '> 2. 区分', { delayMs: 40 })
  await enter(); await sleep(220)
  await tab(); await sleep(200)
  await typeTextLikeUser(app.send, '阿芬', { delayMs: 40 })
  await sleep(500)
  // caret into the quote item "区分" then delete its chars + structural removal
  const clicked = await app.evaluate(`(() => {
    const e = [...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent)
    const ps = [...e.querySelectorAll('blockquote p')]
    const target = ps.find((p) => (p.textContent || '').includes('区分'))
    if (!target) { window.__dbg = ps.map((p) => (p.textContent || '').slice(0, 15)); return false }
    const r = target.getBoundingClientRect()
    window.__qp = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    return true
  })()`)
  if (!clicked) {
    const dbg = await app.evaluate('window.__dbg || []')
    console.log('quote paragraphs:', JSON.stringify(dbg))
    throw new Error('quote item 区分 not found')
  }
  const qp = await app.evaluate('window.__qp')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...qp, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...qp, button: 'left', clickCount: 1 })
  await sleep(300)
  await app.evaluate(`(() => {
    const t = window.__hmSourceIntegrityTrace
    if (!Array.isArray(t)) window.__hmSourceIntegrityTrace = []
    else t.length = 0
    document.querySelectorAll('[class*="toast"]').forEach((n) => n.remove())
  })()`)
  for (let i = 0; i < 4; i += 1) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 150 })
    await sleep(130)
  }
  await sleep(600)
  // flush via source toggle — the trace's failing site
  assert.equal(await toggleSource(app), true, 'could not toggle source')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not appear')
  await sleep(800)
  const dump = await app.evaluate(`(() => ({
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || ''),
    bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-2).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
    fallback: (window.__hmFlushTrace || []).filter(e => e.phase === 'scratch-canonical-fallback').length
  }))()`)
  console.log(JSON.stringify({ ...dump, sourceHead: source.slice(0, 160) }, null, 1))
  assert.equal(dump.toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(dump.toasts)}`)
  assert.equal(typeof source === 'string' && source.includes('爱返回'), true, 'source lost quote')
  assert.equal(typeof source === 'string' && source.includes('阿芬'), true, 'source lost quote list item')
  console.log('PASS scratch quote-nested flush: quote-list char-delete + structural removal + flush stays warning-free')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
