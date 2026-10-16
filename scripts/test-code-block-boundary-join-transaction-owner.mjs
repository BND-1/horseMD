import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import {
  CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_BOUNDARY,
  CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY,
  createCodeBlockBoundaryJoinTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true
    },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value) : null
)
// A CRLF document keeps its CR characters inside the ProseMirror code text —
// this is exactly what trace-23324 carried (`排最后\r\n输出完全吻合。`).
const codeBlock = (value = '') => schema.nodes.code_block.create(
  { language: '' },
  value ? schema.text(value) : null
)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const beforeAtIndex = (doc, index) => {
  let offset = 0
  for (let current = 0; current < index; current += 1) offset += doc.child(current).nodeSize
  return offset
}

// Real Backspace-at-paragraph-start merge: deleting the boundary between a
// code block (left) and the paragraph after it (right) collapses the pair and
// appends the paragraph text to the code block's last line.
const mergeTransaction = (doc, { paragraphIndex, deleteCount = 2 } = {}) => {
  const boundary = beforeAtIndex(doc, paragraphIndex)
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, boundary + 1)
  })
  const tr = state.tr
  // Deleting the code_block's closing token + the paragraph's opening token
  // (exactly the trace-23324 replace 1205..1207) joins the paragraph text
  // onto the code block's last line.
  tr.delete(boundary + 1 - deleteCount, boundary + 1)
  tr.setSelection(TextSelection.create(tr.doc, boundary + 1 - deleteCount))
  return tr
}

const captureJournal = ({ oldDoc, transactions, source, canonical, revision }) => {
  const snapshot = createSourceSyncSnapshot({ revision, source, canonical, doc: oldDoc })
  const factory = createSourceSyncTransactionJournal()
  let checkpoint = null
  let current = oldDoc
  for (const transaction of transactions) {
    const captured = factory.captureOrAdvance({
      checkpoint,
      snapshot,
      transactions: [transaction],
      oldDoc: current,
      newDoc: transaction.doc
    })
    assert.equal(captured.ok, true, `journal capture failed: ${JSON.stringify(captured)}`)
    checkpoint = captured.checkpoint
    current = transaction.doc
  }
  return { snapshot, journal: checkpoint, expectedDoc: current }
}

const planFor = ({
  oldDoc,
  transactions,
  source,
  canonicalBaseline,
  canonical,
  revision,
  resolver,
  validateMarkdown,
  callbackDocumentEquivalent = true
}) => {
  const captured = captureJournal({
    oldDoc,
    transactions,
    source,
    canonical: canonicalBaseline,
    revision
  })
  const owner = createCodeBlockBoundaryJoinTransactionSourceSyncOwner({
    resolveMarkdownOffset: resolver,
    validateMarkdown
  })
  return owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonicalBaseline,
    canonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent,
    boundary: CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_BOUNDARY
  })
}

// ---------------------------------------------------------------------------
// 1. code-absorbs-paragraph, CRLF source (trace-23324 shape)
// ---------------------------------------------------------------------------
{
  const codeText = 'line one\r\nchu-hai   → 大于所有大写首字母，排最后'
  const paragraphText = '输出完全吻合。'
  const oldDoc = document(paragraph('前文'), codeBlock(codeText), paragraph(paragraphText), paragraph('后续'))
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 2 })
  const source = '前文\r\n\r\n```\r\nline one\r\nchu-hai   → 大于所有大写首字母，排最后\r\n```\r\n\r\n输出完全吻合。\r\n\r\n后续\r\n'
  const canonicalBaseline = '前文\n\n```\nline one\nchu-hai   → 大于所有大写首字母，排最后\n```\n\n输出完全吻合。\n\n后续\n'
  const canonical = '前文\n\n```\nline one\nchu-hai   → 大于所有大写首字母，排最后输出完全吻合。\n```\n\n后续\n'
  const expectedSource = '前文\r\n\r\n```\r\nline one\r\nchu-hai   → 大于所有大写首字母，排最后输出完全吻合。\r\n```\r\n\r\n后续\r\n'
  const plan = planFor({
    oldDoc,
    transactions: [merged],
    source,
    canonicalBaseline,
    canonical,
    revision: 2001,
    resolver: ({ markdown, pmPos }) => {
      const anchor = markdown.indexOf('输出完全吻合')
      return pmPos > 20 ? anchor : markdown.indexOf('chu-hai')
    },
    validateMarkdown: ({ markdown, expectedDoc }) =>
      markdown === expectedSource && expectedDoc.eq(merged.doc)
  })
  assert.equal(plan.ok, true, `CRLF code-absorbs-paragraph rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.owner, 'transaction')
  assert.equal(plan.family, CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY)
  assert.equal(plan.result.reason, CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY)
  assert.equal(plan.result.markdown, expectedSource)
  assert.equal(plan.proof.mode, 'code-absorbs-paragraph')
  assert.equal(plan.proof.initialText, codeText + paragraphText)
  assert.equal(plan.proof.finalText, codeText + paragraphText)
  // The authored CRLF bytes survive: every LF is preceded by a CR.
  for (let index = 0; index < plan.result.markdown.length; index += 1) {
    if (plan.result.markdown[index] === '\n') {
      assert.equal(plan.result.markdown[index - 1], '\r')
    }
  }
  assert.equal(plan.proof.patch.eol, '\r\n')
}
console.log('ok 1 code-absorbs-paragraph CRLF')

// ---------------------------------------------------------------------------
// 2. paragraph-absorbs-code (Delete at code start merges code into paragraph)
// ---------------------------------------------------------------------------
{
  const paragraphText = '前文'
  const codeText = 'alpha\nbeta'
  const oldDoc = document(paragraph(paragraphText), codeBlock(codeText), paragraph('后续'))
  // The code block is the RIGHT node of the boundary pair → paragraphIndex 1.
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 1 })
  const source = '前文\r\n\r\n```\r\nalpha\r\nbeta\r\n```\r\n\r\n后续\r\n'
  const canonicalBaseline = '前文\n\n```\nalpha\nbeta\n```\n\n后续\n'
  const mergedParagraph = merged.doc.child(0)
  let mergedText = ''
  for (let i = 0; i < mergedParagraph.childCount; i += 1) mergedText += mergedParagraph.child(i).text || ''
  assert.equal(mergedParagraph.type.name, 'paragraph')
  // PM keeps the code's newline INSIDE the merged paragraph text; the patch
  // must rewrite it with the paragraph line's authored EOL (CRLF stays CRLF).
  const canonical = `前文${mergedText}\n\n后续\n`
  const expectedSource = `${mergedText}\r\n\r\n后续\r\n`.replace(/\r\n|\r|\n/g, '\r\n')
  const plan = planFor({
    oldDoc,
    transactions: [merged],
    source,
    canonicalBaseline,
    canonical,
    revision: 2002,
    resolver: ({ markdown }) => markdown.indexOf('alpha'),
    validateMarkdown: ({ markdown }) => markdown === expectedSource
  })
  assert.equal(plan.ok, true, `paragraph-absorbs-code rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.mode, 'paragraph-absorbs-code')
  assert.equal(plan.result.markdown, expectedSource)
}
console.log('ok 2 paragraph-absorbs-code')

// ---------------------------------------------------------------------------
// 3. Merge + follow-up code text edits (chain, not just terminal state)
// ---------------------------------------------------------------------------
{
  const codeText = 'a\r\nb'
  const oldDoc = document(codeBlock(codeText), paragraph('尾段'))
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 1 })
  const afterMergeIndex = 0
  const cursor = beforeAtIndex(merged.doc, afterMergeIndex) + 1 + (codeText + '尾段').length
  const followUp = EditorState.create({ schema, doc: merged.doc })
    .tr.insertText('!', cursor)
  const source = '```\r\na\r\nb\r\n```\r\n\r\n尾段\r\n'
  const canonicalBaseline = '```\na\nb\n```\n\n尾段\n'
  const finalCode = codeText + '尾段!'
  const canonical = '```\na\nb尾段!\n```\n'
  const expectedSource = '```\r\na\r\nb尾段!\r\n```\r\n'
  const plan = planFor({
    oldDoc,
    transactions: [merged, followUp],
    source,
    canonicalBaseline,
    canonical,
    revision: 2003,
    resolver: ({ markdown }) => markdown.indexOf('尾段'),
    validateMarkdown: ({ markdown }) => markdown === expectedSource
  })
  assert.equal(plan.ok, true, `chain rejected: ${JSON.stringify(plan)}`)
  assert.equal(plan.proof.finalText, finalCode)
  assert.equal(plan.proof.textStepCount, 1)
  assert.equal(plan.result.markdown, expectedSource)
}
console.log('ok 3 merge chain with follow-up text step')

// ---------------------------------------------------------------------------
// 4. Neighbour changed in the same chain → fail closed
// ---------------------------------------------------------------------------
{
  const codeText = 'a\r\nb'
  const oldDoc = document(codeBlock(codeText), paragraph('尾段'), paragraph('邻块'))
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 1 })
  const neighbourPos = beforeAtIndex(merged.doc, 1) + 1 + '邻块'.length
  const neighbourEdit = EditorState.create({ schema, doc: merged.doc })
    .tr.insertText('!', neighbourPos)
  const source = '```\r\na\r\nb\r\n```\r\n\r\n尾段\r\n\r\n邻块\r\n'
  const plan = planFor({
    oldDoc,
    transactions: [merged, neighbourEdit],
    source,
    canonicalBaseline: '```\na\nb\n```\n\n尾段\n\n邻块\n',
    canonical: '```\na\nb尾段\n```\n\n邻块!\n',
    revision: 2004,
    resolver: () => -1,
    validateMarkdown: () => true
  })
  assert.equal(plan.ok, false)
  // The terminal topology (code text changed AND a neighbour changed) no
  // longer matches the single-candidate contract → rejected before replay.
  assert.equal(plan.reason, 'code-block-boundary-join-candidate-count')
}
console.log('ok 4 neighbour edit fails closed')

// ---------------------------------------------------------------------------
// 5. No fence in source at the mapped range → fail closed
// ---------------------------------------------------------------------------
{
  const oldDoc = document(codeBlock('x'), paragraph('尾段'))
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 1 })
  const plan = planFor({
    oldDoc,
    transactions: [merged],
    source: 'x\r\n\r\n尾段\r\n',
    canonicalBaseline: 'x\n\n尾段\n',
    canonical: '```\nx尾段\n```\n',
    revision: 2005,
    resolver: () => -1,
    validateMarkdown: () => true
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'code-block-boundary-join-source-range')
}
console.log('ok 5 missing fence fails closed')

// ---------------------------------------------------------------------------
// 6. Semantic validator rejects the candidate → fail closed, no publication
// ---------------------------------------------------------------------------
{
  const oldDoc = document(codeBlock('a'), paragraph('尾段'))
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 1 })
  const source = '```\r\na\r\n```\r\n\r\n尾段\r\n'
  const plan = planFor({
    oldDoc,
    transactions: [merged],
    source,
    canonicalBaseline: '```\na\n```\n\n尾段\n',
    canonical: '```\na尾段\n```\n',
    revision: 2006,
    resolver: ({ markdown }) => markdown.indexOf('尾段'),
    validateMarkdown: () => false
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'code-block-boundary-join-semantic-document-mismatch')
}
console.log('ok 6 semantic rejection fails closed')

// ---------------------------------------------------------------------------
// 7. Stale journal → reset
// ---------------------------------------------------------------------------
{
  const oldDoc = document(codeBlock('a'), paragraph('尾段'))
  const merged = mergeTransaction(oldDoc, { paragraphIndex: 1 })
  const source = '```\r\na\r\n```\r\n\r\n尾段\r\n'
  const captured = captureJournal({
    oldDoc,
    transactions: [merged],
    source,
    canonical: '```\na\n```\n\n尾段\n',
    revision: 2007
  })
  const owner = createCodeBlockBoundaryJoinTransactionSourceSyncOwner({
    resolveMarkdownOffset: () => 0,
    validateMarkdown: () => true
  })
  const stale = owner.plan({
    journal: captured.journal,
    activeJournal: { ...captured.journal },
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: '```\na\n```\n\n尾段\n',
    canonical: '```\na尾段\n```\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.reason, 'code-block-boundary-join-journal-stale')
  assert.equal(stale.reset, true)
}
console.log('ok 7 stale journal resets')

// ---------------------------------------------------------------------------
// 8. Constructor contract
// ---------------------------------------------------------------------------
assert.throws(
  () => createCodeBlockBoundaryJoinTransactionSourceSyncOwner({ validateMarkdown: () => true }),
  /requires resolveMarkdownOffset/
)
assert.throws(
  () => createCodeBlockBoundaryJoinTransactionSourceSyncOwner({ resolveMarkdownOffset: () => 0 }),
  /requires validateMarkdown/
)
console.log('ok 8 constructor contract')

console.log('PASS code-block boundary join transaction owner: CRLF code-absorbs-paragraph and paragraph-absorbs-code merges, follow-up text chains, neighbour/fence/semantic/stale fail-closed contracts')
