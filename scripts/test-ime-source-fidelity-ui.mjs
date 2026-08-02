// Reproduce the IME-composition source-corruption bug. Real Chinese input goes
// through compositionstart → compositionupdate (pinyin candidates) →
// compositionend (committed CJK). Milkdown's markdownUpdated can fire DURING
// composition (the doc transiently holds pinyin), and the source-preservation
// path captured that pinyin — turning "测试" into fragments like "c", "ce", "s".
//
// insertText bypasses composition (so earlier CJK CDP tests missed this). This
// test drives a REAL composition lifecycle via Input.imeSetComposition, the way
// the handoff demands ("中文逐字提交不能代替真实 IME composition").
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-ime-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 9900)
// Cadence of the composition lifecycle (ms). Humans vary; sweep a couple.
const step = Number(process.env.IME_STEP || 60)

const expected = ['# 测试', '', '测试', '', '1. 测试', '2. 测试', '   1. 测试', ''].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) { const r = await check(); if (r) return r; await sleep(100) }
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

// Drive a real IME composition MORE faithfully: a real pinyin IME fires a raw
// keydown for each latin letter (the first one with isComposing=false, BEFORE
// compositionstart), THEN advances the composition candidate. Pure imeSetComposition
// skips those keydowns, which is why it never reproduced the bug. Interleave them.
let compId = 1
async function imeType(send, pinyin, cjk) {
  const replacementId = `comp-${compId++}`
  for (let i = 0; i < pinyin.length; i += 1) {
    const ch = pinyin[i]
    const code = ch.charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    const text = pinyin.slice(0, i + 1)
    await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length, replacementId, location: 0 })
    await sleep(step)
  }
  await sleep(step)
  await send('Input.insertText', { text: cjk }) // commit → compositionend
  await sleep(step)
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
    await imeType(send, 'ceshi', '测试')
    await sleep(120)
    await clickBlock(evaluate, send, 'p')
    await imeType(send, 'ceshi', '测试')
    await sleep(120)

    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: step })
    await rawKey(send, '1', 'Digit1', 49); await sleep(step)
    await rawKey(send, '.', 'Period', 190); await sleep(step)
    await rawKey(send, ' ', 'Space', 32); await sleep(step)
    await imeType(send, 'ceshi', '测试')
    await sleep(step)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: step })
    await imeType(send, 'ceshi', '测试')
    await sleep(step)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: step })
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: step })
    await imeType(send, 'ceshi', '测试')
    await sleep(500)

    await waitFor(() => toggleSource(evaluate), 'could not open source mode', 60)
    await sleep(400)
    const src = await waitFor(() => textareaValue(evaluate), 'source textarea did not open')
    console.log('--- IME_STEP=' + step + ' ---')
    console.log('SOURCE:'); console.log(src)
    console.log('EXPECTED:'); console.log(expected)
    const ok = src.replace(/\n+$/, '\n') === expected.replace(/\n+$/, '\n')
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL (IME composition corrupted the source)')
    return ok
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    try { await rm(root, { recursive: true, force: true }) } catch {}
  }
}
run().then((ok) => { process.exit(ok ? 0 : 1) }).catch((e) => { console.error(e); process.exit(1) })
