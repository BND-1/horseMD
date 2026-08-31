import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import { createSourceSyncSnapshot, createSourceSyncTransactionJournal } from '../src/renderer/src/lib/source-sync/index.js'
import { provePendingTextTransactionChain } from '../src/renderer/src/lib/source-sync/pending-text-transaction-chain.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)
const journalFactory = createSourceSyncTransactionJournal()

const capture = ({ oldDoc, transactions, revision = 1 }) => {
  const source = 'fixture\n'
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical: source, doc: oldDoc })
  let checkpoint = null
  let currentDoc = oldDoc
  for (const transaction of transactions) {
    const captured = journalFactory.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: [transaction],
      oldDoc: currentDoc,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, captured.reason)
    checkpoint = captured.checkpoint
    currentDoc = transaction.doc
  }
  return { checkpoint, expectedDoc: currentDoc }
}

{
  const oldDoc = document(paragraph('alpha'))
  let state = EditorState.create({ schema, doc: oldDoc })
  const first = state.tr.insertText('x', 6)
  state = state.apply(first)
  const second = state.tr.insertText('中文', 6, 7)
  state = state.apply(second)
  const terminal = state.tr.split(8)
  state = state.apply(terminal)
  const captured = capture({ oldDoc, transactions: [first, second, terminal] })
  const proof = provePendingTextTransactionChain({
    journal: captured.checkpoint,
    expectedDoc: captured.expectedDoc,
    reasonPrefix: 'test-chain',
    requireTerminal: true,
    matchTerminalStep: ({ step }) => ({
      matched: step?.constructor?.name === 'ReplaceStep' && step.structure === true,
      proof: { kind: 'paragraph-split' }
    }),
    validateTextChain: ({ textSteps, terminal: terminalProof, preTerminalDocument }) => ({
      ok: textSteps.length === 2 &&
        terminalProof?.proof?.kind === 'paragraph-split' &&
        preTerminalDocument.textContent === 'alpha中文',
      proof: { target: [0] }
    })
  })
  assert.equal(proof.ok, true, JSON.stringify(proof))
  assert.equal(proof.textStepCount, 2)
  assert.equal(proof.textReplacementStepCount, 1)
  assert.equal(proof.textTransactionCount, 2)
  assert.equal(proof.preTerminalTransactionCount, 2)
  assert.equal(proof.terminal.stepProof.structure, true)
  assert.deepEqual(proof.targetProof, { target: [0] })
}

{
  const oldDoc = document(paragraph('x'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const deleted = state.tr.delete(1, 2)
  const captured = capture({ oldDoc, transactions: [deleted], revision: 2 })
  const proof = provePendingTextTransactionChain({
    journal: captured.checkpoint,
    expectedDoc: captured.expectedDoc,
    reasonPrefix: 'delete-empty',
    validateTextChain: ({ textSteps, preTerminalDocument }) => ({
      ok: textSteps.length === 1 && preTerminalDocument.firstChild.content.size === 0
    })
  })
  assert.equal(proof.ok, true, JSON.stringify(proof))
  assert.equal(proof.terminal, null)
  assert.equal(proof.textReplacementStepCount, 1)
}

{
  const oldDoc = document(paragraph('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const mixed = state.tr.insertText('x', 6).split(7)
  const captured = capture({ oldDoc, transactions: [mixed], revision: 3 })
  const proof = provePendingTextTransactionChain({
    journal: captured.checkpoint,
    expectedDoc: captured.expectedDoc,
    reasonPrefix: 'mixed-terminal',
    requireTerminal: true,
    matchTerminalStep: ({ step }) => ({ matched: step?.structure === true })
  })
  assert.equal(proof.ok, false)
  assert.equal(proof.reason, 'mixed-terminal-terminal-transaction-shape')
}

{
  const oldDoc = document(paragraph('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(3)
  const captured = capture({ oldDoc, transactions: [split], revision: 4 })
  const proof = provePendingTextTransactionChain({
    journal: captured.checkpoint,
    expectedDoc: captured.expectedDoc,
    reasonPrefix: 'unmatched-structure',
    matchTerminalStep: () => ({ matched: false })
  })
  assert.equal(proof.ok, false)
  assert.equal(proof.reason, 'unmatched-structure-pre-terminal-step-contract')
}

{
  const oldDoc = document(paragraph('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const inserted = state.tr.insertText('x', 6)
  const captured = capture({ oldDoc, transactions: [inserted], revision: 5 })
  const proof = provePendingTextTransactionChain({
    journal: captured.checkpoint,
    expectedDoc: captured.expectedDoc,
    reasonPrefix: 'target-reject',
    validateTextChain: () => ({ ok: false, reason: 'target-path-mismatch' })
  })
  assert.equal(proof.ok, false)
  assert.equal(proof.reason, 'target-path-mismatch')
}

console.log('PASS pending text transaction chain: multi-transaction IME-style text/replacement + terminal structure, delete-to-empty, terminal isolation and target validation stay fail-closed')
