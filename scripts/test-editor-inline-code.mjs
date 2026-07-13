import assert from 'node:assert/strict'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import {
  createInlineCodeEditingPlugin,
  inlineCodeMarkBefore
} from '../src/renderer/src/components/editor-inline-code.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  },
  marks: {
    inlineCode: { inclusive: false }
  }
})

const paragraph = (...children) => schema.node('paragraph', null, children)
const code = schema.marks.inlineCode.create()
const plugin = createInlineCodeEditingPlugin()

function mockView(state) {
  return {
    state,
    dom: { contains: () => true },
    focus() {},
    dispatch(tr) {
      this.state = this.state.apply(tr)
    }
  }
}

// A second consecutive backtick turns an empty pair into an active inline-code
// insertion point. Text stays marked until a final backtick exits the mark.
let state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [paragraph(schema.text('`'))]),
  selection: TextSelection.create(schema.node('doc', null, [paragraph(schema.text('`'))]), 2),
  plugins: [plugin]
})
let view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 2, 2, '`'), true)
assert.equal(view.state.doc.textContent, '')
assert.equal(plugin.props.handleTextInput(view, 1, 1, 'ab'), true)
assert.equal(view.state.doc.textContent, 'ab')
assert.ok(code.type.isInSet(view.state.doc.firstChild.firstChild.marks))
assert.equal(plugin.props.handleTextInput(view, 3, 3, '`'), true)
assert.equal(plugin.props.handleTextInput(view, 3, 3, 'x'), false)
view.dispatch(view.state.tr.insertText('x'))
assert.equal(view.state.doc.textContent, 'abx')
assert.equal(view.state.doc.firstChild.child(1).marks.length, 0)

// Clicking the rendered trailing edge enters the mark at the same document
// position, so appending does not require changing the non-inclusive schema.
const boundaryDoc = schema.node('doc', null, [
  paragraph(schema.text('ab', [code]), schema.text(' tail'))
])
state = EditorState.create({
  schema,
  doc: boundaryDoc,
  selection: TextSelection.create(boundaryDoc, 3),
  plugins: [plugin]
})
assert.ok(inlineCodeMarkBefore(state, 3))
view = mockView(state)
const codeElement = {}
assert.equal(plugin.props.handleClick(view, 3, {
  target: { closest: (selector) => selector === 'code' ? codeElement : null }
}), true)
assert.equal(plugin.props.handleTextInput(view, 3, 3, 'c'), true)
assert.equal(view.state.doc.textContent, 'abc tail')
assert.equal(view.state.doc.firstChild.firstChild.text, 'abc')
assert.ok(code.type.isInSet(view.state.doc.firstChild.firstChild.marks))

// A lone opening backtick still belongs to Milkdown's existing Markdown input
// rule; this plugin only intercepts the empty-pair and marked-boundary cases.
const plainDoc = schema.node('doc', null, [paragraph(schema.text('text'))])
state = EditorState.create({ schema, doc: plainDoc, plugins: [plugin] })
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 5, 5, '`'), false)

console.log('PASS inline code: pair entry, boundary append, explicit exit')
