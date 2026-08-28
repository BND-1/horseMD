import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  BLOCKQUOTE_SPLIT_TRANSACTION_BOUNDARY,
  BLOCKQUOTE_SPLIT_TRANSACTION_FAMILY,
  createBlockquoteSplitTransactionSourceSyncOwner,
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
const paragraph = (value = '', role = '') => schema.nodes.paragraph.create(
  { role }, value ? text(value) : null
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

const topLevelStart = (doc, targetIndex) => {
  let result = null
  doc.forEach((_node, offset, index) => {
    if (index === targetIndex) result = offset
  })
  assert.notEqual(result, null)
  return result
}

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

const paragraphTextStartAtPath = (doc, quotePath, paragraphIndex = 0) => {
  const quoteStart = nodeBeforePosAtPath(doc, quotePath)
  let quoteNode = doc
  for (const index of quotePath) quoteNode = quoteNode.child(index)
  let childOffset = 0
  for (let index = 0; index < paragraphIndex; index += 1) {
    childOffset += quoteNode.child(index).nodeSize
  }
  return quoteStart + 2 + childOffset
}

const paragraphTextStart = (doc, topLevelIndex, paragraphIndex = 0) =>
  paragraphTextStartAtPath(doc, [topLevelIndex], paragraphIndex)

const journalFactory = createSourceSyncTransactionJournal()
const createOwner = (validateMarkdown = () => true) =>
  createBlockquoteSplitTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
      pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
    validateMarkdown
  })

const capture = ({ source, canonical, oldDoc, transactions, revision = 60 }) => {
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
  revision = 60,
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
  const source = '\uFEFFbefore\r\n\r\n  >   alpha\r\n\r\nafter\r\n'
  const canonical = 'before\n\n> alpha\n\nafter\n'
  const oldDoc = document(paragraph('before'), quote('alpha'), paragraph('after'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 1) + 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [split],
    nextCanonical: 'before\n\n> al\n>\n> pha\n\nafter\n'
  })
  assert.equal(plan.ok, true, `main split rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, BLOCKQUOTE_SPLIT_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, BLOCKQUOTE_SPLIT_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'blockquote-paragraph-split')
  assert.equal(
    plan.result.markdown,
    '\uFEFFbefore\r\n\r\n  >   al\r\n  >\r\n  >   pha\r\n\r\nafter\r\n'
  )
  assert.equal(plan.proof.kind, 'transaction-blockquote-split-proof')
  assert.equal(plan.proof.splitIndex, 0)
  assert.equal(plan.proof.splitOffset, 2)
  assert.equal(plan.proof.leftText, 'al')
  assert.equal(plan.proof.rightText, 'pha')
  assert.equal(plan.proof.prefix, '  >   ')
  assert.equal(plan.proof.blankPrefix, '  >')
  assert.equal(plan.proof.eol, '\r\n')
  assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep'])
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  let state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0) + 2)
  state = state.apply(split)
  const rightStart = paragraphTextStart(state.doc, 0, 1)
  const followup = state.tr.insertText('XY', rightStart)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split, followup],
    nextCanonical: '> al\n>\n> XYpha\n',
    revision: 61
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.result.markdown, '> al\n>\n> XYpha\n')
  assert.equal(plan.proof.chainLength, 2)
  assert.equal(plan.proof.rightText, 'XYpha')
}

{
  const source = '\uFEFF# nested\r\n\r\n- authored bullet\r\n\r\n  >   quotedalpha\r\n\r\n- following bullet\r\n'
  const canonical = '# nested\n\n* authored bullet\n\n  > quotedalpha\n\n* following bullet\n\n'
  const quotePath = [1, 0, 1]
  const oldDoc = document(
    heading('nested'),
    bulletList([
      listItem([paragraph('authored bullet'), quote('quotedalpha')]),
      listItem('following bullet')
    ])
  )
  let state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStartAtPath(oldDoc, quotePath) + 6)
  state = state.apply(split)
  const followup = state.tr.insertText(
    'XY',
    paragraphTextStartAtPath(state.doc, quotePath, 1)
  )
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [split, followup],
    nextCanonical: '# nested\n\n* authored bullet\n\n  > quoted\n  >\n  > XYalpha\n\n* following bullet\n\n',
    revision: 62
  })
  assert.equal(plan.ok, true, `nested split rejected: ${JSON.stringify(plan)}`)
  assert.deepEqual(plan.proof.nodePath, quotePath)
  assert.equal(
    plan.result.markdown,
    '\uFEFF# nested\r\n\r\n- authored bullet\r\n\r\n  >   quoted\r\n  >\r\n  >   XYalpha\r\n\r\n- following bullet\r\n'
  )
}

{
  const source = '> first\n>\n> second\n'
  const oldDoc = document(quote([paragraph('first'), paragraph('second')]))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0, 1) + 3)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split],
    nextCanonical: '> first\n>\n> sec\n>\n> ond\n',
    revision: 62
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.result.markdown, '> first\n>\n> sec\n>\n> ond\n')
  assert.equal(plan.proof.splitIndex, 1)
}

for (const [label, offset] of [['start', 0], ['end', 5]]) {
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0) + offset)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split],
    nextCanonical: label === 'start' ? '>\n>\n> alpha\n' : '> alpha\n>\n>\n',
    revision: 63 + offset
  })
  assert.equal(plan.ok, false)
  assert.equal(
    ['blockquote-split-target-count', 'blockquote-split-structural-shape'].includes(plan.reason),
    true,
    `${label} split was not rejected narrowly: ${plan.reason}`
  )
}

{
  const source = '> alpha\n\nafter\n'
  const oldDoc = document(quote('alpha'), paragraph('after'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr
    .split(paragraphTextStart(oldDoc, 0) + 2)
    .insertText('!', topLevelStart(oldDoc, 1) + 1 + 'after'.length + 2)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split],
    nextCanonical: '> al\n>\n> pha\n\nafter!\n',
    revision: 70
  })
  assert.equal(plan.reason, 'blockquote-split-top-level-change-count')
}

{
  const source = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr
    .split(paragraphTextStart(oldDoc, 0) + 2)
    .insertText('!', paragraphTextStart(oldDoc, 0, 1) + 2 + 1)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split],
    nextCanonical: '> al\n>\n> pha\n>\n> beta!\n',
    revision: 71
  })
  assert.equal(
    ['blockquote-split-target-count', 'blockquote-split-followup-outside-owned-paragraphs'].includes(plan.reason),
    true
  )
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  let state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0) + 2)
  state = state.apply(split)
  const strong = schema.marks.strong.create()
  const mark = state.tr.addMark(paragraphTextStart(state.doc, 0, 1), paragraphTextStart(state.doc, 0, 1) + 3, strong)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split, mark],
    nextCanonical: '> al\n>\n> **pha**\n',
    revision: 72
  })
  assert.equal(
    ['blockquote-split-target-count', 'blockquote-split-step-not-replace'].includes(plan.reason),
    true
  )
}

{
  const source = '- holder\n\n  > alpha\n\n  > beta\n'
  const canonical = '* holder\n\n  > alpha\n\n  > beta\n\n'
  const firstPath = [0, 0, 1]
  const secondPath = [0, 0, 2]
  const oldDoc = document(bulletList([
    listItem([paragraph('holder'), quote('alpha'), quote('beta')])
  ]))
  let state = EditorState.create({ schema, doc: oldDoc })
  const firstSplit = state.tr.split(paragraphTextStartAtPath(oldDoc, firstPath) + 2)
  state = state.apply(firstSplit)
  const secondSplit = state.tr.split(paragraphTextStartAtPath(state.doc, secondPath) + 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [firstSplit, secondSplit],
    nextCanonical: '* holder\n\n  > al\n  >\n  > pha\n\n  > be\n  >\n  > ta\n\n',
    revision: 73
  })
  assert.equal(plan.reason, 'blockquote-split-anchored-target-count')
  assert.equal(plan.proof?.candidateCount, 0)
}

{
  const source = '> wrong\n'
  const canonical = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0) + 2)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [split],
    nextCanonical: '> al\n>\n> pha\n',
    revision: 73
  })
  assert.equal(plan.reason, 'blockquote-split-raw-text-mismatch')
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0) + 2)
  const { plan } = planFor({
    source,
    canonical: source,
    oldDoc,
    transactions: [split],
    nextCanonical: '> al\n>\n> pha\n',
    revision: 74,
    validateMarkdown: () => false
  })
  assert.equal(plan.reason, 'blockquote-split-semantic-document-mismatch')
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const split = state.tr.split(paragraphTextStart(oldDoc, 0) + 2)
  const captured = capture({
    source,
    canonical: source,
    oldDoc,
    transactions: [split],
    revision: 75
  })
  const owner = createOwner()
  assert.equal(owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: source,
    canonical: '> al\n>\n> pha\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  }).reason, 'blockquote-split-callback-document-mismatch')

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 76,
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
    canonical: '> al\n>\n> pha\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

assert.throws(
  () => createBlockquoteSplitTransactionSourceSyncOwner({}),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createBlockquoteSplitTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)

console.log('PASS blockquote split transaction owner: journal-proven middle Enter and rapid follow-up patch one authored quote line while BOM/CRLF/prefix/neighbours survive and empty, cross-child, marks, mismatch, semantic and stale cases fail closed')
