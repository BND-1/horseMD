import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { joinBackward } from '@milkdown/prose/commands'
import { preserveTransactionOwnedSingleEmptyOrderedBackspaceLift } from '../src/renderer/src/lib/markdown-preservation/lists.js'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_BOUNDARY,
  LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_FAMILY,
  createListOrderedEmptySuccessorLiftTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-ordered-empty-successor-lift-transaction-owner.js'

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
const orderedItem = (label, ...children) => schema.nodes.list_item.create({ checked: null, label, listType: 'ordered', spread: 'false' }, children)
const ordered = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'true' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const oldDoc = document(
  paragraph('before'),
  ordered(
    orderedItem('1.', paragraph('alpha')),
    orderedItem('2.', paragraph()),
    orderedItem('3.', paragraph('beta'))
  ),
  paragraph('after')
)
const removedParagraph = sourceSyncNodeEntryAtPath(oldDoc, [1, 1, 0])
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
assert.equal(intermediateDoc.child(1).childCount, 2)
assert.equal(intermediateDoc.child(1).child(0).childCount, 2)
assert.equal(intermediateDoc.child(1).child(1).attrs.label, '3.')

const intermediateSuccessor = sourceSyncNodeEntryAtPath(intermediateDoc, [1, 1])
const secondState = EditorState.create({ schema, doc: intermediateDoc })
const secondTransaction = secondState.tr.setNodeMarkup(intermediateSuccessor.beforePos, undefined, {
  ...intermediateSuccessor.node.attrs,
  label: '2.'
})
assert.equal(secondTransaction.steps.length, 1)
const secondStep = secondTransaction.steps[0]
assert.equal(secondStep.constructor.name, 'ReplaceAroundStep')
assert.equal(secondStep.structure, true)
assert.equal(secondStep.insert, 1)
assert.equal(secondStep.slice.size, 2)
const expectedDoc = secondTransaction.doc
assert.equal(expectedDoc.child(1).child(1).attrs.label, '2.')
assert.equal(expectedDoc.child(1).child(1).firstChild.textContent, 'beta')

const source = '\uFEFFbefore\r\n\r\n1) alpha\r\n\r\n2) \r\n\r\n3) beta\r\n\r\nafter\r\n'
const previous = 'before\n\n1. alpha\n\n2. <br />\n\n3. beta\n\nafter\n'
const canonical = 'before\n\n1. alpha\n\n   <br />\n\n2. beta\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n1) alpha\r\n\r\n2) beta\r\n\r\nafter\r\n'
const snapshot = createSourceSyncSnapshot({ revision: 155, source, canonical: previous, doc: oldDoc })
const journalFactory = createSourceSyncTransactionJournal()
const firstCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [firstTransaction],
  oldDoc,
  newDoc: intermediateDoc
})
assert.equal(firstCaptured.ok, true)
const secondCaptured = journalFactory.captureOrAdvance({
  checkpoint: firstCaptured.checkpoint,
  snapshot,
  transactions: [secondTransaction],
  oldDoc: intermediateDoc,
  newDoc: expectedDoc
})
assert.equal(secondCaptured.ok, true)
assert.equal(secondCaptured.checkpoint.transactionCount, 2)
assert.deepEqual(secondCaptured.checkpoint.stepDetails.map((entry) => entry.name), ['ReplaceStep', 'ReplaceAroundStep'])

const owner = createListOrderedEmptySuccessorLiftTransactionSourceSyncOwner({
  mapOrderedLift: preserveTransactionOwnedSingleEmptyOrderedBackspaceLift,
  resolveMarkdownOffset: ({ markdown }) => markdown.indexOf('alpha')
})
const plan = owner.plan({
  journal: secondCaptured.checkpoint,
  activeJournal: secondCaptured.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-ordered-empty-successor-lifted')
assert.equal(plan.result.markdown, expectedSource)
assert.deepEqual(plan.proof.removedPath, [1, 1])
assert.deepEqual(plan.proof.transientEmptyListItemPath, [1, 0])
assert.deepEqual(plan.proof.transientEmptyParagraphPath, [1, 0, 1])
assert.deepEqual(plan.proof.successorOldPath, [1, 2])
assert.deepEqual(plan.proof.successorIntermediatePath, [1, 1])
assert.deepEqual(plan.proof.successorFinalPath, [1, 1])
assert.equal(plan.proof.previousLabel, '1.')
assert.equal(plan.proof.removedLabel, '2.')
assert.equal(plan.proof.successorOldLabel, '3.')
assert.equal(plan.proof.successorFinalLabel, '2.')
assert.equal(plan.proof.firstStep.from, firstTransaction.steps[0].from)
assert.equal(plan.proof.secondStep.gapFrom, secondStep.gapFrom)
assert.equal(plan.proof.secondStep.gapTo, secondStep.gapTo)
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)
assert.equal(plan.result.markdown.includes('3) beta'), false)
assert.equal(plan.result.markdown.includes('<br'), false)

const bodySource = source.replace('2) \r\n', '2) authored\r\n')
const bodySnapshot = createSourceSyncSnapshot({ revision: 156, source: bodySource, canonical: previous, doc: oldDoc })
const bodyFirst = journalFactory.captureOrAdvance({ checkpoint: null, snapshot: bodySnapshot, transactions: [firstTransaction], oldDoc, newDoc: intermediateDoc })
const bodySecond = journalFactory.captureOrAdvance({ checkpoint: bodyFirst.checkpoint, snapshot: bodySnapshot, transactions: [secondTransaction], oldDoc: intermediateDoc, newDoc: expectedDoc })
const bodyPlan = owner.plan({
  journal: bodySecond.checkpoint,
  activeJournal: bodySecond.checkpoint,
  snapshot: bodySnapshot,
  currentSource: bodySource,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(bodyPlan.ok, false)
assert.equal(bodyPlan.recognized, true, 'once the two-Step PM family is proven, source row mismatch must block fallback')

const wrongSecondStep = {
  constructor: { name: 'ReplaceAroundStep' },
  from: secondStep.from,
  to: secondStep.to,
  gapFrom: secondStep.gapFrom + 1,
  gapTo: secondStep.gapTo,
  insert: secondStep.insert,
  structure: true,
  slice: secondStep.slice,
  apply: () => ({ doc: expectedDoc })
}
const wrongSecondTransaction = {
  docChanged: true,
  before: intermediateDoc,
  doc: expectedDoc,
  docs: [intermediateDoc],
  steps: [wrongSecondStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongSnapshot = createSourceSyncSnapshot({ revision: 157, source, canonical: previous, doc: oldDoc })
const wrongFirst = journalFactory.captureOrAdvance({ checkpoint: null, snapshot: wrongSnapshot, transactions: [firstTransaction], oldDoc, newDoc: intermediateDoc })
const wrongSecond = journalFactory.captureOrAdvance({ checkpoint: wrongFirst.checkpoint, snapshot: wrongSnapshot, transactions: [wrongSecondTransaction], oldDoc: intermediateDoc, newDoc: expectedDoc })
assert.equal(wrongSecond.ok, true)
const wrongPlan = owner.plan({
  journal: wrongSecond.checkpoint,
  activeJournal: wrongSecond.checkpoint,
  snapshot: wrongSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'ordered-successor-lift-second-step-range')

const fourItemOld = document(
  paragraph('before'),
  schema.nodes.ordered_list.create({ order: 1, spread: 'true' }, [
    orderedItem('1.', paragraph('alpha')),
    orderedItem('2.', paragraph()),
    orderedItem('3.', paragraph('beta')),
    orderedItem('4.', paragraph('gamma'))
  ]),
  paragraph('after')
)
const fourItemFinal = document(
  paragraph('before'),
  schema.nodes.ordered_list.create({ order: 1, spread: 'true' }, [
    orderedItem('1.', paragraph('alpha'), paragraph()),
    orderedItem('2.', paragraph('beta')),
    orderedItem('3.', paragraph('gamma'))
  ]),
  paragraph('after')
)
const fourSnapshot = createSourceSyncSnapshot({ revision: 158, source, canonical: previous, doc: fourItemOld })
const fakeStep = { constructor: { name: 'ReplaceStep' }, from: 1, to: 2, structure: true, slice: { size: 0 }, apply: () => ({ doc: fourItemFinal }) }
const fourTx = { docChanged: true, before: fourItemOld, doc: fourItemFinal, docs: [fourItemOld], steps: [fakeStep], mapping: { maps: [{ map: (position) => position }] } }
const fourCapture = journalFactory.captureOrAdvance({ checkpoint: null, snapshot: fourSnapshot, transactions: [fourTx], oldDoc: fourItemOld, newDoc: fourItemFinal })
const fourPlan = owner.plan({ journal: fourCapture.checkpoint, activeJournal: fourCapture.checkpoint, snapshot: fourSnapshot, currentSource: source, currentCanonical: previous, canonical, expectedDoc: fourItemFinal, callbackDocumentEquivalent: true })
assert.equal(fourPlan.ok, false)
assert.equal(fourPlan.recognized, false, 'four-item renumbering stays for a later broader ordered successor family')

assert.throws(
  () => createListOrderedEmptySuccessorLiftTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires mapOrderedLift/
)
console.log('PASS ordered empty successor lift transaction owner: exact two-transaction ReplaceStep + ReplaceAroundStep journal removes the middle empty row, retains one editor-only trailing paragraph and relabels the successor 3→2 while authored ) delimiter, BOM/CRLF and neighbours stay intact; source/wrong-step/four-item cases fail closed or stay separate')
