import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import {
  preserveTransactionOwnedListSubtreeChange
} from '../src/renderer/src/markdown-source-preservation.js'
import {
  LIST_SUBTREE_TRANSACTION_BOUNDARY,
  LIST_SUBTREE_TRANSACTION_FAMILY,
  createListSubtreeTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    code_block: { content: 'text*', group: 'block', code: true },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null } }
    },
    text: { group: 'inline' }
  }
})

const text = (value) => value ? schema.text(value) : null
const paragraph = (value = '') => schema.nodes.paragraph.create(null, text(value))
const code = (value) => schema.nodes.code_block.create(null, text(value))
const item = (...children) => schema.nodes.list_item.create(null, children)
const taskItem = (checked, ...children) => schema.nodes.list_item.create({ checked }, children)
const ordered = (...items) => schema.nodes.ordered_list.create(null, items)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const identityMap = Object.freeze({ map: (position) => position })
const step = (name, from, to, structure = false) => ({
  constructor: { name },
  from,
  to,
  structure,
  slice: { size: 0, content: null }
})
const transaction = (before, after, steps) => ({
  docChanged: true,
  before,
  doc: after,
  docs: steps.map(() => before),
  steps,
  mapping: { maps: steps.map(() => identityMap) }
})

const captureJournal = ({
  source,
  canonical,
  oldDoc,
  batches,
  revision = 11
}) => {
  const snapshot = createSourceSyncSnapshot({
    revision,
    source,
    canonical,
    doc: oldDoc,
    owner: 'fixture',
    family: 'fixture'
  })
  const journal = createSourceSyncTransactionJournal()
  let checkpoint = null
  for (const batch of batches) {
    const captured = journal.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: batch.transactions,
      oldDoc: batch.oldDoc,
      newDoc: batch.newDoc
    })
    assert.equal(captured.ok, true, `journal capture failed: ${captured.reason || 'unknown'}`)
    checkpoint = captured.checkpoint
  }
  return { snapshot, journal, checkpoint }
}

const planWithJournal = (owner, {
  snapshot,
  checkpoint,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent = true,
  currentSource = snapshot.source,
  currentCanonical = snapshot.canonical,
  activeJournal = checkpoint
}) => owner.plan({
  journal: checkpoint,
  activeJournal,
  snapshot,
  currentSource,
  currentCanonical,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent
})

const parent = '啊额法色饭'
const child = '微'
const codeText = '尼玛，吗了解\n了几百块'
const oldList = ordered(item(paragraph(parent), ordered(item(paragraph(child)))))
const emptyChildList = ordered(item(paragraph(parent), ordered(item(paragraph()))))
const finalList = ordered(item(paragraph(parent)))
const oldDoc = document(oldList, code(codeText), paragraph('后文'))
const intermediateDoc = document(emptyChildList, code(codeText), paragraph('后文'))
const finalDoc = document(finalList, code(codeText), paragraph('后文'))

const first = transaction(oldDoc, intermediateDoc, [step('ReplaceStep', 8, 9)])
const second = transaction(
  intermediateDoc,
  finalDoc,
  [step('ReplaceAroundStep', 5, 11, true)]
)

const makeOwner = (needle = parent, mapListSubtree = preserveTransactionOwnedListSubtreeChange) =>
  createListSubtreeTransactionSourceSyncOwner({
    mapListSubtree,
    resolveMarkdownOffset: ({ markdown }) => markdown.indexOf(needle)
  })

const source = [
  '# 标题', '',
  '1. 啊额法色饭',
  '   1. 微', '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```', '',
  '后文', ''
].join('\n')
const previous = [
  '# 标题', '',
  '1. 啊额法色饭', '',
  '   1. 微', '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```', '',
  '后文', ''
].join('\n')
const next = [
  '# 标题', '',
  '1. 啊额法色饭', '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```', '',
  '后文', ''
].join('\n')
const expected = next

const owner = makeOwner()
const mainJournal = captureJournal({
  source,
  canonical: previous,
  oldDoc,
  batches: [
    { transactions: [first], oldDoc, newDoc: intermediateDoc },
    { transactions: [second], oldDoc: intermediateDoc, newDoc: finalDoc }
  ]
})
assert.equal(mainJournal.checkpoint.chainLength, 2)
assert.equal(mainJournal.checkpoint.batchCount, 2)
assert.deepEqual(
  mainJournal.checkpoint.stepDetails.map((entry) => entry.name),
  ['ReplaceStep', 'ReplaceAroundStep']
)

const plan = planWithJournal(owner, {
  snapshot: mainJournal.snapshot,
  checkpoint: mainJournal.checkpoint,
  canonical: next,
  expectedDoc: finalDoc
})
assert.equal(plan.ok, true)
assert.equal(plan.decision, 'owned')
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_SUBTREE_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_SUBTREE_TRANSACTION_BOUNDARY)
assert.equal(plan.baseRevision, mainJournal.snapshot.revision)
assert.equal(plan.baseSourceDigest, mainJournal.snapshot.sourceDigest)
assert.equal(plan.baseCanonicalDigest, mainJournal.snapshot.canonicalDigest)
assert.equal(plan.result.markdown, expected)
assert.equal(plan.result.reason, LIST_SUBTREE_TRANSACTION_BOUNDARY)
assert.equal(plan.proof.mapperReason, 'diverged-nested-list-change')
assert.equal(plan.proof.transactionJournal.kind, 'source-sync-transaction-journal-proof')
assert.equal(plan.proof.transactionJournal.batchCount, 2)
assert.equal(plan.proof.trailingBoundaryNewlineGrowth, 0,
  'deleting a tail list row must reuse the existing source block separator')
assert.equal(plan.proof.chainLength, 2)
assert.equal((plan.result.markdown.match(/^```$/gm) || []).length, 2,
  'the list subtree owner must not create an empty fence beside the unchanged code block')
assert.equal(plan.result.markdown.includes('   1. 微'), false)
assert.equal(plan.result.markdown.includes(codeText), true)

const crlfSource = source.replace(/\n/g, '\r\n')
const crlfPrevious = previous.replace(/\n/g, '\r\n')
const crlfNext = next.replace(/\n/g, '\r\n')
const crlfJournal = captureJournal({
  source: crlfSource,
  canonical: crlfPrevious,
  oldDoc,
  batches: [
    { transactions: [first], oldDoc, newDoc: intermediateDoc },
    { transactions: [second], oldDoc: intermediateDoc, newDoc: finalDoc }
  ]
})
const crlfPlan = planWithJournal(makeOwner(), {
  snapshot: crlfJournal.snapshot,
  checkpoint: crlfJournal.checkpoint,
  canonical: crlfNext,
  expectedDoc: finalDoc
})
assert.equal(crlfPlan.ok, true)
assert.equal(crlfPlan.result.markdown, crlfNext, 'the bounded replacement must preserve authored CRLF')
assert.equal(crlfPlan.proof.trailingBoundaryNewlineGrowth, 0)

const appendedTail = preserveTransactionOwnedListSubtreeChange({
  source: '1. 啊额法色饭\n   1. 微风',
  previous: '1. 啊额法色饭\n\n   1. 微风',
  next: '1. 啊额法色饭\n\n   1. 微风、\n   2. <br />'
})
assert.equal(appendedTail?.reason, 'diverged-nested-list-change')
assert.equal(appendedTail?.trailingBoundaryNewlineGrowth, 1,
  'a newly appended tail row must terminate before the pre-existing outer block gap')
assert.equal(
  appendedTail?.markdown,
  '1. 啊额法色饭\n   1. 微风、\n   2. \n'
)
const appendedTailCrLf = preserveTransactionOwnedListSubtreeChange({
  source: '1. 啊额法色饭\r\n   1. 微风',
  previous: '1. 啊额法色饭\r\n\r\n   1. 微风',
  next: '1. 啊额法色饭\r\n\r\n   1. 微风、\r\n   2. <br />'
})
assert.equal(appendedTailCrLf?.trailingBoundaryNewlineGrowth, 1)
assert.equal(
  appendedTailCrLf?.markdown,
  '1. 啊额法色饭\r\n   1. 微风、\r\n   2. \r\n'
)

assert.equal(planWithJournal(owner, {
  snapshot: mainJournal.snapshot,
  checkpoint: mainJournal.checkpoint,
  canonical: next,
  expectedDoc: finalDoc,
  callbackDocumentEquivalent: false
}).reason, 'list-subtree-callback-document-mismatch')
assert.equal(planWithJournal(owner, {
  snapshot: mainJournal.snapshot,
  checkpoint: mainJournal.checkpoint,
  canonical: next,
  expectedDoc: finalDoc,
  currentCanonical: `${previous}x`
}).reason, 'list-subtree-live-snapshot-stale')
assert.equal(planWithJournal(owner, {
  snapshot: mainJournal.snapshot,
  checkpoint: mainJournal.checkpoint,
  canonical: next,
  expectedDoc: finalDoc,
  activeJournal: null
}).reason, 'list-subtree-journal-stale')
const staleRevisionSnapshot = createSourceSyncSnapshot({
  revision: mainJournal.snapshot.revision + 1,
  source,
  canonical: previous,
  doc: finalDoc
})
assert.equal(planWithJournal(owner, {
  snapshot: staleRevisionSnapshot,
  checkpoint: mainJournal.checkpoint,
  canonical: next,
  expectedDoc: finalDoc,
  currentSource: source,
  currentCanonical: previous
}).reason, 'transaction-journal-revision-stale')

const oldTwoLists = document(
  ordered(item(paragraph('一'), ordered(item(paragraph('子一'))))),
  bullet(item(paragraph('二'))),
  code(codeText)
)
const newTwoLists = document(
  ordered(item(paragraph('一'))),
  bullet(item(paragraph('二改'))),
  code(codeText)
)
const twoListSource = '1. 一\n   1. 子一\n\n- 二\n\n```\nx\n```\n'
const twoListPrevious = '1. 一\n\n   1. 子一\n\n* 二\n\n```\nx\n```\n'
const twoListNext = '1. 一\n\n* 二改\n\n```\nx\n```\n'
const twoListJournal = captureJournal({
  source: twoListSource,
  canonical: twoListPrevious,
  oldDoc: oldTwoLists,
  batches: [{
    transactions: [transaction(oldTwoLists, newTwoLists, [step('ReplaceStep', 5, 20)])],
    oldDoc: oldTwoLists,
    newDoc: newTwoLists
  }]
})
assert.equal(planWithJournal(makeOwner('一'), {
  snapshot: twoListJournal.snapshot,
  checkpoint: twoListJournal.checkpoint,
  canonical: twoListNext,
  expectedDoc: newTwoLists
}).reason, 'list-subtree-top-level-change-count',
  'one transaction changing two top-level lists must remain fail-closed')

const changedCodeDoc = document(finalList, code(`${codeText}X`), paragraph('后文'))
const listAndCodeJournal = captureJournal({
  source,
  canonical: previous,
  oldDoc,
  batches: [{
    transactions: [transaction(oldDoc, changedCodeDoc, [step('ReplaceStep', 8, 30)])],
    oldDoc,
    newDoc: changedCodeDoc
  }]
})
assert.equal(planWithJournal(owner, {
  snapshot: listAndCodeJournal.snapshot,
  checkpoint: listAndCodeJournal.checkpoint,
  canonical: next.replace('了几百块', '了几百块X'),
  expectedDoc: changedCodeDoc
}).reason, 'list-subtree-top-level-change-count',
  'a neighbouring code-block edit must never be folded into list ownership')

const convertedDoc = document(
  bullet(item(paragraph(parent))),
  code(codeText),
  paragraph('后文')
)
const conversionJournal = captureJournal({
  source,
  canonical: previous,
  oldDoc,
  batches: [{
    transactions: [transaction(oldDoc, convertedDoc, [step('ReplaceStep', 0, 12)])],
    oldDoc,
    newDoc: convertedDoc
  }]
})
assert.equal(planWithJournal(owner, {
  snapshot: conversionJournal.snapshot,
  checkpoint: conversionJournal.checkpoint,
  canonical: next.replace('1. 啊额法色饭', '* 啊额法色饭'),
  expectedDoc: convertedDoc
}).reason, 'list-subtree-list-type-changed',
  'list type conversion belongs to its existing command owner')

const taskOld = document(
  bullet(taskItem(false, paragraph('任务一'))),
  paragraph('后文')
)
const taskNew = document(
  bullet(
    taskItem(false, paragraph('任务一')),
    taskItem(false, paragraph())
  ),
  paragraph('后文')
)
let taskMapperCalls = 0
const taskOwner = makeOwner('任务一', (input) => {
  taskMapperCalls += 1
  return preserveTransactionOwnedListSubtreeChange(input)
})
const taskSource = '- [ ] 任务一\n\n后文\n'
const taskPrevious = '* [ ] 任务一\n\n后文\n'
const taskJournal = captureJournal({
  source: taskSource,
  canonical: taskPrevious,
  oldDoc: taskOld,
  batches: [{
    transactions: [transaction(taskOld, taskNew, [step('ReplaceAroundStep', 5, 8, true)])],
    oldDoc: taskOld,
    newDoc: taskNew
  }]
})
assert.equal(planWithJournal(taskOwner, {
  snapshot: taskJournal.snapshot,
  checkpoint: taskJournal.checkpoint,
  canonical: '* [ ] 任务一\n\n* [ ] <br />\n\n后文\n',
  expectedDoc: taskNew
}).reason, 'list-subtree-task-metadata',
  'task list structure must remain with the sentinel/input-rule owner')
assert.equal(taskMapperCalls, 0,
  'task metadata must be rejected before a bare empty-task candidate is constructed')

const textListOld = document(
  bullet(item(paragraph('LIST_CHILD'))),
  code(codeText)
)
const textListNew = document(
  bullet(item(paragraph('LIST_CHILDX'))),
  code(codeText)
)
let textListMapperCalls = 0
const textListOwner = makeOwner('LIST_CHILD', (input) => {
  textListMapperCalls += 1
  return preserveTransactionOwnedListSubtreeChange(input)
})
const textListSource = '- LIST_CHILD\n\n```\nx\n```\n'
const textListPrevious = '* LIST\\_CHILD\n\n```\nx\n```\n'
const textListJournal = captureJournal({
  source: textListSource,
  canonical: textListPrevious,
  oldDoc: textListOld,
  batches: [{
    transactions: [transaction(textListOld, textListNew, [step('ReplaceStep', 8, 8)])],
    oldDoc: textListOld,
    newDoc: textListNew
  }]
})
assert.equal(planWithJournal(textListOwner, {
  snapshot: textListJournal.snapshot,
  checkpoint: textListJournal.checkpoint,
  canonical: '* LIST\\_CHILDX\n\n```\nx\n```\n',
  expectedDoc: textListNew
}).reason, 'list-subtree-topology-unchanged',
  'plain list text must keep legacy raw-spelling preservation ownership')
assert.equal(textListMapperCalls, 0,
  'text-only list edits must be rejected before canonical escapes can enter source')

const plainOld = document(paragraph('甲'), code(codeText))
const plainNew = document(paragraph('甲X'), code(codeText))
const plainSource = '甲\n\n```\nx\n```\n'
const plainJournal = captureJournal({
  source: plainSource,
  canonical: plainSource,
  oldDoc: plainOld,
  batches: [{
    transactions: [transaction(plainOld, plainNew, [step('ReplaceStep', 2, 2)])],
    oldDoc: plainOld,
    newDoc: plainNew
  }]
})
assert.equal(planWithJournal(makeOwner('甲'), {
  snapshot: plainJournal.snapshot,
  checkpoint: plainJournal.checkpoint,
  canonical: '甲X\n\n```\nx\n```\n',
  expectedDoc: plainNew
}).reason, 'list-subtree-top-level-node-not-list',
  'the generic journal may capture any transaction, while the list owner must decline non-list families')

const firstOnly = captureJournal({
  source,
  canonical: previous,
  oldDoc,
  batches: [{ transactions: [first], oldDoc, newDoc: intermediateDoc }]
})
const gap = firstOnly.journal.captureOrAdvance({
  checkpoint: firstOnly.checkpoint,
  snapshot: firstOnly.snapshot,
  transactions: [second],
  oldDoc,
  newDoc: finalDoc
})
assert.equal(gap.reason, 'transaction-journal-document-stale')
assert.equal(gap.reset, true)

console.log('PASS list subtree transaction owner: generic revision journal owns lifecycle; one exact list topology maps while neighbours, CRLF and fail-closed boundaries remain intact')
