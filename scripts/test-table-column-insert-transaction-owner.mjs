import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { addColumnAfter, addColumnBefore, tableNodes } from '@milkdown/prose/tables'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  TABLE_COLUMN_INSERT_TRANSACTION_BOUNDARY,
  TABLE_COLUMN_INSERT_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableColumnInsertTransactionSourceSyncOwner
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
    { colspan, rowspan, colwidth, alignment: align },
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
} = {}) => createTableColumnInsertTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
})

const journalFactory = createSourceSyncTransactionJournal()
const capture = ({ source, canonical, oldDoc, transactions, revision = 510 }) => {
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
  revision = 510,
  callbackDocumentEquivalent = true,
  validateMarkdown = () => true,
  resolveMarkdownOffset,
  boundary = TABLE_COLUMN_INSERT_TRANSACTION_BOUNDARY
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

const columnTransaction = (doc, {
  columnIndex,
  before = false,
  rowIndex = 2,
  tableIndex = 1
}) => {
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(
      doc,
      textStart(doc, [tableIndex, rowIndex, columnIndex])
    )
  })
  let transaction = null
  const command = before ? addColumnBefore : addColumnAfter
  const ok = command(state, (value) => { transaction = value })
  assert.equal(ok, true, `column command rejected ${JSON.stringify({ columnIndex, before })}`)
  assert.ok(transaction, `column command did not dispatch ${JSON.stringify({ columnIndex, before })}`)
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
const expectedMiddleLines = [
  'before',
  '',
  '| Key    | Value | Value    |     | Note      |',
  '| :----- | :---: | -------: | :------- | :-------- |',
  '| alpha  | same  | same     |      | keep-a    |',
  '| beta | same | same |  | keep-b |',
  '| gamma  | same  | same     |      | keep-g |',
  '| delta | same | same |  | keep-d |',
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
  '| Key | Value | Value |  | Note |',
  '| :--- | :---: | ---: | :--- | :--- |',
  '| alpha | same | same |  | keep-a |',
  '| beta | same | same |  | keep-b |',
  '| gamma | same | same |  | keep-g |',
  '| delta | same | same |  | keep-d |',
  '',
  'after',
  ''
]
const source = `\uFEFF${sourceLines.join('\r\n')}`
const expectedMiddle = `\uFEFF${expectedMiddleLines.join('\r\n')}`
const canonical = canonicalLines.join('\n')
const nextCanonical = nextCanonicalLines.join('\n')

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical })
  assert.equal(plan.ok, true, `column insert owner rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_COLUMN_INSERT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_COLUMN_INSERT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-column-inserted')
  assert.equal(plan.result.markdown, expectedMiddle)
  assert.equal(plan.proof.kind, 'transaction-table-column-insert-proof')
  assert.deepEqual(plan.proof.tablePath, [1])
  assert.equal(plan.proof.insertedColumnIndex, 3)
  assert.equal(plan.proof.insertedAlignment, 'left')
  assert.equal(plan.proof.previousColumnCount, 4)
  assert.equal(plan.proof.nextColumnCount, 5)
  assert.equal(plan.proof.rowCount, 5)
  assert.deepEqual(plan.proof.insertedCellPaths, [[1, 0, 3], [1, 1, 3], [1, 2, 3], [1, 3, 3], [1, 4, 3]])
  assert.equal(plan.proof.stepRanges.length, 5)
  assert.equal(plan.proof.stepRanges.every((entry) => entry.from === entry.to), true)
  assert.equal(plan.proof.stepRanges[0].sliceType, 'table_header')
  assert.equal(plan.proof.stepRanges.slice(1).every((entry) => entry.sliceType === 'table_cell'), true)
  assert.equal(plan.proof.sourceLayout.insertions.length, 6)
  assert.equal(plan.proof.sourceLayout.insertions.find((entry) => entry.kind === 'header')?.resultLine, '| Key    | Value | Value    |     | Note      |')
  assert.equal(plan.proof.sourceLayout.insertions.find((entry) => entry.kind === 'delimiter')?.resultLine, '| :----- | :---: | -------: | :------- | :-------- |')
  assert.equal(plan.proof.transactionJournal.transactionCount, 1)
  assert.equal(plan.proof.transactionJournal.stepCount, 5)
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
  assert.equal(plan.result.markdown.includes('<br'), false)
  assert.equal(plan.result.markdown.includes('| beta | same | same |  | keep-b |'), true)
  assert.equal(plan.result.markdown.endsWith('after\r\n'), true)
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const loneCrSource = `\uFEFF${sourceLines.join('\r')}`
  const loneCrExpected = `\uFEFF${expectedMiddleLines.join('\r')}`
  const { plan } = planFor({ source: loneCrSource, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 511 })
  assert.equal(plan.ok, true, `lone-CR column insert rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.markdown, loneCrExpected)
  assert.equal(plan.result.markdown.includes('\n'), false)
  assert.equal(plan.proof.sourceLayout.rows[0].eol, '\r')
  assert.equal(plan.proof.sourceLayout.delimiter.eol, '\r')
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 0, before: true })
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 512 })
  assert.equal(plan.ok, true, `first-column insert rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.insertedColumnIndex, 0)
  assert.equal(plan.result.markdown.includes('|     | Key    | Value | Value    | Note      |'), true)
  assert.equal(plan.result.markdown.includes('| :----- | :----- | :---: | -------: | :-------- |'), true)
  assert.equal(plan.result.markdown.includes('|   | alpha  | same  | same     | keep-a    |'), true)
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 3 })
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 513 })
  assert.equal(plan.ok, true, `end-column insert rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.insertedColumnIndex, 4)
  assert.equal(plan.result.markdown.includes('| Key    | Value | Value    | Note      |       |'), true)
  assert.equal(plan.result.markdown.includes('| :----- | :---: | -------: | :-------- | :-------- |'), true)
  assert.equal(plan.result.markdown.includes('| beta | same | same | keep-b |  |'), true)
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 514, boundary: 'transaction-table-column-insert-markdown-updated' })
  assert.equal(plan.ok, true)
  assert.equal(plan.boundary, 'transaction-table-column-insert-markdown-updated')
  assert.equal(plan.publication.boundary, 'transaction-table-column-insert-markdown-updated')
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const afterStart = beforeAtPath(transaction.doc, [2]) + 1
  transaction.insertText('X', afterStart + 'after'.length)
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 515 })
  assert.equal(plan.ok, false)
}

{
  const first = columnTransaction(baseDoc, { columnIndex: 2 })
  const midState = first.state.apply(first.transaction)
  const follow = midState.tr.insertText('X', textStart(midState.doc, [1, 2, 3]))
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [first.transaction, follow], nextCanonical, revision: 516 })
  assert.equal(plan.ok, false)
}

{
  const full = columnTransaction(baseDoc, { columnIndex: 2 })
  const partialState = EditorState.create({ schema, doc: baseDoc })
  const partial = partialState.tr.step(full.transaction.steps[0])
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [partial], nextCanonical, revision: 517 })
  assert.equal(plan.ok, false)
}

{
  const strong = schema.marks.strong.create()
  const markedRows = [...baseRows]
  markedRows[2] = row([cell('beta', 'left'), cell('same', 'center'), cell('same', 'right', { marks: [strong] }), cell('keep-b', 'left')])
  const markedDoc = document(paragraph('before'), table(markedRows), paragraph('after'))
  const { transaction } = columnTransaction(markedDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: markedDoc, transactions: [transaction], nextCanonical, revision: 518 })
  assert.equal(plan.reason, 'table-column-insert-source-grid-not-simple')
}

{
  const emptyRows = [...baseRows]
  emptyRows[2] = row([cell('beta', 'left'), cell('same', 'center'), cell('', 'right'), cell('keep-b', 'left')])
  const emptyDoc = document(paragraph('before'), table(emptyRows), paragraph('after'))
  const { transaction } = columnTransaction(emptyDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: emptyDoc, transactions: [transaction], nextCanonical, revision: 519 })
  assert.equal(plan.reason, 'table-column-insert-source-grid-not-simple')
}

{
  const multiRows = [...baseRows]
  multiRows[2] = row([cell('beta', 'left'), cell('same', 'center'), cell('ignored', 'right', { paragraphs: [paragraph('same'), paragraph('extra')] }), cell('keep-b', 'left')])
  const multiDoc = document(paragraph('before'), table(multiRows), paragraph('after'))
  const { transaction } = columnTransaction(multiDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: multiDoc, transactions: [transaction], nextCanonical, revision: 520 })
  assert.equal(plan.ok, false)
}

{
  const spanRows = [...baseRows]
  spanRows[2] = row([cell('wide', 'left', { colspan: 2 }), cell('same', 'right'), cell('keep-b', 'left')])
  const spanDoc = document(paragraph('before'), table(spanRows), paragraph('after'))
  const { transaction } = columnTransaction(spanDoc, { columnIndex: 1 })
  const { plan } = planFor({ source, canonical, oldDoc: spanDoc, transactions: [transaction], nextCanonical, revision: 521 })
  assert.equal(plan.ok, false)
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const { plan } = planFor({ source: source.replace('| gamma  | same  | same     | keep-g |', '| gamma  | same  | WRONG    | keep-g |'), canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 522 })
  assert.equal(plan.ok, false)
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const { plan } = planFor({ source: source.replace('| :----- | :---: | -------: | :-------- |', '| :----- | :---: | invalid | :-------- |'), canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 523 })
  assert.equal(plan.ok, false)
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 524, resolveMarkdownOffset: () => { throw new Error('mapper') } })
  assert.equal(plan.reason, 'table-column-insert-source-position-mapper-threw')
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const { plan } = planFor({ source, canonical, oldDoc: baseDoc, transactions: [transaction], nextCanonical, revision: 525, validateMarkdown: () => false })
  assert.equal(plan.reason, 'table-column-insert-semantic-document-mismatch')
}

{
  const { transaction } = columnTransaction(baseDoc, { columnIndex: 2 })
  const captured = capture({ source, canonical, oldDoc: baseDoc, transactions: [transaction], revision: 526 })
  const owner = createOwner()
  const deferred = owner.plan({ journal: captured.journal, activeJournal: captured.journal, snapshot: captured.snapshot, currentSource: source, currentCanonical: canonical, canonical: nextCanonical, expectedDoc: captured.expectedDoc, callbackDocumentEquivalent: false })
  assert.equal(deferred.reason, 'table-column-insert-callback-document-mismatch')
  assert.equal(deferred.deferred, true)

  const staleSnapshot = createSourceSyncSnapshot({ revision: 527, source, canonical, doc: captured.expectedDoc })
  const stale = owner.plan({ journal: captured.journal, activeJournal: captured.journal, snapshot: staleSnapshot, currentSource: source, currentCanonical: canonical, canonical: nextCanonical, expectedDoc: captured.expectedDoc, callbackDocumentEquivalent: true })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(() => createTableColumnInsertTransactionSourceSyncOwner({}), /requires resolveMarkdownOffset/)
assert.throws(() => createTableColumnInsertTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }), /requires validateMarkdown/)

console.log('PASS table column insert transaction owner: real addColumnBefore/After multi-step journal inserts one stable empty column and delimiter cell, preserves authored pipes/spacing/alignment/BOM/LF/CRLF/lone-CR/other columns/rows/neighbours, supports first/middle/end ordinals, and rejects partial, typed, multi-transaction, marked, empty, multi-paragraph, span, source, delimiter, semantic, callback and stale cases')
