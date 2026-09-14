import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { collectReviewDecorations } from '../src/renderer/src/components/editor-review-decorations.js'
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' },
  blockquote: { content: 'block+', group: 'block' }, text: { group: 'inline' }
}, marks: { highlight: {}, strike: {}, strong: {} } })
const p = text => schema.node('paragraph', null, schema.text(text))
const document = schema.node('doc', null, Array.from({ length: 1000 }, (_, i) => p('普通段落' + i)))
let state = EditorState.create({ schema, doc: document })
let resolves = 0
const originalResolve = document.resolve.bind(document)
document.resolve = pos => { resolves++; return originalResolve(pos) }
const result = collectReviewDecorations(state)
assert.deepEqual(result, { decorations: [], widgetList: [] })
assert.equal(resolves, 0, 'ordinary document must not resolve every textblock for absent review markup')
state = state.apply(state.tr.insertText('{++新增++}', 1))
assert.ok(collectReviewDecorations(state).decorations.length > 0, 'new marker must invalidate no-review cache')
const marked = schema.node('paragraph', null, [schema.text('{'), schema.text('高亮', [schema.marks.highlight.create()]), schema.text('}{>>批注<<}')])
const raw = p('{==正文==}{>>说明<<}')
state = EditorState.create({ schema, doc: schema.node('doc', null, [p('开头'), schema.node('blockquote', null, [marked, raw]), p('结尾')]) })
state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)))
const comments = collectReviewDecorations(state)
assert.ok(comments.widgetList.length >= 1, 'raw/parsed comments must remain discoverable')
assert.ok(comments.decorations.length > 0)
const bytes = JSON.stringify(state.doc.toJSON())
collectReviewDecorations(state, { openGroupKey: null })
assert.equal(JSON.stringify(state.doc.toJSON()), bytes, 'decoration scan must never mutate document')
console.log('PASS review scan: no-marker zero resolve, edited-node invalidation, raw/parsed comments, nested blocks, source unchanged')
