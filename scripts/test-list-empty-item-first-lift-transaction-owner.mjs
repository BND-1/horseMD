import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { joinBackward } from '@milkdown/prose/commands'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import {
  LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_BOUNDARY,
  LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_FAMILY,
  createListEmptyItemFirstLiftTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-empty-item-first-lift-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const item = (...children) => schema.nodes.list_item.create(null, children)
const taskItem = (checked, ...children) => schema.nodes.list_item.create({ checked }, children)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const ordered = (...items) => schema.nodes.ordered_list.create({ order: 1 }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const firstEmptyBackspace = (doc) => {
  const listBefore = doc.child(0).nodeSize
  const firstItemBefore = listBefore + 1
  const firstParagraphBefore = firstItemBefore + 1
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, firstParagraphBefore + 1)
  })
  let transaction = null
  assert.equal(joinBackward(state, (value) => { transaction = value }), true)
  assert.ok(transaction)
  return transaction
}

const oldDoc = document(
  paragraph('before'),
  bullet(item(paragraph()), item(paragraph('right'))),
  paragraph('after')
)
const transaction = firstEmptyBackspace(oldDoc)
const expectedDoc = transaction.doc
assert.equal(transaction.steps.length, 1)
const realStep = transaction.steps[0]
assert.equal(realStep.constructor.name, 'ReplaceAroundStep')
assert.deepEqual(realStep.toJSON(), {
  stepType: 'replaceAround',
  from: 8,
  to: 13,
  gapFrom: 10,
  gapTo: 12,
  insert: 0,
  slice: { content: [{ type: 'bullet_list' }], openEnd: 1 },
  structure: true
})

const source = '\uFEFFbefore\r\n\r\n- \r\n- right\r\n\r\nafter\r\n'
const previous = 'before\n\n* <br />\n\n* right\n\nafter\n'
const canonical = 'before\n\n<br />\n\n* right\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n- right\r\n\r\nafter\r\n'
const snapshot = createSourceSyncSnapshot({ revision: 153, source, canonical: previous, doc: oldDoc })
const journalFactory = createSourceSyncTransactionJournal()
const captured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [transaction],
  oldDoc,
  newDoc: expectedDoc
})
assert.equal(captured.ok, true)
const owner = createListEmptyItemFirstLiftTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown }) => markdown.indexOf('right')
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
assert.equal(plan.family, LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-empty-item-first-lifted')
assert.equal(plan.result.markdown, expectedSource)
assert.deepEqual(plan.proof.removedPath, [1, 0])
assert.deepEqual(plan.proof.liftedParagraphPath, [1])
assert.deepEqual(plan.proof.remainingListPath, [2])
assert.deepEqual(plan.proof.successorOldPath, [1, 1])
assert.deepEqual(plan.proof.successorNewPath, [2, 0])
assert.equal(plan.proof.step.name, 'ReplaceAroundStep')
assert.equal(plan.proof.step.gapFrom, 10)
assert.equal(plan.proof.step.gapTo, 12)
assert.equal(plan.proof.step.insert, 0)
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)
assert.equal(plan.result.markdown.includes('<br'), false)

const tailDoc = document(paragraph('before'), bullet(item(paragraph('left')), item(paragraph())), paragraph('after'))
const tailTx = (() => {
  const listBefore = tailDoc.child(0).nodeSize
  const firstSize = tailDoc.child(1).child(0).nodeSize
  const tailBefore = listBefore + 1 + firstSize
  const state = EditorState.create({
    schema,
    doc: tailDoc,
    selection: TextSelection.create(tailDoc, tailBefore + 2)
  })
  let value = null
  assert.equal(joinBackward(state, (next) => { value = next }), true)
  return value
})()
const tailSnapshot = createSourceSyncSnapshot({ revision: 154, source, canonical: previous, doc: tailDoc })
const tailCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: tailSnapshot,
  transactions: [tailTx],
  oldDoc: tailDoc,
  newDoc: tailTx.doc
})
const tailPlan = owner.plan({
  journal: tailCaptured.checkpoint,
  activeJournal: tailCaptured.checkpoint,
  snapshot: tailSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: tailTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(tailPlan.ok, false)
assert.equal(tailPlan.recognized, false, 'tail empty item stays outside first-empty family')

const orderedDoc = document(paragraph('before'), ordered(item(paragraph()), item(paragraph('right'))), paragraph('after'))
const orderedTx = firstEmptyBackspace(orderedDoc)
const orderedSnapshot = createSourceSyncSnapshot({ revision: 155, source, canonical: previous, doc: orderedDoc })
const orderedCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: orderedSnapshot,
  transactions: [orderedTx],
  oldDoc: orderedDoc,
  newDoc: orderedTx.doc
})
const orderedPlan = owner.plan({
  journal: orderedCaptured.checkpoint,
  activeJournal: orderedCaptured.checkpoint,
  snapshot: orderedSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: orderedTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false, 'ordered first-empty stays for ordered successor/lift family')

const taskDoc = document(paragraph('before'), bullet(taskItem(false, paragraph()), item(paragraph('right'))), paragraph('after'))
const taskTx = firstEmptyBackspace(taskDoc)
const taskSnapshot = createSourceSyncSnapshot({ revision: 156, source, canonical: previous, doc: taskDoc })
const taskCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: taskSnapshot,
  transactions: [taskTx],
  oldDoc: taskDoc,
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
assert.equal(taskPlan.recognized, false, 'task first-empty stays outside plain bullet family')

const looseSource = '\uFEFFbefore\r\n\r\n- \r\n\r\n- right\r\n\r\nafter\r\n'
const looseSnapshot = createSourceSyncSnapshot({ revision: 157, source: looseSource, canonical: previous, doc: oldDoc })
const looseCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: looseSnapshot,
  transactions: [transaction],
  oldDoc,
  newDoc: expectedDoc
})
const loosePlan = owner.plan({
  journal: looseCaptured.checkpoint,
  activeJournal: looseCaptured.checkpoint,
  snapshot: looseSnapshot,
  currentSource: looseSource,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(loosePlan.ok, false)
assert.equal(loosePlan.recognized, true)
assert.equal(loosePlan.reason, 'list-empty-item-first-authored-row-unproven')

const bodySource = source.replace('- \r\n', '- authored\r\n')
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

const wrongStep = new realStep.constructor(
  realStep.from,
  realStep.to,
  realStep.gapFrom + 1,
  realStep.gapTo,
  realStep.slice,
  realStep.insert,
  realStep.structure
)
const state = EditorState.create({ schema, doc: oldDoc })
let wrongTx = null
try { wrongTx = state.tr.step(wrongStep) } catch { wrongTx = null }
if (wrongTx) {
  const wrongSnapshot = createSourceSyncSnapshot({ revision: 159, source, canonical: previous, doc: oldDoc })
  const wrongCaptured = journalFactory.captureOrAdvance({
    checkpoint: null,
    snapshot: wrongSnapshot,
    transactions: [wrongTx],
    oldDoc,
    newDoc: wrongTx.doc
  })
  if (wrongCaptured.ok) {
    const wrongPlan = owner.plan({
      journal: wrongCaptured.checkpoint,
      activeJournal: wrongCaptured.checkpoint,
      snapshot: wrongSnapshot,
      currentSource: source,
      currentCanonical: previous,
      canonical,
      expectedDoc: wrongTx.doc,
      callbackDocumentEquivalent: true
    })
    assert.equal(wrongPlan.ok, false)
    assert.equal(wrongPlan.recognized, true)
  }
}

assert.throws(
  () => createListEmptyItemFirstLiftTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
console.log('PASS list first-empty lift transaction owner: real joinBackward ReplaceAroundStep lifts one plain bullet empty paragraph before the list, removes only the authored first empty marker row with BOM/CRLF intact, and keeps ordered/task/tail/loose/source-mismatch/wrong-gap cases separate or fail closed')
