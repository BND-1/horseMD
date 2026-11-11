// Large documents skip layout for off-screen blocks (content-visibility,
// `.hm-cv`). A caret set without scrolling (a mode switch keeping the
// viewport, a command) at the end of a far-away paragraph that ends with an
// inline html atom (`<img>`): every typed key went to the START of the
// paragraph — Chromium cannot place an insertion in a block it skipped.
// The caret's block is kept laid out (editor-cv-keep.js).
import assert from 'node:assert/strict'
import { open, sleep } from './lib/probe-session.mjs'

const filler = Array.from({ length: 2000 }, (_, i) => `段落 ${i} 一些文字填充用来让文档变长。`).join('\n\n')
const source = `${filler}\n\n# 捐赠\n\n跟踪文档 <img src="alipay.png" style="zoom: 55%;" />\n`
const s = await open('cv-caret', source, 9641)
try {
  await sleep(1500)
  const placed = JSON.parse(await s.trace(`(() => {
    const view = globalThis.__hmSourceReprintHarness.view()
    const last = view.state.doc.lastChild
    const end = view.state.doc.content.size - 1
    view.focus()
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(end), -1)))
    return { scrolled: view.dom.closest('.editor-scroll')?.scrollTop ?? null, cv: Boolean(view.dom.closest('.hm-cv')), offset: view.state.selection.$head.parentOffset, size: last.content.size }
  })()`))
  assert.equal(placed.cv, true, 'large document uses content-visibility')
  assert.equal(placed.offset, placed.size, 'caret at the paragraph end')
  for (const [key, code, keyCode] of [['1', 'Digit1', 49], ['.', 'Period', 190], ['x', 'KeyX', 88]]) {
    const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
    await s.app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await s.app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
    await s.app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(80)
  }
  await sleep(500)
  const text = JSON.parse(await s.trace(`globalThis.__hmSourceReprintHarness.view().state.doc.lastChild.textContent`))
  assert.equal(text, '跟踪文档 1.x', `typed keys land at the caret: ${JSON.stringify(text)}`)
  const markdown = await s.source()
  assert.ok(markdown.endsWith('跟踪文档 <img src="alipay.png" style="zoom: 55%;" />1.x\n'), `source: ${JSON.stringify(markdown.slice(-80))}`)
  console.log('PASS cv caret: in a content-visibility document, keys typed at a programmatic caret after an inline atom land there')
} finally {
  await s.close()
}
