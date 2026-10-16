import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import {
  LIST_EMPTY_ITEM_REMOVE_TRANSACTION_BOUNDARY,
  LIST_EMPTY_ITEM_REMOVE_TRANSACTION_FAMILY,
  createListEmptyItemRemoveTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    text: { group: 'inline' }
  }
})
const text = (value) => value ? schema.text(value) : null
const paragraph = (value = '') => schema.nodes.paragraph.create(null, text(value))
const item = (...children) => schema.nodes.list_item.create(null, children)
const taskItem = (checked, ...children) => schema.nodes.list_item.create({ checked }, children)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const ordered = (...items) => schema.nodes.ordered_list.create(null, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const oldList = bullet(item(paragraph('left')), item(paragraph()), item(paragraph('right')))
const nextList = bullet(item(paragraph('left'), paragraph()), item(paragraph('right')))
const oldDoc = document(paragraph('before'), oldList, paragraph('after'))

const listOffset = oldDoc.child(0).nodeSize
const removedItem = oldList.child(1)
const removedBefore = listOffset + 1 + oldList.child(0).nodeSize
// ProseMirror's physical Backspace shape is a closed structural ReplaceStep
// deleting the empty item wrapper and appending one editor-only paragraph to
// the preceding item. Build that exact expected doc explicitly and use a tiny
// structural fixture transaction so the owner contract stays independent of
// keymap implementation details.
const step = {
  constructor: { name: 'ReplaceStep' },
  from: removedBefore - 1,
  to: removedBefore + 1,
  structure: true,
  slice: { size: 0 },
  apply: () => ({ doc: document(paragraph('before'), nextList, paragraph('after')) })
}
const expectedDoc = document(paragraph('before'), nextList, paragraph('after'))
const fakeTransaction = {
  docChanged: true,
  before: oldDoc,
  doc: expectedDoc,
  docs: [oldDoc],
  steps: [step],
  mapping: { maps: [{ map: (position) => position }] }
}

const source = '\uFEFFbefore\r\n\r\n- left\r\n- \r\n- right\r\n\r\nafter\r\n'
const previous = 'before\n\n* left\n\n* <br />\n\n* right\n\nafter\n'
const canonical = 'before\n\n* left\n\n  <br />\n\n* right\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n- left\r\n- right\r\n\r\nafter\r\n'

const snapshot = createSourceSyncSnapshot({ revision: 151, source, canonical: previous, doc: oldDoc })
const journalFactory = createSourceSyncTransactionJournal()
const captured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [fakeTransaction],
  oldDoc,
  newDoc: expectedDoc
})
assert.equal(captured.ok, true)

const makeOwner = () => createListEmptyItemRemoveTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown }) => markdown.indexOf('left')
})
const owner = makeOwner()
const plan = owner.plan({
  journal: captured.checkpoint,
  activeJournal: captured.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_EMPTY_ITEM_REMOVE_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_EMPTY_ITEM_REMOVE_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-empty-item-removed')
assert.equal(plan.result.markdown, expectedSource)
assert.deepEqual(plan.proof.removedPath, [1, 1])
assert.deepEqual(plan.proof.transientEmptyListItemPath, [1, 0])
assert.deepEqual(plan.proof.transientEmptyParagraphPath, [1, 0, 1])
assert.equal(plan.proof.step.name, 'ReplaceStep')
assert.equal(plan.proof.step.structure, true)
assert.equal(plan.proof.removedSourceRow.token, '-')
assert.equal(plan.proof.rawReplacement.end > plan.proof.rawReplacement.start, true)
assert.equal(plan.result.markdown.includes('<br'), false)
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)

const unrecognizedDoc = document(paragraph('before'), bullet(item(paragraph('left')), item(paragraph('right'))), paragraph('after'))
const unrecognizedStep = { ...step, apply: () => ({ doc: unrecognizedDoc }) }
const unrecognizedTx = { ...fakeTransaction, doc: unrecognizedDoc, steps: [unrecognizedStep] }
const unrecognizedCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [unrecognizedTx],
  oldDoc,
  newDoc: unrecognizedDoc
})
assert.equal(unrecognizedCapture.ok, true)
const unrecognized = owner.plan({
  journal: unrecognizedCapture.checkpoint,
  activeJournal: unrecognizedCapture.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'before\n\n* left\n\n* right\n\nafter\n',
  expectedDoc: unrecognizedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(unrecognized.ok, false)
assert.equal(unrecognized.recognized, false,
  'a row deletion without the exact transient preceding paragraph is not this family')

const taskOld = document(
  paragraph('before'),
  bullet(item(paragraph('left')), taskItem(false, paragraph()), item(paragraph('right'))),
  paragraph('after')
)
const taskExpected = document(
  paragraph('before'),
  bullet(item(paragraph('left'), paragraph()), item(paragraph('right'))),
  paragraph('after')
)
const taskSnapshot = createSourceSyncSnapshot({ revision: 152, source, canonical: previous, doc: taskOld })
const taskTx = { ...fakeTransaction, before: taskOld, doc: taskExpected, docs: [taskOld], steps: [{ ...step, apply: () => ({ doc: taskExpected }) }] }
const taskCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: taskSnapshot,
  transactions: [taskTx],
  oldDoc: taskOld,
  newDoc: taskExpected
})
assert.equal(taskCapture.ok, true)
const taskPlan = owner.plan({
  journal: taskCapture.checkpoint,
  activeJournal: taskCapture.checkpoint,
  snapshot: taskSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: taskExpected,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false, 'task empty-item removal stays outside the plain family')

const sourceWithBody = source.replace('- \r\n', '- authored\r\n')
const sourceMismatchSnapshot = createSourceSyncSnapshot({ revision: 153, source: sourceWithBody, canonical: previous, doc: oldDoc })
const sourceMismatchCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: sourceMismatchSnapshot,
  transactions: [fakeTransaction],
  oldDoc,
  newDoc: expectedDoc
})
const sourceMismatch = owner.plan({
  journal: sourceMismatchCapture.checkpoint,
  activeJournal: sourceMismatchCapture.checkpoint,
  snapshot: sourceMismatchSnapshot,
  currentSource: sourceWithBody,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(sourceMismatch.ok, false)
assert.equal(sourceMismatch.recognized, true,
  'once PM proves this family, an authored-row mismatch must block legacy fallback')

assert.throws(
  () => createListEmptyItemRemoveTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
console.log('PASS list empty-item remove transaction owner: one exact interior plain empty item Backspace deletes only the authored marker row, preserves BOM/CRLF and proves the editor-only trailing paragraph path; task, non-transient and source-mismatch cases fail closed')
