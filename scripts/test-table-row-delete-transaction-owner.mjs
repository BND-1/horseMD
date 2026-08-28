import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { deleteRow, tableNodes } from '@milkdown/prose/tables'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  TABLE_ROW_DELETE_TRANSACTION_BOUNDARY,
  TABLE_ROW_DELETE_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableRowDeleteTransactionSourceSyncOwner
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
  const content = paragraphs || [paragraph(value, marks)]
  return type.create({ colspan, rowspan, colwidth, align }, content)
}
const row = (cells) => schema.nodes.table_row.create(null, cells)
const table = (rows) => schema.nodes.table.create(null, rows)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

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

const createOwner = ({
  validateMarkdown = () => true,
  resolveMarkdownOffset = ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark)
} = {}) => createTableRowDeleteTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
})

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ source, canonical, oldDoc, transactions, revision = 210 }) => {
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
  revision = 210,
  callbackDocumentEquivalent = true,
  validateMarkdown = () => true,
  resolveMarkdownOffset,
  boundary = TABLE_ROW_DELETE_TRANSACTION_BOUNDARY
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

const deleteRowTransaction = (doc, rowIndex, cellIndex = 0, tableIndex = 1) => {
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(
      doc,
      textStart(doc, [tableIndex, rowIndex, cellIndex]) + 1
    )
  })
  let transaction = null
  const ok = deleteRow(state, (value) => { transaction = value })
  assert.equal(ok, true, `deleteRow rejected row ${rowIndex}`)
  assert.ok(transaction, `deleteRow did not dispatch row ${rowIndex}`)
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
const expectedSourceLines = [...sourceLines]
expectedSourceLines.splice(6, 1)
const expectedSource = `\uFEFF${expectedSourceLines.join('\r\n')}`
const nextCanonicalLines = [...canonicalLines]
nextCanonicalLines.splice(6, 1)
const nextCanonical = nextCanonicalLines.join('\n')

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical
  })
  assert.equal(plan.ok, true, `row delete owner rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_ROW_DELETE_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_ROW_DELETE_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-row-deleted')
  assert.equal(plan.result.markdown, expectedSource)
  assert.equal(plan.proof.kind, 'transaction-table-row-delete-proof')
  assert.deepEqual(plan.proof.tablePath, [1])
  assert.deepEqual(plan.proof.rowPath, [1, 3])
  assert.equal(plan.proof.deletedRowIndex, 3)
  assert.equal(plan.proof.columnCount, 3)
  assert.deepEqual(plan.proof.deletedCellTexts, ['same', 'beta', 'repeated'])
  assert.equal(plan.proof.stepDetail.name, 'ReplaceStep')
  assert.equal(plan.proof.stepDetail.sliceSize, 0)
  assert.equal(plan.proof.sourceRange.rawLine, '| same  | beta  | repeated  |')
  assert.equal(plan.proof.sourceRange.eol, '\r\n')
  assert.equal(plan.proof.previousCanonicalRange.rawLine, '| same | beta | repeated |')
  assert.equal(plan.proof.transactionJournal.transactionCount, 1)
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
  assert.equal(plan.result.markdown.includes('| same | beta | repeated |'), true,
    'the first semantically duplicate authored row was removed instead of the selected occurrence')
  assert.equal(plan.result.markdown.includes('| gamma | three | keep-g |'), true)
  assert.equal(plan.result.markdown.endsWith(`after\r\n`), true)
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 224,
    boundary: 'transaction-table-row-delete-markdown-updated'
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.boundary, 'transaction-table-row-delete-markdown-updated')
  assert.equal(plan.publication.boundary, 'transaction-table-row-delete-markdown-updated')
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const loneCrSource = `\uFEFF${sourceLines.join('\r')}`
  const loneCrExpectedLines = [...sourceLines]
  loneCrExpectedLines.splice(6, 1)
  const loneCrExpected = `\uFEFF${loneCrExpectedLines.join('\r')}`
  const { plan } = planFor({
    source: loneCrSource,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 225
  })
  assert.equal(plan.ok, true, `lone-CR row delete rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.markdown, loneCrExpected)
  assert.equal(plan.proof.sourceRange.eol, '\r')
  assert.equal(plan.result.markdown.includes('\n'), false)
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 0, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 211
  })
  assert.equal(plan.reason, 'table-row-delete-header-row')
}

{
  const oneBodyDoc = document(
    paragraph('before'),
    table([baseRows[0], baseRows[1]]),
    paragraph('after')
  )
  const { transaction } = deleteRowTransaction(oneBodyDoc, 1, 0)
  const { plan } = planFor({
    source: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n\nafter\n',
    canonical: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n\nafter\n',
    oldDoc: oneBodyDoc,
    transactions: [transaction],
    nextCanonical: 'before\n\nafter\n',
    revision: 212
  })
  assert.equal(plan.reason, 'table-row-delete-last-body-row')
}

{
  const state = EditorState.create({ schema, doc: baseDoc })
  const from = beforeAtPath(baseDoc, [1, 1])
  const to = beforeAtPath(baseDoc, [1, 3])
  const transaction = state.tr.delete(from, to)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 213
  })
  assert.equal(plan.reason, 'table-row-delete-row-count')
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const afterParagraphStart = beforeAtPath(transaction.doc, [2]) + 1
  transaction.insertText('X', afterParagraphStart + 'after'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 214
  })
  assert.equal(plan.ok, false)
}

{
  const first = deleteRowTransaction(baseDoc, 3, 1)
  const midState = first.state.apply(first.transaction)
  const second = midState.tr.insertText(
    'X',
    textStart(midState.doc, [1, 3, 0]) + 'gamma'.length
  )
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [first.transaction, second],
    nextCanonical,
    revision: 215
  })
  assert.equal(plan.reason, 'table-row-delete-transaction-count')
}

{
  const strong = schema.marks.strong.create()
  const markedDoc = document(
    paragraph('before'),
    table([
      baseRows[0],
      baseRows[1],
      row([cell('marked', 'left', { marks: [strong] }), cell('two', 'right'), cell('note', 'left')]),
      baseRows[4]
    ]),
    paragraph('after')
  )
  const { transaction } = deleteRowTransaction(markedDoc, 2, 0)
  const { plan } = planFor({
    source: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n| **marked** | two | note |\n| gamma | three | keep-g |\n\nafter\n',
    canonical: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n| **marked** | two | note |\n| gamma | three | keep-g |\n\nafter\n',
    oldDoc: markedDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 216
  })
  assert.equal(plan.reason, 'table-row-delete-deleted-row-not-simple')
}

{
  const emptyDoc = document(
    paragraph('before'),
    table([
      baseRows[0],
      baseRows[1],
      row([cell('', 'left'), cell('two', 'right'), cell('note', 'left')]),
      baseRows[4]
    ]),
    paragraph('after')
  )
  const { transaction } = deleteRowTransaction(emptyDoc, 2, 1)
  const { plan } = planFor({
    source: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n|  | two | note |\n| gamma | three | keep-g |\n\nafter\n',
    canonical: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n|  | two | note |\n| gamma | three | keep-g |\n\nafter\n',
    oldDoc: emptyDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 217
  })
  assert.equal(plan.reason, 'table-row-delete-deleted-row-not-simple')
}

{
  const multiParagraphDoc = document(
    paragraph('before'),
    table([
      baseRows[0],
      baseRows[1],
      row([
        cell('ignored', 'left', { paragraphs: [paragraph('one'), paragraph('two')] }),
        cell('two', 'right'),
        cell('note', 'left')
      ]),
      baseRows[4]
    ]),
    paragraph('after')
  )
  const { transaction } = deleteRowTransaction(multiParagraphDoc, 2, 1)
  const multiParagraphSource = 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| alpha | one | keep-a |\n| one two | two | note |\n| gamma | three | keep-g |\n\nafter\n'
  const { plan } = planFor({
    source: multiParagraphSource,
    canonical: multiParagraphSource,
    oldDoc: multiParagraphDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 226
  })
  assert.equal(plan.reason, 'table-row-delete-grid-topology')
}

{
  const spanDoc = document(
    paragraph('before'),
    table([
      baseRows[0],
      row([
        cell('wide', 'left', { colspan: 2 }),
        cell('note', 'left')
      ]),
      baseRows[4]
    ]),
    paragraph('after')
  )
  const { transaction } = deleteRowTransaction(spanDoc, 1, 0)
  const { plan } = planFor({
    source: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| wide | note |\n| gamma | three | keep-g |\n\nafter\n',
    canonical: 'before\n\n| Key | Value | Note |\n| --- | --- | --- |\n| wide | note |\n| gamma | three | keep-g |\n\nafter\n',
    oldDoc: spanDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 218
  })
  assert.equal(plan.reason, 'table-row-delete-grid-topology')
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const { plan } = planFor({
    source: source.replace('| same  | beta  | repeated  |', '| same  | WRONG | repeated  |'),
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 219
  })
  assert.equal(plan.ok, false)
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 220,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'table-row-delete-semantic-document-mismatch')
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 221,
    resolveMarkdownOffset: () => { throw new Error('mapper') }
  })
  assert.equal(plan.reason, 'table-row-delete-source-position-mapper-threw')
}

{
  const { transaction } = deleteRowTransaction(baseDoc, 3, 1)
  const captured = capture({ source, canonical, oldDoc: baseDoc, transactions: [transaction], revision: 222 })
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
  assert.equal(deferred.reason, 'table-row-delete-callback-document-mismatch')
  assert.equal(deferred.deferred, true)

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 223,
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
  () => createTableRowDeleteTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createTableRowDeleteTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => 0
  }),
  /requires validateMarkdown/
)

console.log('PASS table row delete transaction owner: real deleteRow ReplaceStep removes one stable duplicate body-row occurrence, preserves authored table spacing/alignment/BOM/LF/CRLF/lone-CR/other rows/neighbours, and rejects header, last-body, multi-row, multi-transaction, marked, empty, multi-paragraph, span, source, semantic, callback and stale cases')
