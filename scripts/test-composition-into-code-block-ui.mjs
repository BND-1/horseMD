// An IME composition that starts in the text and ends in a CodeMirror code
// block (a quote holding a code block selected — after a block drag + undo —
// then Chinese typed: the first candidate moves the selection into the code
// block and CodeMirror takes focus). The compositionend went to CodeMirror and
// ProseMirror stayed "composing": every later edit, back in the text too, was
// held as candidate text, never reached the source, and a save wrote the old
// file (fuzz seed 5964). editor-composition-end.js ends it.
import assert from 'node:assert/strict'
import { open, sleep } from './lib/probe-session.mjs'

const source = '# 标题\n\n正文第一段。\n\n> ```\n> class A {\n> }\n> ```\n>\n> 引用 quote line\n\n最后一段 final paragraph.\n'
const s = await open('composition-code-block', source, 9647)
const state = async () => JSON.parse(await s.trace(`(() => {
  const h = globalThis.__hmSourceReprintHarness
  const v = h.view()
  return { composing: v.composing, inCode: Boolean(document.activeElement?.closest?.('.cm-editor')), source: h.liveSource() }
})()`))
try {
  await sleep(1000)
  const selected = JSON.parse(await s.trace(`(() => {
    const v = globalThis.__hmSourceReprintHarness.view()
    let pos = null
    v.state.doc.forEach((node, offset) => { if (pos == null && node.type.name === 'blockquote' && node.firstChild?.type.name === 'code_block') pos = offset })
    const Selection = Object.getPrototypeOf(v.state.selection.constructor)
    v.focus()
    v.dispatch(v.state.tr.setSelection(Selection.fromJSON(v.state.doc, { type: 'node', anchor: pos })))
    return v.state.selection.toJSON()
  })()`))
  assert.equal(selected.type, 'node', 'the quote is selected')
  await s.ime('保存')
  await sleep(600)
  const typed = await state()
  assert.equal(typed.inCode, true, 'the composition moved into the code block')
  assert.equal(typed.composing, false, 'ProseMirror is not left composing after the composition ended in CodeMirror')
  await s.clickText('最后一段', 4)
  await s.type('Z')
  await sleep(1200)
  const after = await state()
  assert.equal(after.composing, false)
  assert.ok(after.source.includes('保存'), `the code block text reached the source: ${JSON.stringify(after.source)}`)
  assert.ok(after.source.includes('最后一段Z'), `text typed afterwards reached the source: ${JSON.stringify(after.source)}`)
  const markdown = await s.source()
  assert.equal(markdown, after.source, 'source view shows the synced source')
  console.log('PASS composition into a code block: ProseMirror ends the composition, later edits reach the source')
} finally {
  await s.close()
}
