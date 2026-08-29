import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { baseKeymap } from '@milkdown/prose/commands'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  BLOCKQUOTE_EXIT_TRANSACTION_BOUNDARY,
  BLOCKQUOTE_EXIT_TRANSACTION_FAMILY,
  createBlockquoteExitTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', attrs: { role: { default: '' } } },
    blockquote: { content: 'block+', group: 'block', attrs: { kind: { default: '' } } },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})

const remark = unified().use(remarkParse)
const text = (value, marks = null) => value ? schema.text(value, marks) : null
const paragraph = (value = '', role = '', marks = null) => schema.nodes.paragraph.create(
  { role }, value ? text(value, marks) : null
)
const quote = (children, kind = '') => schema.nodes.blockquote.create(
  { kind }, Array.isArray(children) ? children : [paragraph(children)]
)
const listItem = (children) => schema.nodes.list_item.create(
  null,
  Array.isArray(children) ? children : [paragraph(children)]
)
const bulletList = (items) => schema.nodes.bullet_list.create(null, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const nodeBeforePosAtPath = (doc, path) => {
  let parent = doc
  let beforePos = 0
  for (let depth = 0; depth < path.length; depth += 1) {
    const index = path[depth]
    let childOffset = 0
    for (let sibling = 0; sibling < index; sibling += 1) {
      childOffset += parent.child(sibling).nodeSize
    }
    beforePos = depth === 0 ? childOffset : beforePos + 1 + childOffset
    parent = parent.child(index)
  }
  return beforePos
}

const nodeAtPath = (doc, path) => {
  let node = doc
  for (const index of path) node = node.child(index)
  return node
}

const lastQuoteParagraphTextEnd = (doc, quotePath) => {
  const quoteNode = nodeAtPath(doc, quotePath)
  let childOffset = 0
  for (let index = 0; index < quoteNode.childCount - 1; index += 1) {
    childOffset += quoteNode.child(index).nodeSize
  }
  const paragraphNode = quoteNode.lastChild
  return nodeBeforePosAtPath(doc, quotePath) + 2 + childOffset + paragraphNode.textContent.length
}

const runEnter = (state) => {
  let transaction = null
  assert.equal(baseKeymap.Enter(state, (value) => { transaction = value }), true)
  assert.ok(transaction)
  return { transaction, state: state.apply(transaction) }
}

const exitAndType = ({ oldDoc, quotePath, value = 'XY' }) => {
  let state = EditorState.create({
    schema,
    doc: oldDoc,
    selection: TextSelection.create(oldDoc, lastQuoteParagraphTextEnd(oldDoc, quotePath))
  })
  const first = runEnter(state)
  state = first.state
  const second = runEnter(state)
  state = second.state
  const followup = state.tr.insertText(value, state.selection.from)
  state = state.apply(followup)
  return {
    first: first.transaction,
    second: second.transaction,
    followup,
    firstDoc: first.transaction.doc,
    secondDoc: second.transaction.doc,
    finalDoc: state.doc,
    transactions: [first.transaction, second.transaction, followup]
  }
}

const journalFactory = createSourceSyncTransactionJournal()
const createOwner = (validateMarkdown = () => true) =>
  createBlockquoteExitTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown
  })

const capture = ({ source, canonical, oldDoc, transactions, revision = 100 }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc })
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
    assert.equal(captured.ok, true)
    checkpoint = captured.checkpoint
    currentDoc = transaction.doc
  }
  return { snapshot, journal: checkpoint, expectedDoc: currentDoc }
}

const planFor = ({
  source,
  canonical,
  oldDoc,
  transactions,
  nextCanonical,
  revision = 100,
  validateMarkdown = () => true,
  callbackDocumentEquivalent = true
}) => {
  const captured = capture({ source, canonical, oldDoc, transactions, revision })
  const owner = createOwner(validateMarkdown)
  return {
    owner,
    ...captured,
    plan: owner.plan({
      journal: captured.journal,
      activeJournal: captured.journal,
      snapshot: captured.snapshot,
      currentSource: source,
      currentCanonical: canonical,
      canonical: nextCanonical,
      expectedDoc: captured.expectedDoc,
      callbackDocumentEquivalent
    })
  }
}

const topSource = '\uFEFFbefore\r\n\r\n>   alpha\r\n\r\nafter\r\n'
const topCanonical = 'before\n\n> alpha\n\nafter\n'
const topNextCanonical = 'before\n\n> alpha\n\nXY\n\nafter\n'
const topExpected = '\uFEFFbefore\r\n\r\n>   alpha\r\n\r\nXY\r\n\r\nafter\r\n'
const topDoc = document(paragraph('before'), quote('alpha'), paragraph('after'))
const topExit = exitAndType({ oldDoc: topDoc, quotePath: [1] })

{
  const pendingCanonical = 'before\n\n> alpha\n>\n\nafter\n'
  const { plan } = planFor({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: [topExit.first],
    nextCanonical: pendingCanonical,
    revision: 99
  })
  assert.equal(plan.ok, true, `top pending rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.reason, 'trailing-empty-blockquote-paragraph-created')
  assert.equal(plan.result.markdown, topSource)
  assert.equal(plan.proof.kind, 'transaction-blockquote-exit-pending-proof')
  assert.equal(plan.proof.mode, 'pending')
  assert.deepEqual(plan.proof.nodePath, [1])
  assert.equal(plan.proof.splitStepName, 'ReplaceStep')
  assert.equal(plan.proof.splitStructure, true)
  assert.equal(plan.proof.chainLength, 1)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep'])
}

{
  const { plan } = planFor({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: topExit.transactions,
    nextCanonical: topNextCanonical
  })
  assert.equal(plan.ok, true, `coalesced top exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, BLOCKQUOTE_EXIT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, BLOCKQUOTE_EXIT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'blockquote-paragraph-exit')
  assert.equal(plan.result.markdown, topExpected)
  assert.equal(plan.proof.kind, 'transaction-blockquote-exit-proof')
  assert.equal(plan.proof.mode, 'coalesced')
  assert.deepEqual(plan.proof.parentPath, [])
  assert.deepEqual(plan.proof.nodePath, [1])
  assert.deepEqual(plan.proof.insertedPath, [2])
  assert.equal(plan.proof.parentType, 'doc')
  assert.equal(plan.proof.splitStepName, 'ReplaceStep')
  assert.equal(plan.proof.exitStepName, 'ReplaceAroundStep')
  assert.equal(plan.proof.splitStructure, true)
  assert.equal(plan.proof.exitStructure, true)
  assert.equal(plan.proof.exitedText, 'XY')
  assert.equal(plan.proof.quotePrefix, '>   ')
  assert.equal(plan.proof.exitedPrefix, '')
  assert.equal(plan.proof.eol, '\r\n')
  assert.equal(plan.proof.chainLength, 3)
  assert.deepEqual(
    plan.proof.transactionJournal.stepNames,
    ['ReplaceStep', 'ReplaceAroundStep', 'ReplaceStep']
  )
}

{
  const stagedCanonical = 'before\n\n> alpha\n>\n\nafter\n'
  const { plan } = planFor({
    source: topSource,
    canonical: stagedCanonical,
    oldDoc: topExit.firstDoc,
    transactions: [topExit.second, topExit.followup],
    nextCanonical: topNextCanonical,
    revision: 101
  })
  assert.equal(plan.ok, true, `staged top exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.mode, 'staged')
  assert.equal(plan.proof.splitStepName, null)
  assert.equal(plan.proof.exitStepName, 'ReplaceAroundStep')
  assert.equal(plan.proof.chainLength, 2)
  assert.equal(plan.result.markdown, topExpected)
}

const nestedSource = '\uFEFF# nested\r\n\r\n- holder\r\n\r\n  >   alpha\r\n\r\n- following\r\n'
const nestedCanonical = '# nested\n\n* holder\n\n  > alpha\n\n* following\n\n'
const nestedNextCanonical = '# nested\n\n* holder\n\n  > alpha\n\n  XY\n\n* following\n\n'
const nestedExpected = '\uFEFF# nested\r\n\r\n- holder\r\n\r\n  >   alpha\r\n\r\n  XY\r\n\r\n- following\r\n'
const nestedPath = [1, 0, 1]
const nestedDoc = document(
  paragraph('nested'),
  bulletList([
    listItem([paragraph('holder'), quote('alpha')]),
    listItem('following')
  ])
)
const nestedExit = exitAndType({ oldDoc: nestedDoc, quotePath: nestedPath })

{
  const pendingCanonical = '# nested\n\n* holder\n\n  > alpha\n  >\n\n* following\n\n'
  const { plan } = planFor({
    source: nestedSource,
    canonical: nestedCanonical,
    oldDoc: nestedDoc,
    transactions: [nestedExit.first],
    nextCanonical: pendingCanonical,
    revision: 1015
  })
  assert.equal(plan.ok, true, `nested pending rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.result.reason, 'trailing-empty-blockquote-paragraph-created')
  assert.equal(plan.result.markdown, nestedSource)
  assert.equal(plan.proof.kind, 'transaction-blockquote-exit-pending-proof')
  assert.deepEqual(plan.proof.nodePath, nestedPath)
  assert.equal(plan.proof.chainLength, 1)
}

{
  const { plan } = planFor({
    source: nestedSource,
    canonical: nestedCanonical,
    oldDoc: nestedDoc,
    transactions: nestedExit.transactions,
    nextCanonical: nestedNextCanonical,
    revision: 102
  })
  assert.equal(plan.ok, true, `coalesced nested exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.mode, 'coalesced')
  assert.deepEqual(plan.proof.parentPath, [1, 0])
  assert.deepEqual(plan.proof.nodePath, nestedPath)
  assert.deepEqual(plan.proof.insertedPath, [1, 0, 2])
  assert.equal(plan.proof.parentType, 'list_item')
  assert.equal(plan.proof.quotePrefix, '  >   ')
  assert.equal(plan.proof.exitedPrefix, '  ')
  assert.equal(plan.result.markdown, nestedExpected)
}

{
  const stagedCanonical = '# nested\n\n* holder\n\n  > alpha\n  >\n\n* following\n\n'
  const { plan } = planFor({
    source: nestedSource,
    canonical: stagedCanonical,
    oldDoc: nestedExit.firstDoc,
    transactions: [nestedExit.second, nestedExit.followup],
    nextCanonical: nestedNextCanonical,
    revision: 103
  })
  assert.equal(plan.ok, true, `staged nested exit rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.mode, 'staged')
  assert.deepEqual(plan.proof.nodePath, nestedPath)
  assert.equal(plan.result.markdown, nestedExpected)
}

{
  const noText = exitAndType({ oldDoc: topDoc, quotePath: [1], value: '' })
  const { plan } = planFor({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: [noText.first, noText.second],
    nextCanonical: 'before\n\n> alpha\n\n<br />\n\nafter\n',
    revision: 104
  })
  assert.equal(plan.reason, 'blockquote-exit-target-count')
  assert.equal(plan.recognized, false)
}

{
  const strong = schema.marks.strong.create()
  const markedDoc = document(
    paragraph('before'),
    quote(paragraph('alpha', '', [strong])),
    paragraph('after')
  )
  const exited = exitAndType({ oldDoc: markedDoc, quotePath: [1] })
  const { plan } = planFor({
    source: '\uFEFFbefore\r\n\r\n>   **alpha**\r\n\r\nafter\r\n',
    canonical: 'before\n\n> **alpha**\n\nafter\n',
    oldDoc: markedDoc,
    transactions: exited.transactions,
    nextCanonical: 'before\n\n> **alpha**\n\nXY\n\nafter\n',
    revision: 105
  })
  assert.equal(plan.reason, 'blockquote-exit-target-count')
}

{
  let state = EditorState.create({ schema, doc: topDoc })
  const exit = exitAndType({ oldDoc: topDoc, quotePath: [1] })
  state = state.apply(exit.first)
  state = state.apply(exit.second)
  state = state.apply(exit.followup)
  const neighbour = state.tr.insertText(
    '!',
    nodeBeforePosAtPath(state.doc, [3]) + 1 + 'after'.length
  )
  const { plan } = planFor({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: [...exit.transactions, neighbour],
    nextCanonical: 'before\n\n> alpha\n\nXY\n\nafter!\n',
    revision: 106
  })
  assert.equal(plan.reason, 'blockquote-exit-target-count')
}

{
  const unsupportedDoc = document(quote([
    paragraph('outer'),
    quote('alpha')
  ]))
  const exit = exitAndType({ oldDoc: unsupportedDoc, quotePath: [0, 1] })
  const { plan } = planFor({
    source: '> outer\n>\n> > alpha\n',
    canonical: '> outer\n>\n> > alpha\n',
    oldDoc: unsupportedDoc,
    transactions: exit.transactions,
    nextCanonical: '> outer\n>\n> > alpha\n>\n> XY\n',
    revision: 107
  })
  assert.equal(plan.reason, 'blockquote-exit-target-count')
}

{
  const { plan } = planFor({
    source: topSource.replace('alpha', 'wrong'),
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: topExit.transactions,
    nextCanonical: topNextCanonical,
    revision: 108
  })
  assert.equal(
    ['blockquote-exit-range-unmapped', 'blockquote-exit-raw-text-mismatch'].includes(plan.reason),
    true,
    `source mismatch was not rejected: ${plan.reason}`
  )
  assert.equal(plan.recognized, true)
}

{
  const { plan } = planFor({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: topExit.transactions,
    nextCanonical: topNextCanonical,
    revision: 109,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'blockquote-exit-semantic-document-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const { plan } = planFor({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: topExit.transactions,
    nextCanonical: topNextCanonical,
    revision: 110,
    validateMarkdown: () => { throw new Error('validator') }
  })
  assert.equal(plan.reason, 'blockquote-exit-semantic-validator-threw')
}

{
  const captured = capture({
    source: topSource,
    canonical: topCanonical,
    oldDoc: topDoc,
    transactions: topExit.transactions,
    revision: 111
  })
  const owner = createOwner()
  assert.equal(owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: topSource,
    currentCanonical: topCanonical,
    canonical: topNextCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  }).reason, 'blockquote-exit-callback-document-mismatch')

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 112,
    source: topSource,
    canonical: topCanonical,
    doc: captured.expectedDoc
  })
  const stale = owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: staleSnapshot,
    currentSource: topSource,
    currentCanonical: topCanonical,
    canonical: topNextCanonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(
  () => createBlockquoteExitTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createBlockquoteExitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)

console.log('PASS blockquote exit transaction owner: real two-Enter coalesced/staged journals lift one trailing empty quote paragraph, carry rapid text, preserve top/nested authored prefix/BOM/CRLF/neighbours, and reject empty, marked, neighbour, unsupported, mismatched, semantic and stale cases')
