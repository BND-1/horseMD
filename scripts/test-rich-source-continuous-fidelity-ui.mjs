// Regression: rich→source source fidelity under CONTINUOUS (deferred-callback)
// typing. The sibling test-new-document-list-source-preservation-ui.mjs settles
// ~500ms between every list step, which consumes the input-rule intent each time
// and hides the bug. This test types the list section (marker → Enter → item →
// Enter → Tab → nested item) in one continuous burst, the way a real human does,
// so Milkdown's deferred markdownUpdated batches multiple transactions into one
// callback while the captured input-rule intent is still pending. The rebuilt
// list must still serialize COMPACT (no spurious blank line before the nested
// item) and must never lose the heading/body/outer list.
//
// Background-mode, char-by-char via scripts/lib/human-input.mjs. Never paste.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rich-source-continuous-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 9850)

const expected = ['# 测试文本', '', '这shi', '', '1. 第一项', '2. 第二项', '   1. 嵌套项', '', ''].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function clickBlock(evaluate, send, selector) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
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
    await typeTextLikeUser(send, '测试文本', { delayMs: 60 })
    await sleep(250)
    await clickBlock(evaluate, send, 'p')
    await typeTextLikeUser(send, '这shi', { delayMs: 60 })
    await sleep(250)

    // Continuous list burst: NO big settle between marker, Enter, item, Tab, nested.
    // 50ms = fast but real typing (0ms drops events and breaks the rich editor).
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await rawKey(send, '1', 'Digit1', 49); await sleep(50)
    await rawKey(send, '.', 'Period', 190); await sleep(50)
    await rawKey(send, ' ', 'Space', 32); await sleep(50)
    await typeTextLikeUser(send, '第一项', { delayMs: 60 })
    await sleep(50)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await typeTextLikeUser(send, '第二项', { delayMs: 60 })
    await sleep(50)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: 60 })
    await typeTextLikeUser(send, '嵌套项', { delayMs: 60 })
    await sleep(800) // let the deferred markdownUpdated callback fire

    const shape = await evaluate(`(() => {
      const e = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      return [...e?.querySelectorAll('ol > .milkdown-list-item-block') || []]
        .map((n) => n.querySelector(':scope > li > .children > [data-content-dom] > p')?.textContent)
    })()`)
    assert.deepEqual(shape, ['第一项', '第二项', '嵌套项'], 'rich nested ordered list was not created intact')

    // rich → source: source must equal the compact expected markdown.
    await waitFor(() => toggleSource(evaluate), 'could not open source mode', 60)
    await sleep(300)
    let src = await waitFor(() => textareaValue(evaluate), 'source textarea did not open')
    assert.equal(src, expected, 'rich→source corrupted or loosened the nested ordered list')

    // rich → source → rich → source: a second no-edit round-trip must stay stable
    // (proves the first switch didn't leave a stale rich baseline behind).
    await waitFor(() => toggleSource(evaluate), 'could not return to rich mode', 60)
    await sleep(300)
    await waitFor(() => toggleSource(evaluate), 'could not reopen source mode', 60)
    await sleep(300)
    src = await waitFor(() => textareaValue(evaluate), 'source textarea did not reopen')
    assert.equal(src, expected, 'rich→source→rich→source drifted from the expected markdown')

    console.log('PASS rich-source-continuous-fidelity: nested ordered list survives continuous typing + compact source + round-trip')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    try { await rm(root, { recursive: true, force: true }) } catch {}
  }
}

run().catch((error) => { console.error(error); process.exit(1) })
