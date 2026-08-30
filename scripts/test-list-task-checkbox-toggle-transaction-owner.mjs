import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'
import {
  LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_BOUNDARY,
  LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_FAMILY,
  createListTaskCheckboxToggleTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-task-checkbox-toggle-transaction-owner.js'

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

const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc, owner: 'fixture', family: 'fixture' })
  const journal = createSourceSyncTransactionJournal()
  const captured = journal.captureOrAdvance({ checkpoint: null, snapshot, transactions: [transaction], oldDoc, newDoc: transaction.doc })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}

const planFor = ({ oldDoc, itemPath, nextChecked, source, previous, canonical, expectedSource, revision, rawBody }) => {
  const itemEntry = sourceSyncNodeEntryAtPath(oldDoc, itemPath)
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, [...itemPath, 0])
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr.setNodeAttribute(itemEntry.beforePos, 'checked', nextChecked)
  const capture = captureJournal({ source, canonical: previous, oldDoc, transaction, revision })
  const owner = createListTaskCheckboxToggleTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos }) => pmPos === paragraphEntry.contentStart ? markdown.indexOf(rawBody) : -1,
    validateMarkdown: ({ markdown, expectedDoc }) => markdown === expectedSource && expectedDoc.eq(transaction.doc)
  })
  const plan = owner.plan({
    journal: capture.checkpoint,
    activeJournal: capture.checkpoint,
    snapshot: capture.snapshot,
    currentSource: source,
    currentCanonical: previous,
    canonical,
    expectedDoc: transaction.doc,
    callbackDocumentEquivalent: true
  })
  return { itemEntry, paragraphEntry, transaction, capture, owner, plan }
}

const oldDoc = document(
  paragraph('before'),
  bullet(
    item('1. top', false),
    item('parent', null, [bullet(item('nested', true))]),
    item('tail')
  ),
  paragraph('after')
)
const source = '\uFEFFbefore\r\n\r\n+ [ ] 1\\. top\r\n+ parent\r\n  - [X] nested\r\n+ tail\r\n\r\nafter\r\n'
const previous = 'before\n\n* [ ] 1\\. top\n\n* parent\n\n  * [x] nested\n\n* tail\n\nafter\n'
const topExpected = '\uFEFFbefore\r\n\r\n+ [x] 1\\. top\r\n+ parent\r\n  - [X] nested\r\n+ tail\r\n\r\nafter\r\n'
const top = planFor({
  oldDoc,
  itemPath: [1, 0],
  nextChecked: true,
  source,
  previous,
  canonical: 'top-canonical',
  expectedSource: topExpected,
  revision: 164,
  rawBody: '1\\. top'
})
assert.equal(top.transaction.steps.length, 1)
const topStep = top.transaction.steps[0]
assert.equal(topStep.constructor.name, 'AttrStep')
assert.equal(topStep.pos, top.itemEntry.beforePos)
assert.equal(topStep.attr, 'checked')
assert.equal(topStep.value, true)
assert.equal(top.plan.ok, true, JSON.stringify(top.plan))
assert.equal(top.plan.family, LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_FAMILY)
assert.equal(top.plan.boundary, LIST_TASK_CHECKBOX_TOGGLE_TRANSACTION_BOUNDARY)
assert.equal(top.plan.proof.scope, 'top-level')
assert.equal(top.plan.proof.previousChecked, false)
assert.equal(top.plan.proof.nextChecked, true)
assert.equal(top.plan.proof.sourceRow.token, '+')
assert.equal(top.plan.proof.sourceRow.body, '1\\. top')
assert.equal(top.plan.proof.rawPatch.from, ' ')
assert.equal(top.plan.proof.rawPatch.to, 'x')
assert.equal(top.plan.result.markdown, topExpected)

const nestedExpected = '\uFEFFbefore\r\n\r\n+ [ ] 1\\. top\r\n+ parent\r\n  - [ ] nested\r\n+ tail\r\n\r\nafter\r\n'
const nested = planFor({
  oldDoc,
  itemPath: [1, 1, 1, 0],
  nextChecked: false,
  source,
  previous,
  canonical: 'nested-canonical',
  expectedSource: nestedExpected,
  revision: 165,
  rawBody: 'nested'
})
assert.equal(nested.plan.ok, true, JSON.stringify(nested.plan))
assert.equal(nested.plan.proof.scope, 'nested')
assert.equal(nested.plan.proof.previousChecked, true)
assert.equal(nested.plan.proof.nextChecked, false)
assert.equal(nested.plan.proof.sourceRow.token, '-')
assert.equal(nested.plan.proof.sourceRow.previousState, 'X')
assert.equal(nested.plan.proof.rawPatch.to, ' ')
assert.equal(nested.plan.result.markdown, nestedExpected)

const entityDoc = document(paragraph('before'), bullet(item('A & B', false)), paragraph('after'))
const entitySource = '\uFEFFbefore\r\n\r\n+ [ ] A &amp; B\r\n\r\nafter\r\n'
const entityEntry = sourceSyncNodeEntryAtPath(entityDoc, [1, 0])
const entityParagraph = sourceSyncNodeEntryAtPath(entityDoc, [1, 0, 0])
const entityTx = EditorState.create({ schema, doc: entityDoc }).tr.setNodeAttribute(entityEntry.beforePos, 'checked', true)
const entityCapture = captureJournal({ source: entitySource, canonical: 'entity-previous', oldDoc: entityDoc, transaction: entityTx, revision: 166 })
const entityOwner = createListTaskCheckboxToggleTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos }) => pmPos === entityParagraph.contentStart ? markdown.indexOf('A &amp; B') : -1,
  validateMarkdown: () => true
})
const entityPlan = entityOwner.plan({
  journal: entityCapture.checkpoint,
  activeJournal: entityCapture.checkpoint,
  snapshot: entityCapture.snapshot,
  currentSource: entitySource,
  currentCanonical: 'entity-previous',
  canonical: 'entity-canonical',
  expectedDoc: entityTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(entityPlan.ok, false)
assert.equal(entityPlan.recognized, true)
assert.equal(entityPlan.reason, 'list-task-checkbox-toggle-source-row-unproven')

const wrongStep = {
  constructor: { name: 'AttrStep' },
  pos: topStep.pos + 1,
  attr: 'checked',
  value: true,
  apply: () => ({ doc: top.transaction.doc })
}
const wrongTx = {
  docChanged: true,
  before: oldDoc,
  doc: top.transaction.doc,
  docs: [oldDoc],
  steps: [wrongStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: wrongTx, revision: 167 })
const wrongPlan = top.owner.plan({
  journal: wrongCapture.checkpoint,
  activeJournal: wrongCapture.checkpoint,
  snapshot: wrongCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'wrong-canonical',
  expectedDoc: top.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'list-task-checkbox-toggle-step-target')

const ordinaryDoc = document(paragraph('before'), bullet(item('ordinary', null)), paragraph('after'))
const ordinaryEntry = sourceSyncNodeEntryAtPath(ordinaryDoc, [1, 0])
const ordinaryTx = EditorState.create({ schema, doc: ordinaryDoc }).tr.setNodeAttribute(ordinaryEntry.beforePos, 'checked', false)
const ordinaryCapture = captureJournal({ source: '+ ordinary\n', canonical: '* ordinary\n', oldDoc: ordinaryDoc, transaction: ordinaryTx, revision: 168 })
const noHitOwner = createListTaskCheckboxToggleTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0, validateMarkdown: () => true })
const ordinaryPlan = noHitOwner.plan({
  journal: ordinaryCapture.checkpoint,
  activeJournal: ordinaryCapture.checkpoint,
  snapshot: ordinaryCapture.snapshot,
  currentSource: '+ ordinary\n',
  currentCanonical: '* ordinary\n',
  canonical: '* [ ] ordinary\n',
  expectedDoc: ordinaryTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(ordinaryPlan.ok, false)
assert.equal(ordinaryPlan.recognized, false)

const orderedDoc = document(paragraph('before'), ordered(item('ordered task', false, [], 'ordered')), paragraph('after'))
const orderedEntry = sourceSyncNodeEntryAtPath(orderedDoc, [1, 0])
const orderedTx = EditorState.create({ schema, doc: orderedDoc }).tr.setNodeAttribute(orderedEntry.beforePos, 'checked', true)
const orderedCapture = captureJournal({ source: '1. [ ] ordered task\n', canonical: '1. [ ] ordered task\n', oldDoc: orderedDoc, transaction: orderedTx, revision: 169 })
const orderedPlan = noHitOwner.plan({
  journal: orderedCapture.checkpoint,
  activeJournal: orderedCapture.checkpoint,
  snapshot: orderedCapture.snapshot,
  currentSource: '1. [ ] ordered task\n',
  currentCanonical: '1. [ ] ordered task\n',
  canonical: '1. [x] ordered task\n',
  expectedDoc: orderedTx.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

assert.throws(
  () => createListTaskCheckboxToggleTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS task checkbox toggle transaction owner: top-level/nested bullet tasks use one exact checked AttrStep at list_item.beforePos, raw source changes only checkbox state char while preserving authored marker/spacing/BOM/CRLF/backslash escapes; entity/raw mismatch and wrong AttrStep fail closed, ordinary conversion and ordered task stay separate')
