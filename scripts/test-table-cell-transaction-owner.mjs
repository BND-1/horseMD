import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  TABLE_CELL_TRANSACTION_BOUNDARY,
  TABLE_CELL_TRANSACTION_FAMILY,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal,
  createTableCellTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', attrs: { role: { default: '' } } },
    table: { content: 'table_row+', group: 'block', attrs: { layout: { default: 'auto' } } },
    table_row: { content: 'table_cell+', attrs: { role: { default: '' } } },
    table_cell: {
      content: 'paragraph+',
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
        align: { default: null }
      }
    },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})

const remark = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const text = (value, marks = null) => value ? schema.text(value, marks) : null
const paragraph = (value = '', role = '', marks = null) => schema.nodes.paragraph.create(
  { role }, value ? text(value, marks) : null
)
const cell = (value, align = null, marks = null) => schema.nodes.table_cell.create(
  { colspan: 1, rowspan: 1, colwidth: null, align },
  paragraph(value, '', marks)
)
const row = (cells, role = '') => schema.nodes.table_row.create({ role }, cells)
const table = (rows, layout = 'auto') => schema.nodes.table.create({ layout }, rows)
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

const journalFactory = createSourceSyncTransactionJournal()
const createOwner = (validateMarkdown = () => true) =>
  createTableCellTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown
  })

const capture = ({ source, canonical, oldDoc, transactions, revision = 120 }) => {
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
    assert.equal(captured.ok, true)
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
  revision = 120,
  validateMarkdown = () => true,
  callbackDocumentEquivalent = true
}) => {
  const captured = capture({ source, canonical, oldDoc, transactions, revision })
  const owner = createOwner(validateMarkdown)
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
      callbackDocumentEquivalent
    })
  }
}

const source = '\uFEFF| Key  | Value | Note     |\r\n| :--- | ----: | :------- |\r\n| same | alpha | repeated |\r\n| same | beta  | repeated |\r\n'
const canonical = '| Key | Value | Note |\n| :--- | ---: | :--- |\n| same | alpha | repeated |\n| same | beta | repeated |\n'
const oldDoc = document(table([
  row([cell('Key', 'left'), cell('Value', 'right'), cell('Note', 'left')], 'header'),
  row([cell('same', 'left'), cell('alpha', 'right'), cell('repeated', 'left')]),
  row([cell('same', 'left'), cell('beta', 'right'), cell('repeated', 'left')])
]))

{
  const path = [0, 2, 2]
  let state = EditorState.create({ schema, doc: oldDoc })
  const start = textStart(oldDoc, path)
  const first = state.tr.insertText('X', start + 'repeated'.length)
  state = state.apply(first)
  const second = state.tr.insertText('Y', start + 'repeatedX'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [first, second],
    nextCanonical: canonical.replace(
      '| same | beta | repeated |',
      '| same | beta | repeatedXY |'
    )
  })
  assert.equal(plan.ok, true, `table cell plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, TABLE_CELL_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, TABLE_CELL_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'table-cell-plain-text-change')
  assert.equal(
    plan.result.markdown,
    source.replace('| same | beta  | repeated |', '| same | beta  | repeatedXY |')
  )
  assert.equal(plan.proof.kind, 'transaction-table-cell-proof')
  assert.deepEqual(plan.proof.nodePath, path)
  assert.deepEqual(plan.proof.tablePath, [0])
  assert.deepEqual(plan.proof.rowPath, [0, 2])
  assert.equal(plan.proof.rowIndex, 2)
  assert.equal(plan.proof.cellIndex, 2)
  assert.equal(plan.proof.previousText, 'repeated')
  assert.equal(plan.proof.nextText, 'repeatedXY')
  assert.equal(plan.proof.chainLength, 2)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep', 'ReplaceStep'])
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
  assert.equal(plan.result.markdown.includes('\r\n'), true)
}

{
  const path = [0, 0, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.insertText('s', textStart(oldDoc, path) + 'Value'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| Key | Value | Note |', '| Key | Values | Note |'),
    revision: 121
  })
  assert.equal(plan.ok, true, `header-row cell rejected: ${JSON.stringify(plan)}`)
  assert.deepEqual(plan.proof.nodePath, path)
  assert.equal(plan.result.markdown, source.replace('| Key  | Value |', '| Key  | Values |'))
}

{
  const firstPath = [0, 1, 0]
  const secondPath = [0, 2, 0]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr
    .insertText('X', textStart(oldDoc, firstPath) + 'same'.length)
    .insertText('Y', textStart(oldDoc, secondPath) + 'same'.length + 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical,
    revision: 122
  })
  assert.equal(plan.reason, 'table-cell-anchored-target-count')
}

{
  const strong = schema.marks.strong.create()
  const markedDoc = document(table([
    row([cell('Key'), cell('Value')], 'header'),
    row([cell('plain'), cell('marked', null, [strong])])
  ]))
  const markedSource = '| Key | Value |\n| --- | --- |\n| plain | **marked** |\n'
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: markedDoc })
  const transaction = state.tr.insertText('X', textStart(markedDoc, path) + 'marked'.length)
  const { plan } = planFor({
    source: markedSource,
    canonical: markedSource,
    oldDoc: markedDoc,
    transactions: [transaction],
    nextCanonical: markedSource.replace('**marked**', '**markedX**'),
    revision: 123
  })
  assert.equal(plan.reason, 'table-cell-not-simple-nonempty')
}

{
  const path = [0, 1, 1]
  const start = textStart(oldDoc, path)
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.delete(start, start + 'alpha'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| same | alpha |', '| same |  |'),
    revision: 124
  })
  assert.equal(plan.reason, 'table-cell-not-simple-nonempty')
}

{
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.insertText('|', textStart(oldDoc, path) + 'alpha'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| same | alpha |', '| same | alpha\\| |'),
    revision: 125
  })
  assert.equal(plan.reason, 'syntax-sensitive-insert')
}

{
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr
    .setNodeMarkup(beforeAtPath(oldDoc, path), null, {
      colspan: 2,
      rowspan: 1,
      colwidth: null,
      align: 'right'
    })
    .insertText('X', textStart(oldDoc, path) + 'alpha'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| same | alpha |', '| same | alphaX |'),
    revision: 126
  })
  assert.equal(plan.reason, 'table-cell-attrs-or-type-changed')
}

{
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr
    .setNodeMarkup(beforeAtPath(oldDoc, [0, 1]), null, { role: 'changed' })
    .insertText('X', textStart(oldDoc, path) + 'alpha'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| same | alpha |', '| same | alphaX |'),
    revision: 127
  })
  assert.equal(plan.reason, 'table-cell-anchored-target-count')
}

{
  const multiCell = schema.nodes.table_cell.create(
    { colspan: 1, rowspan: 1, colwidth: null, align: null },
    [paragraph('one'), paragraph('two')]
  )
  const multiDoc = document(table([
    row([cell('H')], 'header'),
    row([multiCell])
  ]))
  const multiSource = '| H |\n| --- |\n| one two |\n'
  const state = EditorState.create({ schema, doc: multiDoc })
  const transaction = state.tr.insertText('X', textStart(multiDoc, [0, 1, 0]) + 3)
  const { plan } = planFor({
    source: multiSource,
    canonical: multiSource,
    oldDoc: multiDoc,
    transactions: [transaction],
    nextCanonical: multiSource.replace('one two', 'oneX two'),
    revision: 128
  })
  assert.equal(plan.reason, 'table-cell-paragraph-count')
}

{
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.insertText('X', textStart(oldDoc, path) + 'alpha'.length)
  const { plan } = planFor({
    source: source.replace('alpha', 'wrong'),
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| same | alpha |', '| same | alphaX |'),
    revision: 129
  })
  assert.equal(plan.ok, false)
}

{
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.insertText('X', textStart(oldDoc, path) + 'alpha'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: canonical.replace('| same | alpha |', '| same | alphaX |'),
    revision: 130,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'semantic-document-mismatch')
}

{
  const path = [0, 1, 1]
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.insertText('X', textStart(oldDoc, path) + 'alpha'.length)
  const captured = capture({ source, canonical, oldDoc, transactions: [transaction], revision: 131 })
  const owner = createOwner()
  assert.equal(owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical: canonical.replace('| same | alpha |', '| same | alphaX |'),
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  }).reason, 'table-cell-callback-document-mismatch')

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 132,
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
    canonical: canonical.replace('| same | alpha |', '| same | alphaX |'),
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(
  () => createTableCellTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset|requires mapTransactions/
)
assert.throws(
  () => createTableCellTransactionSourceSyncOwner({
    mapTransactions: () => ({ ok: true }),
    resolveMarkdownOffset: () => 0
  }),
  /requires validateMarkdown/
)

console.log('PASS table cell transaction owner: stable cell paths and journal ReplaceSteps patch one GFM cell text, preserve duplicate occurrence/table layout/BOM/CRLF/other cells, support header/body rows, and reject syntax, empty, marked, cross-cell, attrs/topology, mismatched, semantic and stale cases')
