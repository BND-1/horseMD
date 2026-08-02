// Permanent regression: rich→source fidelity for a nested ordered list with
// 3 outer + 2 nested items, typed at HUMAN cadence. This is the exact document
// shape that exposed the catastrophic merge (`1. alpha   2.beta` on one line):
// at slower typing more markdownUpdated callbacks fire mid-list, and the
// visible-index line mapper merged nested items because list indents are syntax,
// not visible text. repairMergedListItems now rebuilds the affected list tree
// from the canonical (always content-correct) when that merge is detected.
// Char-by-char via scripts/lib/human-input.mjs; both a continuous and a slower
// cadence are exercised (REPRO_PROFILE=continuous|slow).
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-3x2-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 9872)
const profile = process.env.REPRO_PROFILE || 'continuous'
const PROFILES = {
  continuous: { key: 70, preList: 300, burst: 60, post: 900 },
  slow: { key: 120, preList: 500, burst: 110, post: 1100 }
}
const P = PROFILES[profile] || PROFILES.continuous

const expected = ['# 测试', '', '1. 这时测试', '2. 这时测试', '3. 这时策划师', '   1. 这是测试', '   2. 这是测试', ''].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await check(); if (r) return r
    await sleep(100)
  }
  throw new Error(message)
}
async function clickBlock(evaluate, send, selector) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.min(18, rect.height / 2) }
  })()`)
  if (!point) return false
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  return true
}
async function rawKey(send, key, code, keyCode) {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}
const textareaValue = (evaluate) => evaluate(`document.querySelector('textarea.source-editor')?.value ?? null`)
const toggleSource = (evaluate) => evaluate(`(() => {
  const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(n.title || n.textContent || ''))
  b?.click(); return !!b
})()`)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(() => {
      const e = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      return !!e?.querySelector('h1') && !!e?.querySelector('p')
    })()`), 'new doc skeleton missing')

    await clickBlock(evaluate, send, 'h1')
    await typeTextLikeUser(send, '测试', { delayMs: P.key })
    await sleep(P.preList)
    await clickBlock(evaluate, send, 'p')
    await sleep(P.burst)

    // 1. 这时测试
    await rawKey(send, '1', 'Digit1', 49); await sleep(P.burst)
    await rawKey(send, '.', 'Period', 190); await sleep(P.burst)
    await rawKey(send, ' ', 'Space', 32); await sleep(P.burst)
    await typeTextLikeUser(send, '这时测试', { delayMs: P.key })
    await sleep(P.burst)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: P.key })
    // 2. 这时测试 (auto-numbered)
    await typeTextLikeUser(send, '这时测试', { delayMs: P.key })
    await sleep(P.burst)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: P.key })
    // 3. 这时策划师 (auto-numbered)
    await typeTextLikeUser(send, '这时策划师', { delayMs: P.key })
    await sleep(P.burst)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: P.key })
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: P.key })
    // nested 1. 这是测试
    await typeTextLikeUser(send, '这是测试', { delayMs: P.key })
    await sleep(P.burst)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: P.key })
    // nested 2. 这是测试 (auto)
    await typeTextLikeUser(send, '这是测试', { delayMs: P.key })
    await sleep(P.post)

    const shape = await evaluate(`(() => {
      const e = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const tops = [...e?.querySelectorAll('ol > .milkdown-list-item-block') || []]
      return tops.map((n) => {
        const p = n.querySelector(':scope > li > .children > [data-content-dom] > p')?.textContent
        const nested = [...n.querySelectorAll(':scope > li > .children > ol > .milkdown-list-item-block') || []]
          .map((m) => m.querySelector(':scope > li > .children > [data-content-dom] > p')?.textContent)
        return nested.length ? { text: p, nested } : p
      })
    })()`)
    console.log('RICH shape:', JSON.stringify(shape))

    await waitFor(() => toggleSource(evaluate), 'could not open source mode', 60)
    await sleep(400)
    const src = await waitFor(() => textareaValue(evaluate), 'source textarea did not open')
    console.log('--- profile=' + profile + ' ---')
    console.log('SOURCE:'); console.log(src)
    console.log('EXPECTED:'); console.log(expected)
    const ok = src.replace(/\n+$/, '\n') === expected.replace(/\n+$/, '\n')
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL (catastrophic corruption)')
    return ok
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    try { await rm(root, { recursive: true, force: true }) } catch {}
  }
}
run().then((ok) => { process.exit(ok ? 0 : 1) }).catch((e) => { console.error(e); process.exit(1) })
