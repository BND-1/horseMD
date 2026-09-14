import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { createEditorTransactionTracer, createTransactionTraceDecoder } from '../src/renderer/src/components/editor-transaction-trace.js'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' },
  blockquote: { content: 'block+', group: 'block' },
  text: { group: 'inline' }, image: { inline: true, group: 'inline', attrs: { src: { default: '' } } }
}, marks: { strong: {} } })
const p = text => schema.node('paragraph', null, text ? schema.text(text) : undefined)
const events = []
let active = false
const trace = createEditorTransactionTracer({ enabled: () => active, compactThreshold: 1,
  emit: (type, payload) => events.push(structuredClone({ type, ...payload })) })
let touched = false
const untouched = new Proxy({}, { get() { touched = true; throw new Error('disabled trace touched doc') } })
trace([], untouched, untouched)
assert.equal(touched, false)
assert.equal(events.length, 0)
active = true
let state = EditorState.create({ schema, doc: schema.node('doc', null, [p('编辑目标'), ...Array.from({ length: 1000 }, (_, i) => p('稳定正文' + i))]) })
const decode = createTransactionTraceDecoder()
let firstBytes = 0
for (let i = 0; i < 12; i++) {
  const before = state.doc
  const tr = i === 5 ? state.tr.setSelection(TextSelection.create(state.doc, 2)) : state.tr.insertText('字', 2)
  state = state.apply(tr)
  trace([tr], before, state.doc)
  const event = events.at(-1)
  const restored = decode(event)
  assert.deepEqual(restored.oldDoc, before.toJSON())
  assert.deepEqual(restored.newDoc, state.doc.toJSON())
  assert.deepEqual(event.transactions[0].steps, tr.steps.map(s => s.toJSON()))
  if (i === 0) firstBytes = JSON.stringify(event).length
  else assert.ok(event.docNodes.length <= 3, 'unchanged nodes must not be serialized again')
  if (i === 5) assert.equal(event.docNodes.length, 0, 'selection-only event has no new nodes')
}
assert.ok(JSON.stringify(events.at(-1)).length < firstBytes / 10)
assert.throws(() => createTransactionTraceDecoder()(events.at(-1)), /Missing transaction trace node/)
const replacement = schema.node('doc', null, [schema.node('blockquote', null, [schema.node('paragraph', null, [schema.text('加粗', [schema.marks.strong.create()]), schema.node('image', { src: 'x' })]), p('')])])
trace([], state.doc, replacement)
assert.deepEqual(decode(events.at(-1)).newDoc, JSON.parse(JSON.stringify(replacement.toJSON())), 'replacement, marks, attrs and empty nodes round-trip')
const otherEvents = []
createEditorTransactionTracer({ enabled: () => true, compactThreshold: 1, emit: (type, payload) => otherEvents.push({ type, ...payload }) })([], replacement, state.doc)
assert.notEqual(otherEvents[0].traceId, events[0].traceId)
assert.deepEqual(decode(otherEvents[0]).oldDoc, replacement.toJSON(), 'multiple editors are isolated')
let small
createEditorTransactionTracer({ enabled: () => true, emit: (type, payload) => { small = { type, ...payload } } })([], replacement, replacement)
assert.equal(small.documentFormat, undefined)
assert.deepEqual(small.newDoc, replacement.toJSON(), 'small-doc diagnostic format remains compatible')
console.log('PASS transaction trace: disabled zero-work, exact per-event reconstruction, structural replacement, marks/attrs, selection-only, editor isolation, incomplete trace rejection')
console.log(JSON.stringify({ firstEventChars: firstBytes, steadyEventChars: JSON.stringify(events[11]).length }))
