import assert from 'node:assert/strict'
import {
  SOURCE_SYNC_TRANSACTION_JOURNAL_KIND,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  mapPositionThroughSourceSyncTransactionJournal,
  transactionsFromSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from '../src/renderer/src/lib/source-sync/index.js'

const doc = (id) => ({
  id,
  eq(other) { return other?.id === id }
})
const doc0 = doc('doc-0')
const doc1 = doc('doc-1')
const doc2 = doc('doc-2')
const doc3 = doc('doc-3')

const stepMap = (delta) => ({
  map(position) { return position + delta }
})
const step = (name, from, to, structure = false) => ({
  constructor: { name },
  from,
  to,
  structure,
  slice: { size: 0 }
})
const transaction = (before, after, steps, maps) => ({
  docChanged: true,
  before,
  doc: after,
  steps,
  docs: steps.map(() => before),
  mapping: { maps }
})

const snapshot = createSourceSyncSnapshot({
  revision: 7,
  source: 'author source\n',
  canonical: 'canonical source\n',
  doc: doc0,
  owner: 'fixture',
  family: 'fixture'
})
const first = transaction(
  doc0,
  doc1,
  [step('ReplaceStep', 4, 4)],
  [stepMap(1)]
)
const second = transaction(
  doc1,
  doc2,
  [step('ReplaceAroundStep', 5, 9, true)],
  [stepMap(2)]
)

const journal = createSourceSyncTransactionJournal()
const captured = journal.captureOrAdvance({
  snapshot,
  transactions: [first],
  oldDoc: doc0,
  newDoc: doc1
})
assert.equal(captured.ok, true)
assert.equal(captured.checkpoint.kind, SOURCE_SYNC_TRANSACTION_JOURNAL_KIND)
assert.equal(captured.checkpoint.baseRevision, 7)
assert.equal(captured.checkpoint.source, snapshot.source)
assert.equal(captured.checkpoint.canonical, snapshot.canonical)
assert.equal(captured.checkpoint.batchCount, 1)
assert.equal(captured.checkpoint.transactionCount, 1)
assert.equal(captured.checkpoint.stepCount, 1)
assert.equal(captured.checkpoint.mapCount, 1)
assert.equal(captured.checkpoint.expectedDoc, doc1)
assert.ok(Object.isFrozen(captured.checkpoint))
assert.ok(Object.isFrozen(captured.checkpoint.entries))
assert.ok(Object.isFrozen(captured.checkpoint.entries[0].stepDocs))
assert.equal(captured.checkpoint.entries[0].stepDocs[0], doc0)

const advanced = journal.captureOrAdvance({
  checkpoint: captured.checkpoint,
  snapshot,
  transactions: [second],
  oldDoc: doc1,
  newDoc: doc2
})
assert.equal(advanced.ok, true)
assert.equal(advanced.checkpoint.journalId, captured.checkpoint.journalId)
assert.equal(advanced.checkpoint.oldDoc, doc0)
assert.equal(advanced.checkpoint.expectedDoc, doc2)
assert.equal(advanced.checkpoint.batchCount, 2)
assert.equal(advanced.checkpoint.transactionCount, 2)
assert.equal(advanced.checkpoint.chainLength, 2)
assert.deepEqual(
  advanced.checkpoint.stepDetails.map((entry) => entry.name),
  ['ReplaceStep', 'ReplaceAroundStep']
)
assert.equal(
  journal.mapPosition(advanced.checkpoint, 10),
  13,
  'StepMaps from consecutive dispatch batches must compose in order'
)
assert.equal(
  mapPositionThroughSourceSyncTransactionJournal(advanced.checkpoint, 3),
  6
)
const replayedTransactions = transactionsFromSourceSyncTransactionJournal(advanced.checkpoint)
assert.equal(replayedTransactions.length, 2)
assert.equal(replayedTransactions[0].before, doc0)
assert.equal(replayedTransactions[0].docs[0], doc0)
assert.equal(replayedTransactions[1].before, doc1)
assert.equal(replayedTransactions[1].doc, doc2)
assert.ok(Object.isFrozen(replayedTransactions))
assert.ok(Object.isFrozen(replayedTransactions[0]))

const verified = journal.verify({
  checkpoint: advanced.checkpoint,
  snapshot,
  expectedDoc: doc2
})
assert.equal(verified.ok, true)
assert.equal(verified.proof.kind, 'source-sync-transaction-journal-proof')
assert.equal(verified.proof.baseRevision, 7)
assert.equal(verified.proof.batchCount, 2)
assert.equal(verified.proof.transactionCount, 2)
assert.deepEqual(verified.proof.stepNames, ['ReplaceStep', 'ReplaceAroundStep'])
assert.ok(Object.isFrozen(verified.proof))
assert.equal(
  verifySourceSyncTransactionJournalCheckpoint({
    checkpoint: advanced.checkpoint,
    snapshot,
    expectedDoc: doc2
  }).ok,
  true
)

const staleRevision = createSourceSyncSnapshot({
  revision: 8,
  source: snapshot.source,
  canonical: snapshot.canonical,
  doc: doc2
})
assert.equal(journal.verify({
  checkpoint: advanced.checkpoint,
  snapshot: staleRevision,
  expectedDoc: doc2
}).reason, 'transaction-journal-revision-stale')

const staleSource = createSourceSyncSnapshot({
  revision: 7,
  source: 'different source\n',
  canonical: snapshot.canonical,
  doc: doc2
})
assert.equal(journal.verify({
  checkpoint: advanced.checkpoint,
  snapshot: staleSource,
  expectedDoc: doc2
}).reason, 'transaction-journal-source-stale')

const staleCanonical = createSourceSyncSnapshot({
  revision: 7,
  source: snapshot.source,
  canonical: 'different canonical\n',
  doc: doc2
})
assert.equal(journal.verify({
  checkpoint: advanced.checkpoint,
  snapshot: staleCanonical,
  expectedDoc: doc2
}).reason, 'transaction-journal-canonical-stale')
assert.equal(journal.verify({
  checkpoint: advanced.checkpoint,
  snapshot,
  expectedDoc: doc3
}).reason, 'transaction-journal-document-stale')

const documentGap = journal.captureOrAdvance({
  checkpoint: captured.checkpoint,
  snapshot,
  transactions: [second],
  oldDoc: doc0,
  newDoc: doc2
})
assert.equal(documentGap.ok, false)
assert.equal(documentGap.reason, 'transaction-journal-document-stale')
assert.equal(documentGap.reset, true)

const chainMismatch = journal.captureOrAdvance({
  snapshot,
  transactions: [transaction(doc3, doc1, [step('ReplaceStep', 1, 1)], [stepMap(1)])],
  oldDoc: doc0,
  newDoc: doc1
})
assert.equal(chainMismatch.reason, 'transaction-journal-transaction-chain-mismatch')
assert.equal(chainMismatch.reset, true)

const finalMismatch = journal.captureOrAdvance({
  snapshot,
  transactions: [first],
  oldDoc: doc0,
  newDoc: doc2
})
assert.equal(finalMismatch.reason, 'transaction-journal-batch-result-mismatch')

const noChange = journal.captureOrAdvance({
  snapshot,
  transactions: [{ docChanged: false, before: doc0, doc: doc0, steps: [] }],
  oldDoc: doc0,
  newDoc: doc0
})
assert.equal(noChange.ok, false)
assert.equal(noChange.deferred, true)
assert.equal(noChange.reason, 'transaction-journal-no-document-change')
const noChangeAfterCapture = journal.captureOrAdvance({
  checkpoint: captured.checkpoint,
  snapshot,
  transactions: [{ docChanged: false, before: doc1, doc: doc1, steps: [] }],
  oldDoc: doc1,
  newDoc: doc1
})
assert.equal(noChangeAfterCapture.ok, true)
assert.equal(noChangeAfterCapture.checkpoint, captured.checkpoint)

const bounded = createSourceSyncTransactionJournal({ maxSteps: 1 })
const tooLarge = bounded.captureOrAdvance({
  snapshot,
  transactions: [transaction(
    doc0,
    doc1,
    [step('ReplaceStep', 1, 1), step('ReplaceStep', 2, 2)],
    [stepMap(1), stepMap(1)]
  )],
  oldDoc: doc0,
  newDoc: doc1
})
assert.equal(tooLarge.reason, 'transaction-journal-capacity-exceeded')
assert.equal(tooLarge.reset, true)
assert.deepEqual(tooLarge.proof, { transactionCount: 1, stepCount: 2, mapCount: 2 })

assert.equal(journal.mapPosition(null, 3), null)
assert.equal(journal.mapPosition(advanced.checkpoint, Number.NaN), null)

console.log('PASS source sync transaction journal: revision-bound batches, StepMap composition, stale rejection, document continuity and capacity limits')
