import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { sinkListItem } from '@milkdown/prose/schema-list'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_NESTED_NONEMPTY_BULLET_INDENT_TRANSACTION_BOUNDARY,
  LIST_NESTED_NONEMPTY_BULLET_INDENT_TRANSACTION_FAMILY,
  createListNestedNonemptyBulletIndentTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-nonempty-bullet-indent-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block', attrs: { spread: { default: 'false' } } },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 }, spread: { default: 'false' } } },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        checked: { default: null },
        label: { default: null },
        listType: { default: null },
        spread: { default: 'false' }
      }
    },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const bulletItem = (value = '', children = []) => schema.nodes.list_item.create({
  checked: null, label: '•', listType: 'bullet', spread: 'false'
}, [paragraph(value), ...children])
const taskItem = (value = '') => schema.nodes.list_item.create({
  checked: false, label: '•', listType: 'bullet', spread: 'false'
}, paragraph(value))
const bulletList = (...items) => schema.nodes.bullet_list.create({ spread: 'false' }, items)
const orderedItem = (label, value = '') => schema.nodes.list_item.create({
  checked: null, label, listType: 'ordered', spread: 'false'
}, paragraph(value))
const orderedList = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'false' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const captureSink = (oldDoc, path) => {
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, path)
  const state = EditorState.create({ schema, doc: oldDoc, selection: TextSelection.create(oldDoc, paragraphEntry.contentStart) })
  let transaction = null
  const handled = sinkListItem(schema.nodes.list_item)(state, (value) => { transaction = value })
  return { handled, transaction }
}
const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc, owner: 'fixture', family: 'fixture' })
  const journal = createSourceSyncTransactionJournal()
  const captured = journal.captureOrAdvance({
    checkpoint: null,
    snapshot,
    transactions: [transaction],
    oldDoc,
    newDoc: transaction.doc
  })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}

const runScenario = ({ name, targetIndex, revision, expectedSource }) => {
  const oldDoc = document(
    paragraph('before'),
    bulletList(bulletItem('alpha'), bulletItem('beta'), bulletItem('gamma')),
    paragraph('after')
  )
  const { handled, transaction } = captureSink(oldDoc, [1, targetIndex, 0])
  assert.equal(handled, true)
  assert.equal(transaction.steps.length, 1)
  const nativeStep = transaction.steps[0]
  assert.equal(nativeStep.constructor.name, 'ReplaceAroundStep')
  assert.equal(nativeStep.structure, true)
  assert.equal(nativeStep.slice.size, 3)
  assert.equal(nativeStep.slice.openStart, 1)
  assert.equal(nativeStep.slice.openEnd, 0)
  assert.equal(nativeStep.insert, 1)

  const parentEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, targetIndex - 1])
  const targetEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, targetIndex])
  assert.equal(targetEntry.beforePos, parentEntry.beforePos + parentEntry.node.nodeSize)
  assert.equal(nativeStep.from, targetEntry.beforePos - 1)
  assert.equal(nativeStep.to, targetEntry.beforePos + targetEntry.node.nodeSize)
  assert.equal(nativeStep.gapFrom, targetEntry.beforePos)
  assert.equal(nativeStep.gapTo, nativeStep.to)

  const source = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ gamma\r\n\r\nafter\r\n'
  const previous = 'before\n\n* alpha\n\n* beta\n\n* gamma\n\nafter\n'
  const canonical = targetIndex === 2
    ? 'before\n\n* alpha\n\n* beta\n\n  * gamma\n\nafter\n'
    : 'before\n\n* alpha\n\n  * beta\n\n* gamma\n\nafter\n'
  const journal = captureJournal({ source, canonical: previous, oldDoc, transaction, revision })
  const parentText = targetIndex === 2 ? 'beta' : 'alpha'
  const owner = createListNestedNonemptyBulletIndentTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown }) => markdown.indexOf(parentText),
    validateMarkdown: ({ markdown, expectedDoc }) => markdown === expectedSource && expectedDoc.eq(transaction.doc)
  })
  const plan = owner.plan({
    journal: journal.checkpoint,
    activeJournal: journal.checkpoint,
    snapshot: journal.snapshot,
    currentSource: source,
    currentCanonical: previous,
    canonical,
    expectedDoc: transaction.doc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.ok, true, `${name}: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, LIST_NESTED_NONEMPTY_BULLET_INDENT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, LIST_NESTED_NONEMPTY_BULLET_INDENT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'list-nested-nonempty-bullet-indented')
  assert.equal(plan.result.markdown, expectedSource)
  assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
  assert.equal(plan.result.markdown.includes('\r\n'), true)
  assert.equal(plan.proof.targetIndex, targetIndex)
  assert.equal(plan.proof.parentIndex, targetIndex - 1)
  assert.equal(plan.proof.position, targetIndex === 2 ? 'tail' : 'middle')
  assert.deepEqual(plan.proof.targetPath, [1, targetIndex])
  assert.deepEqual(plan.proof.nestedListPath, [1, targetIndex - 1, 1])
  assert.deepEqual(plan.proof.nestedItemPath, [1, targetIndex - 1, 1, 0])
  assert.equal(plan.proof.movedSourceRow.token, '+')
  assert.equal(plan.proof.rawInsertion.insertion, '  ')
  assert.equal(plan.proof.step.from, nativeStep.from)
  assert.equal(plan.proof.step.gapFrom, nativeStep.gapFrom)
  assert.equal(plan.proof.step.gapTo, nativeStep.gapTo)
  return { oldDoc, transaction, source, previous, canonical, owner }
}

const tail = runScenario({
  name: 'tail',
  targetIndex: 2,
  revision: 158,
  expectedSource: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n\r\nafter\r\n'
})
runScenario({
  name: 'middle',
  targetIndex: 1,
  revision: 159,
  expectedSource: '\uFEFFbefore\r\n\r\n+ alpha\r\n  + beta\r\n+ gamma\r\n\r\nafter\r\n'
})

const wideSource = tail.source.replaceAll('+ ', '+  ')
const wideJournal = captureJournal({ source: wideSource, canonical: tail.previous, oldDoc: tail.oldDoc, transaction: tail.transaction, revision: 160 })
const widePlan = tail.owner.plan({
  journal: wideJournal.checkpoint,
  activeJournal: wideJournal.checkpoint,
  snapshot: wideJournal.snapshot,
  currentSource: wideSource,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: tail.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(widePlan.ok, false)
assert.equal(widePlan.recognized, true)
assert.equal(widePlan.reason, 'nested-nonempty-bullet-indent-source-row-unproven')

const escapedSource = tail.source.replace('+ gamma', '+ ga\\mma')
const escapedJournal = captureJournal({ source: escapedSource, canonical: tail.previous, oldDoc: tail.oldDoc, transaction: tail.transaction, revision: 161 })
const escapedPlan = tail.owner.plan({
  journal: escapedJournal.checkpoint,
  activeJournal: escapedJournal.checkpoint,
  snapshot: escapedJournal.snapshot,
  currentSource: escapedSource,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: tail.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(escapedPlan.ok, false)
assert.equal(escapedPlan.recognized, true)
assert.equal(escapedPlan.reason, 'nested-nonempty-bullet-indent-source-row-unproven')

const emptyOld = document(paragraph('before'), bulletList(bulletItem('alpha'), bulletItem('beta'), bulletItem('')), paragraph('after'))
const emptySink = captureSink(emptyOld, [1, 2, 0])
const emptyJournal = captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: emptyOld, transaction: emptySink.transaction, revision: 162 })
const emptyPlan = tail.owner.plan({
  journal: emptyJournal.checkpoint,
  activeJournal: emptyJournal.checkpoint,
  snapshot: emptyJournal.snapshot,
  currentSource: tail.source,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: emptySink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(emptyPlan.ok, false)
assert.equal(emptyPlan.recognized, false)

const existingNested = bulletList(bulletItem('inside'))
const nestedParentOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [existingNested]), bulletItem('gamma')),
  paragraph('after')
)
const nestedParentSink = captureSink(nestedParentOld, [1, 2, 0])
const nestedJournal = captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: nestedParentOld, transaction: nestedParentSink.transaction, revision: 163 })
const nestedPlan = tail.owner.plan({
  journal: nestedJournal.checkpoint,
  activeJournal: nestedJournal.checkpoint,
  snapshot: nestedJournal.snapshot,
  currentSource: tail.source,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: nestedParentSink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(nestedPlan.ok, false)
assert.equal(nestedPlan.recognized, false)

const taskOld = document(paragraph('before'), bulletList(bulletItem('alpha'), bulletItem('beta'), taskItem('gamma')), paragraph('after'))
const taskSink = captureSink(taskOld, [1, 2, 0])
const taskJournal = captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: taskOld, transaction: taskSink.transaction, revision: 164 })
const taskPlan = tail.owner.plan({
  journal: taskJournal.checkpoint,
  activeJournal: taskJournal.checkpoint,
  snapshot: taskJournal.snapshot,
  currentSource: tail.source,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: taskSink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const orderedOld = document(paragraph('before'), orderedList(orderedItem('1.', 'alpha'), orderedItem('2.', 'beta'), orderedItem('3.', 'gamma')), paragraph('after'))
const orderedSink = captureSink(orderedOld, [1, 2, 0])
const orderedJournal = captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: orderedOld, transaction: orderedSink.transaction, revision: 165 })
const orderedPlan = tail.owner.plan({
  journal: orderedJournal.checkpoint,
  activeJournal: orderedJournal.checkpoint,
  snapshot: orderedJournal.snapshot,
  currentSource: tail.source,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: orderedSink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

const native = tail.transaction.steps[0]
const wrongStep = {
  constructor: { name: 'ReplaceAroundStep' },
  from: native.from,
  to: native.to,
  gapFrom: native.gapFrom + 1,
  gapTo: native.gapTo,
  insert: native.insert,
  structure: true,
  slice: native.slice,
  apply: () => ({ doc: tail.transaction.doc })
}
const wrongTransaction = {
  docChanged: true,
  before: tail.oldDoc,
  doc: tail.transaction.doc,
  docs: [tail.oldDoc],
  steps: [wrongStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongJournal = captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: tail.oldDoc, transaction: wrongTransaction, revision: 166 })
const wrongPlan = tail.owner.plan({
  journal: wrongJournal.checkpoint,
  activeJournal: wrongJournal.checkpoint,
  snapshot: wrongJournal.snapshot,
  currentSource: tail.source,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: tail.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'nested-nonempty-bullet-indent-step-range')

assert.equal(tail.owner.plan({
  journal: captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: tail.oldDoc, transaction: tail.transaction, revision: 167 }).checkpoint,
  activeJournal: null,
  snapshot: captureJournal({ source: tail.source, canonical: tail.previous, oldDoc: tail.oldDoc, transaction: tail.transaction, revision: 168 }).snapshot,
  currentSource: tail.source,
  currentCanonical: tail.previous,
  canonical: tail.canonical,
  expectedDoc: tail.transaction.doc,
  callbackDocumentEquivalent: true
}).ok, false)

assert.throws(
  () => createListNestedNonemptyBulletIndentTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested nonempty bullet indent transaction owner: exact sinkListItem ReplaceAroundStep owns middle/tail plain nonempty bullet Tab sink, source patch only inserts two spaces and preserves authored marker/BOM/CRLF; spacing/raw-body failures are recognized while empty/existing-nested/task/ordered families remain separate')
