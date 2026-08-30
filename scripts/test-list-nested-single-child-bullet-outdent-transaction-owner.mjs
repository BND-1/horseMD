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
  LIST_NESTED_SINGLE_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY,
  LIST_NESTED_SINGLE_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY,
  createListNestedSingleChildBulletOutdentTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-single-child-bullet-outdent-transaction-owner.js'

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

const oldDoc = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'))])),
  paragraph('after')
)
const lifted = captureLift(oldDoc, [1, 1, 1, 0, 0])
assert.equal(lifted.handled, true)
assert.ok(lifted.transaction)
assert.equal(lifted.transaction.steps.length, 1)
const nativeStep = lifted.transaction.steps[0]
assert.equal(nativeStep.constructor.name, 'ReplaceAroundStep')
assert.equal(nativeStep.structure, true)
assert.equal(nativeStep.slice.size, 1)
assert.equal(nativeStep.slice.openStart, 1)
assert.equal(nativeStep.slice.openEnd, 0)
assert.equal(nativeStep.insert, 1)
const parentEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1])
const nestedEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1])
const targetEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, 0])
assert.equal(nativeStep.from, nestedEntry.beforePos)
assert.equal(nativeStep.to, parentEntry.beforePos + parentEntry.node.nodeSize)
assert.equal(nativeStep.gapFrom, targetEntry.beforePos)
assert.equal(nativeStep.gapTo, targetEntry.beforePos + targetEntry.node.nodeSize)
assert.equal(targetEntry.beforePos, nestedEntry.contentStart)

const source = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n\r\nafter\r\n'
const previous = 'before\n\n* alpha\n\n* beta\n\n  * gamma\n\nafter\n'
const canonical = 'before\n\n* alpha\n\n* beta\n\n* gamma\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ gamma\r\n\r\nafter\r\n'
const journal = captureJournal({ source, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 159 })
const parentContentStart = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 0]).contentStart
const targetContentStart = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, 0, 0]).contentStart
const owner = createListNestedSingleChildBulletOutdentTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos }) => pmPos === parentContentStart ? markdown.indexOf('beta') : pmPos === targetContentStart ? markdown.indexOf('gamma') : -1,
  validateMarkdown: ({ markdown, expectedDoc }) => markdown === expectedSource && expectedDoc.eq(lifted.transaction.doc)
})
const plan = owner.plan({
  journal: journal.checkpoint,
  activeJournal: journal.checkpoint,
  snapshot: journal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: lifted.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_NESTED_SINGLE_CHILD_BULLET_OUTDENT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_NESTED_SINGLE_CHILD_BULLET_OUTDENT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-nested-single-child-bullet-outdented')
assert.equal(plan.result.markdown, expectedSource)
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)
assert.deepEqual(plan.proof.parentPath, [1, 1])
assert.deepEqual(plan.proof.nestedListPath, [1, 1, 1])
assert.deepEqual(plan.proof.nestedItemPath, [1, 1, 1, 0])
assert.deepEqual(plan.proof.targetNewPath, [1, 2])
assert.equal(plan.proof.movedSourceRow.token, '+')
assert.equal(plan.proof.movedSourceRow.indent, '  ')
assert.equal(plan.proof.rawRemoval.removed, '  ')
assert.equal(plan.proof.step.sliceSize, 1)

const wideSource = source.replace('  + gamma', '    + gamma')
const wideJournal = captureJournal({ source: wideSource, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 160 })
const widePlan = owner.plan({
  journal: wideJournal.checkpoint,
  activeJournal: wideJournal.checkpoint,
  snapshot: wideJournal.snapshot,
  currentSource: wideSource,
  currentCanonical: previous,
  canonical,
  expectedDoc: lifted.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(widePlan.ok, false)
assert.equal(widePlan.recognized, true)
assert.equal(widePlan.reason, 'nested-single-child-outdent-source-row-unproven')

const mixedMarkerSource = source.replace('  + gamma', '  * gamma')
const mixedJournal = captureJournal({ source: mixedMarkerSource, canonical: previous, oldDoc, transaction: lifted.transaction, revision: 161 })
const mixedPlan = owner.plan({
  journal: mixedJournal.checkpoint,
  activeJournal: mixedJournal.checkpoint,
  snapshot: mixedJournal.snapshot,
  currentSource: mixedMarkerSource,
  currentCanonical: previous,
  canonical,
  expectedDoc: lifted.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(mixedPlan.ok, false)
assert.equal(mixedPlan.recognized, true)
assert.equal(mixedPlan.reason, 'nested-single-child-outdent-source-row-unproven')

const multipleOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'))])),
  paragraph('after')
)
const multipleLift = captureLift(multipleOld, [1, 1, 1, 0, 0])
assert.equal(multipleLift.handled, true)
const multipleJournal = captureJournal({ source, canonical: previous, oldDoc: multipleOld, transaction: multipleLift.transaction, revision: 162 })
const multiplePlan = owner.plan({
  journal: multipleJournal.checkpoint,
  activeJournal: multipleJournal.checkpoint,
  snapshot: multipleJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: multipleLift.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(multiplePlan.ok, false)
assert.equal(multiplePlan.recognized, false)

const emptyOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem(''))])),
  paragraph('after')
)
const emptyLift = captureLift(emptyOld, [1, 1, 1, 0, 0])
assert.equal(emptyLift.handled, true)
const emptyJournal = captureJournal({ source, canonical: previous, oldDoc: emptyOld, transaction: emptyLift.transaction, revision: 163 })
const emptyPlan = owner.plan({
  journal: emptyJournal.checkpoint,
  activeJournal: emptyJournal.checkpoint,
  snapshot: emptyJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: emptyLift.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(emptyPlan.ok, false)
assert.equal(emptyPlan.recognized, false)

const taskOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(taskItem('gamma'))])),
  paragraph('after')
)
const taskLift = captureLift(taskOld, [1, 1, 1, 0, 0])
assert.equal(taskLift.handled, true)
const taskJournal = captureJournal({ source, canonical: previous, oldDoc: taskOld, transaction: taskLift.transaction, revision: 164 })
const taskPlan = owner.plan({
  journal: taskJournal.checkpoint,
  activeJournal: taskJournal.checkpoint,
  snapshot: taskJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: taskLift.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const orderedOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [orderedList(orderedItem('1.', 'gamma'))])),
  paragraph('after')
)
const orderedLift = captureLift(orderedOld, [1, 1, 1, 0, 0])
assert.equal(orderedLift.handled, true)
const orderedJournal = captureJournal({ source, canonical: previous, oldDoc: orderedOld, transaction: orderedLift.transaction, revision: 165 })
const orderedPlan = owner.plan({
  journal: orderedJournal.checkpoint,
  activeJournal: orderedJournal.checkpoint,
  snapshot: orderedJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: orderedLift.transaction.doc,
  callbackDocumentEquivalent: true
})
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
const wrongJournal = captureJournal({ source, canonical: previous, oldDoc, transaction: wrongTx, revision: 166 })
const wrongPlan = owner.plan({
  journal: wrongJournal.checkpoint,
  activeJournal: wrongJournal.checkpoint,
  snapshot: wrongJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: lifted.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'nested-single-child-outdent-step-range')

assert.throws(
  () => createListNestedSingleChildBulletOutdentTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested single child bullet outdent transaction owner: exact single-Step liftListItem removes only two source indentation spaces while preserving authored marker/BOM/CRLF; wider indent/mixed marker/wrong Step fail closed and multiple-child/empty/task/ordered outdents remain separate')
