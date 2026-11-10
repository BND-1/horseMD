// `$…$` typed in a code block is code, never inline math (fuzz seed 5714).
// editor-inline-math.js remembered a pending `$x$` wherever the caret was
// in a textblock — a code_block is one — and committed it on blur (a
// source-mode switch): the math node split the code block and its later
// lines became a paragraph, which was saved.
import assert from 'node:assert/strict'
import { open, sleep } from './lib/probe-session.mjs'

const s = await open('inline-math-code', '# t\n\n```java\nab\ncd\nef\n```\n\npara\n', 9641)
const blocks = `(() => { const out = []; globalThis.__hmSourceReprintHarness.liveDoc().forEach((n) => { let math = 0; n.descendants((c) => { if (c.type.name === 'math_inline') math += 1 }); out.push(n.type.name + (math ? '+math' : '') + ':' + JSON.stringify(n.textContent)) }); return out })()`
try {
  // `$x$` into the code block's second line, caret inside it, then blur.
  await s.trace(`(() => {
    const view = globalThis.__hmSourceReprintHarness.view()
    let at = null
    view.state.doc.forEach((node, offset) => { if (node.type.name === 'code_block') at = offset + 1 + 'ab\\n'.length })
    let tr = view.state.tr.insertText('$x$', at)
    tr = tr.setSelection(view.state.selection.constructor.near(tr.doc.resolve(at + 2)))
    view.dispatch(tr)
    view.dom.dispatchEvent(new FocusEvent('blur'))
    return true
  })()`)
  await sleep(400)
  assert.deepEqual(JSON.parse(await s.trace(blocks)), ['heading:"t"', 'code_block:"ab\\n$x$cd\\nef"', 'paragraph:"para"'], 'the code block stays whole and holds the text')
  // A real keystroke makes it a user edit, so the source follows.
  await s.clickText('para', 0)
  await s.type('Q')
  await sleep(800)
  const source = await s.source()
  assert.equal(source, '# t\n\n```java\nab\n$x$cd\nef\n```\n\nQpara\n', 'source keeps the code block')
  // Outside code the same text still becomes math on blur.
  await s.trace(`(() => {
    const view = globalThis.__hmSourceReprintHarness.view()
    let at = null
    view.state.doc.forEach((node, offset) => { if (node.type.name === 'paragraph' && node.textContent === 'Qpara') at = offset + 1 })
    let tr = view.state.tr.insertText('$y$', at)
    tr = tr.setSelection(view.state.selection.constructor.near(tr.doc.resolve(at + 2)))
    view.dispatch(tr)
    view.dom.dispatchEvent(new FocusEvent('blur'))
    return true
  })()`)
  await sleep(400)
  const after = JSON.parse(await s.trace(blocks))
  assert.equal(after.filter((block) => block.startsWith('paragraph+math')).length, 1, `inline math outside code still converts: ${JSON.stringify(after)}`)
  console.log('PASS inline math in code: `$…$` in a code block stays code through a blur; outside code it still becomes math')
} finally {
  await s.close()
}
