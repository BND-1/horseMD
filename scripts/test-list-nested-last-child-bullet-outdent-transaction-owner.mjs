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
  LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY,
  LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
  createListNestedLastChildBulletOutdentTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-last-child-bullet-outdent-transaction-owner.js'

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
  createListNestedLastChildBulletOutdentTransactionSourceSyncOwner({
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
const lifted = captureLift(oldDoc, [1, 1, 1, 1, 0])
assert.equal(lifted.handled, true)
assert.ok(lifted.transaction)
assert.equal(lifted.transaction.steps.length, 1)
const nativeStep = lifted.transaction.steps[0]
assert.equal(nativeStep.constructor.name, 'ReplaceAroundStep')
assert.equal(nativeStep.structure, true)
assert.equal(nativeStep.slice.size, 2)
assert.equal(nativeStep.slice.openStart, 2)
assert.equal(nativeStep.slice.openEnd, 0)
assert.equal(nativeStep.insert, 2)
const parentEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1])
const targetEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, 1])
assert.equal(nativeStep.from, targetEntry.beforePos)
assert.equal(nativeStep.gapFrom, targetEntry.beforePos)
assert.equal(nativeStep.gapTo, targetEntry.beforePos + targetEntry.node.nodeSize)
assert.equal(nativeStep.to, parentEntry.beforePos + parentEntry.node.nodeSize)

const source = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const previous = 'before\n\n* alpha\n\n* beta\n\n  * gamma\n\n  * delta\n\n* omega\n\nafter\n'
const canonical = 'before\n\n* alpha\n\n* beta\n\n  * gamma\n\n* delta\n\n* omega\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n+ delta\r\n+ omega\r\n\r\nafter\r\n'
const capture = captureJournal({ source, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 160 })
const owner = makeOwner({ oldDoc, labels: { parent: 'beta', nested: ['gamma', 'delta'] }, expectedSource, expectedDoc: lifted.transaction.doc })
const plan = runPlan({ owner, capture, source, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_NESTED_LAST_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-nested-last-child-bullet-outdented')
assert.equal(plan.result.markdown, expectedSource)
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)
assert.equal(plan.proof.nestedCount, 2)
assert.equal(plan.proof.targetIndex, 1)
assert.deepEqual(plan.proof.parentPath, [1, 1])
assert.deepEqual(plan.proof.nestedListPath, [1, 1, 1])
assert.deepEqual(plan.proof.nestedItemPath, [1, 1, 1, 1])
assert.deepEqual(plan.proof.targetNewPath, [1, 2])
assert.equal(plan.proof.movedSourceRow.token, '+')
assert.equal(plan.proof.movedSourceRow.indent, '  ')
assert.equal(plan.proof.rawRemoval.removed, '  ')
assert.equal(plan.proof.step.sliceSize, 2)
assert.equal(plan.proof.step.openStart, 2)
assert.equal(plan.proof.step.insert, 2)

const threeOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'), bulletItem('epsilon'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const threeLift = captureLift(threeOld, [1, 1, 1, 2, 0])
assert.equal(threeLift.handled, true)
assert.equal(threeLift.transaction.steps.length, 1)
assert.equal(threeLift.transaction.steps[0].slice.size, 2)
assert.equal(threeLift.transaction.steps[0].slice.openStart, 2)
assert.equal(threeLift.transaction.steps[0].insert, 2)
const threeSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n  + epsilon\r\n+ omega\r\n\r\nafter\r\n'
const threeExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n+ epsilon\r\n+ omega\r\n\r\nafter\r\n'
const threePrevious = 'three-previous'
const threeCanonical = 'three-canonical'
const threeCapture = captureJournal({ source: threeSource, canonical: threePrevious, oldDoc: threeOld, transaction: threeLift.transaction, revision: 161 })
const threeOwner = makeOwner({
  oldDoc: threeOld,
  labels: { parent: 'beta', nested: ['gamma', 'delta', 'epsilon'] },
  expectedSource: threeExpected,
  expectedDoc: threeLift.transaction.doc
})
const threePlan = runPlan({ owner: threeOwner, capture: threeCapture, source: threeSource, previous: threePrevious, canonical: threeCanonical, expectedDoc: threeLift.transaction.doc })
assert.equal(threePlan.ok, true, JSON.stringify(threePlan))
assert.equal(threePlan.proof.nestedCount, 3)
assert.equal(threePlan.proof.targetIndex, 2)
assert.equal(threePlan.result.markdown, threeExpected)

const wideSource = source.replace('  + delta', '    + delta')
const wideCapture = captureJournal({ source: wideSource, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 162 })
const widePlan = runPlan({ owner, capture: wideCapture, source: wideSource, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(widePlan.ok, false)
assert.equal(widePlan.recognized, true)
assert.equal(widePlan.reason, 'nested-last-child-outdent-source-row-unproven')

const mixedSource = source.replace('  + delta', '  * delta')
const mixedCapture = captureJournal({ source: mixedSource, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 163 })
const mixedPlan = runPlan({ owner, capture: mixedCapture, source: mixedSource, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(mixedPlan.ok, false)
assert.equal(mixedPlan.recognized, true)
assert.equal(mixedPlan.reason, 'nested-last-child-outdent-source-row-unproven')

const firstLift = captureLift(oldDoc, [1, 1, 1, 0, 0])
assert.equal(firstLift.handled, true)
assert.equal(firstLift.transaction.steps.length, 2)
const firstCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: firstLift.transaction, revision: 164 })
const firstPlan = runPlan({ owner, capture: firstCapture, source, previous, canonical, expectedDoc: firstLift.transaction.doc })
assert.equal(firstPlan.ok, false)
assert.equal(firstPlan.recognized, false)

const singleOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'))])),
  paragraph('after')
)
const singleLift = captureLift(singleOld, [1, 1, 1, 0, 0])
const singleCapture = captureJournal({ source, canonical: previous, oldDoc: singleOld, transaction: singleLift.transaction, revision: 165 })
const singlePlan = runPlan({ owner, capture: singleCapture, source, previous, canonical, expectedDoc: singleLift.transaction.doc })
assert.equal(singlePlan.ok, false)
assert.equal(singlePlan.recognized, false)

const taskOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'), taskItem('delta'))])),
  paragraph('after')
)
const taskLift = captureLift(taskOld, [1, 1, 1, 1, 0])
assert.equal(taskLift.handled, true)
const taskCapture = captureJournal({ source, canonical: previous, oldDoc: taskOld, transaction: taskLift.transaction, revision: 166 })
const taskPlan = runPlan({ owner, capture: taskCapture, source, previous, canonical, expectedDoc: taskLift.transaction.doc })
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const emptyOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem(''))])),
  paragraph('after')
)
const emptyLift = captureLift(emptyOld, [1, 1, 1, 1, 0])
assert.equal(emptyLift.handled, true)
const emptyCapture = captureJournal({ source, canonical: previous, oldDoc: emptyOld, transaction: emptyLift.transaction, revision: 167 })
const emptyPlan = runPlan({ owner, capture: emptyCapture, source, previous, canonical, expectedDoc: emptyLift.transaction.doc })
assert.equal(emptyPlan.ok, false)
assert.equal(emptyPlan.recognized, false)

const orderedOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [orderedList(orderedItem('1.', 'gamma'), orderedItem('2.', 'delta'))])),
  paragraph('after')
)
const orderedLift = captureLift(orderedOld, [1, 1, 1, 1, 0])
assert.equal(orderedLift.handled, true)
const orderedCapture = captureJournal({ source, canonical: previous, oldDoc: orderedOld, transaction: orderedLift.transaction, revision: 168 })
const orderedPlan = runPlan({ owner, capture: orderedCapture, source, previous, canonical, expectedDoc: orderedLift.transaction.doc })
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

const wrongStep = {
  constructor: { name: 'ReplaceAroundStep' },
  from: nativeStep.from,
  to: nativeStep.to,
  gapFrom: nativeStep.gapFrom + 1,
  gapTo: nativeStep.gapTo,
  insert: nativeStep.insert,
  structure: true,
  slice: nativeStep.slice,
  apply: () => ({ doc: lifted.transaction.doc })
}
const wrongTx = {
  docChanged: true,
  before: oldDoc,
  doc: lifted.transaction.doc,
  docs: [oldDoc],
  steps: [wrongStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: wrongTx, revision: 169 })
const wrongPlan = runPlan({ owner, capture: wrongCapture, source, previous, canonical, expectedDoc: lifted.transaction.doc })
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'nested-last-child-outdent-step-range')

assert.throws(
  () => createListNestedLastChildBulletOutdentTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested last-child bullet outdent transaction owner: exact last-of-multiple liftListItem works for 2/3 nested children, removes only two target indentation spaces and preserves authored marker/BOM/CRLF; wide/mixed/wrong Step fail closed while first-child/single/empty/task/ordered outdents remain separate')
