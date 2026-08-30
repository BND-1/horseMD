import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { liftListItem } from '@milkdown/prose/schema-list'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY,
  LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
  createListNestedFirstChildBulletOutdentTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-first-child-bullet-outdent-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block', attrs: { spread: { default: 'false' } } },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 }, spread: { default: 'false' } } },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null }, label: { default: null }, listType: { default: null }, spread: { default: 'false' } }
    },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const bulletItem = (value = '', children = []) => schema.nodes.list_item.create({ checked: null, label: '•', listType: 'bullet', spread: 'false' }, [paragraph(value), ...children])
const taskItem = (value = '', children = []) => schema.nodes.list_item.create({ checked: false, label: '•', listType: 'bullet', spread: 'false' }, [paragraph(value), ...children])
const bulletList = (...items) => schema.nodes.bullet_list.create({ spread: 'false' }, items)
const orderedItem = (label, value = '') => schema.nodes.list_item.create({ checked: null, label, listType: 'ordered', spread: 'false' }, paragraph(value))
const orderedList = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'false' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const captureLift = (oldDoc, path) => {
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, path)
  const state = EditorState.create({ schema, doc: oldDoc, selection: TextSelection.create(oldDoc, paragraphEntry.contentStart) })
  let transaction = null
  const handled = liftListItem(schema.nodes.list_item)(state, (value) => { transaction = value })
  return { handled, transaction }
}
const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc, owner: 'fixture', family: 'fixture' })
  const journal = createSourceSyncTransactionJournal()
  const captured = journal.captureOrAdvance({ checkpoint: null, snapshot, transactions: [transaction], oldDoc, newDoc: transaction.doc })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}
const offsetResolverFor = (oldDoc, labels) => {
  const map = new Map()
  map.set(sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 0]).contentStart, labels.parent)
  for (let index = 0; index < labels.nested.length; index += 1) {
    map.set(sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, index, 0]).contentStart, labels.nested[index])
  }
  return ({ markdown, pmPos }) => {
    const label = map.get(pmPos)
    return label ? markdown.indexOf(label) : -1
  }
}
const makeOwner = ({ oldDoc, labels, expectedSource, expectedDoc }) =>
  createListNestedFirstChildBulletOutdentTransactionSourceSyncOwner({
    resolveMarkdownOffset: offsetResolverFor(oldDoc, labels),
    validateMarkdown: ({ markdown, expectedDoc: actual }) => markdown === expectedSource && actual.eq(expectedDoc)
  })
const runPlan = ({ owner, capture, source, previous, canonical, expectedDoc }) => owner.plan({
  journal: capture.checkpoint,
  activeJournal: capture.checkpoint,
  snapshot: capture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})

const oldDoc = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const lifted = captureLift(oldDoc, [1, 1, 1, 0, 0])
assert.equal(lifted.handled, true)
assert.equal(lifted.transaction.steps.length, 2)
const firstStep = lifted.transaction.steps[0]
const secondStep = lifted.transaction.steps[1]
assert.equal(firstStep.constructor.name, 'ReplaceAroundStep')
assert.equal(firstStep.structure, true)
assert.equal(firstStep.insert, 1)
assert.equal(firstStep.slice.size, 3)
assert.equal(firstStep.slice.openStart, 1)
assert.equal(firstStep.slice.openEnd, 0)
assert.equal(secondStep.constructor.name, 'ReplaceAroundStep')
assert.equal(secondStep.structure, true)
assert.equal(secondStep.insert, 1)
assert.equal(secondStep.slice.size, 1)
assert.equal(secondStep.slice.openStart, 1)
assert.equal(secondStep.slice.openEnd, 0)
const nestedEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1])
const targetEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, 0])
const successorEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, 1])
assert.equal(firstStep.from, targetEntry.beforePos + targetEntry.node.nodeSize - 1)
assert.equal(firstStep.to, nestedEntry.beforePos + nestedEntry.node.nodeSize - 1)
assert.equal(firstStep.gapFrom, successorEntry.beforePos)
assert.equal(firstStep.gapTo, nestedEntry.beforePos + nestedEntry.node.nodeSize - 1)
const intermediateDoc = lifted.transaction.docs[1]
const intermediateParent = sourceSyncNodeEntryAtPath(intermediateDoc, [1, 1])
const intermediateNested = sourceSyncNodeEntryAtPath(intermediateDoc, [1, 1, 1])
const intermediateTarget = sourceSyncNodeEntryAtPath(intermediateDoc, [1, 1, 1, 0])
assert.equal(secondStep.from, intermediateNested.beforePos)
assert.equal(secondStep.to, intermediateParent.beforePos + intermediateParent.node.nodeSize)
assert.equal(secondStep.gapFrom, intermediateTarget.beforePos)
assert.equal(secondStep.gapTo, intermediateTarget.beforePos + intermediateTarget.node.nodeSize)

const source = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const previous = 'before\n\n* alpha\n\n* beta\n\n  * gamma\n\n  * delta\n\n* omega\n\nafter\n'
const canonical = 'before\n\n* alpha\n\n* beta\n\n* gamma\n\n  * delta\n\n* omega\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const capture = captureJournal({ source, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 161 })
const owner = makeOwner({ oldDoc, labels: { parent: 'beta', nested: ['gamma', 'delta'] }, expectedSource, expectedDoc: lifted.transaction.doc })
const plan = runPlan({ owner, capture, source, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.family, LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_NESTED_FIRST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-nested-first-child-bullet-outdented')
assert.equal(plan.result.markdown, expectedSource)
assert.equal(plan.proof.nestedCount, 2)
assert.equal(plan.proof.successorCount, 1)
assert.deepEqual(plan.proof.parentPath, [1, 1])
assert.deepEqual(plan.proof.nestedListPath, [1, 1, 1])
assert.deepEqual(plan.proof.nestedItemPath, [1, 1, 1, 0])
assert.deepEqual(plan.proof.targetNewPath, [1, 2])
assert.equal(plan.proof.firstStep.sliceSize, 3)
assert.equal(plan.proof.secondStep.sliceSize, 1)
assert.equal(plan.proof.movedSourceRow.token, '+')
assert.equal(plan.proof.rawRemoval.removed, '  ')
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)

const threeOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'), bulletItem('epsilon'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const threeLift = captureLift(threeOld, [1, 1, 1, 0, 0])
assert.equal(threeLift.handled, true)
assert.equal(threeLift.transaction.steps.length, 2)
const threeSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n  + epsilon\r\n+ omega\r\n\r\nafter\r\n'
const threeExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ gamma\r\n  + delta\r\n  + epsilon\r\n+ omega\r\n\r\nafter\r\n'
const threePrevious = 'three-previous'
const threeCanonical = 'three-canonical'
const threeCapture = captureJournal({ source: threeSource, canonical: threePrevious, oldDoc: threeOld, transaction: threeLift.transaction, revision: 162 })
const threeOwner = makeOwner({ oldDoc: threeOld, labels: { parent: 'beta', nested: ['gamma', 'delta', 'epsilon'] }, expectedSource: threeExpected, expectedDoc: threeLift.transaction.doc })
const threePlan = runPlan({ owner: threeOwner, capture: threeCapture, source: threeSource, previous: threePrevious, canonical: threeCanonical, expectedDoc: threeLift.transaction.doc })
assert.equal(threePlan.ok, true, JSON.stringify(threePlan))
assert.equal(threePlan.proof.nestedCount, 3)
assert.equal(threePlan.proof.successorCount, 2)
assert.equal(threePlan.result.markdown, threeExpected)

const wideSource = source.replace('  + gamma', '    + gamma')
const wideCapture = captureJournal({ source: wideSource, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 163 })
const widePlan = runPlan({ owner, capture: wideCapture, source: wideSource, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(widePlan.ok, false)
assert.equal(widePlan.recognized, true)
assert.equal(widePlan.reason, 'nested-first-child-outdent-source-row-unproven')

const mixedSource = source.replace('  + gamma', '  * gamma')
const mixedCapture = captureJournal({ source: mixedSource, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 164 })
const mixedPlan = runPlan({ owner, capture: mixedCapture, source: mixedSource, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(mixedPlan.ok, false)
assert.equal(mixedPlan.recognized, true)
assert.equal(mixedPlan.reason, 'nested-first-child-outdent-source-row-unproven')

const lastLift = captureLift(oldDoc, [1, 1, 1, 1, 0])
assert.equal(lastLift.handled, true)
assert.equal(lastLift.transaction.steps.length, 1)
const lastCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: lastLift.transaction, revision: 165 })
const lastPlan = runPlan({ owner, capture: lastCapture, source, previous, canonical, expectedDoc: lastLift.transaction.doc })
assert.equal(lastPlan.ok, false)
assert.equal(lastPlan.recognized, false)

const singleOld = document(paragraph('before'), bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'))])), paragraph('after'))
const singleLift = captureLift(singleOld, [1, 1, 1, 0, 0])
const singleCapture = captureJournal({ source, canonical: previous, oldDoc: singleOld, transaction: singleLift.transaction, revision: 166 })
const singlePlan = runPlan({ owner, capture: singleCapture, source, previous, canonical, expectedDoc: singleLift.transaction.doc })
assert.equal(singlePlan.ok, false)
assert.equal(singlePlan.recognized, false)

const taskOld = document(paragraph('before'), bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'), taskItem('delta'))])), paragraph('after'))
const taskLift = captureLift(taskOld, [1, 1, 1, 0, 0])
const taskCapture = captureJournal({ source, canonical: previous, oldDoc: taskOld, transaction: taskLift.transaction, revision: 167 })
const taskPlan = runPlan({ owner, capture: taskCapture, source, previous, canonical, expectedDoc: taskLift.transaction.doc })
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const emptyOld = document(paragraph('before'), bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem(''))])), paragraph('after'))
const emptyLift = captureLift(emptyOld, [1, 1, 1, 0, 0])
const emptyCapture = captureJournal({ source, canonical: previous, oldDoc: emptyOld, transaction: emptyLift.transaction, revision: 168 })
const emptyPlan = runPlan({ owner, capture: emptyCapture, source, previous, canonical, expectedDoc: emptyLift.transaction.doc })
assert.equal(emptyPlan.ok, false)
assert.equal(emptyPlan.recognized, false)

const orderedOld = document(paragraph('before'), bulletList(bulletItem('alpha'), bulletItem('beta', [orderedList(orderedItem('1.', 'gamma'), orderedItem('2.', 'delta'))])), paragraph('after'))
const orderedLift = captureLift(orderedOld, [1, 1, 1, 0, 0])
const orderedCapture = captureJournal({ source, canonical: previous, oldDoc: orderedOld, transaction: orderedLift.transaction, revision: 169 })
const orderedPlan = runPlan({ owner, capture: orderedCapture, source, previous, canonical, expectedDoc: orderedLift.transaction.doc })
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

const wrongFirst = {
  constructor: { name: 'ReplaceAroundStep' },
  from: firstStep.from + 1,
  to: firstStep.to,
  gapFrom: firstStep.gapFrom,
  gapTo: firstStep.gapTo,
  insert: firstStep.insert,
  structure: true,
  slice: firstStep.slice,
  apply: () => ({ doc: lifted.transaction.docs[1] })
}
const wrongTx = {
  docChanged: true,
  before: oldDoc,
  doc: lifted.transaction.doc,
  docs: [oldDoc, lifted.transaction.docs[1]],
  steps: [wrongFirst, secondStep],
  mapping: { maps: [{ map: (position) => position }, { map: (position) => position }] }
}
const wrongCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: wrongTx, revision: 170 })
const wrongPlan = runPlan({ owner, capture: wrongCapture, source, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'nested-first-child-outdent-first-step-range')

assert.throws(
  () => createListNestedFirstChildBulletOutdentTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested first-child bullet outdent transaction owner: exact two-Step liftListItem works for 2/3 nested children with stepDoc-bound intermediate topology, source only removes the first target two-space indent while successors remain nested; wide/mixed/wrong Step fail closed and last/single/empty/task/ordered families remain separate')
