import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { joinBackward } from '@milkdown/prose/commands'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { ReplaceStep } from '@milkdown/prose/transform'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  BLOCKQUOTE_JOIN_TRANSACTION_BOUNDARY,
  BLOCKQUOTE_JOIN_TRANSACTION_FAMILY,
  createBlockquoteJoinTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', attrs: { role: { default: '' } } },
    heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } },
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
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
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

const paragraphTextStartAtPath = (doc, quotePath, paragraphIndex) => {
  const quoteStart = nodeBeforePosAtPath(doc, quotePath)
  let quoteNode = doc
  for (const index of quotePath) quoteNode = quoteNode.child(index)
  let childOffset = 0
  for (let index = 0; index < paragraphIndex; index += 1) {
    childOffset += quoteNode.child(index).nodeSize
  }
  return quoteStart + 2 + childOffset
}

const joinAt = (doc, quotePath, rightIndex) => {
  const selection = TextSelection.create(
    doc,
    paragraphTextStartAtPath(doc, quotePath, rightIndex)
  )
  const state = EditorState.create({ schema, doc, selection })
  let transaction = null
  assert.equal(joinBackward(state, (value) => { transaction = value }), true)
  assert.ok(transaction)
  return transaction
}

const journalFactory = createSourceSyncTransactionJournal()
const createOwner = (validateMarkdown = () => true) =>
  createBlockquoteJoinTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown
  })

const capture = ({ source, canonical, oldDoc, transactions, revision = 80 }) => {
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
  canonical = source.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n'),
  oldDoc,
  transactions,
  nextCanonical,
  revision = 80,
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

{
  const source = '\uFEFFbefore\r\n\r\n  >   alpha\r\n  > \r\n  > beta\r\n\r\nafter\r\n'
  const canonical = 'before\n\n> alpha\n>\n> beta\n\nafter\n'
  const oldDoc = document(paragraph('before'), quote([
    paragraph('alpha'),
    paragraph('beta')
  ]), paragraph('after'))
  let state = EditorState.create({ schema, doc: oldDoc })
  const join = joinAt(oldDoc, [1], 1)
  state = state.apply(join)
  const followup = state.tr.insertText('XY', join.selection.from)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [join, followup],
    nextCanonical: 'before\n\n> alphaXYbeta\n\nafter\n'
  })
  assert.equal(plan.ok, true, `main join rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, BLOCKQUOTE_JOIN_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, BLOCKQUOTE_JOIN_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'blockquote-paragraph-join')
  assert.equal(
    plan.result.markdown,
    '\uFEFFbefore\r\n\r\n  >   alphaXYbeta\r\n\r\nafter\r\n'
  )
  assert.equal(plan.proof.kind, 'transaction-blockquote-join-proof')
  assert.deepEqual(plan.proof.nodePath, [1])
  assert.equal(plan.proof.rightIndex, 1)
  assert.equal(plan.proof.joinStepName, 'ReplaceStep')
  assert.equal(plan.proof.joinStructure, true)
  assert.equal(plan.proof.joinTo - plan.proof.joinFrom, 2)
  assert.equal(plan.proof.leftText, 'alpha')
  assert.equal(plan.proof.rightText, 'beta')
  assert.equal(plan.proof.mergedText, 'alphaXYbeta')
  assert.equal(plan.proof.leftPrefix, '  >   ')
  assert.equal(plan.proof.blankPrefix, '  > ')
  assert.equal(plan.proof.rightPrefix, '  > ')
  assert.equal(plan.proof.eol, '\r\n')
  assert.equal(plan.proof.chainLength, 2)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep', 'ReplaceStep'])
}

{
  const source = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const state = EditorState.create({
    schema,
    doc: oldDoc,
    selection: TextSelection.create(oldDoc, paragraphTextStartAtPath(oldDoc, [0], 1))
  })
  let commandTransaction = null
  assert.equal(joinBackward(state, (value) => { commandTransaction = value }), true)
  const originalStep = commandTransaction.steps[0]
  const transaction = state.tr.step(new ReplaceStep(
    originalStep.from,
    originalStep.to,
    originalStep.slice,
    false
  ))
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> alphabeta\n',
    revision: 801
  })
  assert.equal(plan.ok, true, `non-structural join rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.joinStructure, false)
  assert.equal(plan.result.markdown, '> alphabeta\n')
}

{
  const source = '\uFEFF# nested\r\n\r\n- authored bullet\r\n\r\n  >   quoted\r\n  >\r\n  >   alpha\r\n\r\n- following bullet\r\n'
  const canonical = '# nested\n\n* authored bullet\n\n  > quoted\n  >\n  > alpha\n\n* following bullet\n\n'
  const quotePath = [1, 0, 1]
  const oldDoc = document(
    heading('nested'),
    bulletList([
      listItem([paragraph('authored bullet'), quote([
        paragraph('quoted'),
        paragraph('alpha')
      ])]),
      listItem('following bullet')
    ])
  )
  const join = joinAt(oldDoc, quotePath, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [join],
    nextCanonical: '# nested\n\n* authored bullet\n\n  > quotedalpha\n\n* following bullet\n\n',
    revision: 81
  })
  assert.equal(plan.ok, true, `nested join rejected: ${JSON.stringify(plan)}`)
  assert.deepEqual(plan.proof.nodePath, quotePath)
  assert.equal(
    plan.result.markdown,
    '\uFEFF# nested\r\n\r\n- authored bullet\r\n\r\n  >   quotedalpha\r\n\r\n- following bullet\r\n'
  )
}

{
  const source = '> first\n>\n> second\n>\n> third\n'
  const oldDoc = document(quote([
    paragraph('first'),
    paragraph('second'),
    paragraph('third')
  ]))
  const join = joinAt(oldDoc, [0], 2)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [join],
    nextCanonical: '> first\n>\n> secondthird\n',
    revision: 82
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.result.markdown, '> first\n>\n> secondthird\n')
  assert.equal(plan.proof.rightIndex, 2)
}

{
  const source = '> alpha\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const join = joinAt(oldDoc, [0], 1)
  const { plan } = planFor({
    source,
    canonical: '> alpha\n>\n> beta\n',
    oldDoc,
    transactions: [join],
    nextCanonical: '> alphabeta\n',
    revision: 83
  })
  assert.equal(plan.ok, false)
  assert.equal(
    [
      'blockquote-join-range-unmapped',
      'blockquote-join-raw-text-mismatch',
      'blockquote-join-separator-shape'
    ].includes(plan.reason),
    true,
    `missing quote separator was not rejected: ${plan.reason}`
  )
  assert.equal(plan.recognized, true)
}

{
  const strong = schema.marks.strong.create()
  const source = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([
    paragraph('alpha'),
    paragraph('beta', '', [strong])
  ]))
  const join = joinAt(oldDoc, [0], 1)
  const { plan } = planFor({
    source,
    canonical: '> alpha\n>\n> **beta**\n',
    oldDoc,
    transactions: [join],
    nextCanonical: '> alpha**beta**\n',
    revision: 84
  })
  assert.equal(plan.reason, 'blockquote-join-target-count')
}

{
  const source = '> alpha\n>\n> beta\n\nafter\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]), paragraph('after'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const join = joinAt(oldDoc, [0], 1)
  const joined = state.apply(join)
  const neighbour = joined.tr.insertText(
    '!',
    nodeBeforePosAtPath(joined.doc, [1]) + 1 + 'after'.length
  )
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [join, neighbour],
    nextCanonical: '> alphabeta\n\nafter!\n',
    revision: 85
  })
  assert.equal(plan.reason, 'blockquote-join-top-level-change-count')
}

{
  const source = '- holder\n\n  > alpha\n  >\n  > beta\n\n  > gamma\n  >\n  > delta\n'
  const canonical = '* holder\n\n  > alpha\n  >\n  > beta\n\n  > gamma\n  >\n  > delta\n\n'
  const firstPath = [0, 0, 1]
  const secondPath = [0, 0, 2]
  const oldDoc = document(bulletList([
    listItem([
      paragraph('holder'),
      quote([paragraph('alpha'), paragraph('beta')]),
      quote([paragraph('gamma'), paragraph('delta')])
    ])
  ]))
  let state = EditorState.create({ schema, doc: oldDoc })
  const firstJoin = joinAt(oldDoc, firstPath, 1)
  state = state.apply(firstJoin)
  const secondJoin = joinAt(state.doc, secondPath, 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [firstJoin, secondJoin],
    nextCanonical: '* holder\n\n  > alphabeta\n\n  > gammadelta\n\n',
    revision: 86
  })
  assert.equal(plan.reason, 'blockquote-join-anchored-target-count')
}

{
  const source = '> wrong\n>\n> beta\n'
  const canonical = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const join = joinAt(oldDoc, [0], 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [join],
    nextCanonical: '> alphabeta\n',
    revision: 87
  })
  assert.equal(plan.reason, 'blockquote-join-raw-text-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const source = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const join = joinAt(oldDoc, [0], 1)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [join],
    nextCanonical: '> alphabeta\n',
    revision: 88,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'blockquote-join-semantic-document-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const source = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const join = joinAt(oldDoc, [0], 1)
  const captured = capture({
    source,
    canonical: source,
    oldDoc,
    transactions: [join],
    revision: 89
  })
  const owner = createOwner()
  assert.equal(owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: source,
    canonical: '> alphabeta\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  }).reason, 'blockquote-join-callback-document-mismatch')

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 90,
    source,
    canonical: source,
    doc: captured.expectedDoc
  })
  const stale = owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: staleSnapshot,
    currentSource: source,
    currentCanonical: source,
    canonical: '> alphabeta\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(
  () => createBlockquoteJoinTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createBlockquoteJoinTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)

console.log('PASS blockquote join transaction owner: real joinBackward journal removes one authored quote separator, preserves stable nested paths/BOM/CRLF/prefix/neighbours, carries safe rapid text, and rejects ambiguous, marked, malformed, mismatched, semantic and stale cases')
