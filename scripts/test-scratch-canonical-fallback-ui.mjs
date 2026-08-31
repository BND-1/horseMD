// 0.13.176 trace (04:32:11) repro + structural fix verification.
// Doc: ordered list with nested item, then bullets with a nested bullet.
// User deletes the SECOND bullet's chars one by one then Backspace-removes
// the emptied item, and flushes (source toggle). The trusted local-mapper
// result previously failed validation at the flush site → sticky warning.
// Structural fix: in generated scratch, any failing publication retries
// once with the serializer canonical (still validated) — no warning.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-scratch-fallback-${process.pid}`
const port = Number(process.env.CDP_PORT || 13640 + (process.pid % 30))
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
    await typeTextLikeUser(app.send, '测试', { delayMs: 25 })
    await sleep(500)
    if (await app.evaluate('(() => [...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent)?.textContent.includes("测试"))()')) break
  }
  const enter = () => pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 35 })
  await enter(); await sleep(250)
  // ordered list with a nested item (matches trace structure)
  await typeTextLikeUser(app.send, '1. 阿里和风景', { delayMs: 40 })
  await enter(); await sleep(220)
  await typeTextLikeUser(app.send, '2. 阿里文化课', { delayMs: 40 })
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 40 }); await sleep(220)
  await typeTextLikeUser(app.send, '案例；飞机色付款', { delayMs: 40 })
  await enter(); await enter(); await sleep(300)
  // bullets with a nested bullet under the second
  await typeTextLikeUser(app.send, '- 老师发', { delayMs: 40 })
  await enter(); await sleep(220)
  await typeTextLikeUser(app.send, '- fn ', { delayMs: 40 })
  await enter(); await sleep(220)
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 40 }); await sleep(220)
  await typeTextLikeUser(app.send, '啊啊俄方', { delayMs: 40 })
  await sleep(500)
  // caret back into "- fn " then char-delete + structural removal
  const clicked = await app.evaluate(`(() => {
    const e = [...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent)
    const ps = [...e.querySelectorAll('p')]
    const target = ps.find((p) => (p.textContent || '').includes('fn'))
    if (!target) {
      window.__fpDebug = ps.map((p) => (p.textContent || '').slice(0, 20))
      return false
    }
    const r = target.getBoundingClientRect()
    window.__fp = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    return true
  })()`)
  if (!clicked) {
    const dbg = await app.evaluate('window.__fpDebug || []')
    console.log('paragraphs:', JSON.stringify(dbg))
  }
  assert.equal(clicked, true, 'fn paragraph not found')
  const fp = await app.evaluate('window.__fp')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...fp, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...fp, button: 'left', clickCount: 1 })
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
  // flush via source toggle (the trace's editor-api-flush trigger)
  assert.equal(await toggleSource(app), true, 'could not toggle source')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not appear')
  await sleep(700)
  const dump = await app.evaluate(`(() => ({
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || ''),
    bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-2).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
    fallback: (window.__hmFlushTrace || []).filter(e => e.phase === 'scratch-canonical-fallback').length
  }))()`)
  console.log(JSON.stringify({ ...dump, sourceHead: source.slice(0, 120) }, null, 1))
  assert.equal(dump.toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(dump.toasts)}`)
  assert.equal(typeof source === 'string' && source.includes('老师发'), true, 'source lost sibling bullet')
  assert.equal(typeof source === 'string' && source.includes('啊啊俄方'), true, 'source lost nested bullet')
  console.log('PASS scratch canonical fallback: char-delete + structural removal + flush stays warning-free with intact content')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
