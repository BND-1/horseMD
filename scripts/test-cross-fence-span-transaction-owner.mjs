// Node contracts for the cross-fence span owner (P5c, trace-86199 12:37).
// Locks: the delete-span and undo-restore shapes publish exact source bytes
// (including CRLF and the author's separation gap), and every family gate +
// post-recognition failure behaves as designed (plain reject before the gate,
// recognized fail-closed after it).
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import {
  CROSS_FENCE_SPAN_TRANSACTION_BOUNDARY,
  CROSS_FENCE_SPAN_TRANSACTION_FAMILY,
  createCrossFenceSpanTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: {
      attrs: { level: { default: 2 } },
      content: 'inline*',
      group: 'block'
    },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true
    },
    table: { content: 'block+', group: 'block' },
    text: { group: 'inline' }
  },
  marks: { strong: {} }
})

const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const heading = (value, level = 2) => schema.nodes.heading.create({ level }, schema.text(value))
const codeBlock = (value = '', language = 'text') => schema.nodes.code_block.create(
  { language },
  value ? schema.text(value) : null
)
const table = () => schema.nodes.table.create(null, paragraph('cell'))
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

const beforeAtIndex = (doc, index) => {
  let offset = 0
  for (let current = 0; current < index; current += 1) offset += doc.child(current).nodeSize
  return offset
}

// Block-level resolver stub: locate the block at beforePos by its unique
// text and return the START of its source line (what the production
// pmPosToMarkdownOffset returns for block anchors).
const resolverFor = (markdown) => ({ pmPos, doc }) => {
  let seen = 0
  for (let index = 0; index < doc.childCount; index += 1) {
    const block = doc.child(index)
    if (seen + block.nodeSize > pmPos) {
      const text = String(block.textContent || '')
      if (!text) return null
      const at = markdown.indexOf(text)
      if (at < 0) return null
      return markdown.lastIndexOf('\n', at) + 1
    }
    seen += block.nodeSize
  }
  return null
}

const serializeBlock = (node) => {
  if (node.type.name === 'code_block') {
    const info = node.attrs.language ? `${node.attrs.language}` : ''
    return `\`\`\`${info}\n${node.textContent}\n\`\`\``
  }
  if (node.type.name === 'heading') return `${'#'.repeat(node.attrs.level)} ${node.textContent}`
  return node.textContent
}
const serializeNodes = (nodes) => nodes.map(serializeBlock).join('\n\n')

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
  revision = 3001,
  validateMarkdown,
  resolver,
  serialize = serializeNodes
}) => {
  const captured = captureJournal({
    oldDoc,
    transactions,
    source,
    canonical: canonicalBaseline,
    revision
  })
  const owner = createCrossFenceSpanTransactionSourceSyncOwner({
    resolveMarkdownOffset: resolver || resolverFor(source),
    serializeNodes: serialize,
    validateMarkdown: validateMarkdown || (() => true)
  })
  return owner.plan({
    journal: captured.journal,
    activeJournal: captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonicalBaseline,
    canonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true,
    boundary: CROSS_FENCE_SPAN_TRANSACTION_BOUNDARY
  })
}

const deleteSpan = (doc, { fromIndex, toIndex }) => {
  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) })
  const tr = state.tr
  tr.delete(beforeAtIndex(doc, fromIndex), beforeAtIndex(doc, toIndex))
  return tr
}

const insertBlock = (doc, { atIndex, block }) => {
  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) })
  const tr = state.tr
  tr.insert(beforeAtIndex(doc, atIndex), block)
  return tr
}

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// 1. Selection delete spanning a fence (trace-86137 hold#1 shape)
// ---------------------------------------------------------------------------
{
  const code = 'Windows 电脑\n  └─ Clash Party / Mihomo'
  const oldDoc = document(
    heading('AWS 部署方案', 1),
    paragraph('前言'),
    heading('1. 推荐架构'),
    codeBlock(code),
    heading('区域选择', 3),
    paragraph('根据实测')
  )
  const source = '# AWS 部署方案\n\n前言\n\n## 1. 推荐架构\n\n```text\nWindows 电脑\n  └─ Clash Party / Mihomo\n```\n\n### 区域选择\n\n根据实测\n'
  const tr = deleteSpan(oldDoc, { fromIndex: 2, toIndex: 4 })
  const expected = '# AWS 部署方案\n\n前言\n\n### 区域选择\n\n根据实测\n'
  const plan = planFor({
    oldDoc,
    transactions: [tr],
    source,
    canonicalBaseline: source,
    canonical: expected,
    validateMarkdown: ({ markdown }) => markdown === expected
  })
  check('delete span: owned with exact source bytes', () => {
    assert.equal(plan.ok, true, JSON.stringify(plan))
    assert.equal(plan.family, CROSS_FENCE_SPAN_TRANSACTION_FAMILY)
    assert.equal(plan.result.markdown, expected)
    assert.equal(plan.proof.kind, 'transaction-cross-fence-span-proof')
    assert.equal(plan.proof.oldWindowTypes.length, 2)
    assert.equal(plan.proof.newWindowTypes.length, 0)
  })
}

// ---------------------------------------------------------------------------
// 2. Undo-restore inserting a fence over a leading empty paragraph
//    (trace-86199 hold#2 shape)
// ---------------------------------------------------------------------------
{
  const code = 'Windows 电脑\n  └─ Clash Party / Mihomo'
  const oldDoc = document(
    heading('AWS 部署方案', 1),
    paragraph('前言'),
    heading('1. 推荐架构'),
    paragraph(''),
    heading('区域选择', 3),
    paragraph('根据实测')
  )
  const source = '# AWS 部署方案\n\n前言\n\n## 1. 推荐架构\n\n\n\n### 区域选择\n\n根据实测\n'
  const tr = insertBlock(oldDoc, { atIndex: 3, block: codeBlock(code) })
  // The pre-existing gap (here the polluted 4-newline run from the incident's
  // bad intermediate publish) is PRESERVED around the inserted fence — the
  // owner never rewrites spacing it cannot prove the author intended.
  const expected = '# AWS 部署方案\n\n前言\n\n## 1. 推荐架构\n\n\n\n```text\nWindows 电脑\n  └─ Clash Party / Mihomo\n```\n\n\n\n### 区域选择\n\n根据实测\n'
  const plan = planFor({
    oldDoc,
    transactions: [tr],
    source,
    canonicalBaseline: source,
    canonical: expected,
    validateMarkdown: ({ markdown }) => markdown === expected
  })
  check('undo restore: fence inserted, empty-paragraph suffix anchor skipped', () => {
    assert.equal(plan.ok, true, JSON.stringify(plan))
    assert.equal(plan.result.markdown, expected)
    // Pure insertion: the old window is empty (the empty paragraph fell into
    // the suffix run and was skipped when resolving the suffix anchor).
    assert.equal(plan.proof.oldWindowTypes.length, 0)
    assert.equal(plan.proof.newWindowTypes.length, 1)
  })
}

// ---------------------------------------------------------------------------
// 3. CRLF document keeps its EOL inside the replacement
// ---------------------------------------------------------------------------
{
  const code = 'line one\r\nline two'
  const oldDoc = document(
    heading('方案'),
    codeBlock(code),
    heading('下一节', 3)
  )
  const source = '## 方案\r\n\r\n```\r\nline one\r\nline two\r\n```\r\n\r\n### 下一节\r\n'
  const tr = deleteSpan(oldDoc, { fromIndex: 1, toIndex: 2 })
  const expected = '## 方案\r\n\r\n### 下一节\r\n'
  const plan = planFor({
    oldDoc,
    transactions: [tr],
    source,
    canonicalBaseline: source,
    canonical: expected,
    validateMarkdown: ({ markdown }) => markdown === expected
  })
  check('CRLF span: replacement and gap keep the document EOL', () => {
    assert.equal(plan.ok, true, JSON.stringify(plan))
    assert.equal(plan.result.markdown, expected)
    assert.ok(!/(?<!\r)\n/.test(plan.result.markdown), 'no bare LF leaked into CRLF doc')
  })
}

// ---------------------------------------------------------------------------
// 4. Replacement: fence removed AND a paragraph added in one span
// ---------------------------------------------------------------------------
{
  const oldDoc = document(
    heading('前言'),
    codeBlock('old code'),
    heading('后记', 3)
  )
  const source = '## 前言\n\n```text\nold code\n```\n\n### 后记\n'
  const state = EditorState.create({ schema, doc: oldDoc, selection: TextSelection.create(oldDoc, 1) })
  const tr = state.tr.replaceWith(beforeAtIndex(oldDoc, 1), beforeAtIndex(oldDoc, 2), paragraph('新段落'))
  const expected = '## 前言\n\n新段落\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [tr],
    source,
    canonicalBaseline: source,
    canonical: expected,
    validateMarkdown: ({ markdown }) => markdown === expected
  })
  check('span replacement: fence swapped for a paragraph', () => {
    assert.equal(plan.ok, true, JSON.stringify(plan))
    assert.equal(plan.result.markdown, expected)
  })
}

// ---------------------------------------------------------------------------
// negatives: family gates (plain rejections — the family is NOT claimed)
// ---------------------------------------------------------------------------
check('no fence in the window → plain reject', () => {
  const oldDoc = document(heading('前言'), paragraph('正文'), heading('后记', 3))
  const source = '## 前言\n\n正文\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [deleteSpan(oldDoc, { fromIndex: 1, toIndex: 2 })],
    source,
    canonicalBaseline: source,
    canonical: '## 前言\n\n### 后记\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, false)
  assert.equal(plan.reason, 'cross-fence-span-no-fence-in-span')
})

check('table inside the window → plain reject (padding dimension out of scope)', () => {
  const oldDoc = document(heading('前言'), table(), codeBlock('x'), heading('后记', 3))
  const source = '## 前言\n\n<table/>\n\n```text\nx\n```\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [deleteSpan(oldDoc, { fromIndex: 1, toIndex: 3 })],
    source,
    canonicalBaseline: source,
    canonical: '## 前言\n\n### 后记\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'cross-fence-span-table-in-span')
})

check('1:1 code_block window → plain reject (code content-edit family)', () => {
  const oldDoc = document(heading('前言'), codeBlock('old'), heading('后记', 3))
  const source = '## 前言\n\n```text\nold\n```\n\n### 后记\n'
  const state = EditorState.create({ schema, doc: oldDoc, selection: TextSelection.create(oldDoc, 1) })
  const tr = state.tr.replaceWith(beforeAtIndex(oldDoc, 1), beforeAtIndex(oldDoc, 2), codeBlock('new'))
  const plan = planFor({
    oldDoc,
    transactions: [tr],
    source,
    canonicalBaseline: source,
    canonical: '## 前言\n\n```text\nnew\n```\n\n### 后记\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'cross-fence-span-code-content-edit')
})

check('edge span (window reaches doc start) → plain reject', () => {
  const oldDoc = document(codeBlock('x'), heading('后记', 3))
  const source = '```text\nx\n```\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [deleteSpan(oldDoc, { fromIndex: 0, toIndex: 1 })],
    source,
    canonicalBaseline: source,
    canonical: '### 后记\n'
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'cross-fence-span-edge-span')
})

// ---------------------------------------------------------------------------
// negatives after recognition — fail closed, never a silent hold
// ---------------------------------------------------------------------------
check('unresolved source anchor → recognized fail-closed rejection', () => {
  const oldDoc = document(heading('前言'), codeBlock('x'), heading('后记', 3))
  const source = '## 前言\n\n```text\nx\n```\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [deleteSpan(oldDoc, { fromIndex: 1, toIndex: 2 })],
    source,
    canonicalBaseline: source,
    canonical: '## 前言\n\n### 后记\n',
    resolver: () => null
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
  assert.equal(plan.reason, 'cross-fence-span-source-range-unresolved')
})

check('semantic mismatch → recognized fail-closed rejection', () => {
  const oldDoc = document(heading('前言'), codeBlock('x'), heading('后记', 3))
  const source = '## 前言\n\n```text\nx\n```\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [deleteSpan(oldDoc, { fromIndex: 1, toIndex: 2 })],
    source,
    canonicalBaseline: source,
    canonical: '## 前言\n\n### 后记\n',
    validateMarkdown: () => false
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
  assert.equal(plan.reason, 'cross-fence-span-semantic-document-mismatch')
})

check('serializer failure → recognized fail-closed rejection', () => {
  const oldDoc = document(heading('前言'), paragraph(''), heading('后记', 3))
  const source = '## 前言\n\n\n\n### 后记\n'
  const plan = planFor({
    oldDoc,
    transactions: [insertBlock(oldDoc, { atIndex: 1, block: codeBlock('x') })],
    source,
    canonicalBaseline: source,
    canonical: '## 前言\n\n```text\nx\n```\n\n### 后记\n',
    serialize: () => { throw new Error('boom') }
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.recognized, true)
  assert.equal(plan.reason, 'cross-fence-span-serializer-threw')
})

check('stale journal → reset rejection', () => {
  const oldDoc = document(heading('前言'), codeBlock('x'), heading('后记', 3))
  const source = '## 前言\n\n```text\nx\n```\n\n### 后记\n'
  const captured = captureJournal({
    oldDoc,
    transactions: [deleteSpan(oldDoc, { fromIndex: 1, toIndex: 2 })],
    source,
    canonical: source,
    revision: 3010
  })
  const owner = createCrossFenceSpanTransactionSourceSyncOwner({
    resolveMarkdownOffset: resolverFor(source),
    serializeNodes,
    validateMarkdown: () => true
  })
  const plan = owner.plan({
    journal: captured.journal,
    activeJournal: null,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: source,
    canonical: '## 前言\n\n### 后记\n',
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent: true
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reset, true)
  assert.equal(plan.reason, 'cross-fence-span-journal-stale')
})

console.log(`\nall ${passed} cross-fence-span owner checks passed`)
