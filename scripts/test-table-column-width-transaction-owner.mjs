import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import { TableMap, tableNodes } from '@milkdown/prose/tables'
import {
  TABLE_COLUMN_WIDTH_TRANSACTION_BOUNDARY,
  TABLE_COLUMN_WIDTH_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableColumnWidthTransactionSourceSyncOwner
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
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value) : null
)
const cell = (value, {
  header = false,
  alignment = 'left',
  colspan = 1,
  rowspan = 1,
  colwidth = null
} = {}) => (header ? schema.nodes.table_header : schema.nodes.table_cell).create(
  { colspan, rowspan, colwidth, alignment },
  paragraph(value)
)
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

const widthTransaction = (doc, columnIndex, width, tableIndex = 1) => {
  const targetTable = doc.child(tableIndex)
  const map = TableMap.get(targetTable)
  const tableStart = beforeAtPath(doc, [tableIndex]) + 1
  const state = EditorState.create({ schema, doc })
  const tr = state.tr
  for (let rowIndex = 0; rowIndex < map.height; rowIndex += 1) {
    const mapIndex = rowIndex * map.width + columnIndex
    const pos = map.map[mapIndex]
    const current = targetTable.nodeAt(pos)
    const attrs = current.attrs
    const colwidth = attrs.colwidth ? attrs.colwidth.slice() : Array(attrs.colspan).fill(0)
    colwidth[0] = width
    tr.setNodeMarkup(tableStart + pos, null, { ...attrs, colwidth })
  }
  assert.equal(tr.docChanged, true)
  return tr
}

const singleCellWidthTransaction = (doc, rowIndex, columnIndex, width, tableIndex = 1) => {
  const entryPos = beforeAtPath(doc, [tableIndex, rowIndex, columnIndex])
  const current = doc.child(tableIndex).child(rowIndex).child(columnIndex)
  const state = EditorState.create({ schema, doc })
  return state.tr.setNodeMarkup(entryPos, null, {
    ...current.attrs,
    colwidth: [width]
  })
}

const mixedWidthsTransaction = (doc, columnIndex, widths, tableIndex = 1) => {
  const targetTable = doc.child(tableIndex)
  const map = TableMap.get(targetTable)
  const tableStart = beforeAtPath(doc, [tableIndex]) + 1
  const tr = EditorState.create({ schema, doc }).tr
  for (let rowIndex = 0; rowIndex < map.height; rowIndex += 1) {
    const pos = map.map[rowIndex * map.width + columnIndex]
    const current = targetTable.nodeAt(pos)
    tr.setNodeMarkup(tableStart + pos, null, {
      ...current.attrs,
      colwidth: [widths[rowIndex]]
    })
  }
  return tr
}

const makeRows = ({ width = null, span = false } = {}) => [
  row([
    cell('A', { header: true, alignment: 'left', colwidth: width == null ? null : [width] }),
    cell('B', { header: true, alignment: 'center', colwidth: width == null ? null : [width] }),
    cell('C', { header: true, alignment: 'right', colwidth: width == null ? null : [width] })
  ]),
  row([
    cell('a', { alignment: 'left', colwidth: width == null ? null : [width] }),
    cell('same', { alignment: 'center', colwidth: width == null ? null : [width], colspan: span ? 2 : 1 }),
    cell('keep-a', { alignment: 'right', colwidth: width == null ? null : [width] })
  ]),
  row([
    cell('d', { alignment: 'left', colwidth: width == null ? null : [width] }),
    cell('same', { alignment: 'center', colwidth: width == null ? null : [width] }),
    cell('keep-d', { alignment: 'right', colwidth: width == null ? null : [width] })
  ])
]
const oldDoc = document(
  paragraph('before'),
  table(makeRows()),
  paragraph('after')
)
const source = '\uFEFFbefore\r\n\r\n| A   | B    | C      |\r\n| :-- | :--: | -----: |\r\n| a   | same | keep-a |\r\n| d   | same | keep-d |\r\n\r\nafter\r\n'
const canonical = 'before\n\n| A | B | C |\n| :-- | :--: | --: |\n| a | same | keep-a |\n| d | same | keep-d |\n\nafter\n'

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ oldDoc: baseline, transactions, revision = 710 }) => {
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

const planFor = ({
  baseline = oldDoc,
  transactions,
  nextCanonical = canonical,
  revision = 710,
  currentSource = source,
  currentCanonical = canonical,
  callbackDocumentEquivalent = false,
  validateMarkdown = ({ semanticOptions }) =>
    Array.isArray(semanticOptions?.ignoreTableColumnWidthPaths)
} = {}) => {
  const captured = capture({ oldDoc: baseline, transactions, revision })
  const owner = createTableColumnWidthTransactionSourceSyncOwner({ validateMarkdown })
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
      boundary: TABLE_COLUMN_WIDTH_TRANSACTION_BOUNDARY
    })
  }
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  let validationInput = null
  const { plan } = planFor({
    transactions: [transaction],
    validateMarkdown: (input) => {
      validationInput = input
      return true
    }
  })
  assert.equal(plan.ok, true, `width plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_COLUMN_WIDTH_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_COLUMN_WIDTH_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-column-width-changed')
  assert.equal(plan.result.markdown, source)
  assert.equal(plan.canonical, canonical)
  assert.equal(plan.publication.notifyChange, false)
  assert.equal(plan.proof.kind, 'transaction-table-column-width-proof')
  assert.deepEqual(plan.proof.tablePath, [1])
  assert.equal(plan.proof.columnIndex, 1)
  assert.equal(plan.proof.previousWidth, null)
  assert.equal(plan.proof.nextWidth, 188)
  assert.equal(plan.proof.columnCount, 3)
  assert.equal(plan.proof.rowCount, 3)
  assert.deepEqual(plan.proof.cellPaths, [[1, 0, 1], [1, 1, 1], [1, 2, 1]])
  assert.equal(plan.proof.stepRanges.length, 3)
  assert.equal(plan.proof.stepRanges.every((entry) => entry.stepName === 'ReplaceAroundStep'), true)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, Array(3).fill('ReplaceAroundStep'))
  assert.equal(plan.proof.sourceUnchanged, true)
  assert.equal(plan.proof.canonicalUnchanged, true)
  assert.equal(plan.proof.callbackDocumentEquivalent, false)
  assert.equal(plan.proof.metadataDocumentEquivalent, true)
  assert.equal(validationInput.markdown, canonical)
  assert.equal(validationInput.expectedDoc, transaction.doc)
  assert.deepEqual(
    validationInput.semanticOptions.ignoreTableColumnWidthPaths,
    plan.proof.cellPaths
  )
}

{
  const existing = document(paragraph('before'), table(makeRows({ width: 120 })), paragraph('after'))
  const transaction = widthTransaction(existing, 2, 205)
  const { plan } = planFor({ baseline: existing, transactions: [transaction], revision: 711 })
  assert.equal(plan.ok, true)
  assert.equal(plan.proof.previousWidth, 120)
  assert.equal(plan.proof.nextWidth, 205)
  assert.equal(plan.proof.columnIndex, 2)
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  const { plan } = planFor({
    transactions: [transaction],
    nextCanonical: `${canonical}changed`,
    revision: 712
  })
  assert.equal(plan.reason, 'table-column-width-canonical-changed')
}

{
  const transaction = singleCellWidthTransaction(oldDoc, 1, 1, 188)
  const { plan } = planFor({ transactions: [transaction], revision: 713 })
  assert.equal(plan.reason, 'table-column-width-column-count')
}

{
  const first = widthTransaction(oldDoc, 0, 180)
  const second = widthTransaction(first.doc, 1, 190)
  const { plan } = planFor({ transactions: [first, second], revision: 714 })
  assert.equal(plan.reason, 'table-column-width-column-count')
}

{
  const transaction = mixedWidthsTransaction(oldDoc, 1, [180, 190, 200])
  const { plan } = planFor({ transactions: [transaction], revision: 715 })
  assert.equal(plan.reason, 'table-column-width-column-count')
}

{
  const transaction = widthTransaction(oldDoc, 1, 20)
  const { plan } = planFor({ transactions: [transaction], revision: 716 })
  assert.equal(plan.reason, 'table-column-width-column-count')
}

{
  const spanDoc = document(paragraph('before'), table(makeRows({ span: true })), paragraph('after'))
  const transaction = widthTransaction(spanDoc, 1, 188)
  const { plan } = planFor({ baseline: spanDoc, transactions: [transaction], revision: 717 })
  assert.equal(plan.reason, 'table-column-width-column-count')
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  const textPos = beforeAtPath(transaction.doc, [1, 1, 1, 0]) + 1 + 'same'.length
  const mixed = transaction.insertText('X', textPos)
  const { plan } = planFor({ transactions: [mixed], revision: 718 })
  assert.equal(plan.reason, 'table-column-width-column-count')
}

{
  const first = widthTransaction(oldDoc, 1, 160)
  const second = widthTransaction(first.doc, 1, 188)
  const { plan } = planFor({ transactions: [first, second], revision: 719 })
  assert.equal(plan.reason, 'table-column-width-entry-count')
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  const { plan } = planFor({
    transactions: [transaction],
    revision: 720,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'table-column-width-semantic-document-mismatch')
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  const { plan } = planFor({
    transactions: [transaction],
    revision: 721,
    validateMarkdown: () => { throw new Error('fixture') }
  })
  assert.equal(plan.reason, 'table-column-width-semantic-validator-threw')
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  const captured = capture({ oldDoc, transactions: [transaction], revision: 722 })
  const owner = createTableColumnWidthTransactionSourceSyncOwner({ validateMarkdown: () => true })
  const plan = owner.plan({
    journal: captured.journal,
    activeJournal: { ...captured.journal },
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical,
    expectedDoc: captured.expectedDoc
  })
  assert.equal(plan.reason, 'table-column-width-journal-stale')
  assert.equal(plan.reset, true)
}

{
  const transaction = widthTransaction(oldDoc, 1, 188)
  const { plan } = planFor({
    transactions: [transaction],
    revision: 723,
    currentSource: `${source}stale`
  })
  assert.equal(plan.reason, 'table-column-width-live-snapshot-stale')
  assert.equal(plan.reset, true)
}

assert.throws(
  () => createTableColumnWidthTransactionSourceSyncOwner({}),
  /requires validateMarkdown/
)

console.log('PASS table column width transaction owner: real colwidth ReplaceAroundStep journal, stable column paths, source/canonical unchanged metadata publication, and strict negative ownership')
