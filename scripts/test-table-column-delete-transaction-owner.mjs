import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { deleteColumn, tableNodes } from '@milkdown/prose/tables'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  TABLE_COLUMN_DELETE_TRANSACTION_BOUNDARY,
  TABLE_COLUMN_DELETE_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableColumnDeleteTransactionSourceSyncOwner
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
  return type.create(
    { colspan, rowspan, colwidth, align },
    paragraphs || [paragraph(value, marks)]
  )
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
} = {}) => createTableColumnDeleteTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
})

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ source, canonical, oldDoc, transactions, revision = 410 }) => {
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
  revision = 410,
  callbackDocumentEquivalent = true,
  validateMarkdown = () => true,
  resolveMarkdownOffset,
  boundary = TABLE_COLUMN_DELETE_TRANSACTION_BOUNDARY
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

const deleteColumnTransaction = (doc, columnIndex, rowIndex = 2, tableIndex = 1) => {
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(
      doc,
      textStart(doc, [tableIndex, rowIndex, columnIndex])
    )
  })
  let transaction = null
  const ok = deleteColumn(state, (value) => { transaction = value })
  assert.equal(ok, true, `deleteColumn rejected column ${columnIndex}`)
  assert.ok(transaction, `deleteColumn did not dispatch column ${columnIndex}`)
  return { state, transaction }
}

const baseRows = [
  row([
    cell('Key', 'left', { header: true }),
    cell('Value', 'center', { header: true }),
    cell('Value', 'right', { header: true }),
    cell('Note', 'left', { header: true })
  ]),
  row([
    cell('alpha', 'left'),
    cell('same', 'center'),
    cell('same', 'right'),
    cell('keep-a', 'left')
  ]),
  row([
    cell('beta', 'left'),
    cell('same', 'center'),
    cell('same', 'right'),
    cell('keep-b', 'left')
  ]),
  row([
    cell('gamma', 'left'),
    cell('same', 'center'),
    cell('same', 'right'),
    cell('keep-g', 'left')
  ]),
  row([
    cell('delta', 'left'),
    cell('same', 'center'),
    cell('same', 'right'),
    cell('keep-d', 'left')
  ])
]
const baseDoc = document(paragraph('before'), table(baseRows), paragraph('after'))
const sourceLines = [
  'before',
  '',
  '| Key    | Value | Value    | Note      |',
  '| :----- | :---: | -------: | :-------- |',
  '| alpha  | same  | same     | keep-a    |',
  '| beta | same | same | keep-b |',
  '| gamma  | same  | same     | keep-g |',
  '| delta | same | same | keep-d |',
  '',
  'after',
  ''
]
const expectedSourceLines = [
  'before',
  '',
  '| Key    | Value | Note      |',
  '| :----- | :---: | :-------- |',
  '| alpha  | same  | keep-a    |',
  '| beta | same | keep-b |',
  '| gamma  | same  | keep-g |',
  '| delta | same | keep-d |',
  '',
  'after',
  ''
]
const canonicalLines = [
  'before',
  '',
  '| Key | Value | Value | Note |',
  '| :--- | :---: | ---: | :--- |',
  '| alpha | same | same | keep-a |',
  '| beta | same | same | keep-b |',
  '| gamma | same | same | keep-g |',
  '| delta | same | same | keep-d |',
  '',
  'after',
  ''
]
const nextCanonicalLines = [
  'before',
  '',
  '| Key | Value | Note |',
  '| :--- | :---: | :--- |',
  '| alpha | same | keep-a |',
  '| beta | same | keep-b |',
  '| gamma | same | keep-g |',
  '| delta | same | keep-d |',
  '',
  'after',
  ''
]
const source = `\uFEFF${sourceLines.join('\r\n')}`
const expectedSource = `\uFEFF${expectedSourceLines.join('\r\n')}`
const canonical = canonicalLines.join('\n')
const nextCanonical = nextCanonicalLines.join('\n')

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical
  })
  assert.equal(plan.ok, true, `column delete owner rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_COLUMN_DELETE_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_COLUMN_DELETE_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-column-deleted')
  assert.equal(plan.result.markdown, expectedSource)
  assert.equal(plan.proof.kind, 'transaction-table-column-delete-proof')
  assert.deepEqual(plan.proof.tablePath, [1])
  assert.equal(plan.proof.deletedColumnIndex, 2)
  assert.equal(plan.proof.previousColumnCount, 4)
  assert.equal(plan.proof.nextColumnCount, 3)
  assert.equal(plan.proof.rowCount, 5)
  assert.deepEqual(plan.proof.deletedCellTexts, ['Value', 'same', 'same', 'same', 'same'])
  assert.equal(plan.proof.stepRanges.length, 5)
  assert.deepEqual(
    plan.proof.stepRanges.map((entry) => entry.cellPath),
    [[1, 0, 2], [1, 1, 2], [1, 2, 2], [1, 3, 2], [1, 4, 2]]
  )
  assert.equal(plan.proof.stepDetails.every((entry) => entry.name === 'ReplaceStep'), true)
  assert.equal(plan.proof.sourceLayout.edits.length, 6)
  assert.equal(
    plan.proof.sourceLayout.edits.find((entry) => entry.kind === 'delimiter')?.resultLine,
    '| :----- | :---: | :-------- |'
  )
  assert.equal(
    plan.proof.sourceLayout.edits.find((entry) => entry.kind === 'header')?.resultLine,
    '| Key    | Value | Note      |'
  )
  assert.equal(plan.proof.transactionJournal.transactionCount, 1)
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
  assert.equal(plan.result.markdown.includes('| Key    | Value | Note      |'), true)
  assert.equal(plan.result.markdown.includes('| Value    |'), false,
    'the second duplicate Value column remained after deletion')
  assert.equal(plan.result.markdown.includes('| beta | same | keep-b |'), true)
  assert.equal(plan.result.markdown.endsWith('after\r\n'), true)
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const loneCrSource = `\uFEFF${sourceLines.join('\r')}`
  const loneCrExpected = `\uFEFF${expectedSourceLines.join('\r')}`
  const { plan } = planFor({
    source: loneCrSource,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 411
  })
  assert.equal(plan.ok, true, `lone-CR column delete rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.markdown, loneCrExpected)
  assert.equal(plan.result.markdown.includes('\n'), false)
  assert.equal(plan.proof.sourceLayout.rows[0].eol, '\r')
  assert.equal(plan.proof.sourceLayout.delimiter.eol, '\r')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 412,
    boundary: 'transaction-table-column-delete-markdown-updated'
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.boundary, 'transaction-table-column-delete-markdown-updated')
  assert.equal(plan.publication.boundary, 'transaction-table-column-delete-markdown-updated')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const afterStart = beforeAtPath(transaction.doc, [2]) + 1
  transaction.insertText('X', afterStart + 'after'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 413
  })
  assert.equal(plan.ok, false,
    'column deletion plus a neighbour paragraph edit must fail closed')
}

{
  const first = deleteColumnTransaction(baseDoc, 2)
  const midState = first.state.apply(first.transaction)
  const follow = midState.tr.insertText(
    'X',
    textStart(midState.doc, [1, 2, 1]) + 'same'.length
  )
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [first.transaction, follow],
    nextCanonical,
    revision: 414
  })
  assert.equal(plan.ok, false,
    'column deletion plus a later cell edit must fail closed')
}

{
  const state = EditorState.create({ schema, doc: baseDoc })
  const target = beforeAtPath(baseDoc, [1, 2, 2])
  const targetCell = baseDoc.child(1).child(2).child(2)
  const transaction = state.tr.delete(target, target + targetCell.nodeSize)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 415
  })
  assert.equal(plan.reason, 'table-column-delete-grid-topology')
}

{
  const strong = schema.marks.strong.create()
  const markedRows = [...baseRows]
  markedRows[2] = row([
    cell('beta', 'left'),
    cell('same', 'center'),
    cell('same', 'right', { marks: [strong] }),
    cell('keep-b', 'left')
  ])
  const markedDoc = document(paragraph('before'), table(markedRows), paragraph('after'))
  const { transaction } = deleteColumnTransaction(markedDoc, 2)
  const { plan } = planFor({
    source: source.replace('| beta | same | same | keep-b |', '| beta | same | **same** | keep-b |'),
    canonical: canonical.replace('| beta | same | same | keep-b |', '| beta | same | **same** | keep-b |'),
    oldDoc: markedDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 416
  })
  assert.equal(plan.reason, 'table-column-delete-deleted-column-not-simple')
}

{
  const emptyRows = [...baseRows]
  emptyRows[2] = row([
    cell('beta', 'left'),
    cell('same', 'center'),
    cell('', 'right'),
    cell('keep-b', 'left')
  ])
  const emptyDoc = document(paragraph('before'), table(emptyRows), paragraph('after'))
  const { transaction } = deleteColumnTransaction(emptyDoc, 2)
  const { plan } = planFor({
    source: source.replace('| beta | same | same | keep-b |', '| beta | same |  | keep-b |'),
    canonical: canonical.replace('| beta | same | same | keep-b |', '| beta | same |  | keep-b |'),
    oldDoc: emptyDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 417
  })
  assert.equal(plan.reason, 'table-column-delete-deleted-column-not-simple')
}

{
  const multiRows = [...baseRows]
  multiRows[2] = row([
    cell('beta', 'left'),
    cell('same', 'center'),
    cell('ignored', 'right', { paragraphs: [paragraph('same'), paragraph('extra')] }),
    cell('keep-b', 'left')
  ])
  const multiDoc = document(paragraph('before'), table(multiRows), paragraph('after'))
  const { transaction } = deleteColumnTransaction(multiDoc, 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: multiDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 418
  })
  assert.equal(plan.reason, 'table-column-delete-grid-topology')
}

{
  const spanRows = [...baseRows]
  spanRows[2] = row([
    cell('wide', 'left', { colspan: 2 }),
    cell('same', 'right'),
    cell('keep-b', 'left')
  ])
  const spanDoc = document(paragraph('before'), table(spanRows), paragraph('after'))
  const { transaction } = deleteColumnTransaction(spanDoc, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: spanDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 419
  })
  assert.equal(plan.ok, false)
}

{
  const oneColumnRows = [
    row([cell('Only', 'left', { header: true })]),
    row([cell('one', 'left')]),
    row([cell('two', 'left')])
  ]
  const oneColumnDoc = document(paragraph('before'), table(oneColumnRows), paragraph('after'))
  const oneColumnState = EditorState.create({
    schema,
    doc: oneColumnDoc,
    selection: TextSelection.create(oneColumnDoc, textStart(oneColumnDoc, [1, 1, 0]))
  })
  let dispatched = false
  const deleted = deleteColumn(oneColumnState, () => { dispatched = true })
  assert.equal(deleted, false, 'deleteColumn must reject the table\'s sole column')
  assert.equal(dispatched, false, 'sole-column deletion must not create a transaction journal')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const { plan } = planFor({
    source: source.replace('| gamma  | same  | same     | keep-g |', '| gamma  | same  | WRONG    | keep-g |'),
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 421
  })
  assert.equal(plan.ok, false,
    'authored source text that no longer matches the PM column must fail closed')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const { plan } = planFor({
    source: source.replace('| :----- | :---: | -------: | :-------- |', '| :----- | :---: | invalid | :-------- |'),
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 422
  })
  assert.equal(plan.ok, false,
    'an invalid authored delimiter row must fail closed before raw deletion')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 423,
    resolveMarkdownOffset: () => { throw new Error('mapper') }
  })
  assert.equal(plan.reason, 'table-column-delete-source-position-mapper-threw')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: baseDoc,
    transactions: [transaction],
    nextCanonical,
    revision: 424,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'table-column-delete-semantic-document-mismatch')
}

{
  const { transaction } = deleteColumnTransaction(baseDoc, 2)
  const captured = capture({ source, canonical, oldDoc: baseDoc, transactions: [transaction], revision: 425 })
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
  assert.equal(deferred.reason, 'table-column-delete-callback-document-mismatch')
  assert.equal(deferred.deferred, true)

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 426,
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
  () => createTableColumnDeleteTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createTableColumnDeleteTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => 0
  }),
  /requires validateMarkdown/
)

console.log('PASS table column delete transaction owner: real deleteColumn multi-step journal removes one stable duplicate column and its delimiter cell, preserves authored pipes/spacing/alignment/BOM/LF/CRLF/lone-CR/other columns/rows/neighbours, and rejects partial, typed, multi-transaction, marked, empty, multi-paragraph, span, last-column, source, delimiter, semantic, callback and stale cases')
