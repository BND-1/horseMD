import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { CellSelection, TableMap, setCellAttr, tableNodes } from '@milkdown/prose/tables'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  TABLE_COLUMN_ALIGNMENT_TRANSACTION_BOUNDARY,
  TABLE_COLUMN_ALIGNMENT_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableColumnAlignmentTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/index.js'

const tableNodeSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph+',
  cellAttributes: {
    alignment: {
      default: 'left',
      getFromDOM: (dom) => dom.getAttribute('data-alignment') || 'left',
      setDOMAttr: (value, attrs) => {
        if (value) attrs['data-alignment'] = value
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
const cell = (value, alignment = 'left', {
  header = false,
  marks = null,
  colspan = 1,
  rowspan = 1,
  colwidth = null,
  paragraphs = null
} = {}) => {
  const type = header ? schema.nodes.table_header : schema.nodes.table_cell
  return type.create(
    { colspan, rowspan, colwidth, alignment },
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

const alignmentTransaction = (doc, columnIndex, alignment, tableIndex = 1) => {
  const targetTable = doc.child(tableIndex)
  const map = TableMap.get(targetTable)
  const tableStart = beforeAtPath(doc, [tableIndex]) + 1
  const first = doc.resolve(tableStart + map.positionAt(0, columnIndex, targetTable))
  const last = doc.resolve(
    tableStart + map.positionAt(map.height - 1, columnIndex, targetTable)
  )
  const selection = CellSelection.colSelection(last, first)
  const state = EditorState.create({ schema, doc, selection })
  let transaction = null
  const ok = setCellAttr('alignment', alignment)(state, (value) => {
    transaction = value
  })
  assert.equal(ok, true, `setCellAttr rejected column ${columnIndex}`)
  assert.ok(transaction, `setCellAttr did not dispatch column ${columnIndex}`)
  return { state, transaction }
}

const singleCellAlignmentTransaction = (doc, rowIndex, columnIndex, alignment, tableIndex = 1) => {
  const cellStart = beforeAtPath(doc, [tableIndex, rowIndex, columnIndex]) + 2
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, cellStart)
  })
  let transaction = null
  const ok = setCellAttr('alignment', alignment)(state, (value) => {
    transaction = value
  })
  assert.equal(ok, true)
  assert.ok(transaction)
  return { state, transaction }
}

const twoColumnAlignmentTransaction = (doc, leftColumn, rightColumn, alignment, tableIndex = 1) => {
  const targetTable = doc.child(tableIndex)
  const map = TableMap.get(targetTable)
  const tableStart = beforeAtPath(doc, [tableIndex]) + 1
  const first = doc.resolve(tableStart + map.positionAt(0, leftColumn, targetTable))
  const last = doc.resolve(
    tableStart + map.positionAt(map.height - 1, rightColumn, targetTable)
  )
  const selection = new CellSelection(last, first)
  const state = EditorState.create({ schema, doc, selection })
  let transaction = null
  const ok = setCellAttr('alignment', alignment)(state, (value) => {
    transaction = value
  })
  assert.equal(ok, true)
  assert.ok(transaction)
  return { state, transaction }
}

const createOwner = ({
  validateMarkdown = () => true,
  resolveMarkdownOffset = ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark)
} = {}) => createTableColumnAlignmentTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
})

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ source, canonical, oldDoc, transactions, revision = 610 }) => {
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
  revision = 610,
  callbackDocumentEquivalent = true,
  validateMarkdown = () => true,
  resolveMarkdownOffset,
  boundary = TABLE_COLUMN_ALIGNMENT_TRANSACTION_BOUNDARY
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
const oldDoc = document(
  paragraph('before table'),
  table(baseRows),
  paragraph('after table')
)

const sourceLines = [
  'before table',
  '',
  '| Key    | Value | Value    | Note      |',
  '| :----- | :---: | -------: | :-------- |',
  '| alpha  | same  | same     | keep-a    |',
  '| beta | same | same | keep-b |',
  '| gamma  | same  | same     | keep-g |',
  '| delta | same | same | keep-d |',
  '',
  'after table',
  ''
]
const source = `\uFEFF${sourceLines.join('\r\n')}`
const canonical = [
  'before table',
  '',
  '| Key | Value | Value | Note |',
  '| :--- | :---: | ---: | :--- |',
  '| alpha | same | same | keep-a |',
  '| beta | same | same | keep-b |',
  '| gamma | same | same | keep-g |',
  '| delta | same | same | keep-d |',
  '',
  'after table',
  ''
].join('\n')

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const nextCanonical = canonical.replace(
    '| :--- | :---: | ---: | :--- |',
    '| :--- | :---: | :---: | :--- |'
  )
  const expected = source.replace(
    '| :----- | :---: | -------: | :-------- |',
    '| :----- | :---: | :-------: | :-------- |'
  )
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical
  })
  assert.equal(plan.ok, true, `alignment plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_COLUMN_ALIGNMENT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_COLUMN_ALIGNMENT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-column-alignment-changed')
  assert.equal(plan.result.markdown, expected)
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
  assert.equal(plan.result.markdown.includes('\r\n'), true)
  assert.equal(plan.result.markdown.includes('| Key    | Value | Value    | Note      |'), true)
  assert.equal(plan.result.markdown.includes('| alpha  | same  | same     | keep-a    |'), true)
  assert.equal(plan.proof.kind, 'transaction-table-column-alignment-proof')
  assert.deepEqual(plan.proof.tablePath, [1])
  assert.equal(plan.proof.columnIndex, 2)
  assert.equal(plan.proof.previousAlignment, 'right')
  assert.equal(plan.proof.nextAlignment, 'center')
  assert.equal(plan.proof.columnCount, 4)
  assert.equal(plan.proof.rowCount, 5)
  assert.equal(plan.proof.stepRanges.length, 5)
  assert.deepEqual(
    plan.proof.stepRanges.map((entry) => entry.cellPath),
    [[1, 0, 2], [1, 1, 2], [1, 2, 2], [1, 3, 2], [1, 4, 2]]
  )
  assert.equal(
    plan.proof.stepRanges.every((entry) => entry.stepName === 'ReplaceAroundStep'),
    true
  )
  assert.deepEqual(
    plan.proof.transactionJournal.stepNames,
    Array(5).fill('ReplaceAroundStep')
  )
  assert.equal(plan.proof.sourceLayout.delimiter.eol, '\r\n')
  assert.equal(
    plan.proof.sourceLayout.delimiter.resultLine,
    '| :----- | :---: | :-------: | :-------- |'
  )
  assert.equal(plan.proof.sourceLayout.edit.previousRaw, ' -------: ')
  assert.equal(plan.proof.sourceLayout.edit.text, ' :-------: ')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 1, 'left')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace(
      '| :--- | :---: | ---: | :--- |',
      '| :--- | :--- | ---: | :--- |'
    ),
    revision: 611
  })
  assert.equal(plan.ok, true)
  assert.equal(
    plan.result.markdown.includes('| :----- | :--- | -------: | :-------- |'),
    true
  )
  assert.equal(plan.proof.previousAlignment, 'center')
  assert.equal(plan.proof.nextAlignment, 'left')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 0, 'right')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace(
      '| :--- | :---: | ---: | :--- |',
      '| ---: | :---: | ---: | :--- |'
    ),
    revision: 612
  })
  assert.equal(plan.ok, true)
  assert.equal(
    plan.result.markdown.includes('| -----: | :---: | -------: | :-------- |'),
    true
  )
  assert.equal(plan.proof.previousAlignment, 'left')
  assert.equal(plan.proof.nextAlignment, 'right')
}

{
  const { transaction } = singleCellAlignmentTransaction(oldDoc, 2, 2, 'center')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 613
  })
  assert.equal(plan.reason, 'table-column-alignment-column-count')
}

{
  const { transaction } = twoColumnAlignmentTransaction(oldDoc, 1, 2, 'left')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 614
  })
  assert.equal(plan.reason, 'table-column-alignment-column-count')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const afterAlignment = transaction.doc
  const textPos = beforeAtPath(afterAlignment, [1, 2, 2, 0]) + 1
  const mixed = transaction.insertText('X', textPos + 'same'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [mixed],
    nextCanonical: canonical,
    revision: 615
  })
  assert.equal(plan.reason, 'table-column-alignment-column-count')
}

{
  const { transaction: first } = alignmentTransaction(oldDoc, 2, 'center')
  const { transaction: second } = alignmentTransaction(first.doc, 2, 'left')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [first, second],
    nextCanonical: canonical.replace(
      '| :--- | :---: | ---: | :--- |',
      '| :--- | :---: | :--- | :--- |'
    ),
    revision: 616
  })
  assert.equal(plan.reason, 'table-column-alignment-entry-count')
}

{
  const strong = schema.marks.strong.create()
  const markedRows = baseRows.map((entry, rowIndex) => {
    const cells = []
    entry.forEach((current, _offset, cellIndex) => {
      if (cellIndex === 2) {
        cells.push(cell(
          current.textContent,
          current.attrs.alignment,
          { header: rowIndex === 0, marks: [strong] }
        ))
      } else cells.push(current)
    })
    return row(cells)
  })
  const markedDoc = document(
    paragraph('before table'),
    table(markedRows),
    paragraph('after table')
  )
  const { transaction } = alignmentTransaction(markedDoc, 2, 'center')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: markedDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 617
  })
  assert.equal(plan.reason, 'table-column-alignment-column-count')
}

{
  const spanRows = baseRows.map((entry, rowIndex) => {
    const cells = []
    entry.forEach((current, _offset, cellIndex) => {
      if (cellIndex === 2) {
        cells.push(cell(
          current.textContent,
          current.attrs.alignment,
          { header: rowIndex === 0, colspan: 2 }
        ))
      } else cells.push(current)
    })
    return row(cells)
  })
  const spanDoc = document(
    paragraph('before table'),
    table(spanRows),
    paragraph('after table')
  )
  const { transaction } = alignmentTransaction(spanDoc, 2, 'center')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc: spanDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 618
  })
  assert.equal(plan.reason, 'table-column-alignment-column-count')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const badSource = source.replace(
    '| :----- | :---: | -------: | :-------- |',
    '| :----- | :---: | :-------: | :-------- |'
  )
  const { plan } = planFor({
    source: badSource,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 619
  })
  assert.equal(plan.reason, 'table-column-alignment-source-delimiter-alignment')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const badSource = source.replace(
    '| :----- | :---: | -------: | :-------- |',
    '| :----- | :---: | --x--: | :-------- |'
  )
  const { plan } = planFor({
    source: badSource,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 620
  })
  assert.equal(plan.reason, 'table-column-alignment-source-header-line')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 621,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'table-column-alignment-semantic-document-mismatch')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 622,
    validateMarkdown: () => { throw new Error('fixture') }
  })
  assert.equal(plan.reason, 'table-column-alignment-semantic-validator-threw')
}

{
  const { transaction } = alignmentTransaction(oldDoc, 2, 'center')
  const captured = capture({ source, canonical, oldDoc, transactions: [transaction], revision: 623 })
  const owner = createOwner()
  const deferred = owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  })
  assert.equal(deferred.reason, 'table-column-alignment-callback-document-mismatch')
  assert.equal(deferred.deferred, true)

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 624,
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
    canonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(
  () => createTableColumnAlignmentTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createTableColumnAlignmentTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => 0
  }),
  /requires validateMarkdown/
)

console.log('PASS table column alignment transaction owner: real column CellSelection + ReplaceAroundStep/stepDoc chain changes one stable column alignment, patches only authored GFM delimiter bytes, preserves duplicate columns/BOM/CRLF/layout, and rejects partial/multi-column/mixed/marked/span/source/semantic/stale cases')
