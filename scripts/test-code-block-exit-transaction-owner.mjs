import assert from 'node:assert/strict'
import { exitCode } from '@milkdown/prose/commands'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import {
  CODE_BLOCK_EXIT_TRANSACTION_BOUNDARY,
  CODE_BLOCK_EXIT_TRANSACTION_FAMILY,
  createCodeBlockExitTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block'
    },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})
const paragraph = (value = '', marks = null) => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value, marks) : null
)
const codeBlock = (value = '', language = 'js') => schema.nodes.code_block.create(
  { language },
  value ? schema.text(value) : null
)
const heading = (value = '') => schema.nodes.heading.create(
  { level: 2 },
  value ? schema.text(value) : null
)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)
const beforeAtTopLevel = (doc, index) => {
  let position = 0
  for (let cursor = 0; cursor < index; cursor += 1) position += doc.child(cursor).nodeSize
  return position
}
const baselineDoc = document(
  paragraph('before'),
  codeBlock('console.log(1)', 'js'),
  paragraph('after')
)
const source = '\uFEFFbefore\r\n\r\n~~~js\r\nconsole.log(1)\r\n~~~\r\n\r\nafter\r\n'
const canonical = 'before\n\n```js\nconsole.log(1)\n```\n\nafter\n'
const pendingCanonical = 'before\n\n```js\nconsole.log(1)\n```\n\n<br />\n\nafter\n'
const finalCanonical = 'before\n\n```js\nconsole.log(1)\n```\n\nXY\n\nafter\n'
const finalSource = '\uFEFFbefore\r\n\r\n~~~js\r\nconsole.log(1)\r\n~~~\r\n\r\nXY\r\n\r\nafter\r\n'

const exitTransaction = (doc = baselineDoc) => {
  const codeIndex = Array.from({ length: doc.childCount }, (_, index) => index)
    .find((index) => doc.child(index).type.name === 'code_block')
  assert.notEqual(codeIndex, undefined)
  const position = beforeAtTopLevel(doc, codeIndex) + 1 + doc.child(codeIndex).content.size
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, position)
  })
  let transaction = null
  assert.equal(exitCode(state, (value) => { transaction = value }), true)
  assert.ok(transaction)
  return transaction
}

const insertText = (doc, paragraphIndex, value) => {
  const position = beforeAtTopLevel(doc, paragraphIndex) + 1 + doc.child(paragraphIndex).content.size
  return EditorState.create({ schema, doc }).tr.insertText(value, position)
}

const capture = ({
  snapshot,
  baseline,
  transactions
}) => {
  const factory = createSourceSyncTransactionJournal()
  let checkpoint = null
  let currentDoc = baseline
  for (const transaction of transactions) {
    const captured = factory.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: [transaction],
      oldDoc: currentDoc,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, `journal capture failed: ${JSON.stringify(captured)}`)
    checkpoint = captured.checkpoint
    currentDoc = transaction.doc
  }
  return { journal: checkpoint, expectedDoc: currentDoc }
}

const initialSnapshot = (revision = 1000) => createSourceSyncSnapshot({
  revision,
  source,
  canonical,
  doc: baselineDoc,
  owner: 'bootstrap',
  family: 'bootstrap',
  reason: 'fixture'
})

const makeCoalesced = () => {
  const exit = exitTransaction()
  const x = insertText(exit.doc, 2, 'X')
  const y = insertText(x.doc, 2, 'Y')
  return [exit, x, y]
}

const planFor = ({
  snapshot = initialSnapshot(),
  baseline = baselineDoc,
  transactions = makeCoalesced(),
  nextCanonical = finalCanonical,
  currentSource = source,
  currentCanonical = snapshot.canonical,
  callbackDocumentEquivalent = true,
  resolveMarkdownOffset = () => source.indexOf('~~~js'),
  validateMarkdown = () => true
} = {}) => {
  const captured = capture({ snapshot, baseline, transactions })
  const owner = createCodeBlockExitTransactionSourceSyncOwner({
    resolveMarkdownOffset,
    validateMarkdown
  })
  return {
    ...captured,
    owner,
    plan: owner.plan({
      journal: captured.journal,
      activeJournal: captured.journal,
      snapshot,
      currentSource,
      currentCanonical,
      canonical: nextCanonical,
      expectedDoc: captured.expectedDoc,
      callbackDocumentEquivalent,
      boundary: CODE_BLOCK_EXIT_TRANSACTION_BOUNDARY
    })
  }
}

{
  let validationInput = null
  const { plan } = planFor({
    validateMarkdown: (input) => {
      validationInput = input
      return true
    }
  })
  assert.equal(plan.ok, true, `coalesced exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, CODE_BLOCK_EXIT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, CODE_BLOCK_EXIT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, CODE_BLOCK_EXIT_TRANSACTION_FAMILY)
  assert.equal(plan.result.markdown, finalSource)
  assert.equal(plan.proof.kind, 'transaction-code-block-exit-proof')
  assert.equal(plan.proof.mode, 'coalesced-text')
  assert.equal(plan.proof.codeIndex, 1)
  assert.equal(plan.proof.insertedIndex, 2)
  assert.equal(plan.proof.finalText, 'XY')
  assert.equal(plan.proof.textStepCount, 2)
  assert.deepEqual(
    plan.proof.stepRanges.map((entry) => entry.mode),
    ['insert-paragraph', 'paragraph-text', 'paragraph-text']
  )
  assert.equal(plan.proof.sourceRange.char, '~')
  assert.equal(plan.proof.sourceRange.infoRaw, 'js')
  assert.equal(plan.proof.previousRange.char, '`')
  assert.equal(plan.proof.language, 'js')
  assert.equal(plan.proof.patch.replacement, 'XY\r\n\r\n')
  assert.equal(plan.proof.transactionJournal.stepCount, 3)
  assert.equal(validationInput.markdown, finalSource)
  assert.equal(validationInput.expectedDoc, plan.expectedDoc)
}

{
  const exit = exitTransaction()
  const { plan } = planFor({
    transactions: [exit],
    nextCanonical: pendingCanonical,
    validateMarkdown: () => true
  })
  assert.equal(plan.ok, true, `pending exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.markdown, source)
  assert.equal(plan.proof.mode, 'pending-empty-paragraph')
  assert.equal(plan.proof.finalText, '')
  assert.equal(plan.proof.textStepCount, 0)
  assert.equal(plan.proof.sourceUnchanged, true)
  assert.equal(plan.proof.patch, null)
}

{
  const exit = exitTransaction()
  const pendingSnapshot = createSourceSyncSnapshot({
    revision: 1002,
    source,
    canonical: pendingCanonical,
    doc: exit.doc,
    owner: 'transaction',
    family: CODE_BLOCK_EXIT_TRANSACTION_FAMILY,
    reason: CODE_BLOCK_EXIT_TRANSACTION_FAMILY
  })
  const x = insertText(exit.doc, 2, 'X')
  const y = insertText(x.doc, 2, 'Y')
  const { plan } = planFor({
    snapshot: pendingSnapshot,
    baseline: exit.doc,
    transactions: [x, y],
    nextCanonical: finalCanonical,
    currentCanonical: pendingCanonical,
    validateMarkdown: () => true
  })
  assert.equal(plan.ok, true, `staged exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.markdown, finalSource)
  assert.equal(plan.proof.mode, 'staged-text')
  assert.equal(plan.proof.finalText, 'XY')
  assert.equal(plan.proof.textStepCount, 2)
  assert.equal(plan.proof.transactionJournal.baseFamily, CODE_BLOCK_EXIT_TRANSACTION_FAMILY)
}

{
  const exit = exitTransaction()
  const wrongSnapshot = createSourceSyncSnapshot({
    revision: 1003,
    source,
    canonical: pendingCanonical,
    doc: exit.doc,
    owner: 'legacy',
    family: 'legacy-preservation',
    reason: 'other'
  })
  const x = insertText(exit.doc, 2, 'X')
  const { plan } = planFor({
    snapshot: wrongSnapshot,
    baseline: exit.doc,
    transactions: [x],
    nextCanonical: finalCanonical.replace('XY', 'X'),
    currentCanonical: pendingCanonical
  })
  assert.equal(plan.reason, 'code-block-exit-staged-provenance')
}

{
  const emptyCodeDoc = document(
    paragraph('before'),
    codeBlock('', 'js'),
    paragraph('after')
  )
  const exit = exitTransaction(emptyCodeDoc)
  const snapshot = createSourceSyncSnapshot({
    revision: 1004,
    source: '\uFEFFbefore\r\n\r\n~~~js\r\n~~~\r\n\r\nafter\r\n',
    canonical: 'before\n\n```js\n```\n\nafter\n',
    doc: emptyCodeDoc,
    owner: 'bootstrap',
    family: 'bootstrap',
    reason: 'fixture'
  })
  const { plan } = planFor({
    snapshot,
    baseline: emptyCodeDoc,
    transactions: [exit],
    nextCanonical: 'before\n\n```js\n```\n\n<br />\n\nafter\n',
    currentSource: snapshot.source,
    currentCanonical: snapshot.canonical
  })
  assert.notEqual(plan.ok, true)
  assert.equal(plan.reason, 'code-block-exit-coalesced-candidate-count')
  assert.notEqual(plan.recognized, true)
}

{
  const nonEmptyInsert = EditorState.create({ schema, doc: baselineDoc }).tr
    .insertText('not-exit', beforeAtTopLevel(baselineDoc, 2))
  const { plan } = planFor({
    transactions: [nonEmptyInsert],
    nextCanonical: finalCanonical,
    revision: 1005
  })
  assert.notEqual(plan.ok, true)
  assert.equal(plan.reason, 'code-block-exit-insert-step')
  assert.notEqual(plan.recognized, true)
}

{
  const exit = exitTransaction()
  const mark = schema.marks.strong.create()
  const markedPosition = beforeAtTopLevel(exit.doc, 2) + 1
  const marked = EditorState.create({ schema, doc: exit.doc }).tr
    .replaceWith(markedPosition, markedPosition, schema.text('X', [mark]))
  const { plan } = planFor({
    transactions: [exit, marked],
    nextCanonical: finalCanonical.replace('XY', 'X'),
    revision: 1006
  })
  assert.notEqual(plan.ok, true)
}

{
  const exit = exitTransaction()
  const neighbour = insertText(exit.doc, 3, '!')
  const { plan } = planFor({
    transactions: [exit, neighbour],
    nextCanonical: finalCanonical,
    revision: 1007
  })
  assert.notEqual(plan.ok, true)
}

{
  const { plan } = planFor({
    revision: 1008,
    callbackDocumentEquivalent: false
  })
  assert.equal(plan.reason, 'code-block-exit-callback-document-mismatch')
  assert.notEqual(plan.recognized, true)
}

{
  const { plan } = planFor({
    revision: 1009,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'code-block-exit-semantic-document-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const { plan } = planFor({
    revision: 1010,
    validateMarkdown: () => { throw new Error('fixture') }
  })
  assert.equal(plan.reason, 'code-block-exit-semantic-validator-threw')
}

{
  const duplicate = `${source}\r\n~~~js\r\nconsole.log(1)\r\n~~~\r\n`
  const snapshot = createSourceSyncSnapshot({
    revision: 1011,
    source: duplicate,
    canonical,
    doc: baselineDoc,
    owner: 'bootstrap',
    family: 'bootstrap',
    reason: 'fixture'
  })
  const captured = capture({ snapshot, baseline: baselineDoc, transactions: makeCoalesced() })
  const owner = createCodeBlockExitTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => Number.NaN,
    validateMarkdown: () => true
  })
  const plan = owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot,
    currentSource: duplicate,
    currentCanonical: canonical,
    canonical: finalCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.reason, 'code-block-exit-source-range')
  assert.equal(plan.recognized, true)
}

{
  const snapshot = initialSnapshot(1012)
  const captured = capture({ snapshot, baseline: baselineDoc, transactions: makeCoalesced() })
  const owner = createCodeBlockExitTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => source.indexOf('~~~js'),
    validateMarkdown: () => true
  })
  const plan = owner.plan({
    journal: captured.journal,
    activeJournal: { ...captured.journal },
    snapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical: finalCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.reason, 'code-block-exit-journal-stale')
  assert.equal(plan.reset, true)
}

assert.throws(
  () => createCodeBlockExitTransactionSourceSyncOwner({ validateMarkdown: () => true }),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createCodeBlockExitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)

console.log('PASS code block exit transaction owner: real exitCode insertion, pending/coalesced/staged provenance, BOM/CRLF tilde source insertion, and strict negative ownership')
