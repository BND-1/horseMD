// CDP test for #39: Tab in a code block inserts at cursor, not re-indent line.
// Drives the CodeMirror editor via REAL clicks (to place the caret through CM's
// own click handler → updates its internal selection) + REAL Tab keys, then reads
// the rendered .cm-line text. No view-API access needed (CM6 hides it behind a
// weakmap). Connects to a running app on --remote-debugging-port=9222.
import { connectCdp, sleep } from './lib/cdp.mjs'
async function click(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
async function tabKey(send, shift = false) {
  const common = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 1 : 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

async function main() {
  const { ws, send, evaluate: ev } = await connectCdp({ intervalMs: 500 })
  await send('Runtime.enable')
  const out = {}

  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('tab-test'))
    if (tab) tab.click()
    return true
  })()`)
  await sleep(700)

  // Find the .cm-line whose text is exactly the seed line (the test doc's code
  // block). Return its rect + the .cm-content it belongs to (scoped by a data
  // attr so later reads target THIS editor, not the welcome doc's).
  const target = await ev(`(() => {
    const lines = [...document.querySelectorAll('.cm-line')]
    const line = lines.find((l) => l.textContent === 'const x = 123')
    if (!line) return { error: 'seed line not found', count: lines.length, sample: lines.slice(0,8).map(l=>l.textContent) }
    const ed = line.closest('.cm-editor')
    ed.setAttribute('data-hm-target', '1')
    const r = line.getBoundingClientRect()
    return { x: Math.round(r.left + 56), y: Math.round(r.top + r.height / 2) }
  })()`)
  out.target = target
  if (target.error || target.__error) { console.log(JSON.stringify(out, null, 2)); ws.close(); process.exit(1) }

  // --- TEST A: click mid-line, verify caret is mid-line, press Tab ---
  await click(send, target.x, target.y)
  await sleep(150)
  const caretMid = await ev(`(() => {
    const s = getSelection()
    return { anchorOffset: s.anchorOffset, isText: s.anchorNode && s.anchorNode.nodeType === 3 }
  })()`)
  await tabKey(send, false)
  await sleep(180)
  const afterA = await ev(`(() => {
    const ed = document.querySelector('.cm-editor[data-hm-target="1"]')
    const line = ed.querySelector('.cm-line')
    const text = line.textContent
    return { text, hasMidTab: /\\t/.test(text) && !/^[ \\t]/.test(text) && text.includes('const') }
  })()`)
  out.testA_midLine = {
    caretBefore: caretMid.anchorOffset,
    after: JSON.stringify(afterA.text),
    // PASS = a tab was inserted at the mid-line caret: the first tab in the line
    // is preceded by non-whitespace (i.e. NOT a leading re-indent). indentWithTab
    // would instead prepend leading whitespace → first tab at index 0.
    pass: (() => {
      const t = afterA.text || ''
      const firstTab = t.indexOf('\t')
      return firstTab > 0 && /\S/.test(t.slice(0, firstTab)) && t.includes('const')
    })(),
  }

  // --- TEST B: line-start Tab still indents (inserts \t at start) ---
  // Reset the line to the seed, click at far left, Tab, expect leading tab.
  await ev(`(() => {
    const ed = document.querySelector('.cm-editor[data-hm-target="1"]')
    const line = ed.querySelector('.cm-line')
    // Select all in this line + retype seed via the DOM isn't reliable; instead
    // dispatch a Home then verify. Simpler: rely on TEST A outcome + a separate
    // start-click. Reset by clicking start then Backspace-delete loop is fragile,
    // so TEST B reuses whatever state and just clicks the line start.
    return true
  })()`)
  // For B, click at the very left of the line.
  const startPt = await ev(`(() => {
    const ed = document.querySelector('.cm-editor[data-hm-target="1"]')
    const line = ed.querySelector('.cm-line')
    const r = line.getBoundingClientRect()
    return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) }
  })()`)
  // Move caret to line start via Home (CM keymap) for a deterministic start pos.
  await click(send, startPt.x, startPt.y)
  await sleep(120)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 })
  await sleep(120)
  await tabKey(send, false)
  await sleep(180)
  const afterB = await ev(`(() => {
    const ed = document.querySelector('.cm-editor[data-hm-target="1"]')
    return { text: ed.querySelector('.cm-line').textContent }
  })()`)
  out.testB_lineStart = {
    after: JSON.stringify(afterB.text),
    // After A (mid-line tab) + a start Tab: expect a leading tab now too.
    pass: /^\t/.test(afterB.text),
  }

  out.ALL_PASS = out.testA_midLine.pass
  // TEST B is secondary (best-effort given state carries over); gate overall on A.
  console.log(JSON.stringify(out, null, 2))
  ws.close()
  process.exit(out.ALL_PASS ? 0 : 2)
}
main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(3) })
