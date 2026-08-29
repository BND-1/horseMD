import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_BOUNDARY,
  EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY,
  createEmptyCodeBlockUnpackTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } },
    paragraph: { content: 'text*', group: 'block' },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      attrs: { language: { default: null } }
    },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})
const remark = unified().use(remarkParse)
const text = (value, marks = null) => value ? schema.text(value, marks || undefined) : null
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
const paragraph = (value = '', marks = null) =>
  schema.nodes.paragraph.create(null, text(value, marks))
const code = (value = '', language = null) =>
  schema.nodes.code_block.create({ language }, text(value))
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const topLevelStart = (doc, targetIndex) => {
  let result = null
  doc.forEach((node, offset, index) => {
    if (index === targetIndex) result = offset
  })
  assert.notEqual(result, null)
  return result
}

const source = '\uFEFF# Heading\r\n\r\n~~~js\r\n\r\n~~~\r\n\r\ntail\r\n'
const canonical = '# Heading\n\n```js\n```\n\ntail\n'
const oldDoc = document(heading('Heading'), code('', 'js'), paragraph('tail'))
const blockStart = topLevelStart(oldDoc, 1)
const unwrap = EditorState.create({ schema, doc: oldDoc }).tr.replaceWith(
  blockStart,
  blockStart + oldDoc.child(1).nodeSize,
  paragraph()
)
assert.equal(unwrap.steps[0]?.constructor?.name, 'ReplaceStep')
const emptyDoc = unwrap.doc
const insertX = EditorState.create({ schema, doc: emptyDoc }).tr.insertText('X', blockStart + 1)
const xDoc = insertX.doc
const insertY = EditorState.create({ schema, doc: xDoc }).tr.insertText('Y', blockStart + 2)
const xyDoc = insertY.doc
const emptyCanonical = '# Heading\n\n<br />\n\ntail\n'
const xyCanonical = '# Heading\n\nXY\n\ntail\n'
const emptyExpected = '\uFEFF# Heading\r\n\r\n\r\n\r\ntail\r\n'
const xyExpected = '\uFEFF# Heading\r\n\r\nXY\r\n\r\ntail\r\n'

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ baseline = oldDoc, transactions, revision = 810 }) => {
  const snapshot = createSourceSyncSnapshot({
    revision,
    source,
    canonical,
    doc: baseline
  })
  let checkpoint = null
  let currentDoc = baseline
  for (const transaction of transactions) {
    const captured = journalFactory.captureOrAdvance({
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
  return { snapshot, journal: checkpoint, expectedDoc: currentDoc }
}

const ownerFor = (validateMarkdown = ({ markdown, expectedDoc }) => {
  const target = expectedDoc.child(1)
  return markdown === (target.textContent ? xyExpected : emptyExpected)
}) => createEmptyCodeBlockUnpackTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
  validateMarkdown
})

const planFor = ({
  baseline = oldDoc,
  transactions,
  nextCanonical,
  boundary = EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_BOUNDARY,
  revision = 810,
  currentSource = source,
  currentCanonical = canonical,
  callbackDocumentEquivalent = true,
  validateMarkdown
}) => {
  const captured = capture({ baseline, transactions, revision })
  const owner = ownerFor(validateMarkdown)
  return {
    ...captured,
    owner,
    plan: owner.plan({
      journal: captured.journal,
      activeJournal: captured.journal,
      snapshot: captured.snapshot,
      currentSource,
      currentCanonical,
      canonical: nextCanonical,
      expectedDoc: captured.expectedDoc,
      callbackDocumentEquivalent,
      boundary
    })
  }
}

{
  const { plan } = planFor({
    transactions: [unwrap],
    nextCanonical: emptyCanonical,
    boundary: 'transaction-empty-code-block-unpack-markdown-updated'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'empty-code-block-unpack-awaiting-content')
  assert.equal(plan.deferred, true)
  assert.equal(plan.holdJournal, true)
  assert.notEqual(plan.recognized, true,
    'pending empty paragraph must hold the journal without failing closed')
  assert.equal(plan.proof.kind, 'transaction-empty-code-block-unpack-proof')
  assert.equal(plan.proof.mode, 'pending-empty')
  assert.equal(plan.proof.finalText, '')
  assert.equal(plan.proof.rawReplacement.replacement, '\r\n')
  assert.equal(plan.proof.stepRanges.length, 1)
}

{
  const { plan } = planFor({
    transactions: [unwrap],
    nextCanonical: emptyCanonical,
    boundary: 'transaction-empty-code-block-unpack-forced-flush',
    revision: 811
  })
  assert.equal(plan.ok, true, `forced empty plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY)
  assert.equal(plan.result.reason, 'empty-fenced-code-block-backspace-unpack')
  assert.equal(plan.result.markdown, emptyExpected)
  assert.equal(plan.proof.mode, 'forced-empty')
  assert.equal(plan.proof.rawReplacement.eol, '\r\n')
  assert.equal(plan.result.markdown.includes('<br'), false)
}

{
  const { plan } = planFor({
    transactions: [unwrap, insertX, insertY],
    nextCanonical: xyCanonical,
    boundary: 'transaction-empty-code-block-unpack-markdown-updated',
    revision: 812
  })
  assert.equal(plan.ok, true, `coalesced plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.family, EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, 'transaction-empty-code-block-unpack-markdown-updated')
  assert.equal(plan.result.markdown, xyExpected)
  assert.equal(plan.proof.mode, 'coalesced-text')
  assert.equal(plan.proof.topLevelIndex, 1)
  assert.equal(plan.proof.language, 'js')
  assert.equal(plan.proof.finalText, 'XY')
  assert.equal(plan.proof.stepRanges.length, 3)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, [
    'ReplaceStep', 'ReplaceStep', 'ReplaceStep'
  ])
  assert.equal(plan.proof.sourceRange.char, '~')
  assert.equal(plan.proof.previousRange.char, '`')
  assert.equal(plan.proof.rawReplacement.replacement, 'XY\r\n')
}

{
  const nonemptyDoc = document(heading('Heading'), code('old', 'js'), paragraph('tail'))
  const start = topLevelStart(nonemptyDoc, 1)
  const transaction = EditorState.create({ schema, doc: nonemptyDoc }).tr.replaceWith(
    start,
    start + nonemptyDoc.child(1).nodeSize,
    paragraph()
  )
  const { plan } = planFor({
    baseline: nonemptyDoc,
    transactions: [transaction],
    nextCanonical: emptyCanonical,
    revision: 813
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-source-not-empty')
  assert.notEqual(plan.recognized, true)
}

{
  const direct = EditorState.create({ schema, doc: oldDoc }).tr.replaceWith(
    blockStart,
    blockStart + oldDoc.child(1).nodeSize,
    paragraph('direct')
  )
  const { plan } = planFor({
    transactions: [direct],
    nextCanonical: '# Heading\n\ndirect\n\ntail\n',
    revision: 814,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-replacement-step')
}

{
  const { snapshot, journal, expectedDoc } = capture({
    transactions: [unwrap, insertX, insertY],
    revision: 815
  })
  const mismatchedOwner = createEmptyCodeBlockUnpackTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown: () => true
  })
  const mismatchedSource = source.replace('\r\n\r\n~~~\r\n', '\r\nhidden\r\n~~~\r\n')
  const staleSnapshot = createSourceSyncSnapshot({
    revision: snapshot.revision,
    source: mismatchedSource,
    canonical,
    doc: oldDoc
  })
  const plan = mismatchedOwner.plan({
    journal: { ...journal, source: mismatchedSource, baseSourceDigest: staleSnapshot.sourceDigest },
    activeJournal: null,
    snapshot: staleSnapshot,
    currentSource: mismatchedSource,
    currentCanonical: canonical,
    canonical: xyCanonical,
    expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-journal-stale')
}

{
  const languageSource = source.replace('~~~js', '~~~ts')
  const captured = capture({ transactions: [unwrap, insertX, insertY], revision: 816 })
  const languageSnapshot = createSourceSyncSnapshot({
    revision: 816,
    source: languageSource,
    canonical,
    doc: oldDoc
  })
  const journal = Object.freeze({
    ...captured.journal,
    source: languageSource,
    baseSourceDigest: languageSnapshot.sourceDigest
  })
  const plan = ownerFor(() => true).plan({
    journal,
    activeJournal: journal,
    snapshot: languageSnapshot,
    currentSource: languageSource,
    currentCanonical: canonical,
    canonical: xyCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-language-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const tailPos = topLevelStart(xyDoc, 2) + 1 + 'tail'.length
  const outside = EditorState.create({ schema, doc: xyDoc }).tr.insertText('!', tailPos)
  const { plan } = planFor({
    transactions: [unwrap, insertX, insertY, outside],
    nextCanonical: '# Heading\n\nXY\n\ntail!\n',
    revision: 817,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-top-level-change-count')
}

{
  const strong = schema.marks.strong.create()
  const marked = EditorState.create({ schema, doc: emptyDoc }).tr.replaceWith(
    blockStart + 1,
    blockStart + 1,
    schema.text('X', [strong])
  )
  const { plan } = planFor({
    transactions: [unwrap, marked],
    nextCanonical: '# Heading\n\n**X**\n\ntail\n',
    revision: 818,
    validateMarkdown: () => true
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-result-not-plain-paragraph')
}

{
  const { plan } = planFor({
    transactions: [unwrap, insertX, insertY],
    nextCanonical: xyCanonical,
    revision: 819,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-semantic-document-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const { plan } = planFor({
    transactions: [unwrap, insertX, insertY],
    nextCanonical: xyCanonical,
    revision: 820,
    callbackDocumentEquivalent: false
  })
  assert.equal(plan.reason, 'empty-code-block-unpack-callback-document-mismatch')
  assert.equal(plan.deferred, true)
  assert.notEqual(plan.recognized, true)
}

{
  const captured = capture({ transactions: [unwrap, insertX, insertY], revision: 821 })
  const staleSnapshot = createSourceSyncSnapshot({
    revision: 822,
    source,
    canonical,
    doc: captured.expectedDoc
  })
  const plan = ownerFor().plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: staleSnapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical: xyCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.reason, 'transaction-journal-revision-stale')
  assert.equal(plan.reset, true)
}

assert.throws(
  () => createEmptyCodeBlockUnpackTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createEmptyCodeBlockUnpackTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => 0
  }),
  /requires validateMarkdown/
)

console.log('PASS empty code block unpack owner: real code_block→paragraph ReplaceStep, pending journal hold, forced-empty and coalesced text raw fence removal, with strict source/language/neighbour/mark/semantic/stale rejection')
