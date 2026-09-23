import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { captureEditorContextCopy } from '../src/renderer/src/components/editor-context-copy.js'

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' },
  paragraph: { content: 'text*' },
  text: {}
} })
const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('selected text')))
function fixture() {
  const textNode = {}
  const codeRoot = { isConnected: true }
  let browserSelection = null
  let copies = 0
  const transactions = []
  const document = { getSelection: () => browserSelection }
  const view = {
    state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2, 7) }),
    dom: { isConnected: true, ownerDocument: document, contains: node => node === textNode || node === codeRoot },
    isDestroyed: false,
    posAtDOM: (_node, offset) => offset + 1,
    dispatch(transaction) { transactions.push(transaction); this.state = this.state.apply(transaction) },
    focus() {},
  }
  const options = { executeCopy: d => { assert.equal(d, document); copies++; return true } }
  return {
    view, options, textNode, codeRoot, transactions,
    setBrowserSelection: value => { browserSelection = value },
    get copies() { return copies }
  }
}
{
  const f = fixture()
  const action = captureEditorContextCopy(f.view, null, f.options)
  f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(doc, 1)))
  assert.equal(action.copy(), true)
  assert.equal(f.view.state.selection.from, 2)
  assert.equal(f.view.state.selection.to, 7)
  assert.equal(f.view.state.doc, doc)
  assert.ok(f.transactions.every(tr => !tr.docChanged), 'copy must not enter document history')
  assert.equal(f.copies, 1)
}
{
  const f = fixture()
  f.setBrowserSelection({ isCollapsed: false, anchorNode: f.textNode, focusNode: f.textNode, anchorOffset: 9, focusOffset: 2 })
  const action = captureEditorContextCopy(f.view, null, f.options)
  assert.equal(action.copy(), true)
  assert.equal(f.view.state.selection.anchor, 10)
  assert.equal(f.view.state.selection.head, 3)
}
{
  const f = fixture()
  f.view.state = EditorState.create({ schema, doc })
  assert.equal(captureEditorContextCopy(f.view, null, f.options), null)
  f.setBrowserSelection({ isCollapsed: false, anchorNode: {}, focusNode: {} })
  assert.equal(captureEditorContextCopy(f.view, null, f.options), null)
  assert.equal(f.copies, 0)
}
for (const change of [
  f => { f.view.dispatch(f.view.state.tr.insertText('new', 1)) },
  f => { f.view.dom.isConnected = false },
  f => { f.view.isDestroyed = true }
]) {
  const f = fixture()
  const action = captureEditorContextCopy(f.view, null, f.options)
  change(f)
  assert.equal(action.copy(), false, 'stale menu must not copy a different revision')
  assert.equal(f.copies, 0)
}
for (const executeCopy of [() => false, () => { throw new Error('clipboard unavailable') }]) {
  const f = fixture()
  assert.equal(captureEditorContextCopy(f.view, null, { executeCopy }).copy(), false)
  assert.equal(f.view.state.doc, doc)
}
{
  const f = fixture()
  const selection = { ranges: [{ from: 10, to: 40000, empty: false }] }
  const codeDoc = {}
  const codeView = {
    state: { selection, doc: codeDoc },
    dispatch({ selection: next }) { this.state.selection = next },
    focus() {}
  }
  const target = { closest: () => f.codeRoot }
  const options = { ...f.options, findCodeMirror: () => codeView }
  const action = captureEditorContextCopy(f.view, target, options)
  assert.equal(action.kind, 'code')
  codeView.state.selection = { ranges: [{ empty: true }] }
  assert.equal(action.copy(), true)
  assert.equal(codeView.state.selection, selection, 'must use full CodeMirror selection, not rendered lines')
  assert.equal(f.transactions.length, 0, 'code copy must not collapse the ProseMirror caret')
  codeView.state.doc = {}
  assert.equal(action.copy(), false)
  assert.equal(f.copies, 1)
  assert.equal(captureEditorContextCopy(f.view, target, { findCodeMirror() { throw new Error('destroyed') } }), null)
}
console.log('PASS context copy: selection/focus restoration, reversed range, empty/foreign/stale rejection, failure reporting, full CodeMirror selection, no document mutations')
