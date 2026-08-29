import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value) : null
)
const document = (value = '') => schema.nodes.doc.create(null, paragraph(value))
const baselineDoc = document('alpha')
const snapshot = createSourceSyncSnapshot({
  revision: 41,
  source: 'alpha\n',
  canonical: 'alpha\n',
  doc: baselineDoc,
  owner: 'transaction',
  family: 'code-block-exit',
  reason: 'code-block-exit'
})
const factory = createSourceSyncTransactionJournal()
const firstTransaction = EditorState.create({ schema, doc: baselineDoc }).tr
  .insertText('X', 1 + 'alpha'.length)
const first = factory.captureOrAdvance({
  snapshot,
  transactions: [firstTransaction],
  oldDoc: baselineDoc,
  newDoc: firstTransaction.doc
})
assert.equal(first.ok, true)
assert.equal(first.checkpoint.baseOwner, 'transaction')
assert.equal(first.checkpoint.baseFamily, 'code-block-exit')
assert.equal(first.checkpoint.baseReason, 'code-block-exit')

const secondTransaction = EditorState.create({ schema, doc: firstTransaction.doc }).tr
  .insertText('Y', 1 + 'alphaX'.length)
const second = factory.captureOrAdvance({
  checkpoint: first.checkpoint,
  snapshot,
  transactions: [secondTransaction],
  oldDoc: firstTransaction.doc,
  newDoc: secondTransaction.doc
})
assert.equal(second.ok, true)
assert.equal(second.checkpoint.baseOwner, 'transaction')
assert.equal(second.checkpoint.baseFamily, 'code-block-exit')
assert.equal(second.checkpoint.baseReason, 'code-block-exit')
assert.equal(second.checkpoint.batchCount, 2)

const verified = verifySourceSyncTransactionJournalCheckpoint({
  checkpoint: second.checkpoint,
  snapshot,
  expectedDoc: secondTransaction.doc
})
assert.equal(verified.ok, true)
assert.equal(verified.proof.baseOwner, 'transaction')
assert.equal(verified.proof.baseFamily, 'code-block-exit')
assert.equal(verified.proof.baseReason, 'code-block-exit')

const relabelledSnapshot = createSourceSyncSnapshot({
  revision: 41,
  source: 'alpha\n',
  canonical: 'alpha\n',
  doc: secondTransaction.doc,
  owner: 'legacy',
  family: 'legacy-preservation',
  reason: 'same-bytes-different-owner'
})
const relabelled = verifySourceSyncTransactionJournalCheckpoint({
  checkpoint: second.checkpoint,
  snapshot: relabelledSnapshot,
  expectedDoc: secondTransaction.doc
})
assert.equal(relabelled.ok, false)
assert.equal(relabelled.reason, 'transaction-journal-provenance-stale')
assert.equal(relabelled.reset, true)

const externalSnapshot = createSourceSyncSnapshot({
  revision: 42,
  source: 'alphaXY\n',
  canonical: 'alphaXY\n',
  doc: secondTransaction.doc,
  owner: 'external-checkpoint',
  family: 'external-checkpoint',
  reason: 'source-mode-accepted'
})
const thirdTransaction = EditorState.create({ schema, doc: secondTransaction.doc }).tr
  .insertText('Z', 1 + 'alphaXY'.length)
const third = factory.captureOrAdvance({
  snapshot: externalSnapshot,
  transactions: [thirdTransaction],
  oldDoc: secondTransaction.doc,
  newDoc: thirdTransaction.doc
})
assert.equal(third.ok, true)
assert.equal(third.checkpoint.baseOwner, 'external-checkpoint')
assert.equal(third.checkpoint.baseFamily, 'external-checkpoint')
assert.equal(third.checkpoint.baseReason, 'source-mode-accepted')

const stale = factory.captureOrAdvance({
  checkpoint: second.checkpoint,
  snapshot: externalSnapshot,
  transactions: [thirdTransaction],
  oldDoc: secondTransaction.doc,
  newDoc: thirdTransaction.doc
})
assert.equal(stale.ok, false)
assert.equal(stale.reason, 'transaction-journal-revision-stale')
assert.equal(stale.reset, true)

console.log('PASS source sync transaction journal provenance: snapshot owner/family/reason bind the first revision, survive appended batches, reset on a new snapshot, and remain in verification proof')
