import assert from 'node:assert/strict'
import { Fragment, Schema, Slice } from '@milkdown/prose/model'
import { ReplaceStep } from '@milkdown/prose/transform'
import {
  PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY,
  PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
  createPlainParagraphTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  transactionsFromSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})

const text = (value) => value ? schema.text(value) : null
const paragraph = (value = '') => schema.nodes.paragraph.create(null, text(value))
const item = (...children) => schema.nodes.list_item.create(null, children)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const paragraphRange = (doc, targetIndex) => {
  let result = null
  doc.forEach((node, offset, index) => {
    if (index === targetIndex) {
      result = { start: offset + 1, end: offset + 1 + node.content.size }
    }
  })
  return result
}

const transactionForStep = (before, step) => {
  const applied = step.apply(before)
  assert.equal(applied.failed, null)
  return {
    docChanged: true,
    before,
    doc: applied.doc,
    steps: [step],
    docs: [before],
    mapping: { maps: [step.getMap()] }
  }
}

const paragraphStarts = (markdown) => {
  const starts = [0]
  let cursor = 0
  while (true) {
    const next = markdown.indexOf('\n\n', cursor)
    if (next < 0) break
    starts.push(next + 2)
    cursor = next + 2
  }
  return starts
}

const resolveMarkdownOffset = ({ markdown, pmPos, doc }) => {
  const $pos = doc.resolve(pmPos)
  if ($pos.depth !== 1 || $pos.parent.type.name !== 'paragraph') return null
  const starts = paragraphStarts(markdown)
  return starts[$pos.index(0)] + $pos.parentOffset
}

const validateMarkdown = ({ markdown, expectedDoc }) => {
  const actual = markdown.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '').split('\n\n')
    .filter((block) => block !== '')
  const expected = []
  // Mirror production: top-level empty paragraphs are editor-owned transients
  // the semantic comparator ignores.
  expectedDoc.forEach((node) => {
    if ((node.textContent || '') !== '') expected.push(node.textContent)
  })
  return JSON.stringify(actual) === JSON.stringify(expected)
}

const makeOwner = () => createPlainParagraphTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
})

const source = 'alpha\n\nbeta\n'
const oldDoc = document(paragraph('alpha'), paragraph('beta'))
const firstRange = paragraphRange(oldDoc, 0)
const first = transactionForStep(
  oldDoc,
  new ReplaceStep(
    firstRange.end,
    firstRange.end,
    new Slice(Fragment.from(schema.text('X')), 0, 0)
  )
)
const secondRange = paragraphRange(first.doc, 1)
const second = transactionForStep(
  first.doc,
  new ReplaceStep(
    secondRange.end - 2,
    secondRange.end,
    new Slice(Fragment.from(schema.text('ZZ')), 0, 0)
  )
)
const expected = 'alphaX\n\nbeZZ\n'
const snapshot = createSourceSyncSnapshot({
  revision: 11,
  source,
  canonical: source,
  doc: oldDoc,
  owner: 'fixture',
  family: 'fixture'
})
const journal = createSourceSyncTransactionJournal()
const captured = journal.captureOrAdvance({
  snapshot,
  transactions: [first],
  oldDoc,
  newDoc: first.doc
})
assert.equal(captured.ok, true)
const advanced = journal.captureOrAdvance({
  checkpoint: captured.checkpoint,
  snapshot,
  transactions: [second],
  oldDoc: first.doc,
  newDoc: second.doc
})
assert.equal(advanced.ok, true)
assert.equal(advanced.checkpoint.transactionCount, 2)
assert.equal(advanced.checkpoint.entries[0].stepDocs[0], oldDoc)
assert.equal(advanced.checkpoint.entries[1].stepDocs[0], first.doc)
const replay = transactionsFromSourceSyncTransactionJournal(advanced.checkpoint)
assert.equal(replay.length, 2)
assert.equal(replay[0].docs[0], oldDoc)
assert.equal(replay[1].before, first.doc)

const owner = makeOwner()
const plan = owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: source,
  canonical: expected,
  expectedDoc: second.doc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true)
assert.equal(plan.decision, 'owned')
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, PLAIN_PARAGRAPH_TRANSACTION_FAMILY)
assert.equal(plan.boundary, PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY)
assert.equal(plan.baseRevision, 11)
assert.equal(plan.result.markdown, expected)
assert.equal(plan.result.reason, 'plain-text-transactions')
assert.equal(plan.proof.kind, 'transaction-plain-paragraph-proof')
assert.equal(plan.proof.transactionJournal.transactionCount, 2)
assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep', 'ReplaceStep'])
assert.equal(plan.proof.plainParagraphCount, 2)

const syntaxDoc = document(paragraph('alpha'), paragraph('beta'))
const syntaxRange = paragraphRange(syntaxDoc, 1)
const syntaxTransaction = transactionForStep(
  syntaxDoc,
  new ReplaceStep(
    syntaxRange.end,
    syntaxRange.end,
    new Slice(Fragment.from(schema.text('*')), 0, 0)
  )
)
const syntaxSnapshot = createSourceSyncSnapshot({
  revision: 12,
  source,
  canonical: source,
  doc: syntaxDoc
})
const syntaxJournal = journal.captureOrAdvance({
  snapshot: syntaxSnapshot,
  transactions: [syntaxTransaction],
  oldDoc: syntaxDoc,
  newDoc: syntaxTransaction.doc
}).checkpoint
const syntaxPlan = owner.plan({
  journal: syntaxJournal,
  activeJournal: syntaxJournal,
  snapshot: syntaxSnapshot,
  currentSource: source,
  currentCanonical: source,
  canonical: 'alpha\n\nbeta\\*\n',
  expectedDoc: syntaxTransaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(syntaxPlan.ok, false)
assert.equal(syntaxPlan.reason, 'syntax-sensitive-insert')
assert.equal(syntaxPlan.family, PLAIN_PARAGRAPH_TRANSACTION_FAMILY)

const splitDoc = document(paragraph('alp'), paragraph('ha'), paragraph('beta'))
const structuralStep = {
  constructor: { name: 'ReplaceStep' },
  from: 4,
  to: 4,
  structure: false,
  slice: {
    size: 2,
    content: { size: 2, forEach() {} },
    openStart: 1,
    openEnd: 1
  },
  getMap() { return { map(position) { return position + 2 } } }
}
const splitTransaction = {
  docChanged: true,
  before: oldDoc,
  doc: splitDoc,
  steps: [structuralStep],
  docs: [oldDoc],
  mapping: { maps: [structuralStep.getMap()] }
}
const splitJournal = journal.captureOrAdvance({
  snapshot,
  transactions: [splitTransaction],
  oldDoc,
  newDoc: splitDoc
}).checkpoint
assert.equal(owner.plan({
  journal: splitJournal,
  activeJournal: splitJournal,
  snapshot,
  currentSource: source,
  currentCanonical: source,
  canonical: 'alp\n\nha\n\nbeta\n',
  expectedDoc: splitDoc,
  callbackDocumentEquivalent: true
}).reason, 'phase1-structural-slice')

const listOldDoc = document(bullet(item(paragraph('item'))))
const listRange = (() => {
  let result = null
  listOldDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') result = { start: pos + 1, end: pos + 1 + node.content.size }
  })
  return result
})()
const listTransaction = transactionForStep(
  listOldDoc,
  new ReplaceStep(
    listRange.end - 1,
    listRange.end,
    Slice.empty
  )
)
const listSnapshot = createSourceSyncSnapshot({
  revision: 13,
  source: '- item\n',
  canonical: '* item\n',
  doc: listOldDoc
})
const listJournal = journal.captureOrAdvance({
  snapshot: listSnapshot,
  transactions: [listTransaction],
  oldDoc: listOldDoc,
  newDoc: listTransaction.doc
}).checkpoint
assert.equal(owner.plan({
  journal: listJournal,
  activeJournal: listJournal,
  snapshot: listSnapshot,
  currentSource: '- item\n',
  currentCanonical: '* item\n',
  canonical: '* ite\n',
  expectedDoc: listTransaction.doc,
  callbackDocumentEquivalent: true
}).reason, 'phase1-non-top-level-paragraph')

const staleSnapshot = createSourceSyncSnapshot({
  revision: 14,
  source,
  canonical: source,
  doc: second.doc
})
const stalePlan = owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot: staleSnapshot,
  currentSource: source,
  currentCanonical: source,
  canonical: expected,
  expectedDoc: second.doc,
  callbackDocumentEquivalent: true
})
assert.equal(stalePlan.reason, 'transaction-journal-revision-stale')
assert.equal(stalePlan.reset, true)
assert.equal(owner.plan({
  journal: advanced.checkpoint,
  activeJournal: advanced.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: source,
  canonical: expected,
  expectedDoc: second.doc,
  callbackDocumentEquivalent: false
}).reason, 'plain-paragraph-callback-document-mismatch')

// --- E0 P3c: the terminal top-level split family (IME pending text + Enter) ---

const splitOwner = createPlainParagraphTransactionSourceSyncOwner({
  requireTerminalSplit: true,
  resolveMarkdownOffset,
  validateMarkdown
})
const splitJournalFactory = createSourceSyncTransactionJournal()
const planSplit = ({ transactions, canonical = 'canonical\n' }) => {
  const snap = createSourceSyncSnapshot({
    revision: 21,
    source,
    canonical: source,
    doc: oldDoc
  })
  let checkpoint = null
  let currentDoc = oldDoc
  for (const transaction of transactions) {
    const captured = splitJournalFactory.captureOrAdvance({
      checkpoint,
      snapshot: snap,
      transactions: [transaction],
      oldDoc: currentDoc,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true)
    checkpoint = captured.checkpoint
    currentDoc = transaction.doc
  }
  return splitOwner.plan({
    journal: checkpoint,
    activeJournal: checkpoint,
    snapshot: snap,
    currentSource: source,
    currentCanonical: source,
    canonical,
    expectedDoc: currentDoc,
    callbackDocumentEquivalent: true
  })
}
const insertAt = (before, paragraphIndex, offset, value) => {
  const range = paragraphRange(before, paragraphIndex)
  return transactionForStep(
    before,
    new ReplaceStep(
      range.start + offset,
      range.start + offset,
      new Slice(Fragment.from(schema.text(value)), 0, 0)
    )
  )
}
const splitAt = (before, paragraphIndex, offset) => transactionForStep(
  before,
  new ReplaceStep(
    paragraphRange(before, paragraphIndex).start + offset,
    paragraphRange(before, paragraphIndex).start + offset,
    new Slice(Fragment.from([paragraph(), paragraph()]), 1, 1),
    true
  )
)

{
  // 0.13.170 16:38:54 trace: a pending text chain (one committed IME run is
  // enough to model it) followed by an IMMEDIATE Enter at the paragraph end.
  const typed = insertAt(oldDoc, 0, 'alpha'.length, 'X')
  const split = splitAt(typed.doc, 0, 'alphaX'.length)
  const plan = planSplit({ transactions: [typed, split] })
  assert.equal(plan.ok, true, `terminal split rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.decision, 'owned')
  assert.equal(plan.family, 'plain-paragraph-terminal-split')
  assert.equal(plan.boundary, 'transaction-plain-paragraph-split')
  assert.equal(plan.result.reason, 'plain-paragraph-split')
  assert.equal(plan.proof.kind, 'transaction-plain-paragraph-split-proof')
  assert.equal(plan.proof.terminalSplit, true)
  assert.equal(plan.proof.chainLength, 2)
  // Minimal separator: the authored blank boundary after the paragraph is
  // already present, so the split adds NO extra bytes; the editor-owned
  // empty paragraph itself is not serialized (top-level empties transient).
  assert.equal(plan.result.markdown, 'alphaX\n\nbeta\n')
}

{
  // A pure text journal is NOT this family — it stays with the existing
  // plain-paragraph authority paths.
  const typed = insertAt(oldDoc, 0, 'alpha'.length, 'X')
  const plan = planSplit({ transactions: [typed] })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'phase1-terminal-split-missing')
}

{
  // A structural step that is not the FINAL step stays out of contract.
  const split = splitAt(oldDoc, 0, 'alpha'.length)
  const typed = insertAt(split.doc, 2, 0, 'Z')
  const plan = planSplit({ transactions: [split, typed] })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'phase1-structural-step')
}

{
  // Two structural steps in one journal: the first is already non-terminal,
  // so it rejects before a second could ever be accepted.
  const split = splitAt(oldDoc, 0, 'alpha'.length)
  const splitAgain = splitAt(split.doc, 2, 'beta'.length)
  const plan = planSplit({ transactions: [split, splitAgain] })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'phase1-structural-step')
}

{
  // Enter at the paragraph START leaves an empty LEFT paragraph — no mapper
  // contract, fail closed.
  const split = splitAt(oldDoc, 0, 0)
  const plan = planSplit({ transactions: [split] })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'phase1-result-empty-paragraph')
}

console.log('PASS plain paragraph transaction owner: shared journal replay owns rapid ReplaceStep chains and the IME+Enter terminal split while rejecting no-split, mid-chain structural, double-structural, empty-left, syntax, list and stale families')
