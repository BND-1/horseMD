import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { splitListItem } from '@milkdown/prose/schema-list'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_BOUNDARY,
  LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_FAMILY,
  createListTaskEmptySiblingSplitTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-task-empty-sibling-split-transaction-owner.js'

const ZWSP = '\u200B'
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
const item = (value, checked = null, children = [], listType = 'bullet') => schema.nodes.list_item.create({
  checked,
  label: listType === 'ordered' ? '1.' : '•',
  listType,
  spread: 'false'
}, [paragraph(value), ...children])
const bullet = (...items) => schema.nodes.bullet_list.create({ spread: 'false' }, items)
const ordered = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'false' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const captureSplit = (oldDoc, paragraphPath, offset = null) => {
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, paragraphPath)
  const splitOffset = offset == null ? paragraphEntry.node.textContent.length : offset
  const state = EditorState.create({
    schema,
    doc: oldDoc,
    selection: TextSelection.create(oldDoc, paragraphEntry.contentStart + splitOffset)
  })
  let transaction = null
  const handled = splitListItem(schema.nodes.list_item)(state, (value) => { transaction = value })
  return { handled, transaction, paragraphEntry, splitOffset }
}
const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc, owner: 'fixture', family: 'fixture' })
  const journal = createSourceSyncTransactionJournal()
  const captured = journal.captureOrAdvance({ checkpoint: null, snapshot, transactions: [transaction], oldDoc, newDoc: transaction.doc })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}
const planFor = ({ oldDoc, paragraphPath, source, previous, canonical, expectedSource, revision, rawBody, offset = null }) => {
  const split = captureSplit(oldDoc, paragraphPath, offset)
  assert.equal(split.handled, true)
  const capture = captureJournal({ source, canonical: previous, oldDoc, transaction: split.transaction, revision })
  const owner = createListTaskEmptySiblingSplitTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos }) => pmPos === split.paragraphEntry.contentStart ? markdown.indexOf(rawBody) : -1,
    validateMarkdown: ({ markdown, expectedDoc }) => markdown === expectedSource && expectedDoc.eq(split.transaction.doc)
  })
  const plan = owner.plan({
    journal: capture.checkpoint,
    activeJournal: capture.checkpoint,
    snapshot: capture.snapshot,
    currentSource: source,
    currentCanonical: previous,
    canonical,
    expectedDoc: split.transaction.doc,
    callbackDocumentEquivalent: true
  })
  return { split, capture, owner, plan }
}

const topUncheckedDoc = document(
  paragraph('before'),
  bullet(item('1. Top', false), item('Tail')),
  paragraph('after')
)
const topSource = '\uFEFFbefore\r\n\r\n+ [ ] 1\\. Top\r\n+ Tail\r\n\r\nafter\r\n'
const topPrevious = 'before\n\n* [ ] 1\\. Top\n\n* Tail\n\nafter\n'
const topExpected = `\uFEFFbefore\r\n\r\n+ [ ] 1\\. Top\r\n+ [ ] ${ZWSP}\r\n+ Tail\r\n\r\nafter\r\n`
const top = planFor({
  oldDoc: topUncheckedDoc,
  paragraphPath: [1, 0, 0],
  source: topSource,
  previous: topPrevious,
  canonical: 'top-canonical',
  expectedSource: topExpected,
  revision: 165,
  rawBody: '1\\. Top'
})
assert.equal(top.plan.ok, true, JSON.stringify(top.plan))
assert.equal(top.plan.family, LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_FAMILY)
assert.equal(top.plan.boundary, LIST_TASK_EMPTY_SIBLING_SPLIT_TRANSACTION_BOUNDARY)
assert.equal(top.plan.proof.scope, 'top-level')
assert.equal(top.plan.proof.checked, false)
assert.equal(top.plan.proof.sourceRow.token, '+')
assert.equal(top.plan.proof.rawInsertion.text, `+ [ ] ${ZWSP}\r\n`)
assert.equal(top.plan.result.markdown, topExpected)
const topStep = top.split.transaction.steps[0]
assert.equal(topStep.constructor.name, 'ReplaceStep')
assert.equal(topStep.structure, true)
assert.equal(topStep.slice.size, 4)
assert.equal(topStep.slice.openStart, 2)
assert.equal(topStep.slice.openEnd, 2)
assert.equal(topStep.from, top.split.paragraphEntry.contentStart + '1. Top'.length)

const checkedDoc = document(paragraph('before'), bullet(item('Checked', true), item('Tail')), paragraph('after'))
const checkedSource = '\uFEFFbefore\r\n\r\n- [X] Checked\r\n- Tail\r\n\r\nafter\r\n'
const checkedExpected = `\uFEFFbefore\r\n\r\n- [X] Checked\r\n- [X] ${ZWSP}\r\n- Tail\r\n\r\nafter\r\n`
const checked = planFor({
  oldDoc: checkedDoc,
  paragraphPath: [1, 0, 0],
  source: checkedSource,
  previous: 'checked-previous',
  canonical: 'checked-canonical',
  expectedSource: checkedExpected,
  revision: 166,
  rawBody: 'Checked'
})
assert.equal(checked.plan.ok, true, JSON.stringify(checked.plan))
assert.equal(checked.plan.proof.checked, true)
assert.equal(checked.plan.proof.sourceRow.state, 'X')
assert.equal(checked.plan.proof.rawInsertion.text, `- [X] ${ZWSP}\r\n`)

const nestedDoc = document(
  paragraph('before'),
  bullet(item('Parent', null, [bullet(item('Nested', true))]), item('Tail')),
  paragraph('after')
)
const nestedSource = '\uFEFFbefore\r\n\r\n+ Parent\r\n  + [x] Nested\r\n+ Tail\r\n\r\nafter\r\n'
const nestedExpected = `\uFEFFbefore\r\n\r\n+ Parent\r\n  + [x] Nested\r\n  + [x] ${ZWSP}\r\n+ Tail\r\n\r\nafter\r\n`
const nested = planFor({
  oldDoc: nestedDoc,
  paragraphPath: [1, 0, 1, 0, 0],
  source: nestedSource,
  previous: 'nested-previous',
  canonical: 'nested-canonical',
  expectedSource: nestedExpected,
  revision: 167,
  rawBody: 'Nested'
})
assert.equal(nested.plan.ok, true, JSON.stringify(nested.plan))
assert.equal(nested.plan.proof.scope, 'nested')
assert.equal(nested.plan.proof.checked, true)
assert.equal(nested.plan.proof.rawInsertion.text, `  + [x] ${ZWSP}\r\n`)

const entityDoc = document(paragraph('before'), bullet(item('A & B', false), item('Tail')), paragraph('after'))
const entitySource = '\uFEFFbefore\r\n\r\n+ [ ] A &amp; B\r\n+ Tail\r\n'
const entitySplit = captureSplit(entityDoc, [1, 0, 0])
const entityCapture = captureJournal({ source: entitySource, canonical: 'entity-previous', oldDoc: entityDoc, transaction: entitySplit.transaction, revision: 168 })
const entityOwner = createListTaskEmptySiblingSplitTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos }) => pmPos === entitySplit.paragraphEntry.contentStart ? markdown.indexOf('A &amp; B') : -1,
  validateMarkdown: () => true
})
const entityPlan = entityOwner.plan({
  journal: entityCapture.checkpoint,
  activeJournal: entityCapture.checkpoint,
  snapshot: entityCapture.snapshot,
  currentSource: entitySource,
  currentCanonical: 'entity-previous',
  canonical: 'entity-canonical',
  expectedDoc: entitySplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(entityPlan.ok, false)
assert.equal(entityPlan.recognized, true)
assert.equal(entityPlan.reason, 'task-empty-sibling-split-source-row-unproven')

const middle = planFor({
  oldDoc: checkedDoc,
  paragraphPath: [1, 0, 0],
  source: checkedSource,
  previous: 'checked-previous',
  canonical: 'middle-canonical',
  expectedSource: checkedExpected,
  revision: 169,
  rawBody: 'Checked',
  offset: 3
})
assert.equal(middle.plan.ok, false)
assert.equal(middle.plan.recognized, false)

const wrongStep = {
  constructor: { name: 'ReplaceStep' },
  from: topStep.from - 1,
  to: topStep.to - 1,
  structure: true,
  slice: topStep.slice,
  apply: () => ({ doc: top.split.transaction.doc })
}
const wrongTx = {
  docChanged: true,
  before: topUncheckedDoc,
  doc: top.split.transaction.doc,
  docs: [topUncheckedDoc],
  steps: [wrongStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongCapture = captureJournal({ source: topSource, canonical: topPrevious, oldDoc: topUncheckedDoc, transaction: wrongTx, revision: 170 })
const wrongPlan = top.owner.plan({
  journal: wrongCapture.checkpoint,
  activeJournal: wrongCapture.checkpoint,
  snapshot: wrongCapture.snapshot,
  currentSource: topSource,
  currentCanonical: topPrevious,
  canonical: 'wrong-canonical',
  expectedDoc: top.split.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'task-empty-sibling-split-step-range')

const ordinaryDoc = document(paragraph('before'), bullet(item('Ordinary', null), item('Tail')), paragraph('after'))
const ordinarySplit = captureSplit(ordinaryDoc, [1, 0, 0])
const ordinaryCapture = captureJournal({ source: '+ Ordinary\n+ Tail\n', canonical: '* Ordinary\n\n* Tail\n', oldDoc: ordinaryDoc, transaction: ordinarySplit.transaction, revision: 171 })
const noHitOwner = createListTaskEmptySiblingSplitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0, validateMarkdown: () => true })
const ordinaryPlan = noHitOwner.plan({
  journal: ordinaryCapture.checkpoint,
  activeJournal: ordinaryCapture.checkpoint,
  snapshot: ordinaryCapture.snapshot,
  currentSource: '+ Ordinary\n+ Tail\n',
  currentCanonical: '* Ordinary\n\n* Tail\n',
  canonical: 'ordinary-canonical',
  expectedDoc: ordinarySplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(ordinaryPlan.ok, false)
assert.equal(ordinaryPlan.recognized, false)

const orderedDoc = document(paragraph('before'), ordered(item('Ordered', true, [], 'ordered'), item('Tail', null, [], 'ordered')), paragraph('after'))
const orderedSplit = captureSplit(orderedDoc, [1, 0, 0])
const orderedCapture = captureJournal({ source: '1. [x] Ordered\n2. Tail\n', canonical: '1. [x] Ordered\n2. Tail\n', oldDoc: orderedDoc, transaction: orderedSplit.transaction, revision: 172 })
const orderedPlan = noHitOwner.plan({
  journal: orderedCapture.checkpoint,
  activeJournal: orderedCapture.checkpoint,
  snapshot: orderedCapture.snapshot,
  currentSource: '1. [x] Ordered\n2. Tail\n',
  currentCanonical: '1. [x] Ordered\n2. Tail\n',
  canonical: 'ordered-canonical',
  expectedDoc: orderedSplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

assert.throws(
  () => createListTaskEmptySiblingSplitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS task empty sibling split transaction owner: top-level unchecked/checked and nested checked end-Enter share one exact splitListItem ReplaceStep, source inserts only same authored task prefix + U+200B sentinel while preserving marker/BOM/CRLF/successors; entity/wrong-step fail closed and middle/ordinary/ordered stay separate')
