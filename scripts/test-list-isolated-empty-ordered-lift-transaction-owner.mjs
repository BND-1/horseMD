import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { joinBackward } from '@milkdown/prose/commands'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import {
  LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_BOUNDARY,
  LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_FAMILY,
  createListIsolatedEmptyOrderedLiftTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-isolated-empty-ordered-lift-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        checked: { default: null },
        label: { default: null },
        listType: { default: null },
        spread: { default: null }
      }
    },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const item = (...children) => schema.nodes.list_item.create(null, children)
const taskItem = (checked, ...children) => schema.nodes.list_item.create({ checked }, children)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const ordered = (...items) => schema.nodes.ordered_list.create({ order: 1 }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const oldDoc = document(
  paragraph('heading'),
  bullet(item(paragraph('literal'))),
  ordered(item(paragraph())),
  bullet(item(paragraph('right'))),
  paragraph('after')
)
let orderedBefore = 0
for (let index = 0; index < 2; index += 1) orderedBefore += oldDoc.child(index).nodeSize
const selectionPos = orderedBefore + 3
const state = EditorState.create({
  schema,
  doc: oldDoc,
  selection: TextSelection.create(oldDoc, selectionPos)
})
let transaction = null
assert.equal(joinBackward(state, (value) => { transaction = value }), true)
assert.ok(transaction)
assert.equal(transaction.steps.length, 1)
const step = transaction.steps[0]
assert.equal(step.constructor.name, 'ReplaceStep')
assert.equal(step.structure, true)
assert.equal(step.slice.size, 0)
const expectedDoc = transaction.doc

const source = '\uFEFFheading\r\n\r\n- literal\r\n\r\n1. \r\n\r\n- right\r\n\r\nafter\r\n'
const previous = 'heading\n\n* literal\n\n1. <br />\n\n* right\n\nafter\n'
const canonical = 'heading\n\n* literal\n\n* <br />\n\n* right\n\nafter\n'
const expectedSource = '\uFEFFheading\r\n\r\n- literal\r\n\r\n- \r\n\r\n- right\r\n\r\nafter\r\n'
const snapshot = createSourceSyncSnapshot({ revision: 154, source, canonical: previous, doc: oldDoc })
const journalFactory = createSourceSyncTransactionJournal()
const captured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [transaction],
  oldDoc,
  newDoc: expectedDoc
})
assert.equal(captured.ok, true)
const followingBefore = orderedBefore + oldDoc.child(2).nodeSize
const owner = createListIsolatedEmptyOrderedLiftTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos }) =>
    pmPos > followingBefore ? markdown.indexOf('right') : markdown.indexOf('literal')
})
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
assert.equal(plan.family, LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-isolated-empty-ordered-lifted')
assert.equal(plan.result.markdown, expectedSource)
assert.deepEqual(plan.proof.orderedPath, [2])
assert.deepEqual(plan.proof.orderedItemPath, [2, 0])
assert.deepEqual(plan.proof.appendedPath, [1, 1])
assert.equal(plan.proof.sourceBulletToken, '-')
assert.equal(plan.proof.orderedStart, 1)
assert.equal(plan.proof.step.from, step.from)
assert.equal(plan.proof.step.to, step.to)
assert.equal(plan.proof.previousToken, '1.')
assert.equal(plan.proof.nextToken, '-')
assert.equal(plan.proof.step.name, 'ReplaceStep')
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)

const nestedOld = document(
  paragraph('heading'),
  bullet(item(paragraph('literal'), bullet(item(paragraph('nested'))))),
  ordered(item(paragraph())),
  paragraph('after')
)
let nestedBefore = nestedOld.child(0).nodeSize + nestedOld.child(1).nodeSize
const nestedState = EditorState.create({
  schema,
  doc: nestedOld,
  selection: TextSelection.create(nestedOld, nestedBefore + 3)
})
let nestedTx = null
assert.equal(joinBackward(nestedState, (value) => { nestedTx = value }), true)
const nestedSnapshot = createSourceSyncSnapshot({ revision: 155, source, canonical: previous, doc: nestedOld })
const nestedCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: nestedSnapshot,
  transactions: [nestedTx],
  oldDoc: nestedOld,
  newDoc: nestedTx.doc
})
const nestedPlan = owner.plan({
  journal: nestedCaptured.checkpoint,
  activeJournal: nestedCaptured.checkpoint,
  snapshot: nestedSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: nestedTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(nestedPlan.ok, false)
assert.equal(nestedPlan.recognized, false, 'preceding nested bullet stays outside isolated plain lift family')

const taskOld = document(
  paragraph('heading'),
  bullet(taskItem(false, paragraph('literal'))),
  ordered(item(paragraph())),
  paragraph('after')
)
const taskBefore = taskOld.child(0).nodeSize + taskOld.child(1).nodeSize
const taskState = EditorState.create({
  schema,
  doc: taskOld,
  selection: TextSelection.create(taskOld, taskBefore + 3)
})
let taskTx = null
assert.equal(joinBackward(taskState, (value) => { taskTx = value }), true)
const taskSnapshot = createSourceSyncSnapshot({ revision: 156, source, canonical: previous, doc: taskOld })
const taskCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: taskSnapshot,
  transactions: [taskTx],
  oldDoc: taskOld,
  newDoc: taskTx.doc
})
const taskPlan = owner.plan({
  journal: taskCaptured.checkpoint,
  activeJournal: taskCaptured.checkpoint,
  snapshot: taskSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: taskTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const multiOrdered = document(
  paragraph('heading'),
  bullet(item(paragraph('literal'))),
  ordered(item(paragraph()), item(paragraph('second'))),
  paragraph('after')
)
const multiBefore = multiOrdered.child(0).nodeSize + multiOrdered.child(1).nodeSize
const multiState = EditorState.create({
  schema,
  doc: multiOrdered,
  selection: TextSelection.create(multiOrdered, multiBefore + 3)
})
let multiTx = null
assert.equal(joinBackward(multiState, (value) => { multiTx = value }), true)
const multiSnapshot = createSourceSyncSnapshot({ revision: 157, source, canonical: previous, doc: multiOrdered })
const multiCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: multiSnapshot,
  transactions: [multiTx],
  oldDoc: multiOrdered,
  newDoc: multiTx.doc
})
const multiPlan = owner.plan({
  journal: multiCaptured.checkpoint,
  activeJournal: multiCaptured.checkpoint,
  snapshot: multiSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: multiTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(multiPlan.ok, false)
assert.equal(multiPlan.recognized, false, 'multi-item ordered list is not isolated single-empty family')

const bodySource = source.replace('1. \r\n', '1. authored\r\n')
const bodySnapshot = createSourceSyncSnapshot({ revision: 158, source: bodySource, canonical: previous, doc: oldDoc })
const bodyCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: bodySnapshot,
  transactions: [transaction],
  oldDoc,
  newDoc: expectedDoc
})
const bodyPlan = owner.plan({
  journal: bodyCaptured.checkpoint,
  activeJournal: bodyCaptured.checkpoint,
  snapshot: bodySnapshot,
  currentSource: bodySource,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(bodyPlan.ok, false)
assert.equal(bodyPlan.recognized, true)

const badStep = {
  constructor: { name: 'ReplaceStep' },
  from: step.from - 1,
  to: step.to,
  structure: true,
  slice: { size: 0 },
  apply: () => ({ doc: expectedDoc })
}
const badTx = {
  docChanged: true,
  before: oldDoc,
  doc: expectedDoc,
  docs: [oldDoc],
  steps: [badStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const badSnapshot = createSourceSyncSnapshot({ revision: 159, source, canonical: previous, doc: oldDoc })
const badCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: badSnapshot,
  transactions: [badTx],
  oldDoc,
  newDoc: expectedDoc
})
const badPlan = owner.plan({
  journal: badCaptured.checkpoint,
  activeJournal: badCaptured.checkpoint,
  snapshot: badSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(badPlan.ok, false)
assert.equal(badPlan.recognized, true)
assert.equal(badPlan.reason, 'isolated-ordered-lift-step-range')

assert.throws(
  () => createListIsolatedEmptyOrderedLiftTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
console.log('PASS isolated empty ordered lift transaction owner: one exact structural ReplaceStep merges a single empty ordered list into the preceding plain bullet list, rewriting only the authored ordered marker to the preceding bullet token while BOM/CRLF/block gaps stay intact; nested/task/multi-item/source-body/wrong-step cases stay separate or fail closed')
