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
  LIST_NESTED_BULLET_SPLIT_TRANSACTION_BOUNDARY,
  LIST_NESTED_BULLET_SPLIT_TRANSACTION_FAMILY,
  createListNestedBulletSplitTransactionSourceSyncOwner
} from '../src/renderer/src/lib/source-sync/list-nested-bullet-split-transaction-owner.js'

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

const captureSplit = (oldDoc, paragraphPath, splitOffset) => {
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, paragraphPath)
  const state = EditorState.create({
    schema,
    doc: oldDoc,
    selection: TextSelection.create(oldDoc, paragraphEntry.contentStart + splitOffset)
  })
  let transaction = null
  const handled = splitListItem(schema.nodes.list_item)(state, (value) => { transaction = value })
  return { handled, transaction, paragraphEntry }
}
const captureJournal = ({ source, canonical, oldDoc, transaction, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc, owner: 'fixture', family: 'fixture' })
  const journal = createSourceSyncTransactionJournal()
  const captured = journal.captureOrAdvance({ checkpoint: null, snapshot, transactions: [transaction], oldDoc, newDoc: transaction.doc })
  assert.equal(captured.ok, true, captured.reason)
  return { snapshot, checkpoint: captured.checkpoint }
}
const planFor = ({ oldDoc, paragraphPath, splitOffset, source, previous, canonical, expectedSource, revision, rawNeedle = null }) => {
  const split = captureSplit(oldDoc, paragraphPath, splitOffset)
  assert.equal(split.handled, true)
  assert.ok(split.transaction)
  const capture = captureJournal({ source, canonical: previous, oldDoc, transaction: split.transaction, revision })
  const owner = createListNestedBulletSplitTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ pmPos, markdown }) => pmPos === split.paragraphEntry.contentStart
      ? markdown.indexOf(rawNeedle || split.paragraphEntry.node.textContent)
      : -1,
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

const oldDoc = document(
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

const middleExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + ga\r\n  + mma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const middle = planFor({
  oldDoc,
  paragraphPath: [1, 1, 1, 0, 0],
  splitOffset: 2,
  source,
  previous,
  canonical: 'middle-canonical',
  expectedSource: middleExpected,
  revision: 162
})
assert.equal(middle.plan.ok, true, JSON.stringify(middle.plan))
assert.equal(middle.plan.family, LIST_NESTED_BULLET_SPLIT_TRANSACTION_FAMILY)
assert.equal(middle.plan.boundary, LIST_NESTED_BULLET_SPLIT_TRANSACTION_BOUNDARY)
assert.equal(middle.plan.result.reason, 'list-nested-bullet-item-split')
assert.equal(middle.plan.result.markdown, middleExpected)
assert.equal(middle.plan.proof.splitOffset, 2)
assert.equal(middle.plan.proof.leftText, 'ga')
assert.equal(middle.plan.proof.rightText, 'mma')
assert.equal(middle.plan.proof.sourceRow.token, '+')
assert.equal(middle.plan.proof.sourceRow.eol, '\r\n')
assert.equal(middle.plan.proof.step.name, 'ReplaceStep')
assert.equal(middle.plan.proof.step.sliceSize, 4)
assert.equal(middle.plan.proof.step.openStart, 2)
assert.equal(middle.plan.proof.step.openEnd, 2)
assert.equal(middle.split.transaction.steps[0].from, middle.split.paragraphEntry.contentStart + 2)

const endExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + \r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const end = planFor({
  oldDoc,
  paragraphPath: [1, 1, 1, 0, 0],
  splitOffset: 5,
  source,
  previous,
  canonical: 'end-canonical',
  expectedSource: endExpected,
  revision: 163
})
assert.equal(end.plan.ok, true, JSON.stringify(end.plan))
assert.equal(end.plan.proof.leftText, 'gamma')
assert.equal(end.plan.proof.rightText, '')
assert.equal(end.plan.result.markdown, endExpected)

const escapedOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('1. literal'), bulletItem('delta'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const escapedSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + 1\\. literal\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const escapedExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + 1\\. literal\r\n  + \r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
const escaped = planFor({
  oldDoc: escapedOld,
  paragraphPath: [1, 1, 1, 0, 0],
  splitOffset: '1. literal'.length,
  source: escapedSource,
  previous: 'escaped-previous',
  canonical: 'escaped-canonical',
  expectedSource: escapedExpected,
  revision: 164,
  rawNeedle: '1\\. literal'
})
assert.equal(escaped.plan.ok, true, JSON.stringify(escaped.plan))
assert.equal(escaped.plan.proof.previousText, '1. literal')
assert.equal(escaped.plan.proof.sourceRow.body, '1\\. literal')
assert.equal(escaped.plan.proof.sourceRow.rawSplitOffset, '1\\. literal'.length)
assert.equal(escaped.plan.result.markdown, escapedExpected)

const threeOld = document(
  paragraph('before'),
  bulletList(
    bulletItem('alpha'),
    bulletItem('beta', [bulletList(bulletItem('gamma'), bulletItem('delta'), bulletItem('epsilon'))]),
    bulletItem('omega')
  ),
  paragraph('after')
)
const threeSource = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n  + epsilon\r\n+ omega\r\n\r\nafter\r\n'
const threeExpected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + de\r\n  + lta\r\n  + epsilon\r\n+ omega\r\n\r\nafter\r\n'
const middleIndex = planFor({
  oldDoc: threeOld,
  paragraphPath: [1, 1, 1, 1, 0],
  splitOffset: 2,
  source: threeSource,
  previous: 'three-previous',
  canonical: 'three-canonical',
  expectedSource: threeExpected,
  revision: 165
})
assert.equal(middleIndex.plan.ok, true, JSON.stringify(middleIndex.plan))
assert.equal(middleIndex.plan.proof.targetIndex, 1)
assert.equal(middleIndex.plan.proof.leftText, 'de')
assert.equal(middleIndex.plan.proof.rightText, 'lta')

const looseSource = source.replace('  + gamma', '  +  gamma')
const looseSplit = captureSplit(oldDoc, [1, 1, 1, 0, 0], 2)
const looseCapture = captureJournal({ source: looseSource, canonical: previous, oldDoc, transaction: looseSplit.transaction, revision: 166 })
const looseOwner = createListNestedBulletSplitTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ pmPos, markdown }) => pmPos === looseSplit.paragraphEntry.contentStart ? markdown.indexOf('gamma') : -1,
  validateMarkdown: () => true
})
const loosePlan = looseOwner.plan({
  journal: looseCapture.checkpoint,
  activeJournal: looseCapture.checkpoint,
  snapshot: looseCapture.snapshot,
  currentSource: looseSource,
  currentCanonical: previous,
  canonical: 'loose-canonical',
  expectedDoc: looseSplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(loosePlan.ok, false)
assert.equal(loosePlan.recognized, true)
assert.equal(loosePlan.reason, 'nested-bullet-split-source-row-unproven')

const wrongStep = {
  constructor: { name: 'ReplaceStep' },
  from: middle.split.transaction.steps[0].from + 1,
  to: middle.split.transaction.steps[0].to + 1,
  structure: true,
  slice: middle.split.transaction.steps[0].slice,
  apply: () => ({ doc: middle.split.transaction.doc })
}
const wrongTx = {
  docChanged: true,
  before: oldDoc,
  doc: middle.split.transaction.doc,
  docs: [oldDoc],
  steps: [wrongStep],
  mapping: { maps: [{ map: (position) => position }] }
}
const wrongCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: wrongTx, revision: 167 })
const wrongPlan = middle.owner.plan({
  journal: wrongCapture.checkpoint,
  activeJournal: wrongCapture.checkpoint,
  snapshot: wrongCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'wrong-canonical',
  expectedDoc: middle.split.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(wrongPlan.ok, false)
assert.equal(wrongPlan.recognized, true)
assert.equal(wrongPlan.reason, 'nested-bullet-split-step-range')

const startSplit = captureSplit(oldDoc, [1, 1, 1, 0, 0], 0)
assert.equal(startSplit.handled, true)
const startCapture = captureJournal({ source, canonical: previous, oldDoc, transaction: startSplit.transaction, revision: 168 })
const startOwner = createListNestedBulletSplitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0, validateMarkdown: () => true })
const startPlan = startOwner.plan({
  journal: startCapture.checkpoint,
  activeJournal: startCapture.checkpoint,
  snapshot: startCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'start-canonical',
  expectedDoc: startSplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(startPlan.ok, false)
assert.equal(startPlan.recognized, false)

const taskOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [bulletList(taskItem('gamma'), bulletItem('delta'))])),
  paragraph('after')
)
const taskSplit = captureSplit(taskOld, [1, 1, 1, 0, 0], 2)
assert.equal(taskSplit.handled, true)
const taskCapture = captureJournal({ source, canonical: previous, oldDoc: taskOld, transaction: taskSplit.transaction, revision: 169 })
const taskPlan = startOwner.plan({
  journal: taskCapture.checkpoint,
  activeJournal: taskCapture.checkpoint,
  snapshot: taskCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'task-canonical',
  expectedDoc: taskSplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(taskPlan.ok, false)
assert.equal(taskPlan.recognized, false)

const orderedOld = document(
  paragraph('before'),
  bulletList(bulletItem('alpha'), bulletItem('beta', [orderedList(orderedItem('1.', 'gamma'), orderedItem('2.', 'delta'))])),
  paragraph('after')
)
const orderedSplit = captureSplit(orderedOld, [1, 1, 1, 0, 0], 2)
assert.equal(orderedSplit.handled, true)
const orderedCapture = captureJournal({ source, canonical: previous, oldDoc: orderedOld, transaction: orderedSplit.transaction, revision: 170 })
const orderedPlan = startOwner.plan({
  journal: orderedCapture.checkpoint,
  activeJournal: orderedCapture.checkpoint,
  snapshot: orderedCapture.snapshot,
  currentSource: source,
  currentCanonical: previous,
  canonical: 'ordered-canonical',
  expectedDoc: orderedSplit.transaction.doc,
  callbackDocumentEquivalent: true
})
assert.equal(orderedPlan.ok, false)
assert.equal(orderedPlan.recognized, false)

// E0 P3b (0.13.180 trace 09:47): Chinese IME commit into the target nested
// item followed by an IMMEDIATE Enter is one journal — text ReplaceSteps
// inside the target paragraph, then the terminal splitListItem. The owner
// must prove the chain and publish the same bounded row patch.
{
  const paragraphPath = [1, 1, 1, 0, 0]
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, paragraphPath)
  let state = EditorState.create({ schema, doc: oldDoc })
  const transactions = []
  // IME-shaped composition: replace the whole word progressively —
  // "gamma" → "ga" (composition) → "gab" (commit), all inside the target.
  transactions.push(state.tr.insertText('ga', paragraphEntry.contentStart, paragraphEntry.contentStart + 5))
  state = state.apply(transactions[0])
  transactions.push(state.tr.insertText('b', paragraphEntry.contentStart + 2))
  state = state.apply(transactions[1])
  const split = captureSplit(state.doc, paragraphPath, 3)
  assert.equal(split.handled, true)
  transactions.push(split.transaction)
  const journal = createSourceSyncTransactionJournal()
  let checkpoint = null
  let currentDoc = oldDoc
  for (const transaction of transactions) {
    const captured = journal.captureOrAdvance({
      checkpoint,
      snapshot: createSourceSyncSnapshot({
        revision: 171,
        source,
        canonical: previous,
        doc: oldDoc,
        owner: 'fixture',
        family: 'fixture'
      }),
      transactions: [transaction],
      oldDoc: currentDoc,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, captured.reason)
    checkpoint = captured.checkpoint
    currentDoc = transaction.doc
  }
  const expectedDoc = split.transaction.doc
  const chainSnapshot = createSourceSyncSnapshot({
    revision: 171,
    source,
    canonical: previous,
    doc: oldDoc,
    owner: 'fixture',
    family: 'fixture'
  })
  // Final texts: "gab" | "" (split at end after the IME replacement).
  const chainExpected = '﻿before\r\n\r\n+ alpha\r\n+ beta\r\n  + gab\r\n  + \r\n  + delta\r\n+ omega\r\n\r\nafter\r\n'
  const chainOwner = createListNestedBulletSplitTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ pmPos, markdown }) =>
      pmPos === sourceSyncNodeEntryAtPath(oldDoc, paragraphPath).contentStart
        ? markdown.indexOf('gamma')
        : -1,
    validateMarkdown: ({ markdown, expectedDoc: doc }) =>
      markdown === chainExpected && doc.eq(expectedDoc)
  })
  const chainPlan = chainOwner.plan({
    journal: checkpoint,
    activeJournal: checkpoint,
    snapshot: chainSnapshot,
    currentSource: source,
    currentCanonical: previous,
    canonical: 'chain-canonical',
    expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(chainPlan.ok, true, JSON.stringify(chainPlan))
  assert.equal(chainPlan.result.markdown, chainExpected)
  assert.deepEqual(chainPlan.proof.pendingTextChain, { textStepCount: 2, textTransactionCount: 2 })
  assert.equal(chainPlan.proof.leftText, 'gab')
  assert.equal(chainPlan.proof.rightText, '')

  // Negative: a text step OUTSIDE the target paragraph (sibling item) must
  // stay fail-closed instead of being swallowed into the chain.
  const outsideState = EditorState.create({ schema, doc: oldDoc })
  const outsideTransactions = []
  const siblingEntry = sourceSyncNodeEntryAtPath(oldDoc, [1, 0, 0])
  outsideTransactions.push(outsideState.tr.insertText('X', siblingEntry.contentStart))
  const outsideSplit = captureSplit(
    outsideState.apply(outsideTransactions[0]).doc,
    paragraphPath,
    2
  )
  assert.equal(outsideSplit.handled, true)
  outsideTransactions.push(outsideSplit.transaction)
  const outsideJournal = createSourceSyncTransactionJournal()
  let outsideCheckpoint = null
  let outsideDocCursor = oldDoc
  for (const transaction of outsideTransactions) {
    const captured = outsideJournal.captureOrAdvance({
      checkpoint: outsideCheckpoint,
      snapshot: createSourceSyncSnapshot({
        revision: 172,
        source,
        canonical: previous,
        doc: oldDoc,
        owner: 'fixture',
        family: 'fixture'
      }),
      transactions: [transaction],
      oldDoc: outsideDocCursor,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, captured.reason)
    outsideCheckpoint = captured.checkpoint
    outsideDocCursor = transaction.doc
  }
  const outsidePlan = chainOwner.plan({
    journal: outsideCheckpoint,
    activeJournal: outsideCheckpoint,
    snapshot: createSourceSyncSnapshot({
      revision: 172,
      source,
      canonical: previous,
      doc: oldDoc,
      owner: 'fixture',
      family: 'fixture'
    }),
    currentSource: source,
    currentCanonical: previous,
    canonical: 'outside-canonical',
    expectedDoc: outsideSplit.transaction.doc,
    callbackDocumentEquivalent: true
  })
  assert.equal(outsidePlan.ok, false)
  // A foreign text step means the journal is NOT this family's shape — a
  // plain rejection so legacy stays available (the blockquote families hit
  // this same branch with quote-paragraph text + a slice-2 split).
  assert.equal(outsidePlan.recognized, false)
  assert.equal(outsidePlan.reason, 'nested-bullet-split-text-outside-target-paragraph')
}

assert.throws(
  () => createListNestedBulletSplitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('PASS nested bullet split transaction owner: middle/end splitListItem uses one exact ReplaceStep at paragraph contentStart+splitOffset, raw byte boundary preserves authored backslash escapes while inserting only EOL+indent+marker+spacing; middle nested index works, unsafe row/wrong Step fail closed, start/task/ordered remain separate; IME pending-text + terminal Enter chain publishes the same bounded patch while foreign text steps fail closed')
