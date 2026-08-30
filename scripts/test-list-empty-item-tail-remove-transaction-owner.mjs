import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import {
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import {
  LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_BOUNDARY,
  LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_FAMILY,
  createListEmptyItemTailRemoveTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-empty-item-tail-remove-transaction-owner.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        checked: { default: null },
        label: { default: null },
        listType: { default: null },
        spread: { default: null }
      }
    },
    text: { group: 'inline' }
  }
})
const text = (value) => value ? schema.text(value) : null
const paragraph = (value = '') => schema.nodes.paragraph.create(null, text(value))
const item = (...children) => schema.nodes.list_item.create(null, children)
const taskItem = (checked, ...children) => schema.nodes.list_item.create({ checked }, children)
const semanticItem = (attrs, ...children) => schema.nodes.list_item.create(attrs, children)
const bullet = (...items) => schema.nodes.bullet_list.create(null, items)
const ordered = (...items) => schema.nodes.ordered_list.create(null, items)
const quote = (...blocks) => schema.nodes.blockquote.create(null, blocks)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const nodeBeforePosAtPath = (doc, path) => {
  let parent = doc
  let beforePos = 0
  for (let depth = 0; depth < path.length; depth += 1) {
    const index = path[depth]
    let childOffset = 0
    for (let sibling = 0; sibling < index; sibling += 1) childOffset += parent.child(sibling).nodeSize
    beforePos = depth === 0 ? childOffset : beforePos + 1 + childOffset
    parent = parent.child(index)
  }
  return beforePos
}
const contentStartAtPath = (doc, path) => nodeBeforePosAtPath(doc, path) + 1

const oldList = bullet(item(paragraph('left')), item(paragraph()))
const nextList = bullet(item(paragraph('left'), paragraph()))
const oldDoc = document(paragraph('before'), oldList, paragraph('after'))
const expectedDoc = document(paragraph('before'), nextList, paragraph('after'))
const listOffset = oldDoc.child(0).nodeSize
const removedBefore = listOffset + 1 + oldList.child(0).nodeSize
const step = {
  constructor: { name: 'ReplaceStep' },
  from: removedBefore - 1,
  to: removedBefore + 1,
  structure: true,
  slice: { size: 0 },
  apply: () => ({ doc: expectedDoc })
}
const fakeTransaction = {
  docChanged: true,
  before: oldDoc,
  doc: expectedDoc,
  docs: [oldDoc],
  steps: [step],
  mapping: { maps: [{ map: (position) => position }] }
}

const source = '\uFEFFbefore\r\n\r\n- left\r\n- \r\n\r\nafter\r\n'
const previous = 'before\n\n* left\n\n* <br />\n\nafter\n'
const canonical = 'before\n\n* left\n\n  <br />\n\nafter\n'
const expectedSource = '\uFEFFbefore\r\n\r\n- left\r\n\r\nafter\r\n'
const snapshot = createSourceSyncSnapshot({ revision: 152, source, canonical: previous, doc: oldDoc })
const journalFactory = createSourceSyncTransactionJournal()
const captured = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [fakeTransaction],
  oldDoc,
  newDoc: expectedDoc
})
assert.equal(captured.ok, true)

const owner = createListEmptyItemTailRemoveTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown }) => markdown.indexOf('left')
})
const plan = owner.plan({
  journal: captured.checkpoint,
  activeJournal: captured.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(plan.ok, true, JSON.stringify(plan))
assert.equal(plan.owner, 'transaction')
assert.equal(plan.family, LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_FAMILY)
assert.equal(plan.boundary, LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_BOUNDARY)
assert.equal(plan.result.reason, 'list-empty-item-tail-removed')
assert.equal(plan.result.markdown, expectedSource)
assert.deepEqual(plan.proof.removedPath, [1, 1])
assert.deepEqual(plan.proof.transientEmptyListItemPath, [1, 0])
assert.deepEqual(plan.proof.transientEmptyParagraphPath, [1, 0, 1])
assert.equal(plan.proof.step.name, 'ReplaceStep')
assert.equal(plan.proof.step.structure, true)
assert.equal(plan.proof.removedSourceRow.token, '-')
assert.equal(plan.result.markdown.charCodeAt(0), 0xFEFF)
assert.equal(plan.result.markdown.includes('\r\n'), true)
assert.equal(plan.result.markdown.includes('<br'), false)

{
  const quoteOldList = ordered(
    item(paragraph('alpha')),
    item(paragraph('beta')),
    item(paragraph())
  )
  const quoteNextList = ordered(
    item(paragraph('alpha')),
    item(paragraph('beta'), paragraph())
  )
  const quoteOldDoc = document(
    paragraph('quote-title'),
    quote(paragraph('intro'), quoteOldList),
    paragraph('after')
  )
  const quoteExpectedDoc = document(
    paragraph('quote-title'),
    quote(paragraph('intro'), quoteNextList),
    paragraph('after')
  )
  const removedBefore = nodeBeforePosAtPath(quoteOldDoc, [1, 1, 2])
  const quoteStep = {
    constructor: { name: 'ReplaceStep' },
    from: removedBefore - 1,
    to: removedBefore + 1,
    structure: true,
    slice: { size: 0 },
    apply: () => ({ doc: quoteExpectedDoc })
  }
  const quoteTransaction = {
    docChanged: true,
    before: quoteOldDoc,
    doc: quoteExpectedDoc,
    docs: [quoteOldDoc],
    steps: [quoteStep],
    mapping: { maps: [{ map: (position) => position }] }
  }
  const quoteSource = '\uFEFFquote-title\r\n\r\n> intro\r\n>\r\n> 1. alpha\r\n> 2. beta\r\n> 3. <br />\r\n\r\nafter\r\n'
  const quotePrevious = 'quote-title\n\n> intro\n>\n> 1. alpha\n> 2. beta\n> 3. <br />\n\nafter\n'
  const quoteCanonical = 'quote-title\n\n> intro\n>\n> 1. alpha\n> 2. beta\n>\n>    <br />\n\nafter\n'
  const quoteExpectedSource = '\uFEFFquote-title\r\n\r\n> intro\r\n>\r\n> 1. alpha\r\n> 2. beta\r\n\r\nafter\r\n'
  const quoteSnapshot = createSourceSyncSnapshot({
    revision: 1521,
    source: quoteSource,
    canonical: quotePrevious,
    doc: quoteOldDoc
  })
  const quoteCapture = journalFactory.captureOrAdvance({
    checkpoint: null,
    snapshot: quoteSnapshot,
    transactions: [quoteTransaction],
    oldDoc: quoteOldDoc,
    newDoc: quoteExpectedDoc
  })
  assert.equal(quoteCapture.ok, true)
  const paragraphPositions = new Map([
    [contentStartAtPath(quoteOldDoc, [1, 1, 0, 0]), 'alpha'],
    [contentStartAtPath(quoteOldDoc, [1, 1, 1, 0]), 'beta']
  ])
  const quoteOwner = createListEmptyItemTailRemoveTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos }) => {
      const needle = paragraphPositions.get(pmPos)
      assert.ok(needle, 'quote tail owner must never request a source-map anchor for the empty tail paragraph')
      return markdown.indexOf(needle)
    }
  })
  const quotePlan = quoteOwner.plan({
    journal: quoteCapture.checkpoint,
    activeJournal: quoteCapture.checkpoint,
    snapshot: quoteSnapshot,
    currentSource: quoteSource,
    currentCanonical: quotePrevious,
    canonical: quoteCanonical,
    expectedDoc: quoteExpectedDoc,
    callbackDocumentEquivalent: false
  })
  assert.equal(quotePlan.ok, true, JSON.stringify(quotePlan))
  assert.equal(quotePlan.result.markdown, quoteExpectedSource)
  assert.equal(quotePlan.proof.containerType, 'blockquote')
  assert.deepEqual(quotePlan.proof.listPath, [1, 1])
  assert.equal(quotePlan.proof.quoteChildIndex, 1)
  assert.equal(quotePlan.proof.callbackDocumentEquivalent, false)
  assert.equal(quotePlan.proof.transactionProvenTransientEquivalent, true)
  assert.deepEqual(quotePlan.proof.removedPath, [1, 1, 2])
  assert.deepEqual(quotePlan.proof.transientEmptyListItemPath, [1, 1, 1])
  assert.deepEqual(quotePlan.proof.transientEmptyParagraphPath, [1, 1, 1, 1])
  assert.equal(quotePlan.proof.removedSourceRow.prefix, '> ')
  assert.equal(quotePlan.proof.removedSourceRow.token, '3.')
  assert.equal(quotePlan.result.markdown.includes('> 3. <br />'), false)
  assert.equal(quotePlan.result.markdown.charCodeAt(0), 0xFEFF)
  assert.equal(quotePlan.result.markdown.includes('\r\n'), true)
}

const interiorOld = document(
  paragraph('before'),
  bullet(item(paragraph('left')), item(paragraph()), item(paragraph('right'))),
  paragraph('after')
)
const interiorExpected = document(
  paragraph('before'),
  bullet(item(paragraph('left'), paragraph()), item(paragraph('right'))),
  paragraph('after')
)
const interiorSnapshot = createSourceSyncSnapshot({ revision: 153, source, canonical: previous, doc: interiorOld })
const interiorTx = {
  ...fakeTransaction,
  before: interiorOld,
  doc: interiorExpected,
  docs: [interiorOld],
  steps: [{ ...step, apply: () => ({ doc: interiorExpected }) }]
}
const interiorCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: interiorSnapshot,
  transactions: [interiorTx],
  oldDoc: interiorOld,
  newDoc: interiorExpected
})
const interiorPlan = owner.plan({
  journal: interiorCapture.checkpoint,
  activeJournal: interiorCapture.checkpoint,
  snapshot: interiorSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: interiorExpected,
  callbackDocumentEquivalent: true
})
assert.equal(interiorPlan.ok, false)
assert.equal(interiorPlan.recognized, false, 'interior empty-item removal stays outside tail family')

const taskOld = document(paragraph('before'), bullet(item(paragraph('left')), taskItem(false, paragraph())), paragraph('after'))
const taskExpected = document(paragraph('before'), bullet(item(paragraph('left'), paragraph())), paragraph('after'))
const taskSnapshot = createSourceSyncSnapshot({ revision: 154, source, canonical: previous, doc: taskOld })
const taskTx = { ...fakeTransaction, before: taskOld, doc: taskExpected, docs: [taskOld], steps: [{ ...step, apply: () => ({ doc: taskExpected }) }] }
const taskCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: taskSnapshot,
  transactions: [taskTx],
  oldDoc: taskOld,
  newDoc: taskExpected
})
const taskPlan = owner.plan({
  journal: taskCapture.checkpoint,
  activeJournal: taskCapture.checkpoint,
  snapshot: taskSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: taskExpected,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false, 'task tail removal stays outside plain family')

const mixedOrderedOld = document(
  paragraph('before'),
  bullet(
    semanticItem({ listType: 'bullet', label: '•' }, paragraph('left')),
    semanticItem({ listType: 'ordered', label: '1.' }, paragraph())
  ),
  paragraph('after')
)
const mixedOrderedExpected = document(
  paragraph('before'),
  bullet(semanticItem({ listType: 'bullet', label: '•' }, paragraph('left'), paragraph())),
  paragraph('after')
)
const mixedOrderedSnapshot = createSourceSyncSnapshot({
  revision: 1541,
  source,
  canonical: previous,
  doc: mixedOrderedOld
})
const mixedOrderedTx = {
  ...fakeTransaction,
  before: mixedOrderedOld,
  doc: mixedOrderedExpected,
  docs: [mixedOrderedOld],
  steps: [{ ...step, apply: () => ({ doc: mixedOrderedExpected }) }]
}
const mixedOrderedCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: mixedOrderedSnapshot,
  transactions: [mixedOrderedTx],
  oldDoc: mixedOrderedOld,
  newDoc: mixedOrderedExpected
})
assert.equal(mixedOrderedCapture.ok, true)
const mixedOrderedPlan = owner.plan({
  journal: mixedOrderedCapture.checkpoint,
  activeJournal: mixedOrderedCapture.checkpoint,
  snapshot: mixedOrderedSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: mixedOrderedExpected,
  callbackDocumentEquivalent: true
})
assert.equal(mixedOrderedPlan.ok, false)
assert.equal(mixedOrderedPlan.recognized, false,
  'explicit ordered item inside bullet container belongs to ordered lift family, not plain tail owner')

const nestedOld = document(
  paragraph('before'),
  bullet(item(paragraph('left'), bullet(item(paragraph('nested')))), item(paragraph())),
  paragraph('after')
)
const nestedExpected = document(
  paragraph('before'),
  bullet(item(paragraph('left'), bullet(item(paragraph('nested'))), paragraph())),
  paragraph('after')
)
const nestedSnapshot = createSourceSyncSnapshot({ revision: 155, source, canonical: previous, doc: nestedOld })
const nestedTx = {
  ...fakeTransaction,
  before: nestedOld,
  doc: nestedExpected,
  docs: [nestedOld],
  steps: [{ ...step, apply: () => ({ doc: nestedExpected }) }]
}
const nestedCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: nestedSnapshot,
  transactions: [nestedTx],
  oldDoc: nestedOld,
  newDoc: nestedExpected
})
const nestedPlan = owner.plan({
  journal: nestedCapture.checkpoint,
  activeJournal: nestedCapture.checkpoint,
  snapshot: nestedSnapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc: nestedExpected,
  callbackDocumentEquivalent: true
})
assert.equal(nestedPlan.ok, false)
assert.equal(nestedPlan.recognized, false, 'tail removal after nested structure stays outside the plain tail family')

const sourceWithBody = source.replace('- \r\n', '- authored\r\n')
const bodySnapshot = createSourceSyncSnapshot({ revision: 156, source: sourceWithBody, canonical: previous, doc: oldDoc })
const bodyCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: bodySnapshot,
  transactions: [fakeTransaction],
  oldDoc,
  newDoc: expectedDoc
})
const bodyPlan = owner.plan({
  journal: bodyCapture.checkpoint,
  activeJournal: bodyCapture.checkpoint,
  snapshot: bodySnapshot,
  currentSource: sourceWithBody,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(bodyPlan.ok, false)
assert.equal(bodyPlan.recognized, true, 'PM-owned tail family must block legacy when authored tail row has body')

const looseSource = '\uFEFFbefore\r\n\r\n- left\r\n\r\n- \r\n\r\nafter\r\n'
const looseSnapshot = createSourceSyncSnapshot({ revision: 157, source: looseSource, canonical: previous, doc: oldDoc })
const looseCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot: looseSnapshot,
  transactions: [fakeTransaction],
  oldDoc,
  newDoc: expectedDoc
})
const loosePlan = owner.plan({
  journal: looseCapture.checkpoint,
  activeJournal: looseCapture.checkpoint,
  snapshot: looseSnapshot,
  currentSource: looseSource,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(loosePlan.ok, false)
assert.equal(loosePlan.recognized, true, 'loose authored tail rows must fail closed after PM family recognition')
assert.equal(loosePlan.reason, 'list-empty-item-tail-authored-row-unproven')

const badStep = { ...step, from: step.from - 1, apply: () => ({ doc: expectedDoc }) }
const badTx = { ...fakeTransaction, steps: [badStep] }
const badCapture = journalFactory.captureOrAdvance({
  checkpoint: null,
  snapshot,
  transactions: [badTx],
  oldDoc,
  newDoc: expectedDoc
})
const badPlan = owner.plan({
  journal: badCapture.checkpoint,
  activeJournal: badCapture.checkpoint,
  snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical,
  expectedDoc,
  callbackDocumentEquivalent: true
})
assert.equal(badPlan.ok, false)
assert.equal(badPlan.recognized, true)
assert.equal(badPlan.reason, 'list-empty-item-tail-step-range')

assert.throws(
  () => createListEmptyItemTailRemoveTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
console.log('PASS list empty-item tail remove transaction owner: exact final plain empty item Backspace owns one structural wrapper-boundary ReplaceStep, deletes only the authored tail marker row while preserving BOM/CRLF, and keeps interior/task/loose/source-mismatch/wrong-step cases outside or fail closed')
