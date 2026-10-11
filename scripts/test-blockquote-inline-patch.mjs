// Blockquote paragraph owner — localized inline patch (0.13.235).
//
// Quote paragraphs carrying marks or spanning several `> ` lines used to fail
// closed on every keystroke (`blockquote-paragraph-not-simple-plain`), and the
// legacy fallback is blocked for this family, so users saw the rich/source
// mismatch warning. The owner now maps the changed span as a bounded raw patch.
// The validator stub accepts ONLY the expected bytes, so each case proves the
// owner offers the exact patch (and that nothing else is published).
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'
import {
  createBlockquoteParagraphTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    text: { group: 'inline' },
    hardbreak: { inline: true, group: 'inline', attrs: { isInline: { default: false } } }
  },
  marks: { strong: {}, emphasis: {}, inlineCode: {} }
})
const remark = unified().use(remarkParse)
const t = (value, marks) => schema.text(value, marks)
const br = (isInline = true) => schema.nodes.hardbreak.create({ isInline })
const strong = () => [schema.marks.strong.create()]
const p = (...content) => schema.nodes.paragraph.create(null, content)
const quote = (...children) => schema.nodes.blockquote.create(null, children)
const doc = (...blocks) => schema.nodes.doc.create(null, blocks)

const journalFactory = createSourceSyncTransactionJournal()

function run({ source, oldDoc, edit, expected, label }) {
  const canonical = source
  const state = EditorState.create({ schema, doc: oldDoc })
  const transaction = edit(state)
  const snapshot = createSourceSyncSnapshot({ revision: 7, source, canonical, doc: oldDoc })
  const captured = journalFactory.captureOrAdvance({
    checkpoint: null,
    snapshot,
    transactions: [transaction],
    oldDoc,
    newDoc: transaction.doc
  })
  assert.equal(captured.ok, true, `${label}: journal capture`)
  const owner = createBlockquoteParagraphTransactionSourceSyncOwner({
    resolveMarkdownOffset: ({ markdown, pmPos, doc: target }) => pmPosToMarkdownOffset(markdown, pmPos, target, remark),
    // The owner validates a BOM-less, LF-normalized copy; the published
    // result (asserted below) must still carry the exact raw bytes.
    validateMarkdown: ({ markdown }) =>
      markdown === expected.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  })
  return owner.plan({
    journal: captured.checkpoint,
    activeJournal: captured.checkpoint,
    snapshot,
    currentSource: source,
    currentCanonical: canonical,
    canonical: 'canonical-not-used-by-this-path',
    expectedDoc: transaction.doc,
    callbackDocumentEquivalent: true
  })
}

const textPos = (target, needle) => {
  let found = null
  target.descendants((node, pos) => {
    if (found == null && node.isText && node.text.includes(needle)) found = pos + node.text.indexOf(needle)
  })
  assert.notEqual(found, null, `text ${needle}`)
  return found
}

const cases = [
  {
    label: 'insert inside bold',
    source: '> a **bold** z\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'bold') + 2),
    expected: '> a **boXld** z\n'
  },
  {
    label: 'append to bold end (mark inherited)',
    source: '> a **bold** z\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.insert(textPos(state.doc, 'bold') + 4, t('X', strong())),
    expected: '> a **boldX** z\n'
  },
  {
    label: 'insert after bold without mark',
    source: '> a **bold** z\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.insert(textPos(state.doc, 'bold') + 4, t('X')),
    expected: '> a **bold**X z\n'
  },
  {
    label: 'second line of soft-wrapped quote',
    source: '> line one\n> line two\n\nafter\n',
    oldDoc: doc(quote(p(t('line one'), br(), t('line two'))), p(t('after'))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'two') + 3),
    expected: '> line one\n> line twoX\n\nafter\n'
  },
  {
    label: 'first line of soft-wrapped quote',
    source: '> line one\n> line two\n',
    oldDoc: doc(quote(p(t('line one'), br(), t('line two')))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'one') + 1),
    expected: '> line oXne\n> line two\n'
  },
  {
    label: 'lazy continuation line',
    source: '> line one\nlazy two\n',
    oldDoc: doc(quote(p(t('line one'), br(), t('lazy two')))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'lazy')),
    expected: '> line one\nXlazy two\n'
  },
  {
    label: 'CRLF and nested prefix spacing survive',
    source: '>  line one\r\n>   line two\r\n',
    oldDoc: doc(quote(p(t('line one'), br(), t('line two')))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'two')),
    expected: '>  line one\r\n>   line Xtwo\r\n'
  },
  {
    label: 'delete text inside multi-line quote',
    source: '> line one\n> line two\n',
    oldDoc: doc(quote(p(t('line one'), br(), t('line two')))),
    edit: (state) => state.tr.delete(textPos(state.doc, 'two'), textPos(state.doc, 'two') + 2),
    expected: '> line one\n> line o\n'
  },
  {
    label: 'input-rule emphasis is spelled with delimiters',
    source: '\uFEFFbefore\r\n\r\n > quoted alpha\r\n',
    oldDoc: doc(p(t('before')), quote(p(t('quoted alpha')))),
    edit: (state) => state.tr.insert(textPos(state.doc, 'alpha') + 5, t('e', [schema.marks.emphasis.create()])),
    expected: '\uFEFFbefore\r\n\r\n > quoted alpha*e*\r\n'
  },
  {
    label: 'typed markdown symbol is escaped when needed',
    source: '> a **bold** z\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.insertText('*', textPos(state.doc, ' z') + 2),
    expected: '> a **bold** z\\*\n'
  }
]

for (const testCase of cases) {
  const plan = run(testCase)
  assert.equal(plan.ok, true, `${testCase.label}: ${plan.reason}`)
  assert.equal(plan.result.markdown, testCase.expected, testCase.label)
  assert.equal(plan.proof.mapperReason, 'bounded-inline-localized-patch', testCase.label)
}

// Fail closed: the validator rejects every candidate → recognized rejection,
// nothing published, legacy fallback stays blocked.
{
  const plan = run({
    label: 'validator rejects',
    source: '> a **bold** z\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'bold') + 2),
    expected: '__never__'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
  assert.equal(plan.reason, 'blockquote-paragraph-semantic-document-mismatch')
}

// Fail closed: deleting across a line break is not a pure text span.
{
  const oldDoc = doc(quote(p(t('line one'), br(), t('line two'))))
  const plan = run({
    label: 'delete across break',
    source: '> line one\n> line two\n',
    oldDoc,
    edit: (state) => state.tr.delete(textPos(state.doc, 'one') + 2, textPos(state.doc, 'two')),
    expected: '> line ontwo\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
}

// Fail closed: source bytes that do not carry the paragraph's text.
{
  const plan = run({
    label: 'stale source',
    source: '> unrelated **words**\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.insertText('X', textPos(state.doc, 'bold') + 2),
    expected: '> a **boXld** z\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
}

// A pure mark toggle (Mod+B) keeps the original fail-closed contract.
{
  const plan = run({
    label: 'mark toggle',
    source: '> a **bold** z\n',
    oldDoc: doc(quote(p(t('a '), t('bold', strong()), t(' z')))),
    edit: (state) => state.tr.addMark(textPos(state.doc, ' z') + 1, textPos(state.doc, ' z') + 2, schema.marks.strong.create()),
    expected: '> a **bold** **z**\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
  assert.equal(plan.reason, 'blockquote-paragraph-not-simple-plain')
}

console.log(`PASS blockquote inline patch: ${cases.length} marked / soft-wrapped / lazy / CRLF / delete / escape edits map to exact bytes; validator rejection, cross-break delete, stale source and mark toggles fail closed`)
