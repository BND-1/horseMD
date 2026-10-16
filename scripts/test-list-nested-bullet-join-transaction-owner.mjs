import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { joinBackward } from '@milkdown/prose/commands'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_NESTED_BULLET_JOIN_TRANSACTION_BOUNDARY,
  LIST_NESTED_BULLET_JOIN_TRANSACTION_FAMILY,
  createListNestedBulletJoinTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-bullet-join-transaction-owner.js'

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

const captureJoin = (oldDoc, targetIndex) => {
  const targetParagraph = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, targetIndex, 0])
  const state = EditorState.create({ schema, doc: oldDoc, selection: TextSelection.create(oldDoc, targetParagraph.contentStart) })
  let transaction = null
  const handled = joinBackward(state, (value) => { transaction = value })
  return { handled, transaction, targetParagraph }
}
const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc, owner: 'fixture', family: 'fixture' })
  const journal = createSourceSyncTransactionJournal()
  const captured = journal.captureOrAdvance({ checkpoint: null, snapshot, transactions: [transaction], oldDoc, newDoc: transaction.doc })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}
const planFor = ({ oldDoc, targetIndex, source, previous, canonical, expectedSource, revision, rawPrevious, rawTarget }) => {
  const joined = captureJoin(oldDoc, targetIndex)
  assert.equal(joined.handled, true)
  assert.ok(joined.transaction)
  const previousParagraph = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 1, targetIndex - 1, 0])
  const capture = captureJournal({ source, canonical: previous, oldDoc, transaction: joined.transaction, revision })
  const owner = createListNestedBulletJoinTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos }) => {
      if (pmPos === previousParagraph.contentStart) return markdown.indexOf(rawPrevious)
      if (pmPos === joined.targetParagraph.contentStart) return markdown.indexOf(rawTarget)
      return -1
    },
    validateMarkdown: ({ markdown, expectedDoc }) => markdown === expectedSource && expectedDoc.eq(joined.transaction.doc)
  })
  const plan = owner.plan({
    journal: capture.checkpoint,
    activeJournal: capture.checkpoint,
    snapshot: capture.snapshot,
    currentSource: source,
    currentCanonical: previous,
    canonical,
    expectedDoc: joined.transaction.doc,
    callbackDocumentEquivalent: true
  })
  return { joined, capture, owner, plan, previousParagraph }
}

const twoOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const source = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const previous = 'before\n\n* alpha\n\n* beta\n\n  * gamma\n\n  * delta\n\n* omega\n\nafter\n'
const expected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n\r\n    delta\r\n+ omega\r\n\r\nafter\r\n'
const two = planFor({
  oldDoc: twoOld,
  targetIndex: 1,
  source,
  previous,
  canonical: 'two-canonical',
  expectedSource: expected,
  revision: 163,
  rawPrevious: 'gamma',
  rawTarget: 'delta'
})
assert.equal(two.joined.transaction.steps.length, 1)
const step = two.joined.transaction.steps[0]
assert.equal(step.constructor.name, 'ReplaceStep')
assert.equal(step.structure, true)
assert.equal(step.slice.size, 0)
const previousEntry = sourceSyncNodeEntryAtPath(twoOld, [1, 1, 1, 0])
const targetEntry = sourceSyncNodeEntryAtPath(twoOld, [1, 1, 1, 1])
assert.equal(step.from, targetEntry.beforePos - 1)
assert.equal(step.from, previousEntry.beforePos + previousEntry.node.nodeSize - 1)
assert.equal(step.to, targetEntry.contentStart)
assert.equal(two.plan.ok, true, JSON.stringify(two.plan))
assert.equal(two.plan.family, LIST_NESTED_BULLET_JOIN_TRANSACTION_FAMILY)
assert.equal(two.plan.boundary, LIST_NESTED_BULLET_JOIN_TRANSACTION_BOUNDARY)
assert.equal(two.plan.result.reason, 'list-nested-bullet-item-joined')
assert.equal(two.plan.result.markdown, expected)
assert.equal(two.plan.proof.targetIndex, 1)
assert.deepEqual(two.plan.proof.previousPath, [1, 1, 1, 0])
assert.deepEqual(two.plan.proof.targetPath, [1, 1, 1, 1])
assert.equal(two.plan.proof.rawReplacement.replacement, '\r\n    ')
assert.equal(two.plan.proof.previousSourceRow.token, '+')
assert.equal(two.plan.proof.targetSourceRow.token, '+')

const threeOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'), bulletItem('epsilon'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const threeSource = '\uFEFFbefore\r\n\r\n- alpha\r\n- beta\r\n  - gamma\r\n  - delta\r\n  - epsilon\r\n- omega\r\n\r\nafter\r\n'
const middleExpected = '\uFEFFbefore\r\n\r\n- alpha\r\n- beta\r\n  - gamma\r\n\r\n    delta\r\n  - epsilon\r\n- omega\r\n\r\nafter\r\n'
const middle = planFor({
  oldDoc: threeOld,
  targetIndex: 1,
  source: threeSource,
  previous: 'three-previous',
  canonical: 'middle-canonical',
  expectedSource: middleExpected,
  revision: 164,
  rawPrevious: 'gamma',
  rawTarget: 'delta'
})
assert.equal(middle.plan.ok, true, JSON.stringify(middle.plan))
assert.equal(middle.plan.proof.targetIndex, 1)
assert.equal(middle.plan.result.markdown, middleExpected)
assert.equal(middle.joined.transaction.doc.child(1).child(1).child(1).childCount, 2)
assert.equal(middle.joined.transaction.doc.child(1).child(1).child(1).child(0).childCount, 2)
assert.equal(middle.joined.transaction.doc.child(1).child(1).child(1).child(1).firstChild.textContent, 'epsilon')

const lastExpected = '\uFEFFbefore\r\n\r\n- alpha\r\n- beta\r\n  - gamma\r\n  - delta\r\n\r\n    epsilon\r\n- omega\r\n\r\nafter\r\n'
const last = planFor({
  oldDoc: threeOld,
  targetIndex: 2,
  source: threeSource,
  previous: 'three-previous',
  canonical: 'last-canonical',
  expectedSource: lastExpected,
  revision: 165,
  rawPrevious: 'delta',
  rawTarget: 'epsilon'
})
assert.equal(last.plan.ok, true, JSON.stringify(last.plan))
assert.equal(last.plan.proof.targetIndex, 2)
assert.equal(last.plan.result.markdown, lastExpected)

const escapedOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('1. gamma'), bulletItem('2. delta'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const escapedSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + 1\\. gamma\r\n  + 2\\. delta\r\n+ omega\r\n\r\nafter\r\n'
const escapedExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + 1\\. gamma\r\n\r\n    2\\. delta\r\n+ omega\r\n\r\nafter\r\n'
const escaped = planFor({
  oldDoc: escapedOld,
  targetIndex: 1,
  source: escapedSource,
  previous: 'escaped-previous',
  canonical: 'escaped-canonical',
  expectedSource: escapedExpected,
  revision: 166,
  rawPrevious: '1\\. gamma',
  rawTarget: '2\\. delta'
})
assert.equal(escaped.plan.ok, true, JSON.stringify(escaped.plan))
assert.equal(escaped.plan.result.markdown, escapedExpected)
assert.equal(escaped.plan.proof.previousText, '1. gamma')
assert.equal(escaped.plan.proof.targetText, '2. delta')

const looseSource = source.replace('  + delta', '  +  delta')
const looseJoin = captureJoin(twoOld, 1)
const loosePrevious = sourceSyncNodeEntryAtPath(twoOld, [1, 1, 1, 0, 0])
const looseCapture = captureJournal({ source: looseSource, canonical: previous, oldDoc: twoOld, transaction: looseJoin.transaction, revision: 167 })
const looseOwner = createListNestedBulletJoinTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos }) => pmPos === loosePrevious.contentStart
    ? markdown.indexOf('gamma')
    : pmPos === looseJoin.targetParagraph.contentStart ? markdown.indexOf('delta') : -1,
  validateMarkdown: () => true
})
const loosePlan = looseOwner.plan({
  journal: looseCapture.checkpoint,
  activeJournal: looseCapture.checkpoint,
  snapshot: looseCapture.snapshot,
  currentSource: looseSource,
  currentCanonical: previous,
  canonical: 'loose-canonical',
  expectedDoc: looseJoin.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(loosePlan.ok, false)
assert.equal(loosePlan.recognized, true)
assert.equal(loosePlan.reason, 'nested-bullet-join-source-row-unproven')

const wrongStep = {
  constructor: { name: 'ReplaceStep' },
  from: step.from + 1,
  to: step.to,
  structure: true,
  slice: step.slice,
  apply: () => ({ doc: two.joined.transaction.doc })
}
const wrongTx = {
  docChanged: true,
  before: twoOld,
  doc: two.joined.transaction.doc,
  docs: [twoOld],
  steps: [wrongStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongCapture = captureJournal({ source, canonical: previous, oldDoc: twoOld, transaction: wrongTx, revision: 168 })
const wrongPlan = two.owner.plan({
  journal: wrongCapture.checkpoint,
  activeJournal: wrongCapture.checkpoint,
  snapshot: wrongCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'wrong-canonical',
  expectedDoc: two.joined.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'nested-bullet-join-step-range')

const taskOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(bulletItem('gamma'), taskItem('delta'))])),
  paragraph('after')
)
const taskJoin = captureJoin(taskOld, 1)
assert.equal(taskJoin.handled, true)
const taskCapture = captureJournal({ source, canonical: previous, oldDoc: taskOld, transaction: taskJoin.transaction, revision: 169 })
const noHitOwner = createListNestedBulletJoinTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0, validateMarkdown: () => true })
const taskPlan = noHitOwner.plan({
  journal: taskCapture.checkpoint,
  activeJournal: taskCapture.checkpoint,
  snapshot: taskCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'task-canonical',
  expectedDoc: taskJoin.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const orderedOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [orderedList(orderedItem('1.', 'gamma'), orderedItem('2.', 'delta'))])),
  paragraph('after')
)
const orderedJoin = captureJoin(orderedOld, 1)
assert.equal(orderedJoin.handled, true)
const orderedCapture = captureJournal({ source, canonical: previous, oldDoc: orderedOld, transaction: orderedJoin.transaction, revision: 170 })
const orderedPlan = noHitOwner.plan({
  journal: orderedCapture.checkpoint,
  activeJournal: orderedCapture.checkpoint,
  snapshot: orderedCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'ordered-canonical',
  expectedDoc: orderedJoin.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

assert.throws(
  () => createListNestedBulletJoinTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested bullet join transaction owner: any non-first sibling joinBackward uses one exact zero-slice ReplaceStep, previous+target become two paragraphs in one item, source replaces only target marker prefix with authored EOL+four-space continuation while preserving BOM/CRLF/escapes; unsafe row/wrong Step fail closed and task/ordered stay separate')
