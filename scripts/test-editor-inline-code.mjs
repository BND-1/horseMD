import assert from 'node:assert/strict'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import {
  createInlineCodeEditingPlugin,
  inlineCodeMarkBefore,
  inlineCodeRangeAtSelection
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

// Standard Markdown input must work through the same one-key-at-a-time path as
// a real keyboard: one opener, ordinary characters, then one closer.
let state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [paragraph()]),
  plugins: [plugin]
})
let view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 1, 1, '`'), true)
assert.equal(view.state.doc.textContent, '`')
for (const character of 'awdawdwa') {
  const position = view.state.selection.from
  assert.equal(plugin.props.handleTextInput(view, position, position, character), true)
}
assert.equal(view.state.doc.textContent, 'awdawdwa')
assert.ok(code.type.isInSet(view.state.doc.firstChild.firstChild.marks))
assert.deepEqual(inlineCodeRangeAtSelection(view.state), { from: 1, to: 9 })
assert.equal(plugin.props.decorations(view.state).find().length, 2)
assert.equal(plugin.props.handleKeyDown(view, {
  key: 'ArrowRight',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}), true)
assert.equal(plugin.props.decorations(view.state), null)
assert.equal(plugin.props.handleTextInput(view, 9, 9, 'x'), false)
view.dispatch(view.state.tr.insertText('x'))
assert.equal(view.state.doc.textContent, 'awdawdwax')
assert.equal(view.state.doc.firstChild.firstChild.text, 'awdawdwa')
assert.ok(code.type.isInSet(view.state.doc.firstChild.firstChild.marks))
assert.equal(view.state.doc.firstChild.child(1).text, 'x')
assert.equal(view.state.doc.firstChild.child(1).marks.length, 0)

// The symmetric left-boundary action exits before the code without moving
// over or deleting the first code character.
const leftBoundaryDoc = schema.node('doc', null, [
  paragraph(schema.text('ab', [code]))
])
state = EditorState.create({
  schema,
  doc: leftBoundaryDoc,
  selection: TextSelection.create(leftBoundaryDoc, 1),
  plugins: [plugin]
})
view = mockView(state)
assert.equal(plugin.props.handleKeyDown(view, {
  key: 'ArrowLeft',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}), true)
assert.equal(plugin.props.handleTextInput(view, 1, 1, 'x'), false)
view.dispatch(view.state.tr.insertText('x'))
assert.equal(view.state.doc.textContent, 'xab')
assert.equal(view.state.doc.firstChild.firstChild.text, 'x')
assert.equal(view.state.doc.firstChild.firstChild.marks.length, 0)
assert.equal(view.state.doc.firstChild.child(1).text, 'ab')
assert.ok(code.type.isInSet(view.state.doc.firstChild.child(1).marks))

// Arrow keys inside the mark and modified navigation remain native.
state = EditorState.create({
  schema,
  doc: leftBoundaryDoc,
  selection: TextSelection.create(leftBoundaryDoc, 2),
  plugins: [plugin]
})
view = mockView(state)
assert.equal(plugin.props.handleKeyDown(view, {
  key: 'ArrowRight',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}), false)
assert.equal(plugin.props.handleKeyDown(view, {
  key: 'ArrowRight',
  altKey: false,
  ctrlKey: false,
  metaKey: true,
  shiftKey: false
}), false)

// Two consecutive backticks stay literal until the next ordinary character.
// This preserves manual `` and ``` input, while text after an empty pair enters
// inline code without the user needing to place the caret again.
state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [paragraph(schema.text('`'))]),
  selection: TextSelection.create(schema.node('doc', null, [paragraph(schema.text('`'))]), 2),
  plugins: [plugin]
})
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 2, 2, '`'), true)
assert.equal(view.state.doc.textContent, '``')
assert.equal(plugin.props.handleTextInput(view, 3, 3, '`'), true)
assert.equal(view.state.doc.textContent, '```')

state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [paragraph(schema.text('``'))]),
  selection: TextSelection.create(schema.node('doc', null, [paragraph(schema.text('``'))]), 3),
  plugins: [plugin]
})
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 3, 3, 'ab'), true)
assert.equal(view.state.doc.textContent, 'ab')
assert.ok(code.type.isInSet(view.state.doc.firstChild.firstChild.marks))
assert.deepEqual(inlineCodeRangeAtSelection(view.state), { from: 1, to: 3 })
assert.equal(plugin.props.decorations(view.state).find().length, 2)
assert.equal(plugin.props.handleTextInput(view, 3, 3, '`'), true)
assert.equal(plugin.props.decorations(view.state), null)
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

// A lone opening backtick is inserted literally by this plugin, preventing the
// competing Milkdown input rule from deleting manual delimiters.
const plainDoc = schema.node('doc', null, [paragraph(schema.text('text'))])
state = EditorState.create({ schema, doc: plainDoc, plugins: [plugin] })
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 5, 5, '`'), true)
assert.equal(view.state.doc.textContent, 'text`')

console.log('PASS inline code: standard one-by-one input, literal backticks, boundary append, explicit exit')
