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
  LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_BOUNDARY,
  LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_FAMILY,
  createListNestedEmptyBulletTailIndentTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-empty-bullet-tail-indent-transaction-owner.js'

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
  checked: null,
  label: '•',
  listType: 'bullet',
  spread: 'false'
}, [paragraph(value), ...children])
const taskItem = (value = '') => schema.nodes.list_item.create({
  checked: false,
  label: '•',
  listType: 'bullet',
  spread: 'false'
}, paragraph(value))
const bulletList = (...items) => schema.nodes.bullet_list.create({ spread: 'false' }, items)
const orderedItem = (label, value = '') => schema.nodes.list_item.create({
  checked: null,
  label,
  listType: 'ordered',
  spread: 'false'
}, paragraph(value))
const orderedList = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'false' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const captureSink = (oldDoc, path) => {
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, path)
  const state = EditorState.create({
    schema,
    doc: oldDoc,
    selection: TextSelection.create(oldDoc, paragraphEntry.contentStart)
  })
  let transaction = null
  const handled = sinkListItem(schema.nodes.list_item)(state, (value) => { transaction = value })
  return { handled, transaction }
}

const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({
    revision,
    source,
    canonical,
    doc: oldDoc,
    owner: 'fixture',
    family: 'fixture'
  })
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

const oldDoc = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta'), bulletItem('')),
  paragraph('after')
)
const { handled, transaction } = captureSink(oldDoc, [1, 2, 0])
assert.equal(handled, true)
assert.ok(transaction)
assert.equal(transaction.steps.length, 1)
const nativeStep = transaction.steps[0]
assert.equal(nativeStep.constructor.name, 'ReplaceAroundStep')
assert.equal(nativeStep.structure, true)
assert.equal(nativeStep.slice.size, 3)
assert.equal(nativeStep.slice.openStart, 1)
assert.equal(nativeStep.slice.openEnd, 0)
assert.equal(nativeStep.insert, 1)

const parentEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 1])
const targetEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 2])
assert.equal(targetEntry.beforePos, parentEntry.beforePos + parentEntry.node.nodeSize)
assert.equal(nativeStep.from, targetEntry.beforePos - 1)
assert.equal(nativeStep.to, targetEntry.beforePos + targetEntry.node.nodeSize)
assert.equal(nativeStep.gapFrom, targetEntry.beforePos)
assert.equal(nativeStep.gapTo, nativeStep.to)

const source = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ \r\n\r\nafter\r\n'
const previous = 'before\n\n* alpha\n\n* beta\n\n* <br />\n\nafter\n'
const canonical = 'before\n\n* alpha\n\n* beta\n\n  * <br />\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n\r\n  + \r\n\r\nafter\r\n'
const { snapshot, checkpoint } = captureJournal({
  source,
  canonical: previous,
  oldDoc,
  transaction,
  revision: 157
})
const owner = createListNestedEmptyBulletTailIndentTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown }) => markdown.indexOf('beta'),
  validateMarkdown: ({ markdown, expectedDoc }) =>
    markdown === expectedSource && expectedDoc.eq(transaction.doc)
})
const plan = owner.plan({
  journal: checkpoint,
  activeJournal: checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_NESTED_EMPTY_BULLET_TAIL_INDENT_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-nested-empty-bullet-tail-indented')
assert.equal(plan.result.markdown, expectedSource)
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)
assert.ok(plan.result.markdown.includes('+ beta\r\n\r\n  + \r\n'))
assert.deepEqual(plan.proof.parentPath, [1, 1])
assert.deepEqual(plan.proof.targetPath, [1, 2])
assert.deepEqual(plan.proof.nestedListPath, [1, 1, 1])
assert.deepEqual(plan.proof.nestedItemPath, [1, 1, 1, 0])
assert.equal(plan.proof.movedSourceRow.token, '+')
assert.equal(plan.proof.rawInsertion.insertion, '\r\n  ')
assert.equal(plan.proof.step.from, nativeStep.from)
assert.equal(plan.proof.step.gapFrom, nativeStep.gapFrom)
assert.equal(plan.proof.step.gapTo, nativeStep.gapTo)

const authoredBodySource = source.replace('+ \r\n\r\nafter', '+ authored\r\n\r\nafter')
const bodyJournal = captureJournal({
  source: authoredBodySource,
  canonical: previous,
  oldDoc,
  transaction,
  revision: 158
})
const bodyPlan = owner.plan({
  journal: bodyJournal.checkpoint,
  activeJournal: bodyJournal.checkpoint,
  snapshot: bodyJournal.snapshot,
  currentSource: authoredBodySource,
  currentCanonical: previous,
  canonical,
  expectedDoc: transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(bodyPlan.ok, false)
assert.equal(bodyPlan.recognized, true)
assert.equal(bodyPlan.reason, 'nested-empty-bullet-indent-source-row-unproven')

const wideSpacingSource = source.replaceAll('+ ', '+  ')
const spacingJournal = captureJournal({
  source: wideSpacingSource,
  canonical: previous,
  oldDoc,
  transaction,
  revision: 159
})
const spacingPlan = owner.plan({
  journal: spacingJournal.checkpoint,
  activeJournal: spacingJournal.checkpoint,
  snapshot: spacingJournal.snapshot,
  currentSource: wideSpacingSource,
  currentCanonical: previous,
  canonical,
  expectedDoc: transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(spacingPlan.ok, false)
assert.equal(spacingPlan.recognized, true)
assert.equal(spacingPlan.reason, 'nested-empty-bullet-indent-source-row-unproven')

const nonEmptyOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta'), bulletItem('gamma')),
  paragraph('after')
)
const nonEmptySink = captureSink(nonEmptyOld, [1, 2, 0])
assert.equal(nonEmptySink.handled, true)
const nonEmptyJournal = captureJournal({
  source: source.replace('+ \r\n', '+ gamma\r\n'),
  canonical: previous.replace('* <br />', '* gamma'),
  oldDoc: nonEmptyOld,
  transaction: nonEmptySink.transaction,
  revision: 160
})
const nonEmptyPlan = owner.plan({
  journal: nonEmptyJournal.checkpoint,
  activeJournal: nonEmptyJournal.checkpoint,
  snapshot: nonEmptyJournal.snapshot,
  currentSource: nonEmptyJournal.snapshot.source,
  currentCanonical: nonEmptyJournal.snapshot.canonical,
  canonical: canonical.replace('<br />', 'gamma'),
  expectedDoc: nonEmptySink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(nonEmptyPlan.ok, false)
assert.equal(nonEmptyPlan.recognized, false)

const existingNested = bulletList(bulletItem('inside'))
const nestedParentOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [existingNested]), bulletItem('')),
  paragraph('after')
)
const nestedParentSink = captureSink(nestedParentOld, [1, 2, 0])
assert.equal(nestedParentSink.handled, true)
const nestedParentJournal = captureJournal({
  source,
  canonical: previous,
  oldDoc: nestedParentOld,
  transaction: nestedParentSink.transaction,
  revision: 161
})
const nestedParentPlan = owner.plan({
  journal: nestedParentJournal.checkpoint,
  activeJournal: nestedParentJournal.checkpoint,
  snapshot: nestedParentJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: nestedParentSink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(nestedParentPlan.ok, false)
assert.equal(nestedParentPlan.recognized, false)

const taskOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta'), taskItem('')),
  paragraph('after')
)
const taskSink = captureSink(taskOld, [1, 2, 0])
assert.equal(taskSink.handled, true)
const taskJournal = captureJournal({ source, canonical: previous, oldDoc: taskOld, transaction: taskSink.transaction, revision: 162 })
const taskPlan = owner.plan({
  journal: taskJournal.checkpoint,
  activeJournal: taskJournal.checkpoint,
  snapshot: taskJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: taskSink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const orderedOld = document(
  paragraph('before'),
  orderedList(orderedItem('1.', 'alpha'), orderedItem('2.', 'beta'), orderedItem('3.', '')),
  paragraph('after')
)
const orderedSink = captureSink(orderedOld, [1, 2, 0])
assert.equal(orderedSink.handled, true)
const orderedJournal = captureJournal({ source, canonical: previous, oldDoc: orderedOld, transaction: orderedSink.transaction, revision: 163 })
const orderedPlan = owner.plan({
  journal: orderedJournal.checkpoint,
  activeJournal: orderedJournal.checkpoint,
  snapshot: orderedJournal.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: orderedSink.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

assert.equal(owner.plan({
  journal: checkpoint,
  activeJournal: checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: transaction.doc,
  callbackDocumentEquivalent: false
}).reason, 'nested-empty-bullet-indent-callback-document-mismatch')

assert.throws(
  () => createListNestedEmptyBulletTailIndentTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested empty bullet tail indent transaction owner: exact sinkListItem ReplaceAroundStep moves only a plain tail empty bullet under its preceding nonempty sibling, preserving authored bullet marker/BOM/CRLF with one parse-safe blank line; source-body/spacing failures are recognized and nonempty/existing-nested/task/ordered families stay separate')
