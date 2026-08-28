import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { addRowAfter, tableNodes } from '@milkdown/prose/tables'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  TABLE_ROW_INSERT_TRANSACTION_BOUNDARY,
  TABLE_ROW_INSERT_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableRowInsertTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/index.js'

const tableNodeSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph+',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => dom.getAttribute('data-align'),
      setDOMAttr: (value, attrs) => {
        if (value) attrs['data-align'] = value
      }
    }
  }
})

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardbreak: { inline: true, group: 'inline', atom: true },
    ...tableNodeSpecs
  },
  marks: { strong: {} }
})

const remark = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const text = (value, marks = null) => value ? schema.text(value, marks) : null
const paragraph = (value = '', marks = null) => schema.nodes.paragraph.create(
  null,
  value ? text(value, marks) : null
)
const cell = (value, align = null, {
  header = false,
  marks = null,
  colspan = 1,
  rowspan = 1,
  colwidth = null,
  paragraphs = null
} = {}) => {
  const type = header ? schema.nodes.table_header : schema.nodes.table_cell
  return type.create(
    { colspan, rowspan, colwidth, align },
    paragraphs || [paragraph(value, marks)]
  )
}
const row = (cells) => schema.nodes.table_row.create(null, cells)
const table = (rows) => schema.nodes.table.create(null, rows)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)
const emptyRow = (columns) => row(Array.from({ length: columns }, () => cell('')))

const beforeAtPath = (doc, path) => {
  let parent = doc
  let before = 0
  for (let depth = 0; depth < path.length; depth += 1) {
    let offset = 0
    for (let index = 0; index < path[depth]; index += 1) {
      offset += parent.child(index).nodeSize
    }
    before = depth === 0 ? offset : before + 1 + offset
    parent = parent.child(path[depth])
  }
  return before
}
const textStart = (doc, path) => beforeAtPath(doc, path) + 2

const blankFromAuthoredLine = (line, values) => {
  let result = line
  let searchFrom = 0
  const spans = []
  for (const value of values) {
    const start = result.indexOf(value, searchFrom)
    assert.ok(start >= 0, `missing ${value} in authored row ${line}`)
    spans.push({ start, end: start + value.length })
    searchFrom = start + value.length
  }
  for (const span of spans.reverse()) {
    result = result.slice(0, span.start) + result.slice(span.end)
  }
  return result
}

const createOwner = ({
  validateMarkdown = () => true,
  resolveMarkdownOffset = ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark)
} = {}) => createTableRowInsertTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
})

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ source, canonical, oldDoc, transactions, revision = 310 }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc })
  let checkpoint = null
  let currentDoc = oldDoc
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

const planFor = ({
  source,
  canonical,
  oldDoc,
  transactions,
  nextCanonical,
  revision = 310,
  callbackDocumentEquivalent = true,
  validateMarkdown = () => true,
  resolveMarkdownOffset,
  boundary = TABLE_ROW_INSERT_TRANSACTION_BOUNDARY
}) => {
  const captured = capture({ source, canonical, oldDoc, transactions, revision })
  const owner = createOwner({ validateMarkdown, resolveMarkdownOffset })
  return {
    ...captured,
    owner,
    plan: owner.plan({
      journal: captured.journal,
      activeJournal: captured.journal,
      snapshot: captured.snapshot,
      currentSource: source,
      currentCanonical: canonical,
      canonical: nextCanonical,
      expectedDoc: captured.expectedDoc,
      callbackDocumentEquivalent,
      boundary
    })
  }
}

const addAfterTransaction = (doc, rowIndex, tableIndex = 1) => {
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, textStart(doc, [tableIndex, rowIndex, 0]) + 1)
  })
  let transaction = null
  const ok = addRowAfter(state, (value) => { transaction = value })
  assert.equal(ok, true, `addRowAfter rejected row ${rowIndex}`)
  assert.ok(transaction, `addRowAfter did not dispatch row ${rowIndex}`)
  return { state, transaction }
}

const baseRows = [
  row([
    cell('Key', 'left', { header: true }),
    cell('Value', 'right', { header: true }),
    cell('Note', 'left', { header: true })
  ]),
  row([cell('alpha', 'left'), cell('one', 'right'), cell('keep-a', 'left')]),
  row([cell('same', 'left'), cell('beta', 'right'), cell('repeated', 'left')]),
  row([cell('same', 'left'), cell('beta', 'right'), cell('repeated', 'left')]),
  row([cell('gamma', 'left'), cell('three', 'right'), cell('keep-g', 'left')])
]
const baseDoc = document(paragraph('before'), table(baseRows), paragraph('after'))
const sourceLines = [
  'before',
  '',
  '| Key   | Value | Note     |',
  '| :---- | ----: | :------- |',
  '| alpha | one   | keep-a   |',
  '| same | beta | repeated |',
  '| same  | beta  | repeated  |',
  '| gamma | three | keep-g |',
  '',
  'after',
  ''
]
const canonicalLines = [
  'before',
  '',
  '| Key | Value | Note |',
  '| :--- | ---: | :--- |',
  '| alpha | one | keep-a |',
  '| same | beta | repeated |',
  '| same | beta | repeated |',
  '| gamma | three | keep-g |',
  '',
  'after',
  ''
]
const source = `\uFEFF${sourceLines.join('\r\n')}`
const canonical = canonicalLines.join('\n')
const templateLine = sourceLines[6]
const blankTemplateLine = blankFromAuthoredLine(templateLine, ['same', 'beta', 'repeated'])
const expectedLines = [...sourceLines]
expectedLines.splice(7, 0, blankTemplateLine)
const expectedSource = `\uFEFF${expectedLines.join('\r\n')}`
const nextCanonicalLines = [...canonicalLines]
nextCanonicalLines.splice(7, 0, '|  |  |  |')
const nextCanonical = nextCanonicalLines.join('\n')

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical
  })
  assert.equal(plan.ok, true, `row insert owner rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_ROW_INSERT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_ROW_INSERT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-row-inserted')
  assert.equal(plan.result.markdown, expectedSource)
  assert.equal(plan.proof.kind, 'transaction-table-row-insert-proof')
  assert.deepEqual(plan.proof.tablePath, [1])
  assert.deepEqual(plan.proof.insertedRowPath, [1, 4])
  assert.equal(plan.proof.insertedRowIndex, 4)
  assert.deepEqual(plan.proof.templateRowPath, [1, 3])
  assert.equal(plan.proof.templateRowIndex, 3)
  assert.equal(plan.proof.columnCount, 3)
  assert.equal(plan.proof.stepDetail.name, 'ReplaceStep')
  assert.equal(plan.proof.stepRange.from, plan.proof.stepRange.to)
  assert.equal(plan.proof.stepRange.sliceSize > 0, true)
  assert.equal(plan.proof.sourceTemplateRange.rawLine, templateLine)
  assert.equal(plan.proof.sourceTemplateRange.blankLine, blankTemplateLine)
  assert.equal(plan.proof.sourceTemplateRange.eol, '\r\n')
  assert.equal(plan.proof.insertion.placement, 'after-template-row')
  assert.equal(plan.proof.insertion.eol, '\r\n')
  assert.equal(plan.proof.transactionJournal.transactionCount, 1)
  assert.equal(plan.result.markdown.includes('| same | beta | repeated |'), true)
  assert.equal(plan.result.markdown.includes(templateLine), true)
  assert.equal(plan.result.markdown.includes('| gamma | three | keep-g |'), true)
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
}

{
  const { transaction } = addAfterTransaction(baseDoc, 0)
  const firstBodyTemplate = sourceLines[4]
  const firstBodyBlank = blankFromAuthoredLine(firstBodyTemplate, ['alpha', 'one', 'keep-a'])
  const expected = [...sourceLines]
  expected.splice(4, 0, firstBodyBlank)
  const { plan } = planFor({
    source: source.replaceAll('\r\n', '\n'),
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 311
  })
  assert.equal(plan.ok, true, `first-body insert rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.insertedRowIndex, 1)
  assert.equal(plan.proof.templateRowIndex, 1)
  assert.equal(plan.proof.insertion.placement, 'before-first-body-row')
  assert.equal(plan.result.markdown, `\uFEFF${expected.join('\n')}`)
}

{
  const tailDoc = document(paragraph('before'), table(baseRows))
  const tailLines = [
    'before',
    '',
    '| Key | Value | Note |',
    '| --- | --- | --- |',
    '| alpha | one | keep-a |',
    '| same | beta | repeated |',
    '| same | beta | repeated |',
    '| gamma  | three  | keep-g  |'
  ]
  const tailSource = `\uFEFF${tailLines.join('\r')}`
  const tailCanonical = tailLines.join('\n')
  const tailBlank = blankFromAuthoredLine(tailLines.at(-1), ['gamma', 'three', 'keep-g'])
  const { transaction } = addAfterTransaction(tailDoc, 4)
  const { plan } = planFor({
    source: tailSource,
    canonical: tailCanonical,
    oldDoc: tailDoc,
    transactions: [transaction],
    nextCanonical: `${tailCanonical}\n|  |  |  |`,
    revision: 312
  })
  assert.equal(plan.ok, true, `EOF lone-CR append rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.insertedRowIndex, 5)
  assert.equal(plan.proof.templateRowIndex, 4)
  assert.equal(plan.proof.insertion.placement, 'append-after-unterminated-row')
  assert.equal(plan.proof.insertion.eol, '\r')
  assert.equal(plan.result.markdown, `${tailSource}\r${tailBlank}`)
  assert.equal(plan.result.markdown.includes('\n'), false)
}

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 313,
    boundary: 'transaction-table-row-insert-markdown-updated'
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.boundary, 'transaction-table-row-insert-markdown-updated')
  assert.equal(plan.publication.boundary, 'transaction-table-row-insert-markdown-updated')
}

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const insertedTextStart = beforeAtPath(transaction.doc, [1, 4, 0]) + 2
  transaction.insertText('X', insertedTextStart)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 314
  })
  assert.equal(plan.reason, 'table-row-insert-step-count')
}

{
  const first = addAfterTransaction(baseDoc, 3)
  const midState = first.state.apply(first.transaction)
  const follow = midState.tr.insertText('X', beforeAtPath(midState.doc, [1, 4, 0]) + 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [first.transaction, follow],
    nextCanonical,
    revision: 315
  })
  assert.equal(plan.reason, 'table-row-insert-transaction-count')
}

{
  const state = EditorState.create({ schema, doc: baseDoc })
  const boundary = beforeAtPath(baseDoc, [1, 4])
  const transaction = state.tr.insert(
    boundary,
    row([cell('new'), cell('row'), cell('text')])
  )
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 316
  })
  assert.equal(plan.reason, 'table-row-insert-owned-row-count')
}

{
  const state = EditorState.create({ schema, doc: baseDoc })
  const boundary = beforeAtPath(baseDoc, [1, 4])
  const transaction = state.tr.insert(
    boundary,
    row([cell('', null, { colspan: 2 }), cell('')])
  )
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 317
  })
  assert.equal(plan.reason, 'table-row-insert-grid-topology')
}

{
  const strong = schema.marks.strong.create()
  const markedRows = [...baseRows]
  markedRows[3] = row([
    cell('same', 'left', { marks: [strong] }),
    cell('beta', 'right'),
    cell('repeated', 'left')
  ])
  const markedDoc = document(paragraph('before'), table(markedRows), paragraph('after'))
  const { transaction } = addAfterTransaction(markedDoc, 3)
  const { plan } = planFor({
    source: source.replace(templateLine, '| **same**  | beta  | repeated  |'),
    canonical: canonical.replace('| same | beta | repeated |\n| gamma', '| **same** | beta | repeated |\n| gamma'),
    oldDoc: markedDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 318
  })
  assert.equal(plan.reason, 'table-row-insert-template-row-not-simple')
}

{
  const emptyRows = [...baseRows]
  emptyRows[3] = emptyRow(3)
  const emptyDoc = document(paragraph('before'), table(emptyRows), paragraph('after'))
  const { transaction } = addAfterTransaction(emptyDoc, 3)
  const { plan } = planFor({
    source: source.replace(templateLine, '|  |  |  |'),
    canonical: canonical.replace('| same | beta | repeated |\n| gamma', '|  |  |  |\n| gamma'),
    oldDoc: emptyDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 319
  })
  assert.equal(plan.reason, 'table-row-insert-template-row-not-simple')
}

{
  const multiRows = [...baseRows]
  multiRows[3] = row([
    cell('same', 'left', { paragraphs: [paragraph('same'), paragraph('extra')] }),
    cell('beta', 'right'),
    cell('repeated', 'left')
  ])
  const multiDoc = document(paragraph('before'), table(multiRows), paragraph('after'))
  const { transaction } = addAfterTransaction(multiDoc, 3)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: multiDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 320
  })
  assert.equal(plan.reason, 'table-row-insert-grid-topology')
}

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const { plan } = planFor({
    source: source.replace(templateLine, '| WRONG | beta  | repeated  |'),
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 321
  })
  assert.equal(plan.ok, false)
}

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 322,
    resolveMarkdownOffset: () => { throw new Error('mapper') }
  })
  assert.equal(plan.reason, 'table-row-insert-source-position-mapper-threw')
}

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 323,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'table-row-insert-semantic-document-mismatch')
}

{
  const { transaction } = addAfterTransaction(baseDoc, 3)
  const captured = capture({ source, canonical, oldDoc: baseDoc, transactions: [transaction], revision: 324 })
  const owner = createOwner()
  const deferred = owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical: nextCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  })
  assert.equal(deferred.reason, 'table-row-insert-callback-document-mismatch')
  assert.equal(deferred.deferred, true)

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 325,
    source,
    canonical,
    doc: captured.expectedDoc
  })
  const stale = owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: staleSnapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical: nextCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(
  () => createTableRowInsertTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createTableRowInsertTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => 0
  }),
  /requires validateMarkdown/
)

console.log('PASS table row insert transaction owner: real addRowAfter ReplaceStep inserts one stable empty body row from the selected author-row template, preserves duplicate occurrence/table spacing/alignment/BOM/LF/CRLF/lone-CR/EOF/other rows/neighbours, and rejects typed, multi-transaction, non-empty, span, marked, empty-template, multi-paragraph, source, semantic, callback and stale cases')
