import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { joinBackward } from '@milkdown/prose/commands'
import { preserveTransactionOwnedOrderedEmptySuccessorChain } from '../src/renderer/src/lib/markdown-preservation/lists.js'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_BOUNDARY,
  LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_FAMILY,
  createListOrderedEmptySuccessorChainTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-ordered-empty-successor-chain-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 }, spread: { default: 'true' } } },
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
const orderedItem = (label, ...children) => schema.nodes.list_item.create({
  checked: null,
  label,
  listType: 'ordered',
  spread: 'false'
}, children)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const makeOldDoc = ({ order, values }) => document(
  paragraph('before'),
  schema.nodes.ordered_list.create({ order, spread: 'true' }, values.map((value, index) =>
    orderedItem(`${order + index}.`, paragraph(value))
  )),
  paragraph('after')
)

const makeTransactions = ({ oldDoc, removedIndex }) => {
  const removedParagraph = sourceSyncNodeEntryAtPath(oldDoc, [1, removedIndex, 0])
  const state = EditorState.create({
    schema,
    doc: oldDoc,
    selection: TextSelection.create(oldDoc, removedParagraph.contentStart)
  })
  let firstTransaction = null
  assert.equal(joinBackward(state, (value) => { firstTransaction = value }), true)
  assert.ok(firstTransaction)
  assert.equal(firstTransaction.steps.length, 1)
  assert.equal(firstTransaction.steps[0].constructor.name, 'ReplaceStep')
  assert.equal(firstTransaction.steps[0].structure, true)
  assert.equal(firstTransaction.steps[0].slice.size, 0)

  const intermediateDoc = firstTransaction.doc
  const order = Number(oldDoc.child(1).attrs.order)
  const successorCount = oldDoc.child(1).childCount - removedIndex - 1
  const secondState = EditorState.create({ schema, doc: intermediateDoc })
  const secondTransaction = secondState.tr
  for (let offset = 0; offset < successorCount; offset += 1) {
    const finalIndex = removedIndex + offset
    const target = sourceSyncNodeEntryAtPath(secondTransaction.doc, [1, finalIndex])
    secondTransaction.setNodeMarkup(target.beforePos, undefined, {
      ...target.node.attrs,
      label: `${order + finalIndex}.`
    })
  }
  assert.equal(secondTransaction.steps.length, successorCount)
  assert.equal(secondTransaction.steps.every((step) => step.constructor.name === 'ReplaceAroundStep'), true)
  return Object.freeze({
    firstTransaction,
    intermediateDoc,
    secondTransaction,
    expectedDoc: secondTransaction.doc,
    successorCount
  })
}

const journalFactory = createSourceSyncTransactionJournal()
const owner = createListOrderedEmptySuccessorChainTransactionSourceSyncOwner({
  mapOrderedChain: preserveTransactionOwnedOrderedEmptySuccessorChain,
  resolveMarkdownOffset: ({ markdown }) => markdown.indexOf('alpha')
})

const makePlan = ({ revision, oldDoc, source, previous, canonical, removedIndex }) => {
  const tx = makeTransactions({ oldDoc, removedIndex })
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical: previous, doc: oldDoc })
  const firstCaptured = journalFactory.captureOrAdvance({
    checkpoint: null,
    snapshot,
    transactions: [tx.firstTransaction],
    oldDoc,
    newDoc: tx.intermediateDoc
  })
  assert.equal(firstCaptured.ok, true)
  const secondCaptured = journalFactory.captureOrAdvance({
    checkpoint: firstCaptured.checkpoint,
    snapshot,
    transactions: [tx.secondTransaction],
    oldDoc: tx.intermediateDoc,
    newDoc: tx.expectedDoc
  })
  assert.equal(secondCaptured.ok, true)
  const plan = owner.plan({
    journal: secondCaptured.checkpoint,
    activeJournal: secondCaptured.checkpoint,
    snapshot,
    currentSource: source,
    currentCanonical: previous,
    canonical,
    expectedDoc: tx.expectedDoc,
    callbackDocumentEquivalent: true
  })
  return { plan, snapshot, captured: secondCaptured.checkpoint, ...tx }
}

const order4Old = makeOldDoc({ order: 4, values: ['alpha', '', 'beta', 'gamma'] })
const order4Source = '\uFEFFbefore\r\n\r\n4) alpha\r\n\r\n5) \r\n\r\n6) beta\r\n\r\n7) gamma\r\n\r\nafter\r\n'
const order4Previous = 'before\n\n4. alpha\n\n5. <br />\n\n6. beta\n\n7. gamma\n\nafter\n'
const order4Canonical = 'before\n\n4. alpha\n\n   <br />\n\n5. beta\n\n6. gamma\n\nafter\n'
const order4Expected = '\uFEFFbefore\r\n\r\n4) alpha\r\n\r\n5) beta\r\n\r\n6) gamma\r\n\r\nafter\r\n'
const order4 = makePlan({
  revision: 156,
  oldDoc: order4Old,
  source: order4Source,
  previous: order4Previous,
  canonical: order4Canonical,
  removedIndex: 1
})
assert.equal(order4.plan.ok, true, JSON.stringify(order4.plan))
assert.equal(order4.plan.owner, 'transaction')
assert.equal(order4.plan.family, LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_FAMILY)
assert.equal(order4.plan.boundary, LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_BOUNDARY)
assert.equal(order4.plan.result.reason, 'list-ordered-empty-successor-chain-lifted')
assert.equal(order4.plan.result.markdown, order4Expected)
assert.equal(order4.plan.proof.removedIndex, 1)
assert.equal(order4.plan.proof.successorCount, 2)
assert.deepEqual(order4.plan.proof.removedPath, [1, 1])
assert.deepEqual(order4.plan.proof.transientEmptyListItemPath, [1, 0])
assert.deepEqual(order4.plan.proof.transientEmptyParagraphPath, [1, 0, 1])
assert.equal(order4.plan.proof.listOrder, 4)
assert.equal(order4.plan.proof.previousLabel, '4.')
assert.equal(order4.plan.proof.removedLabel, '5.')
assert.deepEqual(order4.plan.proof.successorOldLabels, ['6.', '7.'])
assert.deepEqual(order4.plan.proof.successorFinalLabels, ['5.', '6.'])
assert.equal(order4.plan.proof.relabelSteps.length, 2)
assert.deepEqual(order4.plan.proof.relabelSteps.map((entry) => entry.oldLabel), ['6.', '7.'])
assert.deepEqual(order4.plan.proof.relabelSteps.map((entry) => entry.finalLabel), ['5.', '6.'])
assert.deepEqual(order4.captured.stepDetails.map((entry) => entry.name), [
  'ReplaceStep',
  'ReplaceAroundStep',
  'ReplaceAroundStep'
])
assert.equal(order4.plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(order4.plan.result.markdown.includes('\r\n'), true)
assert.equal(order4.plan.result.markdown.includes('5) beta'), true)
assert.equal(order4.plan.result.markdown.includes('6) gamma'), true)
assert.equal(order4.plan.result.markdown.includes('7) gamma'), false)
assert.equal(order4.plan.result.markdown.includes('<br'), false)

const index2Old = makeOldDoc({ order: 1, values: ['alpha', 'beta', '', 'gamma', 'delta'] })
const index2Source = 'before\n\n1. alpha\n\n2. beta\n\n3. \n\n4. gamma\n\n5. delta\n\nafter\n'
const index2Previous = 'before\n\n1. alpha\n\n2. beta\n\n3. <br />\n\n4. gamma\n\n5. delta\n\nafter\n'
const index2Canonical = 'before\n\n1. alpha\n\n2. beta\n\n   <br />\n\n3. gamma\n\n4. delta\n\nafter\n'
const index2Expected = 'before\n\n1. alpha\n\n2. beta\n\n3. gamma\n\n4. delta\n\nafter\n'
const index2 = makePlan({
  revision: 157,
  oldDoc: index2Old,
  source: index2Source,
  previous: index2Previous,
  canonical: index2Canonical,
  removedIndex: 2
})
assert.equal(index2.plan.ok, true, JSON.stringify(index2.plan))
assert.equal(index2.plan.result.markdown, index2Expected)
assert.equal(index2.plan.proof.removedIndex, 2)
assert.equal(index2.plan.proof.successorCount, 2)
assert.deepEqual(index2.plan.proof.previousPath, [1, 1])
assert.deepEqual(index2.plan.proof.transientEmptyParagraphPath, [1, 1, 1])
assert.deepEqual(index2.plan.proof.successorOldLabels, ['4.', '5.'])
assert.deepEqual(index2.plan.proof.successorFinalLabels, ['3.', '4.'])

const threeSuccessorOld = makeOldDoc({ order: 2, values: ['alpha', '', 'beta', 'gamma', 'delta'] })
const threeSource = 'before\n\n2. alpha\n\n3. \n\n4. beta\n\n5. gamma\n\n6. delta\n\nafter\n'
const threePrevious = 'before\n\n2. alpha\n\n3. <br />\n\n4. beta\n\n5. gamma\n\n6. delta\n\nafter\n'
const threeCanonical = 'before\n\n2. alpha\n\n   <br />\n\n3. beta\n\n4. gamma\n\n5. delta\n\nafter\n'
const threeExpected = 'before\n\n2. alpha\n\n3. beta\n\n4. gamma\n\n5. delta\n\nafter\n'
const three = makePlan({
  revision: 158,
  oldDoc: threeSuccessorOld,
  source: threeSource,
  previous: threePrevious,
  canonical: threeCanonical,
  removedIndex: 1
})
assert.equal(three.plan.ok, true, JSON.stringify(three.plan))
assert.equal(three.plan.result.markdown, threeExpected)
assert.equal(three.plan.proof.successorCount, 3)
assert.equal(three.plan.proof.relabelSteps.length, 3)
assert.deepEqual(three.plan.proof.successorOldLabels, ['4.', '5.', '6.'])
assert.deepEqual(three.plan.proof.successorFinalLabels, ['3.', '4.', '5.'])

const bodySource = order4Source.replace('5) \r\n', '5) authored\r\n')
const body = makePlan({
  revision: 159,
  oldDoc: order4Old,
  source: bodySource,
  previous: order4Previous,
  canonical: order4Canonical,
  removedIndex: 1
})
assert.equal(body.plan.ok, false)
assert.equal(body.plan.recognized, true, 'PM chain proof makes authored body mismatch fail closed')

const mixedSource = order4Source.replace('5) \r\n\r\n', '5) \n\n')
const mixed = makePlan({
  revision: 160,
  oldDoc: order4Old,
  source: mixedSource,
  previous: order4Previous,
  canonical: order4Canonical,
  removedIndex: 1
})
assert.equal(mixed.plan.ok, false)
assert.equal(mixed.plan.recognized, true, 'mixed-EOL bounded source must fail closed after PM family recognition')

const wrongTxBase = makeTransactions({ oldDoc: order4Old, removedIndex: 1 })
const originalSecond = wrongTxBase.secondTransaction
const wrongStepIndex = 1
const originalWrongStep = originalSecond.steps[wrongStepIndex]
const wrongStep = {
  constructor: { name: 'ReplaceAroundStep' },
  from: originalWrongStep.from,
  to: originalWrongStep.to,
  gapFrom: originalWrongStep.gapFrom + 1,
  gapTo: originalWrongStep.gapTo,
  insert: originalWrongStep.insert,
  structure: true,
  slice: originalWrongStep.slice,
  apply: () => ({ doc: wrongTxBase.expectedDoc })
}
const wrongSecondTransaction = {
  docChanged: true,
  before: wrongTxBase.intermediateDoc,
  doc: wrongTxBase.expectedDoc,
  docs: originalSecond.docs,
  steps: originalSecond.steps.map((step, index) => index === wrongStepIndex ? wrongStep : step),
  mapping: originalSecond.mapping
}
const wrongSnapshot = createSourceSyncSnapshot({ revision: 161, source: order4Source, canonical: order4Previous, doc: order4Old })
const wrongFirstCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: wrongSnapshot,
  transactions: [wrongTxBase.firstTransaction],
  oldDoc: order4Old,
  newDoc: wrongTxBase.intermediateDoc
})
const wrongSecondCaptured = journalFactory.captureOrAdvance({
  checkpoint: wrongFirstCaptured.checkpoint,
  snapshot: wrongSnapshot,
  transactions: [wrongSecondTransaction],
  oldDoc: wrongTxBase.intermediateDoc,
  newDoc: wrongTxBase.expectedDoc
})
assert.equal(wrongSecondCaptured.ok, true)
const wrongPlan = owner.plan({
  journal: wrongSecondCaptured.checkpoint,
  activeJournal: wrongSecondCaptured.checkpoint,
  snapshot: wrongSnapshot,
  currentSource: order4Source,
  currentCanonical: order4Previous,
  canonical: order4Canonical,
  expectedDoc: wrongTxBase.expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'ordered-successor-chain-relabel-step-range')

const singleOld = makeOldDoc({ order: 1, values: ['alpha', '', 'beta'] })
const singleTx = makeTransactions({ oldDoc: singleOld, removedIndex: 1 })
const singleSource = 'before\n\n1. alpha\n\n2. \n\n3. beta\n\nafter\n'
const singlePrevious = 'before\n\n1. alpha\n\n2. <br />\n\n3. beta\n\nafter\n'
const singleCanonical = 'before\n\n1. alpha\n\n   <br />\n\n2. beta\n\nafter\n'
const singleSnapshot = createSourceSyncSnapshot({ revision: 162, source: singleSource, canonical: singlePrevious, doc: singleOld })
const singleFirst = journalFactory.captureOrAdvance({ checkpoint: null, snapshot: singleSnapshot, transactions: [singleTx.firstTransaction], oldDoc: singleOld, newDoc: singleTx.intermediateDoc })
const singleSecond = journalFactory.captureOrAdvance({ checkpoint: singleFirst.checkpoint, snapshot: singleSnapshot, transactions: [singleTx.secondTransaction], oldDoc: singleTx.intermediateDoc, newDoc: singleTx.expectedDoc })
const singlePlan = owner.plan({
  journal: singleSecond.checkpoint,
  activeJournal: singleSecond.checkpoint,
  snapshot: singleSnapshot,
  currentSource: singleSource,
  currentCanonical: singlePrevious,
  canonical: singleCanonical,
  expectedDoc: singleTx.expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(singlePlan.ok, false)
assert.equal(singlePlan.recognized, false, 'single successor remains owned by 0.13.155 family')

assert.throws(
  () => createListOrderedEmptySuccessorChainTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires mapOrderedChain/
)
console.log('PASS ordered empty successor-chain transaction owner: 2/3 successor relabel chains, removedIndex 1/2, non-1 order and authored ) delimiter are transaction-owned; body/mixed-EOL/wrong-step fail closed and single-successor stays with 0.13.155 owner')
