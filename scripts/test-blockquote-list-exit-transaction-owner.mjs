import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { ReplaceAroundStep } from '@milkdown/prose/transform'
import { liftListItem } from '@milkdown/prose/schema-list'
import {
  BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
  createBlockquoteExitTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { spread: { default: false } }
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 }, spread: { default: false } }
    },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        label: { default: '' },
        listType: { default: '' },
        spread: { default: true },
        checked: { default: null }
      }
    },
    text: { group: 'inline' }
  }
})

const paragraph = (value = '') => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value) : null
)
const item = (label, value = '') => schema.nodes.list_item.create(
  { label, listType: 'ordered', spread: true, checked: null },
  paragraph(value)
)
const ordered = (...items) => schema.nodes.ordered_list.create(
  { order: 1, spread: false },
  items
)
const quote = (...children) => schema.nodes.blockquote.create(null, children)
const document = (...children) => schema.nodes.doc.create(null, children)

const oldDoc = document(
  quote(
    paragraph('intro'),
    ordered(item('1.', 'one'), item('2.', 'two'), item('3.'))
  ),
  paragraph('after')
)
const emptyParagraph = sourceSyncNodeEntryAtPath(oldDoc, [0, 1, 2, 0])
assert.ok(emptyParagraph)
let state = EditorState.create({
  schema,
  doc: oldDoc,
  selection: TextSelection.create(oldDoc, emptyParagraph.contentStart)
})
let liftedTransaction = null
assert.equal(
  liftListItem(schema.nodes.list_item)(state, (value) => { liftedTransaction = value }),
  true,
  'liftListItem must derive the empty-tail lift topology'
)
assert.ok(liftedTransaction)
assert.equal(liftedTransaction.steps.length, 1)
const liftedStep = liftedTransaction.steps[0]
assert.equal(liftedStep.constructor.name, 'ReplaceAroundStep')
// Milkdown's live Enter command emits this same range/slice with structure=true
// (captured in the 0.13.165 failure trace). Keep that production contract
// strict instead of relaxing the owner to schema-list's structure=false step.
const tracedStep = new ReplaceAroundStep(
  liftedStep.from,
  liftedStep.to,
  liftedStep.gapFrom,
  liftedStep.gapTo,
  liftedStep.slice,
  liftedStep.insert,
  true
)
const transaction = state.tr.step(tracedStep)
assert.equal(transaction.steps[0].structure, true)
state = state.apply(transaction)
const expectedDoc = state.doc
assert.equal(expectedDoc.child(0).type.name, 'blockquote')
assert.equal(expectedDoc.child(0).child(1).type.name, 'ordered_list')
assert.equal(expectedDoc.child(0).child(1).childCount, 2)
assert.equal(expectedDoc.child(0).lastChild.type.name, 'paragraph')
assert.equal(expectedDoc.child(0).lastChild.content.size, 0)

const source = '\uFEFF> intro\r\n>\r\n> 1. one\r\n> 2. two\r\n> 3. <br />\r\n\r\nafter\r\n'
const canonical = '> intro\n>\n> 1. one\n> 2. two\n> 3. <br />\n\nafter\n'
const expectedSource = '\uFEFF> intro\r\n>\r\n> 1. one\r\n> 2. two\r\n\r\nafter\r\n'
const nextCanonical = '> intro\n>\n> 1. one\n> 2. two\n>\n> <br />\n\nafter\n'

const journalFactory = createSourceSyncTransactionJournal()
const snapshot = createSourceSyncSnapshot({
  revision: 166,
  source,
  canonical,
  doc: oldDoc
})
const captured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [transaction],
  oldDoc,
  newDoc: expectedDoc
})
assert.equal(captured.ok, true)

let semanticOptionsSeen = null
const owner = createBlockquoteExitTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos, doc }) => {
    const retained = sourceSyncNodeEntryAtPath(doc, [0, 1, 1, 0])
    if (!retained || pmPos !== retained.contentStart) return null
    return markdown.indexOf('two')
  },
  validateMarkdown: ({ markdown, expectedDoc: validatedDoc, semanticOptions }) => {
    semanticOptionsSeen = semanticOptions
    return markdown === expectedSource && validatedDoc.eq(expectedDoc)
  }
})
const plan = owner.plan({
  journal: captured.checkpoint,
  activeJournal: captured.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: canonical,
  canonical: nextCanonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true)
assert.equal(plan.decision, 'owned')
assert.equal(plan.family, BLOCKQUOTE_EXIT_TRANSACTION_FAMILY)
assert.equal(plan.result.reason, 'trailing-empty-blockquote-paragraph-after-list-exit')
assert.equal(plan.result.markdown, expectedSource)
assert.equal(plan.proof.kind, 'transaction-blockquote-list-exit-pending-proof')
assert.equal(plan.proof.mode, 'list-exit-pending')
assert.deepEqual(plan.proof.nodePath, [0])
assert.deepEqual(plan.proof.listPath, [0, 1])
assert.deepEqual(plan.proof.removedItemPath, [0, 1, 2])
assert.deepEqual(plan.proof.transientParagraphPath, [0, 2])
assert.equal(plan.proof.listType, 'ordered_list')
assert.equal(plan.proof.removedIndex, 2)
assert.equal(plan.proof.step.name, 'ReplaceAroundStep')
assert.equal(plan.proof.step.structure, true)
assert.equal(plan.proof.step.sliceSize, 1)
assert.equal(plan.proof.step.openStart, 1)
assert.equal(plan.proof.step.openEnd, 0)
assert.equal(plan.proof.removedSourceRow.token, '3.')
assert.equal(plan.proof.removedSourceRow.body, '<br />')
assert.equal(plan.proof.removedSourceRow.eol, '\r\n')
assert.deepEqual(
  semanticOptionsSeen?.ignoreTrailingEmptyBlockquoteParagraphPaths,
  [[0]],
  'owner must validate only the exact blockquote transient path'
)

const badSource = source.replace('> 3. <br />', '> 3. authored')
const badSnapshot = createSourceSyncSnapshot({
  revision: 167,
  source: badSource,
  canonical,
  doc: oldDoc
})
const badCaptured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: badSnapshot,
  transactions: [transaction],
  oldDoc,
  newDoc: expectedDoc
})
assert.equal(badCaptured.ok, true)
const rejected = owner.plan({
  journal: badCaptured.checkpoint,
  activeJournal: badCaptured.checkpoint,
  snapshot: badSnapshot,
  currentSource: badSource,
  currentCanonical: canonical,
  canonical: nextCanonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(rejected.ok, false)
assert.equal(rejected.recognized, true)
assert.equal(rejected.reason, 'blockquote-list-exit-pending-authored-row-unproven')

console.log('PASS blockquote list-exit transaction owner: final empty quote-list item exits through the existing focused owner and raw proof fails closed')
