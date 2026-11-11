// Editor-only document changes (0.13.235).
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import {
  isHeadingIdOnlyChange,
  isTrailingEmptyParagraphAppend
} from '../src/renderer/src/lib/source-sync/editor-only-document.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 }, id: { default: '' } } },
    table: { content: 'text*', group: 'block' },
    text: {}
  }
})
const p = (text = '') => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const h = (text, id = '') => schema.nodes.heading.create({ level: 2, id }, schema.text(text))
const table = (text) => schema.nodes.table.create(null, schema.text(text))
const doc = (...blocks) => schema.nodes.doc.create(null, blocks)

// Trailing empty paragraph appended after a final non-paragraph block.
{
  const oldDoc = doc(p('a'), table('t'))
  const tr = EditorState.create({ schema, doc: oldDoc }).tr.insert(oldDoc.content.size, p())
  assert.equal(isTrailingEmptyParagraphAppend([tr], oldDoc, tr.doc), true)
  const typed = EditorState.create({ schema, doc: oldDoc }).tr.insert(oldDoc.content.size, p('x'))
  assert.equal(isTrailingEmptyParagraphAppend([typed], oldDoc, typed.doc), false, 'non-empty append is a real edit')
  const afterParagraph = doc(p('a'))
  const tr2 = EditorState.create({ schema, doc: afterParagraph }).tr.insert(afterParagraph.content.size, p())
  assert.equal(isTrailingEmptyParagraphAppend([tr2], afterParagraph, tr2.doc), false, 'doc already ended with a paragraph')
}

// Heading-id-only setNodeMarkup is editor-only; text or level changes are not.
{
  const oldDoc = doc(p('a'), h('Title', 'old-id'), p('b'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const idOnly = state.tr.setNodeMarkup(3, undefined, { level: 2, id: 'title' })
  assert.equal(isHeadingIdOnlyChange([idOnly], oldDoc, idOnly.doc), true)
  const level = state.tr.setNodeMarkup(3, undefined, { level: 3, id: 'old-id' })
  assert.equal(isHeadingIdOnlyChange([level], oldDoc, level.doc), false, 'level is authored')
  const text = state.tr.insertText('X', 4)
  assert.equal(isHeadingIdOnlyChange([text], oldDoc, text.doc), false, 'text edit is authored')
}

console.log('PASS editor-only document: trailing empty paragraph append, heading-id-only sync')
