// editor-inline-code.js turns a typed `` `x` `` into inline code (Typora: the
// opener stays literal until the closing backtick). Editing existing inline
// code — the side at its edges, arrows, clicks, the backticks shown while
// inside, IME — is the token plugin's (editor-html-token-editing.js, shared
// with <kbd>; 2026-11-22), locked by test-token-edit-ui / test-inline-code-ui
// in the real editor.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { createInlineCodeEditingPlugin } from '../src/renderer/src/components/editor-inline-code.js'

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
let edits = 0
const plugin = createInlineCodeEditingPlugin({ onEdit: () => { edits += 1 } })

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

// An opener stays literal while the content is typed (Chinese IME text too);
// the closing backtick removes both delimiters and marks the content.
let state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [paragraph()]),
  plugins: [plugin]
})
let view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 1, 1, '`'), true)
assert.equal(view.state.doc.textContent, '`')
assert.equal(view.state.doc.firstChild.firstChild.marks.length, 0)
for (const character of '中文') {
  const position = view.state.selection.from
  assert.equal(plugin.props.handleTextInput(view, position, position, character), false, 'other characters are not the plugin\'s')
  view.dispatch(view.state.tr.insertText(character))
  assert.equal(view.state.doc.firstChild.firstChild.marks.length, 0)
}
assert.equal(view.state.doc.textContent, '`中文')
assert.equal(plugin.props.handleTextInput(view, 4, 4, '`'), true)
assert.equal(view.state.doc.textContent, '中文')
assert.ok(code.type.isInSet(view.state.doc.firstChild.firstChild.marks))
// The caret ends after the code, outside it: typing goes after.
assert.equal(view.state.selection.head, 3)
assert.deepEqual(view.state.storedMarks, [])
view.dispatch(view.state.tr.insertText('x'))
assert.equal(view.state.doc.firstChild.firstChild.text, '中文')
assert.equal(view.state.doc.firstChild.child(1).text, 'x')
assert.equal(view.state.doc.firstChild.child(1).marks.length, 0)
assert.ok(edits >= 2, 'every conversion / literal backtick marks a user edit')

// Repeated backtick runs stay literal: `` and ``` are not inline code.
const tick = schema.node('doc', null, [paragraph(schema.text('`'))])
state = EditorState.create({ schema, doc: tick, selection: TextSelection.create(tick, 2), plugins: [plugin] })
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 2, 2, '`'), true)
assert.equal(view.state.doc.textContent, '``')
assert.equal(plugin.props.handleTextInput(view, 3, 3, '`'), true)
assert.equal(view.state.doc.textContent, '```')
view.dispatch(view.state.tr.insertText('a'))
assert.equal(view.state.doc.textContent, '```a')
assert.equal(view.state.doc.firstChild.firstChild.marks.length, 0)

// An escaped opener (\`) never pairs.
const escaped = schema.node('doc', null, [paragraph(schema.text('\\`ab'))])
state = EditorState.create({ schema, doc: escaped, selection: TextSelection.create(escaped, 5), plugins: [plugin] })
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 5, 5, '`'), true)
assert.equal(view.state.doc.textContent, '\\`ab`')
assert.equal(view.state.doc.firstChild.firstChild.marks.length, 0)

// A lone opening backtick after text is inserted literally (Crepe's own input
// rule would consume the delimiter keystroke).
const plainDoc = schema.node('doc', null, [paragraph(schema.text('text'))])
state = EditorState.create({ schema, doc: plainDoc, plugins: [plugin] })
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 5, 5, '`'), true)
assert.equal(view.state.doc.textContent, 'text`')

// Inside existing inline code a backtick is the token plugin's (at the end it
// leaves the code; elsewhere it is a literal backtick in the code).
const inside = schema.node('doc', null, [paragraph(schema.text('ab', [code]), schema.text(' tail'))])
state = EditorState.create({ schema, doc: inside, selection: TextSelection.create(inside, 2), plugins: [plugin] })
view = mockView(state)
assert.equal(plugin.props.handleTextInput(view, 2, 2, '`'), false)
assert.equal(view.state.doc.textContent, 'ab tail')

// Selections and other characters are never touched.
assert.equal(plugin.props.handleTextInput(view, 1, 3, '`'), false)
assert.equal(plugin.props.handleTextInput(view, 2, 2, 'x'), false)

console.log('PASS inline code input: opener literal until the closing backtick (IME text too), caret after the code, `` / ``` / \\` literal, a lone opener literal, inside code left to the token plugin')
