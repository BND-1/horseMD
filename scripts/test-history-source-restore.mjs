// Undo/redo source restoration (fuzz seed 36, 0.13.237).
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import { history, undo } from '@milkdown/prose/history'
import {
  createSourceSnapshotHistory,
  isHistoryTransactionBatch,
  planHistorySourceRestore
} from '../src/renderer/src/lib/source-sync/history-source-restore.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: {}
  }
})
const p = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const doc = (...blocks) => schema.nodes.doc.create(null, blocks)

// A real undo transaction is recognized; an ordinary edit is not.
let state = EditorState.create({ schema, doc: doc(p('a')), plugins: [history()] })
const edit = state.tr.insertText('X', 2)
state = state.apply(edit)
let undoTr = null
undo(state, (tr) => { undoTr = tr })
assert.ok(undoTr, 'undo dispatched')
assert.equal(isHistoryTransactionBatch([undoTr]), true)
assert.equal(isHistoryTransactionBatch([edit]), false)
assert.equal(isHistoryTransactionBatch([]), false)

// Newest record wins for equal documents; identity lookup first, then eq.
const ring = createSourceSnapshotHistory({ limit: 3 })
const base = doc(p('a'))
assert.equal(ring.record({ doc: base, source: 'a\n' }), true)
assert.equal(ring.record({ doc: base, source: 'a\n' }), false, 'duplicate of the newest entry')
ring.record({ doc: doc(p('b')), source: 'b\n' })
ring.record({ doc: doc(p('a')), source: 'a  \n' })
assert.equal(ring.find(doc(p('a'))).source, 'a  \n', 'most recent spelling of an equal document')
assert.equal(ring.find(base).source, 'a  \n')
ring.record({ doc: doc(p('c')), source: 'c\n' })
ring.record({ doc: doc(p('d')), source: 'd\n' })
assert.equal(ring.size, 3, 'bounded')
assert.equal(ring.find(doc(p('b'))), null, 'evicted')
assert.equal(ring.record({ doc: null, source: 'x' }), false)

// The plan only owns history transactions that land on a recorded document.
const restored = planHistorySourceRestore({
  history: ring,
  transactions: [undoTr],
  newDoc: doc(p('d')),
  currentSource: 'z\n',
  currentCanonical: 'z\n',
  canonical: 'd\n'
})
assert.equal(restored.ok, true)
assert.equal(restored.result.markdown, 'd\n')
assert.equal(restored.family, 'history-source-restore')
assert.equal(planHistorySourceRestore({ history: ring, transactions: [edit], newDoc: doc(p('d')), canonical: 'd\n' }).reason, 'history-restore-not-history')
assert.equal(planHistorySourceRestore({ history: ring, transactions: [undoTr], newDoc: doc(p('q')), canonical: 'q\n' }).reason, 'history-restore-unknown-document')

console.log('PASS history source restore: undo/redo detection, bounded newest-first (doc, source) ring, restore plan only for recorded documents')
