import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { joinBackward } from '@milkdown/prose/commands'
import {
  LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_BOUNDARY,
  LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_FAMILY,
  createListNestedFirstOrderedParentJoinTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'

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
const orderedItem = (label, value = '', children = []) => schema.nodes.list_item.create(
  { checked: null, label, listType: 'ordered', spread: 'false' },
  [paragraph(value), ...children]
)
const bulletItem = (value = '') => schema.nodes.list_item.create(
  { checked: null, label: '•', listType: 'bullet', spread: 'false' },
  paragraph(value)
)
const orderedList = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'false' }, items)
const bulletList = (...items) => schema.nodes.bullet_list.create({ spread: 'false' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const oldDoc = document(
  paragraph('before'),
  orderedList(
    orderedItem('1.', 'top-one', [
      orderedList(
        orderedItem('1.', 'nested-alpha'),
        orderedItem('2.', 'nested-beta')
      )
    ]),
    orderedItem('2.', 'top-two')
  ),
  bulletList(bulletItem('bullet-alpha'), bulletItem('bullet-beta')),
  paragraph('after')
)
const targetParagraph = sourceSyncNodeEntryAtPath(oldDoc, [1, 0, 1, 0, 0])
assert.ok(targetParagraph)
const state = EditorState.create({
  schema,
  doc: oldDoc,
  selection: TextSelection.create(oldDoc, targetParagraph.contentStart)
})
let joinTransaction = null
assert.equal(joinBackward(state, (value) => { joinTransaction = value }), true)
assert.ok(joinTransaction)
assert.equal(joinTransaction.steps.length, 1)
const joinStep = joinTransaction.steps[0]
assert.equal(joinStep.constructor.name, 'ReplaceAroundStep')
assert.equal(joinStep.structure, true)
assert.equal(joinStep.insert, 0)
assert.equal(joinStep.slice.size, 1)
assert.equal(joinStep.slice.openStart, 0)
assert.equal(joinStep.slice.openEnd, 1)
assert.equal(joinTransaction.doc.child(1).child(0).childCount, 3)
assert.equal(joinTransaction.doc.child(1).child(0).child(0).textContent, 'top-one')
assert.equal(joinTransaction.doc.child(1).child(0).child(1).textContent, 'nested-alpha')
assert.equal(joinTransaction.doc.child(1).child(0).child(2).type.name, 'ordered_list')
assert.equal(joinTransaction.doc.child(1).child(0).child(2).childCount, 1)
assert.equal(joinTransaction.doc.child(1).child(0).child(2).child(0).attrs.label, '2.')

const successorAfterJoin = sourceSyncNodeEntryAtPath(joinTransaction.doc, [1, 0, 2, 0])
assert.ok(successorAfterJoin)
const relabelState = EditorState.create({ schema, doc: joinTransaction.doc })
const relabelTransaction = relabelState.tr.setNodeMarkup(successorAfterJoin.beforePos, undefined, {
  ...successorAfterJoin.node.attrs,
  label: '1.'
})
assert.equal(relabelTransaction.steps.length, 1)
const relabelStep = relabelTransaction.steps[0]
assert.equal(relabelStep.constructor.name, 'ReplaceAroundStep')
assert.equal(relabelStep.structure, true)
assert.equal(relabelStep.insert, 1)
assert.equal(relabelStep.slice.size, 2)
assert.equal(relabelStep.slice.openStart, 0)
assert.equal(relabelStep.slice.openEnd, 0)
const expectedDoc = relabelTransaction.doc
assert.equal(expectedDoc.child(1).child(0).child(2).child(0).attrs.label, '1.')

const source = '\uFEFFbefore\r\n\r\n1. top-one\r\n   1. nested-alpha\r\n   2. nested-beta\r\n2. top-two\r\n\r\n- bullet-alpha\r\n- bullet-beta\r\n\r\nafter\r\n'
const previous = 'before\n\n1. top-one\n\n   1. nested-alpha\n\n   2. nested-beta\n2. top-two\n\n* bullet-alpha\n\n* bullet-beta\n\nafter\n'
const canonical = 'before\n\n1. top-one\n\n   nested-alpha\n\n   1. nested-beta\n2. top-two\n\n* bullet-alpha\n\n* bullet-beta\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n1. top-one\r\n\r\n   nested-alpha\r\n\r\n   1. nested-beta\r\n2. top-two\r\n\r\n- bullet-alpha\r\n- bullet-beta\r\n\r\nafter\r\n'

const journalFactory = createSourceSyncTransactionJournal()
const capture = (actualSource, revision) => {
  const snapshot = createSourceSyncSnapshot({
    revision,
    source: actualSource,
    canonical: previous,
    doc: oldDoc,
    owner: 'fixture',
    family: 'fixture'
  })
  const captured = journalFactory.captureOrAdvance({
    checkpoint: null,
    snapshot,
    transactions: [joinTransaction, relabelTransaction],
    oldDoc,
    newDoc: expectedDoc
  })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}
const offsets = new Map([
  [sourceSyncNodeEntryAtPath(oldDoc, [1, 0, 0]).contentStart, 'top-one'],
  [sourceSyncNodeEntryAtPath(oldDoc, [1, 0, 1, 0, 0]).contentStart, 'nested-alpha'],
  [sourceSyncNodeEntryAtPath(oldDoc, [1, 0, 1, 1, 0]).contentStart, 'nested-beta']
])
const resolveMarkdownOffset = ({ markdown, pmPos }) => {
  const text = offsets.get(pmPos)
  return text ? markdown.indexOf(text) : -1
}
const owner = createListNestedFirstOrderedParentJoinTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown: ({ markdown, expectedDoc: actual }) =>
    markdown === expectedSource && actual.eq(expectedDoc)
})
const captured = capture(source, 166)
const plan = owner.plan({
  journal: captured.checkpoint,
  activeJournal: captured.checkpoint,
  snapshot: captured.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.family, LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_NESTED_FIRST_ORDERED_PARENT_JOIN_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-nested-first-ordered-parent-joined')
assert.equal(plan.result.markdown, expectedSource)
assert.equal(plan.proof.kind, 'transaction-list-nested-first-ordered-parent-join-proof')
assert.equal(plan.proof.chainLength, 2)
assert.deepEqual(plan.proof.parentPath, [1, 0])
assert.deepEqual(plan.proof.targetItemPath, [1, 0, 1, 0])
assert.deepEqual(plan.proof.successorItemPath, [1, 0, 1, 1])
assert.deepEqual(plan.proof.movedParagraphPath, [1, 0, 1])
assert.deepEqual(plan.proof.remainingNestedPath, [1, 0, 2])
assert.equal(plan.proof.firstStep.sliceSize, 1)
assert.equal(plan.proof.firstStep.insert, 0)
assert.equal(plan.proof.secondStep.sliceSize, 2)
assert.equal(plan.proof.secondStep.insert, 1)
assert.equal(plan.proof.targetSourceRow.token, '1.')
assert.equal(plan.proof.successorSourceRow.token, '2.')
assert.deepEqual(plan.proof.successorTokenReplacement, { from: '2.', to: '1.' })
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)

const wideTargetSource = source.replace('   1. nested-alpha', '    1. nested-alpha')
const wideCaptured = capture(wideTargetSource, 167)
const widePlan = owner.plan({
  journal: wideCaptured.checkpoint,
  activeJournal: wideCaptured.checkpoint,
  snapshot: wideCaptured.snapshot,
  currentSource: wideTargetSource,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(widePlan.ok, false)
assert.equal(widePlan.recognized, true)
assert.equal(widePlan.reason, 'nested-first-ordered-parent-join-source-row-unproven')

const parenSource = source.replace('   1. nested-alpha', '   1) nested-alpha')
const parenCaptured = capture(parenSource, 168)
const parenPlan = owner.plan({
  journal: parenCaptured.checkpoint,
  activeJournal: parenCaptured.checkpoint,
  snapshot: parenCaptured.snapshot,
  currentSource: parenSource,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(parenPlan.ok, false)
assert.equal(parenPlan.recognized, true)
assert.equal(parenPlan.reason, 'nested-first-ordered-parent-join-source-row-unproven')

assert.throws(
  () => createListNestedFirstOrderedParentJoinTransactionSourceSyncOwner({ resolveMarkdownOffset }),
  /requires validateMarkdown/
)
console.log('PASS nested first ordered parent join transaction owner: real joinBackward + relabel journal creates a separate parent paragraph, renumbers the surviving nested item, preserves BOM/CRLF/raw text, and fails closed on unproven indentation/delimiter')
