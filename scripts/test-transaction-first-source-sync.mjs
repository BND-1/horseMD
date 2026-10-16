import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  TRANSACTION_FIRST_FAMILIES,
  TRANSACTION_FIRST_MODES,
  buildPlainParagraphSourceRangeMap,
  captureTransactionFirstSourceSync,
  classifyPhaseOnePlainParagraphTransaction,
  reconcileTransactionFirstSourceSync,
  runTransactionFirstSourceSync
} from '../src/renderer/src/lib/transaction-first-source-sync.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' }
  },
  marks: {
    em: {}
  }
})

const remark = unified().use(remarkParse)
const phaseOneAuthority = [TRANSACTION_FIRST_FAMILIES.PLAIN_PARAGRAPH_INLINE_REPLACE]
const text = (value, marks = null) => schema.text(value, marks)
const paragraph = (value, marks = null) => schema.node('paragraph', null, value ? text(value, marks) : null)
const heading = (value) => schema.node('heading', null, text(value))
const bulletList = (...items) => schema.node(
  'bullet_list',
  null,
  items.map((value) => schema.node('list_item', null, paragraph(value)))
)
const doc = (...blocks) => schema.node('doc', null, blocks)

const contentStartOf = (pmDoc, value, occurrence = 0) => {
  let seen = 0
  let found = null
  pmDoc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' || node.textContent !== value) return true
    if (seen++ === occurrence) found = pos + 1
    return found == null
  })
  assert.notEqual(found, null, `missing paragraph ${value} #${occurrence}`)
  return found
}

const source = 'alpha\n\nrepeat\n\nrepeat\n\nomega\n'
const oldDoc = doc(
  paragraph('alpha'),
  paragraph('repeat'),
  paragraph('repeat'),
  paragraph('omega')
)
const oldState = EditorState.create({ schema, doc: oldDoc })
const sourceMap = buildPlainParagraphSourceRangeMap({ source, doc: oldDoc, remark })
assert.equal(sourceMap.ok, true)
assert.equal(sourceMap.entries.length, 4, 'all simple top-level paragraphs should be mapped')

const secondRepeatStart = contentStartOf(oldDoc, 'repeat', 1)
assert.equal(
  sourceMap.mapPosition(sourceMap.normalizedSource, secondRepeatStart, oldDoc),
  source.lastIndexOf('repeat'),
  'duplicate paragraph text must map by the PM/source snapshot, not to the first textual occurrence'
)

const transaction = oldState.tr.insertText('X', secondRepeatStart + 3)
const newState = oldState.apply(transaction)
const expected = 'alpha\n\nrepeat\n\nrepXeat\n\nomega\n'
const validateExpected = (markdown, expectedDoc) =>
  markdown === expected && expectedDoc?.eq?.(newState.doc) === true

const shadow = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected,
  legacyResult: { markdown: expected, reason: 'legacy-fixture' }
})
assert.equal(shadow.ownership, 'owned')
assert.equal(shadow.transaction.family, 'plain-paragraph-inline-replace')
assert.equal(shadow.transaction.classificationReason, 'phase1-plain-paragraph-inline-replace')
assert.equal(shadow.transaction.markdown, expected)
assert.equal(shadow.comparison, 'byte-equal')
assert.equal(shadow.promotionEligible, true)
assert.equal(shadow.publication.owner, 'legacy', 'shadow mode must never publish the transaction candidate')

const stagedCheckpoint = captureTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected
})
assert.equal(stagedCheckpoint.ownership, 'owned')
assert.equal(stagedCheckpoint.family, 'plain-paragraph-inline-replace')
assert.deepEqual(stagedCheckpoint.stepNames, ['ReplaceStep'])
assert.equal(stagedCheckpoint.sourceMapEntries, 4)

globalThis.__hmTransactionFirstTrace = []
const stagedEqual = reconcileTransactionFirstSourceSync({
  checkpoint: stagedCheckpoint,
  currentSource: source,
  currentDoc: newState.doc,
  legacyResult: { markdown: expected, reason: 'legacy-fixture' }
})
assert.equal(stagedEqual.comparison, 'byte-equal')
assert.equal(stagedEqual.promotionEligible, true)
assert.equal(stagedEqual.publication.owner, 'legacy', 'staged shadow reconcile must remain behavior-neutral')
assert.equal(stagedEqual.reconcileReason, 'matched-snapshot')
assert.deepEqual(globalThis.__hmTransactionFirstTrace.at(-1)?.stepNames, ['ReplaceStep'])
assert.equal(globalThis.__hmTransactionFirstTrace.at(-1)?.transactionFamily, 'plain-paragraph-inline-replace')
assert.equal(globalThis.__hmTransactionFirstTrace.at(-1)?.sourceMapEntries, 4)
assert.equal('markdown' in globalThis.__hmTransactionFirstTrace.at(-1), false, 'trace must not include full source bytes')

const stagedDiverged = reconcileTransactionFirstSourceSync({
  checkpoint: stagedCheckpoint,
  currentSource: source,
  currentDoc: newState.doc,
  legacyResult: { markdown: `${expected}legacy-only`, reason: 'legacy-fixture' }
})
assert.equal(stagedDiverged.comparison, 'byte-diverged')
assert.equal(stagedDiverged.promotionEligible, false)
assert.equal(stagedDiverged.publication.owner, 'legacy')

const stagedStaleSource = reconcileTransactionFirstSourceSync({
  checkpoint: stagedCheckpoint,
  currentSource: `${source}external-change`,
  currentDoc: newState.doc,
  legacyResult: { markdown: 'legacy-safe', reason: 'legacy-fixture' }
})
assert.equal(stagedStaleSource.comparison, 'shadow-stale-source')
assert.equal(stagedStaleSource.reconcileReason, 'source-checkpoint-changed')
assert.equal(stagedStaleSource.publication.owner, 'legacy')

const laterTransaction = newState.tr.insertText('Y', contentStartOf(newState.doc, 'repXeat', 0) + 1)
const laterState = newState.apply(laterTransaction)
const stagedStaleDoc = reconcileTransactionFirstSourceSync({
  checkpoint: stagedCheckpoint,
  currentSource: source,
  currentDoc: laterState.doc,
  legacyResult: { markdown: 'legacy-safe', reason: 'legacy-fixture' }
})
assert.equal(stagedStaleDoc.comparison, 'shadow-stale-document')
assert.equal(stagedStaleDoc.reconcileReason, 'callback-document-changed')
assert.equal(stagedStaleDoc.publication.owner, 'legacy')

const observeDivergence = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.OBSERVE,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected,
  legacyResult: { markdown: expected.replace('repXeat', 'legacy-different'), reason: 'legacy-fixture' }
})
assert.equal(observeDivergence.comparison, 'byte-diverged')
assert.equal(observeDivergence.promotionEligible, false)
assert.equal(observeDivergence.publication.owner, 'legacy', 'observe mode remains behavior-neutral on divergence')

const authoritative = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: validateExpected,
  legacyResult: { markdown: expected, reason: 'legacy-fixture' }
})
assert.equal(authoritative.publication.owner, 'transaction')
assert.equal(authoritative.publication.markdown, expected)

const staleMap = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source: `${source}tail`,
  transactions: [transaction],
  oldState,
  newState,
  sourceRangeMap: sourceMap,
  validateMarkdown: () => true,
  legacyResult: { markdown: 'legacy-safe', reason: 'legacy-fixture' }
})
assert.equal(staleMap.ownership, 'rejected')
assert.equal(staleMap.transaction.reason, 'stale-source-range-map')
assert.equal(staleMap.publication.owner, 'legacy', 'a stale source map must fail closed to legacy')

const syntaxTransaction = oldState.tr.insertText('*', secondRepeatStart + 2)
const syntaxState = oldState.apply(syntaxTransaction)
const syntaxRejected = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source,
  transactions: [syntaxTransaction],
  oldState,
  newState: syntaxState,
  sourceRangeMap: sourceMap,
  validateMarkdown: () => true,
  legacyResult: { markdown: source, reason: 'legacy-fixture' }
})
assert.equal(syntaxRejected.ownership, 'rejected')
assert.equal(syntaxRejected.transaction.reason, 'syntax-sensitive-insert')
assert.equal(syntaxRejected.publication.owner, 'legacy', 'Markdown-sensitive text stays on fallback')

const rejectedCheckpoint = captureTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.SHADOW,
  source,
  transactions: [syntaxTransaction],
  oldState,
  newState: syntaxState,
  sourceRangeMap: sourceMap,
  validateMarkdown: () => true
})
const stagedRejected = reconcileTransactionFirstSourceSync({
  checkpoint: rejectedCheckpoint,
  currentSource: source,
  currentDoc: syntaxState.doc,
  legacyResult: { markdown: source, reason: 'legacy-fixture' }
})
assert.equal(stagedRejected.comparison, 'transaction-rejected')
assert.equal(stagedRejected.transaction.reason, 'syntax-sensitive-insert')
assert.equal(stagedRejected.publication.owner, 'legacy')
delete globalThis.__hmTransactionFirstTrace

const alphaStart = contentStartOf(oldDoc, 'alpha')
const deleteTransaction = oldState.tr.delete(alphaStart + 1, alphaStart + 2)
const deleteState = oldState.apply(deleteTransaction)
const deleteExpected = source.replace('alpha', 'apha')
const deleteResult = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source,
  transactions: [deleteTransaction],
  oldState,
  newState: deleteState,
  sourceRangeMap: sourceMap,
  validateMarkdown: (markdown, expectedDoc) =>
    markdown === deleteExpected && expectedDoc?.eq?.(deleteState.doc) === true,
  legacyResult: { markdown: deleteExpected, reason: 'legacy-fixture' }
})
assert.equal(deleteResult.transaction.ok, true)
assert.equal(deleteResult.transaction.family, 'plain-paragraph-inline-replace')

const replaceTransaction = oldState.tr.insertText('ZZ', alphaStart + 1, alphaStart + 3)
const replaceState = oldState.apply(replaceTransaction)
const replaceExpected = source.replace('alpha', 'aZZha')
const replaceResult = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source,
  transactions: [replaceTransaction],
  oldState,
  newState: replaceState,
  sourceRangeMap: sourceMap,
  validateMarkdown: (markdown, expectedDoc) =>
    markdown === replaceExpected && expectedDoc?.eq?.(replaceState.doc) === true,
  legacyResult: { markdown: replaceExpected, reason: 'legacy-fixture' }
})
assert.equal(replaceResult.transaction.ok, true)
assert.equal(replaceResult.transaction.family, 'plain-paragraph-inline-replace')

const splitTransaction = oldState.tr.split(secondRepeatStart + 3)
const splitState = oldState.apply(splitTransaction)
assert.equal(splitTransaction.steps[0]?.constructor?.name, 'ReplaceStep', 'paragraph split should exercise the structural ReplaceStep lookalike')
const splitClassification = classifyPhaseOnePlainParagraphTransaction({
  transactions: [splitTransaction],
  oldState,
  newState: splitState,
  sourceRangeMap: sourceMap
})
assert.equal(splitClassification.owned, false)
assert.equal(splitClassification.reason, 'phase1-structural-slice')
const splitResult = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source,
  transactions: [splitTransaction],
  oldState,
  newState: splitState,
  sourceRangeMap: sourceMap,
  validateMarkdown: () => true,
  legacyResult: { markdown: 'legacy-safe', reason: 'legacy-fixture' }
})
assert.equal(splitResult.ownership, 'rejected')
assert.equal(splitResult.transaction.reason, 'phase1-structural-slice')
assert.equal(splitResult.publication.owner, 'legacy')

const fakeStructuralTransaction = {
  docChanged: true,
  before: oldDoc,
  steps: [{ constructor: { name: 'ReplaceAroundStep' } }]
}
assert.equal(
  classifyPhaseOnePlainParagraphTransaction({
    transactions: [fakeStructuralTransaction],
    oldState,
    newState,
    sourceRangeMap: sourceMap
  }).reason,
  'phase1-step-not-replace'
)

const singleSource = 'x\n'
const singleDoc = doc(paragraph('x'))
const singleState = EditorState.create({ schema, doc: singleDoc })
const singleMap = buildPlainParagraphSourceRangeMap({ source: singleSource, doc: singleDoc, remark })
const emptyTransaction = singleState.tr.delete(1, 2)
const emptyState = singleState.apply(emptyTransaction)
const emptyClassification = classifyPhaseOnePlainParagraphTransaction({
  transactions: [emptyTransaction],
  oldState: singleState,
  newState: emptyState,
  sourceRangeMap: singleMap
})
assert.equal(emptyClassification.owned, false)
assert.equal(emptyClassification.reason, 'phase1-result-empty-paragraph')

const marked = schema.mark('em')
const markedSource = '*styled*\n\nplain\n'
const markedDoc = doc(paragraph('styled', [marked]), paragraph('plain'))
const markedMap = buildPlainParagraphSourceRangeMap({ source: markedSource, doc: markedDoc, remark })
assert.equal(markedMap.entries.length, 1, 'marked/non-contiguous authored text must be excluded from Phase 0')
assert.equal(markedMap.entries[0].text, 'plain')
const markedState = EditorState.create({ schema, doc: markedDoc })
const markedTransaction = markedState.tr.insertText('X', 2)
const markedNextState = markedState.apply(markedTransaction)
assert.equal(
  classifyPhaseOnePlainParagraphTransaction({
    transactions: [markedTransaction],
    oldState: markedState,
    newState: markedNextState,
    sourceRangeMap: markedMap
  }).reason,
  'phase1-non-plain-source-paragraph'
)

const headingSource = '# title\n\nbody\n'
const headingDoc = doc(heading('title'), paragraph('body'))
const headingMap = buildPlainParagraphSourceRangeMap({ source: headingSource, doc: headingDoc, remark })
assert.deepEqual(
  headingMap.entries.map((entry) => entry.text),
  ['body'],
  'Phase 0 source map must not silently expand ownership to headings'
)
const headingState = EditorState.create({ schema, doc: headingDoc })
const headingTransaction = headingState.tr.insertText('X', 2)
const headingNextState = headingState.apply(headingTransaction)
assert.equal(
  classifyPhaseOnePlainParagraphTransaction({
    transactions: [headingTransaction],
    oldState: headingState,
    newState: headingNextState,
    sourceRangeMap: headingMap
  }).reason,
  'phase1-non-top-level-paragraph'
)

const listSource = '- item\n\nplain\n'
const listDoc = doc(bulletList('item'), paragraph('plain'))
const listState = EditorState.create({ schema, doc: listDoc })
const listMap = buildPlainParagraphSourceRangeMap({ source: listSource, doc: listDoc, remark })
const listItemStart = contentStartOf(listDoc, 'item')
const listTransaction = listState.tr.insertText('X', listItemStart + 2)
const listNextState = listState.apply(listTransaction)
assert.equal(
  classifyPhaseOnePlainParagraphTransaction({
    transactions: [listTransaction],
    oldState: listState,
    newState: listNextState,
    sourceRangeMap: listMap
  }).reason,
  'phase1-non-top-level-paragraph'
)

const crlfSource = '\uFEFFalpha\r\n\r\nbeta\r\n'
const crlfDoc = doc(paragraph('alpha'), paragraph('beta'))
const crlfState = EditorState.create({ schema, doc: crlfDoc })
const crlfMap = buildPlainParagraphSourceRangeMap({ source: crlfSource, doc: crlfDoc, remark })
assert.equal(crlfMap.ok, true)
assert.equal(crlfMap.normalizedSource, 'alpha\n\nbeta\n')
const betaStart = contentStartOf(crlfDoc, 'beta')
const crlfTransaction = crlfState.tr.insertText('X', betaStart + 2)
const crlfNextState = crlfState.apply(crlfTransaction)
const crlfExpected = '\uFEFFalpha\r\n\r\nbeXta\r\n'
const crlfResult = runTransactionFirstSourceSync({
  mode: TRANSACTION_FIRST_MODES.AUTHORITATIVE,
  allowedFamilies: phaseOneAuthority,
  source: crlfSource,
  transactions: [crlfTransaction],
  oldState: crlfState,
  newState: crlfNextState,
  sourceRangeMap: crlfMap,
  validateMarkdown: (markdown, expectedDoc) =>
    markdown === 'alpha\n\nbeXta\n' && expectedDoc?.eq?.(crlfNextState.doc) === true,
  legacyResult: { markdown: crlfExpected, reason: 'legacy-fixture' }
})
assert.equal(crlfResult.transaction.ok, true)
assert.equal(crlfResult.transaction.markdown, crlfExpected, 'transaction patch must retain authored BOM + CRLF bytes')
assert.equal(crlfResult.publication.markdown, crlfExpected)

console.log('PASS transaction-first source sync phases 0-1: source-map shadow lifecycle plus explicit plain-paragraph authority classification')
