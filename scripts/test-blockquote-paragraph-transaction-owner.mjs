import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY,
  BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
  createBlockquoteParagraphTransactionSourceSyncOwner,
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
  { role },
  value ? text(value) : null
)
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
const quote = (children, kind = '') => schema.nodes.blockquote.create(
  { kind },
  Array.isArray(children) ? children : [paragraph(children)]
)
const item = (value) => schema.nodes.list_item.create(null, paragraph(value))
const listItem = (children) => schema.nodes.list_item.create(
  null,
  Array.isArray(children) ? children : [paragraph(children)]
)
const bulletList = (items) => schema.nodes.bullet_list.create(null, items)
const list = (value) => bulletList([item(value)])
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

const paragraphTextPosAtPath = (doc, quotePath, paragraphIndex = 0) => {
  const quoteStart = nodeBeforePosAtPath(doc, quotePath)
  let quoteNode = doc
  for (const index of quotePath) quoteNode = quoteNode.child(index)
  let childOffset = 0
  for (let index = 0; index < paragraphIndex; index += 1) {
    childOffset += quoteNode.child(index).nodeSize
  }
  return quoteStart + 2 + childOffset
}

const directParagraphTextPos = (doc, topLevelIndex, paragraphIndex = 0) =>
  paragraphTextPosAtPath(doc, [topLevelIndex], paragraphIndex)

const owner = createBlockquoteParagraphTransactionSourceSyncOwner({
  resolveMarkdownOffset: ({ markdown, pmPos, doc }) =>
    pmPosToMarkdownOffset(markdown, pmPos, doc, remark),
  validateMarkdown: () => true
})
const journalFactory = createSourceSyncTransactionJournal()

const capture = ({ source, canonical, oldDoc, transactions, revision = 40 }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc })
  let checkpoint = null
  let currentDoc = oldDoc
  for (const transaction of transactions) {
    const nextDoc = transaction.doc
    const captured = journalFactory.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: [transaction],
      oldDoc: currentDoc,
      newDoc: nextDoc
    })
    assert.equal(captured.ok, true)
    checkpoint = captured.checkpoint
    currentDoc = nextDoc
  }
  return { snapshot, journal: checkpoint, expectedDoc: currentDoc }
}

const planFor = ({
  source,
  canonical = source.replace(/\r\n|\r/g, '\n').replace(/^\uFEFF/, ''),
  oldDoc,
  transactions,
  nextCanonical,
  revision = 40,
  callbackDocumentEquivalent = true
}) => {
  const captured = capture({ source, canonical, oldDoc, transactions, revision })
  return {
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
  let state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 1)
  const first = state.tr.insertText('X', pos + 5)
  state = state.apply(first)
  const second = state.tr.insertText('Y', pos + 6)
  state = state.apply(second)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [first, second],
    nextCanonical: 'before\n\n> alphaXY\n\nafter\n'
  })
  assert.equal(plan.ok, true, `main quote plan rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY)
  assert.equal(plan.boundary, BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY)
  assert.equal(plan.result.reason, 'blockquote-paragraph-text-change')
  assert.equal(plan.result.markdown, source.replace('alpha', 'alphaXY'))
  assert.equal(plan.proof.kind, 'transaction-blockquote-paragraph-proof')
  assert.equal(plan.proof.topLevelIndex, 1)
  assert.equal(plan.proof.paragraphIndex, 0)
  assert.equal(plan.proof.chainLength, 2)
  assert.deepEqual(plan.proof.transactionJournal.stepNames, ['ReplaceStep', 'ReplaceStep'])
  assert.equal(plan.result.markdown.startsWith('\uFEFF'), true)
  assert.equal(plan.result.markdown.includes('\r\n'), true)
  assert.equal(plan.result.markdown.includes('  >   alphaXY'), true)
}

{
  const source = '- authored\n\n  >   nested alpha\n\n- following\n'
  const canonical = '* authored\n\n  > nested alpha\n\n* following\n\n'
  const quotePath = [0, 0, 1]
  const oldDoc = document(bulletList([
    listItem([paragraph('authored'), quote('nested alpha')]),
    listItem('following')
  ]))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = paragraphTextPosAtPath(oldDoc, quotePath)
  const transaction = state.tr.insertText('X', pos + 'nested alpha'.length)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '* authored\n\n  > nested alphaX\n\n* following\n\n',
    revision: 41
  })
  assert.equal(plan.ok, true, `nested quote text rejected: ${JSON.stringify(plan)}`)
  assert.deepEqual(plan.proof.nodePath, quotePath)
  assert.equal(plan.result.markdown, source.replace('nested alpha', 'nested alphaX'))
}

{
  const source = '> same\n\nmiddle\n\n> same\n'
  const oldDoc = document(quote('same'), paragraph('middle'), quote('same'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 2)
  const transaction = state.tr.insertText('!', pos + 4)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> same\n\nmiddle\n\n> same!\n',
    revision: 41
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.result.markdown, '> same\n\nmiddle\n\n> same!\n')
  assert.equal(plan.proof.topLevelIndex, 2)
}

{
  const source = '> alpha\n>\n> beta\n'
  const canonical = source
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0, 1)
  const transaction = state.tr.insertText('X', pos + 2, pos + 4)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> alpha\n>\n> beX\n',
    revision: 42
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.result.markdown, '> alpha\n>\n> beX\n')
  assert.equal(plan.proof.paragraphIndex, 1)
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0)
  const emptied = state.tr.delete(pos, pos + 5)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [emptied],
    nextCanonical: '> <br />\n',
    revision: 43
  })
  assert.equal(plan.reason, 'blockquote-paragraph-not-simple-nonempty')
}

{
  const source = '> alpha\n>\n> beta\n'
  const oldDoc = document(quote([paragraph('alpha'), paragraph('beta')]))
  const state = EditorState.create({ schema, doc: oldDoc })
  const firstPos = directParagraphTextPos(oldDoc, 0, 0)
  const secondPos = directParagraphTextPos(oldDoc, 0, 1)
  const transaction = state.tr
    .insertText('X', firstPos + 'alpha'.length)
    .insertText('Y', secondPos + 'beta'.length + 1)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> alphaX\n>\n> betaY\n',
    revision: 44
  })
  assert.equal(plan.reason, 'blockquote-paragraph-change-count')
  assert.equal(plan.recognized, false)
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0)
  const split = state.tr.split(pos + 2)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [split],
    nextCanonical: '> al\n>\n> pha\n',
    revision: 45
  })
  assert.equal(plan.reason, 'blockquote-paragraph-child-count-changed')
}

{
  const source = '> alpha\n\nafter\n'
  const oldDoc = document(quote('alpha'), paragraph('after'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const quotePos = directParagraphTextPos(oldDoc, 0)
  const afterPos = topLevelStart(oldDoc, 1) + 1
  const transaction = state.tr
    .insertText('X', quotePos + 5)
    .insertText('!', afterPos + 5 + 1)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> alphaX\n\nafter!\n',
    revision: 46
  })
  assert.equal(plan.reason, 'blockquote-paragraph-top-level-change-count')
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0)
  const strong = schema.marks.strong.create()
  const transaction = state.tr.addMark(pos, pos + 5, strong)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> **alpha**\n',
    revision: 47
  })
  assert.equal(plan.reason, 'blockquote-paragraph-not-simple-nonempty')
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote([heading('alpha')]))
  const state = EditorState.create({ schema, doc: oldDoc })
  let textPos = null
  oldDoc.descendants((node, pos) => {
    if (textPos == null && node.isText) textPos = pos
  })
  const transaction = state.tr.insertText('X', textPos + 5)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> # alphaX\n',
    revision: 48
  })
  assert.equal(plan.reason, 'blockquote-paragraph-not-simple-nonempty')
}

{
  const source = '- holder\n\n  > alpha\n\n  > beta\n'
  const canonical = '* holder\n\n  > alpha\n\n  > beta\n\n'
  const firstPath = [0, 0, 1]
  const secondPath = [0, 0, 2]
  const oldDoc = document(bulletList([
    listItem([paragraph('holder'), quote('alpha'), quote('beta')])
  ]))
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = state.tr
    .insertText('X', paragraphTextPosAtPath(oldDoc, firstPath) + 'alpha'.length)
    .insertText('Y', paragraphTextPosAtPath(oldDoc, secondPath) + 'beta'.length + 1)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '* holder\n\n  > alphaX\n\n  > betaY\n\n',
    revision: 49
  })
  assert.equal(plan.reason, 'blockquote-paragraph-anchored-target-count')
  assert.equal(plan.proof?.candidateCount, 0)
}

{
  const source = '> wrong\n'
  const canonical = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0)
  const transaction = state.tr.insertText('X', pos + 5)
  const { plan } = planFor({
    source,
    canonical,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> alphaX\n',
    revision: 49
  })
  assert.equal(plan.reason, 'raw-block-text-mismatch')
  assert.equal(plan.recognized, true)
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0)
  const transaction = state.tr.insertText('*', pos + 5)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> alpha\\*\n',
    revision: 50
  })
  assert.equal(plan.reason, 'syntax-sensitive-insert')
  assert.equal(plan.recognized, true)
}

{
  const source = '> alpha\n'
  const oldDoc = document(quote('alpha'))
  const state = EditorState.create({ schema, doc: oldDoc })
  const pos = directParagraphTextPos(oldDoc, 0)
  const transaction = state.tr.insertText('X', pos + 5)
  const captured = capture({
    source,
    canonical: source,
    oldDoc,
    transactions: [transaction],
    revision: 51
  })
  assert.equal(owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: source,
    canonical: '> alphaX\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: false
  }).reason, 'blockquote-paragraph-callback-document-mismatch')

  const staleSnapshot = createSourceSyncSnapshot({
    revision: 52,
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
    canonical: '> alphaX\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.reason, 'transaction-journal-revision-stale')
  assert.equal(stale.reset, true)
}

{
  const source = '> - item\n'
  const oldDoc = document(quote([list('item')]))
  const state = EditorState.create({ schema, doc: oldDoc })
  let textPos = null
  oldDoc.descendants((node, pos) => {
    if (textPos == null && node.isText) textPos = pos
  })
  const transaction = state.tr.insertText('X', textPos + 4)
  const { plan } = planFor({
    source,
    oldDoc,
    transactions: [transaction],
    nextCanonical: '> * itemX\n',
    revision: 53
  })
  assert.equal(plan.reason, 'blockquote-paragraph-not-simple-nonempty')
}

console.log('PASS blockquote paragraph transaction owner: one direct non-empty plain paragraph maps by PM ReplaceStep while prefix/BOM/EOL survive and empty, split, marks, nested, multi-paragraph, neighbour, syntax, mismatch and stale cases fail closed')
