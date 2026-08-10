import assert from 'node:assert/strict'
import { Schema, Slice, Fragment } from '@milkdown/prose/model'
import { EditorState, Plugin } from '@milkdown/prose/state'
import { ReplaceStep } from '@milkdown/prose/transform'
import { mapPlainTextTransactionsToSource } from '../src/renderer/src/lib/source-transaction-sync.js'
import { createSourceTransactionDispatch } from '../src/renderer/src/components/editor-source-transactions.js'

const mapTransactions = (options) => mapPlainTextTransactionsToSource({
  ...options,
  validateMarkdown: options.validateMarkdown || (() => true)
})

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: { attrs: { level: { default: 1 } }, content: 'text*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' }
  },
  marks: {
    strong: {}
  }
})

const text = (value) => schema.text(value)
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? text(value) : null)
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
const quote = (value) => schema.nodes.blockquote.create(null, paragraph(value))
const item = (value) => schema.nodes.list_item.create(null, paragraph(value))
const list = (value) => schema.nodes.bullet_list.create(null, item(value))

const doc = schema.nodes.doc.create(null, [
  heading('标题'),
  paragraph('正文'),
  quote('引用'),
  list('项目')
])

const source = '# 标题\n\n正文\n\n> 引用\n\n- 项目\n'

const textPositions = {}
doc.descendants((node, pos) => {
  if (node.isText) textPositions[node.text] = pos
})

const rawStarts = {
  标题: source.indexOf('标题'),
  正文: source.indexOf('正文'),
  引用: source.indexOf('引用'),
  项目: source.indexOf('项目')
}

const mapPosition = (markdown, pmPos, pmDoc) => {
  let result = null
  pmDoc.descendants((node, pos) => {
    if (result != null || !node.isText) return
    if (pmPos < pos || pmPos > pos + node.nodeSize) return
    const rawStart = markdown.indexOf(node.text)
    if (rawStart >= 0) result = rawStart + (pmPos - pos)
  })
  if (result != null) return result
  // Empty textblocks have no text descendant; this test intentionally leaves
  // them unmapped because production must fail closed in the same situation.
  return null
}

const apply = (state, step) => {
  const tr = state.tr.step(step)
  return {
    transaction: tr,
    state: state.apply(tr)
  }
}

// Plain text insertion in a paragraph.
let state = EditorState.create({ schema, doc })
let result = apply(
  state,
  new ReplaceStep(
    textPositions.正文 + 2,
    textPositions.正文 + 2,
    new Slice(Fragment.from(text('新增')), 0, 0)
  )
)
let mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正文新增\n\n> 引用\n\n- 项目\n')

// Enter inside a top-level paragraph inserts exactly one Markdown blank line,
// then following text transactions map against the newly split PM document.
const tailDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
const tailSource = '# 标题\n\n正文\n'
let tailTextPos = null
tailDoc.descendants((node, pos) => {
  if (tailTextPos == null && node.isText && node.text === '正文') tailTextPos = pos
})
state = EditorState.create({ schema, doc: tailDoc })
const splitTransaction = state.tr.split(tailTextPos + 1)
const splitState = state.apply(splitTransaction)
mapped = mapTransactions({
  source: tailSource,
  transactions: [splitTransaction],
  oldState: state,
  newState: splitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正\n\n文\n')
const splitSource = mapped.markdown
const splitHints = mapped.blockHints
let newParagraphTextPos = null
splitState.doc.descendants((node, pos) => {
  if (newParagraphTextPos == null && node.isText && node.text === '文') newParagraphTextPos = pos
})
const followTransaction = splitState.tr.insertText('新', newParagraphTextPos)
const followState = splitState.apply(followTransaction)
mapped = mapTransactions({
  source: splitSource,
  transactions: [followTransaction],
  oldState: splitState,
  newState: followState,
  blockHints: splitHints,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正\n\n新文\n')

// Enter at the end of a paragraph before another authored paragraph creates a
// real raw blank-line slot. A second Enter inside that owned empty paragraph
// creates another slot; neither operation may map later text into a neighbour.
const middleDoc = schema.nodes.doc.create(null, [paragraph('Alpha'), paragraph('Omega')])
const middleSource = 'Alpha\n\nOmega'
state = EditorState.create({ schema, doc: middleDoc })
const middleSplit = state.tr.split(6)
const middleSplitState = state.apply(middleSplit)
mapped = mapTransactions({
  source: middleSource,
  transactions: [middleSplit],
  oldState: state,
  newState: middleSplitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, 'Alpha\n\n\n\nOmega')

const ownedEmptySplit = middleSplitState.tr.split(8)
const ownedEmptySplitState = middleSplitState.apply(ownedEmptySplit)
mapped = mapTransactions({
  source: mapped.markdown,
  transactions: [ownedEmptySplit],
  oldState: middleSplitState,
  newState: ownedEmptySplitState,
  blockHints: mapped.blockHints,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, 'Alpha\n\n\n\n\n\nOmega')

// Hints own both a ProseMirror coordinate and a raw Markdown coordinate. An
// edit in an earlier block must shift both before text is entered into the
// empty block, including CRLF documents.
const runHintShiftCase = (lineEnding) => {
  const initialDoc = schema.nodes.doc.create(null, [paragraph('a')])
  const initialSource = 'a'
  let initialState = EditorState.create({ schema, doc: initialDoc })
  const split = initialState.tr.split(2)
  const afterSplit = initialState.apply(split)
  let result = mapTransactions({
    source: initialSource,
    transactions: [split],
    oldState: initialState,
    newState: afterSplit,
    mapPosition
  })
  assert.equal(result.ok, true)
  if (lineEnding === '\r\n') {
    result.markdown = result.markdown.replaceAll('\n', '\r\n')
    result.blockHints = result.blockHints.map((hint) => ({
      ...hint,
      rawStart: hint.rawStart * 2 - 1
    }))
  }

  const editFirst = afterSplit.tr.insertText('x', 2)
  const afterFirst = afterSplit.apply(editFirst)
  result = mapTransactions({
    source: result.markdown,
    transactions: [editFirst],
    oldState: afterSplit,
    newState: afterFirst,
    blockHints: result.blockHints,
    mapPosition
  })
  assert.equal(result.ok, true)

  const typeInEmpty = afterFirst.tr.insertText('b', 5)
  const afterEmpty = afterFirst.apply(typeInEmpty)
  result = mapTransactions({
    source: result.markdown,
    transactions: [typeInEmpty],
    oldState: afterFirst,
    newState: afterEmpty,
    blockHints: result.blockHints,
    mapPosition
  })
  assert.equal(result.ok, true)
  assert.equal(result.markdown, `ax${lineEnding}${lineEnding}b`)
}
runHintShiftCase('\n')
runHintShiftCase('\r\n')

// Leading spaces are authored as U+200B + literal spaces so Markdown does not
// reinterpret them as an indented code block. The sentinel disappears again
// when the block no longer starts with whitespace.
const sentinelDoc = schema.nodes.doc.create(null, [paragraph('a')])
state = EditorState.create({ schema, doc: sentinelDoc })
const sentinelSplit = state.tr.split(2)
let sentinelState = state.apply(sentinelSplit)
let sentinelMapped = mapTransactions({
  source: 'a',
  transactions: [sentinelSplit],
  oldState: state,
  newState: sentinelState,
  mapPosition
})
const sentinelSpace = sentinelState.tr.insertText(' ', 4)
let sentinelNextState = sentinelState.apply(sentinelSpace)
sentinelMapped = mapTransactions({
  source: sentinelMapped.markdown,
  transactions: [sentinelSpace],
  oldState: sentinelState,
  newState: sentinelNextState,
  blockHints: sentinelMapped.blockHints,
  mapPosition
})
assert.equal(sentinelMapped.ok, true)
assert.equal(sentinelMapped.markdown, 'a\n\n\u200B ')
sentinelState = sentinelNextState
const sentinelText = sentinelState.tr.insertText('x', 5)
sentinelNextState = sentinelState.apply(sentinelText)
sentinelMapped = mapTransactions({
  source: sentinelMapped.markdown,
  transactions: [sentinelText],
  oldState: sentinelState,
  newState: sentinelNextState,
  blockHints: sentinelMapped.blockHints,
  mapPosition
})
assert.equal(sentinelMapped.markdown, 'a\n\n\u200B x')
sentinelState = sentinelNextState
const removeLeadingSpace = sentinelState.tr.delete(4, 5)
sentinelNextState = sentinelState.apply(removeLeadingSpace)
sentinelMapped = mapTransactions({
  source: sentinelMapped.markdown,
  transactions: [removeLeadingSpace],
  oldState: sentinelState,
  newState: sentinelNextState,
  blockHints: sentinelMapped.blockHints,
  mapPosition
})
assert.equal(sentinelMapped.ok, true)
assert.equal(sentinelMapped.markdown, 'a\n\nx')

// An empty block that was not created by the mapper has no byte ownership.
// Even if a caller supplies an optimistic position, it must fail closed.
const unownedEmptyDoc = schema.nodes.doc.create(null, [paragraph()])
state = EditorState.create({ schema, doc: unownedEmptyDoc })
const unownedType = state.tr.insertText('unsafe', 1)
const unownedTypeState = state.apply(unownedType)
mapped = mapTransactions({
  source: '',
  transactions: [unownedType],
  oldState: state,
  newState: unownedTypeState,
  mapPosition: () => 0
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'empty-block-without-source-slot')

// CRLF documents keep their line-ending convention when Enter creates a new
// paragraph. The transaction mapper must not introduce a lone LF.
const crlfSource = tailSource.replaceAll('\n', '\r\n')
state = EditorState.create({ schema, doc: tailDoc })
const crlfSplit = state.tr.split(tailTextPos + 1)
const crlfSplitState = state.apply(crlfSplit)
mapped = mapTransactions({
  source: crlfSource,
  transactions: [crlfSplit],
  oldState: state,
  newState: crlfSplitState,
  // The mapper hands the position mapper the normalized LF view, so the
  // plain-LF resolver applies directly.
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\n\r\n正\r\n\r\n文\r\n')

// BOM + CRLF documents keep both file-format spellings through plain edits
// and structural splits. The normalized proof view is invisible to the caller.
const bomCrlfSource = '\uFEFF# 标题\r\n\r\n正文\r\n'
const bomCrlfDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
state = EditorState.create({ schema, doc: bomCrlfDoc })
let bomCrlfTextPos = null
bomCrlfDoc.descendants((node, pos) => {
  if (bomCrlfTextPos == null && node.isText && node.text === '正文') bomCrlfTextPos = pos
})
const bomInsert = state.tr.insertText('X', bomCrlfTextPos + 2)
const bomInsertState = state.apply(bomInsert)
mapped = mapTransactions({
  source: bomCrlfSource,
  transactions: [bomInsert],
  oldState: state,
  newState: bomInsertState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '\uFEFF# 标题\r\n\r\n正文X\r\n')

state = EditorState.create({ schema, doc: bomCrlfDoc })
const bomSplit = state.tr.split(bomCrlfTextPos + 1)
const bomSplitState = state.apply(bomSplit)
mapped = mapTransactions({
  source: bomCrlfSource,
  transactions: [bomSplit],
  oldState: state,
  newState: bomSplitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '\uFEFF# 标题\r\n\r\n正\r\n\r\n文\r\n')

// A lone-CR document uses `\r` as its own line ending; the mapper must not
// silently upgrade it to LF when Enter creates a new paragraph.
const crOnlySource = '# 标题\r\r正文\r'
const crOnlyDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
state = EditorState.create({ schema, doc: crOnlyDoc })
let crOnlyTextPos = null
crOnlyDoc.descendants((node, pos) => {
  if (crOnlyTextPos == null && node.isText && node.text === '正文') crOnlyTextPos = pos
})
const crOnlySplit = state.tr.split(crOnlyTextPos + 1)
const crOnlySplitState = state.apply(crOnlySplit)
mapped = mapTransactions({
  source: crOnlySource,
  transactions: [crOnlySplit],
  oldState: state,
  newState: crOnlySplitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\r正\r\r文\r')

// Plain text edits in a lone-CR document keep the authored spelling; no line
// ending is introduced by the insertion.
state = EditorState.create({ schema, doc: crOnlyDoc })
const crOnlyInsert = state.tr.insertText('X', crOnlyTextPos + 2)
const crOnlyInsertState = state.apply(crOnlyInsert)
mapped = mapTransactions({
  source: crOnlySource,
  transactions: [crOnlyInsert],
  oldState: state,
  newState: crOnlyInsertState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\r正文X\r')

// Mixed EOL documents reject structural splits atomically; ordinary plain
// text edits (which introduce no new line ending) remain safe.
const mixedSource = '# 标题\r\n\r\n正文\n'
const mixedDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
state = EditorState.create({ schema, doc: mixedDoc })
let mixedTextPos = null
mixedDoc.descendants((node, pos) => {
  if (mixedTextPos == null && node.isText && node.text === '正文') mixedTextPos = pos
})
const mixedSplit = state.tr.split(mixedTextPos + 1)
const mixedSplitState = state.apply(mixedSplit)
mapped = mapTransactions({
  source: mixedSource,
  transactions: [mixedSplit],
  oldState: state,
  newState: mixedSplitState,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'mixed-line-ending-split')
assert.equal(mapped.markdown, mixedSource)

state = EditorState.create({ schema, doc: mixedDoc })
const mixedInsert = state.tr.insertText('X', mixedTextPos + 2)
const mixedInsertState = state.apply(mixedInsert)
mapped = mapTransactions({
  source: mixedSource,
  transactions: [mixedInsert],
  oldState: state,
  newState: mixedInsertState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\n\r\n正文X\n')

// Editing list text preserves the authored `-` marker. Emptying the whole item
// stays on the specialized list-exit fallback until that structural sequence
// is transaction-owned end to end.
state = EditorState.create({ schema, doc })
result = apply(
  state,
  new ReplaceStep(
    textPositions.项目 + 1,
    textPositions.项目 + 2,
    Slice.empty
  )
)
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正文\n\n> 引用\n\n- 项\n')
assert.ok(!mapped.markdown.includes('* 项'))

state = EditorState.create({ schema, doc })
result = apply(
  state,
  new ReplaceStep(
    textPositions.项目,
    textPositions.项目 + 2,
    Slice.empty
  )
)
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'textblock-emptied')
assert.equal(mapped.markdown, source)

// Cross-block and syntax-sensitive edits are rejected atomically.
state = EditorState.create({ schema, doc })
const crossBlockTransaction = state.tr.delete(textPositions.正文, textPositions.引用 + 2)
result = {
  transaction: crossBlockTransaction,
  state: state.apply(crossBlockTransaction)
}
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.markdown, source)

// A batch is atomic: a valid first transaction followed by an unsupported
// syntax transaction must not leak the first patch into the source.
const atomicDoc = schema.nodes.doc.create(null, [paragraph('atomic')])
const atomicSource = 'atomic'
state = EditorState.create({ schema, doc: atomicDoc })
const atomicPlain = state.tr.insertText('X', 2)
const atomicMidState = state.apply(atomicPlain)
const atomicSyntax = atomicMidState.tr.insertText('`', 3)
const atomicFinalState = atomicMidState.apply(atomicSyntax)
mapped = mapTransactions({
  source: atomicSource,
  transactions: [atomicPlain, atomicSyntax],
  oldState: state,
  newState: atomicFinalState,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.markdown, atomicSource)

// Individually ordinary characters can complete Markdown syntax across
// transactions. The parser-equivalence gate must reject the final source when
// it would cold-open as a different document than the live ProseMirror state.
const semanticDoc = schema.nodes.doc.create(null, [paragraph('x~~')])
const semanticSource = 'x~~'
state = EditorState.create({ schema, doc: semanticDoc })
const semanticTransaction = state.tr.insertText('~~', 1)
const semanticState = state.apply(semanticTransaction)
mapped = mapTransactions({
  source: semanticSource,
  transactions: [semanticTransaction],
  oldState: state,
  newState: semanticState,
  mapPosition,
  validateMarkdown: (markdown) => markdown !== '~~x~~'
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'semantic-document-mismatch')
assert.equal(mapped.markdown, semanticSource)

state = EditorState.create({ schema, doc })
result = apply(
  state,
  new ReplaceStep(
    textPositions.正文 + 2,
    textPositions.正文 + 2,
    new Slice(Fragment.from(text('`')), 0, 0)
  )
)
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.markdown, source)

// The dispatch boundary forwards one complete applyTransaction batch,
// including recursively appended plugin transactions, before updating the
// view. A batch prefix can therefore never advance source independently.
const appendPlugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null
    if (transactions.some((transaction) => transaction.getMeta('hm-append-test'))) return null
    return newState.tr
      .insertText('!', newState.doc.content.size - 1)
      .setMeta('hm-append-test', true)
  }
})
const dispatchState = EditorState.create({
  schema,
  doc: schema.nodes.doc.create(null, [paragraph('atomic')]),
  plugins: [appendPlugin]
})
let observedBatch = null
let updateCount = 0
const fakeView = {
  state: dispatchState,
  updateState(nextState) {
    updateCount += 1
    this.state = nextState
  }
}
createSourceTransactionDispatch((transactions, oldState, newState) => {
  observedBatch = { transactions, oldState, newState }
}).call(fakeView, dispatchState.tr.insertText('X', 2))
assert.equal(observedBatch.transactions.length, 2)
assert.equal(observedBatch.oldState, dispatchState)
assert.equal(observedBatch.newState.doc.textContent, 'aXtomic!')
assert.equal(updateCount, 1)
assert.equal(fakeView.state, observedBatch.newState)

console.log('PASS source transaction sync: plain edits map exactly; structural/syntax edits fail closed')
