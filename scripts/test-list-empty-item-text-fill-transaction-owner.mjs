// Node contracts for the empty-item text-fill owner (P6e, trace-38723
// 2026-09-12 10:16). Locks: an IME/plain-text chain filling the sole empty
// paragraph of a proven plain list item publishes exact source bytes into the
// authored empty marker row (indent/token/spacing/EOL and every other byte
// preserved); chain-stage misses stay plain rejections (other families may
// own them) while post-recognition failures fail closed with recognized so
// the generic locally-aligned mapper can never publish a drifted placement.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import {
  LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_BOUNDARY,
  LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_FAMILY,
  createListEmptyItemTextFillTransactionSourceSyncOwner,
  createSourceSyncSnapshot,
  createSourceSyncTransactionJournal
} from '../src/renderer/src/lib/source-sync/index.js'
import { sourceSyncNodeEntryAtPath } from '../src/renderer/src/lib/source-sync/top-level-subtree.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block', attrs: { spread: { default: 'false' } } },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 }, spread: { default: 'false' } } },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null }, label: { default: null }, listType: { default: null }, spread: { default: 'false' } }
    },
    text: { group: 'inline' }
  }
})

const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? schema.text(value) : null)
const bulletItem = (value, extraParagraphs = []) => schema.nodes.list_item.create(
  { checked: null, label: '•', listType: 'bullet', spread: 'false' },
  [paragraph(value), ...extraParagraphs.map(paragraph)]
)
const orderedItem = (label, value = '') => schema.nodes.list_item.create(
  { checked: null, label, listType: 'ordered', spread: 'false' },
  paragraph(value)
)
const taskItem = (value = '') => schema.nodes.list_item.create(
  { checked: false, label: '•', listType: 'bullet', spread: 'false' },
  paragraph(value)
)
const bulletList = (...items) => schema.nodes.bullet_list.create({ spread: 'false' }, items)
const orderedList = (...items) => schema.nodes.ordered_list.create({ order: 1, spread: 'false' }, items)
const document = (...blocks) => schema.nodes.doc.create(null, blocks)

// Production-shaped resolver: locate the textblock containing pmPos and map
// it to the start of its (unique) line IN THE PASSED MARKDOWN (the owner
// resolves both the authored source and the canonical baseline).
const markdownAwareResolver = ({ markdown, pmPos, doc }) => {
  let $pos
  try { $pos = doc.resolve(pmPos) } catch { return null }
  const text = $pos.parent?.textContent
  if (!text || typeof markdown !== 'string') return null
  const at = markdown.indexOf(text)
  if (at < 0) return null
  return markdown.lastIndexOf('\n', at) + 1
}

const textTransaction = (doc, at, insert, { from = null } = {}) => {
  // The journal only consumes steps; the default (auto-near) selection keeps
  // this safe for documents whose first block is a list.
  const state = EditorState.create({ schema, doc })
  const tr = state.tr
  if (from == null) tr.insertText(insert, at)
  else tr.replaceWith(from, at, insert ? schema.text(insert) : null)
  return tr
}

const captureJournal = ({ source, canonical, oldDoc, transactions, revision = 38723 }) => {
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
  fillSteps,
  source,
  canonicalBaseline,
  canonical = 'current-canonical',
  validateMarkdown,
  resolver,
  revision = 38723,
  callbackDocumentEquivalent = true,
  activeJournalOverride = null
}) => {
  const captured = captureJournal({
    source,
    canonical: canonicalBaseline,
    oldDoc,
    transactions: fillSteps(oldDoc),
    revision
  })
  const owner = createListEmptyItemTextFillTransactionSourceSyncOwner({
    resolveMarkdownOffset: resolver || markdownAwareResolver,
    validateMarkdown: validateMarkdown || (() => true)
  })
  const plan = owner.plan({
    journal: captured.journal,
    activeJournal: activeJournalOverride || captured.journal,
    snapshot: captured.snapshot,
    currentSource: source,
    currentCanonical: canonicalBaseline,
    canonical,
    expectedDoc: captured.expectedDoc,
    callbackDocumentEquivalent,
    boundary: LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_BOUNDARY
  })
  return { ...captured, owner, plan }
}

// ---------------------------------------------------------------------------
// 1. The incident shape (trace-38723): a loose top-level bullet list whose
//    last item is the empty sibling a split just published; an IME chain
//    fills it. Authored source keeps its own escapes (>=), marker spellings,
//    the empty `- ` row and the blank line before the fence.
// ---------------------------------------------------------------------------
const incidentOldDoc = document(
  paragraph('intro'),
  bulletList(
    bulletItem('可用版本：', ['>= 2.6.0']),
    bulletItem('时间复杂度：', ['O(1)']),
    bulletItem('返回值：', ['执行加法操作之后 值。色剂狂放不羁开始']),
    bulletItem('')
  ),
  paragraph('after fence')
)
const incidentSource = 'intro\n\n- 可用版本：\n\n  >= 2.6.0\n\n- 时间复杂度：\n\n  O(1)\n\n- 返回值：\n\n  执行加法操作之后 值。色剂狂放不羁开始\n\n- \n\nafter fence\n'
const incidentPrevious = 'intro\n\n- 可用版本：\n\n  > \\= 2.6.0\n- 时间复杂度：\n\n  O(1)\n- 返回值：\n\n  执行加法操作之后 值。色剂狂放不羁开始\n- <br />\n\nafter fence\n'
const incidentExpected = 'intro\n\n- 可用版本：\n\n  >= 2.6.0\n\n- 时间复杂度：\n\n  O(1)\n\n- 返回值：\n\n  执行加法操作之后 值。色剂狂放不羁开始\n\n- 色不放假\n\nafter fence\n'

// IME-shaped chain into the empty item's paragraph: incremental composition
// inserts, then a replacement that lands the final word.
const incidentFill = (doc) => {
  const emptyParagraph = sourceSyncNodeEntryAtPath(doc, [1, 3, 0])
  const start = emptyParagraph.contentStart
  const first = textTransaction(doc, start, '色')
  const second = textTransaction(first.doc, start + 1, '不')
  const third = textTransaction(second.doc, start + 2, '放假')
  const final = textTransaction(third.doc, start + 4, '色不放假', { from: start })
  return [first, second, third, final]
}

let incidentValidated = null
const incident = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource,
  canonicalBaseline: incidentPrevious,
  validateMarkdown: ({ markdown }) => {
    incidentValidated = markdown
    return markdown === incidentExpected
  }
})
assert.equal(incident.plan.ok, true, JSON.stringify(incident.plan))
assert.equal(incident.plan.family, LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_FAMILY)
assert.equal(incident.plan.boundary, LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_BOUNDARY)
assert.equal(incident.plan.decision, 'owned')
assert.equal(incident.plan.result.reason, 'list-empty-item-text-filled')
assert.equal(incident.plan.result.markdown, incidentExpected)
assert.equal(incidentValidated, incidentExpected)
assert.equal(incident.plan.proof.listKind, 'bullet')
assert.equal(incident.plan.proof.itemIndex, 3)
assert.equal(incident.plan.proof.finalText, '色不放假')
assert.equal(incident.plan.proof.sourceRow.token, '-')
assert.equal(incident.plan.proof.sourceRow.indent, '')
assert.equal(incident.plan.proof.sourceRow.spacing, ' ')
assert.equal(incident.plan.proof.sourceRow.body, '')
assert.equal(incident.plan.proof.rawInsertion.text, '色不放假')
assert.equal(incident.plan.proof.pendingTextChain.textStepCount, 4)
assert.equal(incident.plan.proof.chainLength, 4)
// Byte evidence: only the empty row's body changed.
assert.equal(
  incident.plan.result.markdown,
  incidentSource.replace('\n\n- \n\nafter fence', '\n\n- 色不放假\n\nafter fence')
)

// ---------------------------------------------------------------------------
// 2. Single plain insert (no IME replacement tail) in the same shape.
// ---------------------------------------------------------------------------
const singleInsert = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [1, 3, 0]).contentStart
    return [textTransaction(doc, start, '字')]
  },
  source: incidentSource,
  canonicalBaseline: incidentPrevious
})
assert.equal(singleInsert.plan.ok, true, JSON.stringify(singleInsert.plan))
assert.equal(singleInsert.plan.proof.pendingTextChain.textStepCount, 1)

// ---------------------------------------------------------------------------
// 3. Ordered empty sibling fill: ordinal must equal list order + item index.
// ---------------------------------------------------------------------------
const orderedOldDoc = document(
  orderedList(orderedItem('1.', '甲'), orderedItem('2.', ''))
)
const orderedFill = planFor({
  oldDoc: orderedOldDoc,
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 1, 0]).contentStart
    return [textTransaction(doc, start, '乙')]
  },
  source: '1. 甲\n2. \n',
  canonicalBaseline: '1. 甲\n2. <br />\n'
})
assert.equal(orderedFill.plan.ok, true, JSON.stringify(orderedFill.plan))
assert.equal(orderedFill.plan.result.markdown, '1. 甲\n2. 乙\n')
assert.equal(orderedFill.plan.proof.listKind, 'ordered')

// ---------------------------------------------------------------------------
// 4. Empty item FIRST: the anchor falls back to the following sibling.
// ---------------------------------------------------------------------------
const firstEmptyOldDoc = document(
  bulletList(bulletItem(''), bulletItem('乙'))
)
const firstEmptyFill = planFor({
  oldDoc: firstEmptyOldDoc,
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 0, 0]).contentStart
    return [textTransaction(doc, start, '甲')]
  },
  source: '- \n- 乙\n',
  canonicalBaseline: '- <br />\n- 乙\n'
})
assert.equal(firstEmptyFill.plan.ok, true, JSON.stringify(firstEmptyFill.plan))
assert.equal(firstEmptyFill.plan.result.markdown, '- 甲\n- 乙\n')
assert.equal(firstEmptyFill.plan.proof.itemIndex, 0)

// ---------------------------------------------------------------------------
// Chain-stage misses: plain rejections (recognized must stay false so other
// families and legacy remain available).
// ---------------------------------------------------------------------------
const plainRejection = (label, plan, reason) => {
  assert.equal(plan.ok, false, `${label}: expected rejection`)
  assert.equal(plan.decision, 'rejected', label)
  assert.equal(plan.reason, reason, `${label}: ${plan.reason}`)
  assert.equal(plan.recognized, false, `${label}: must not be recognized`)
}

// 5. Text into an already NON-empty item paragraph (list-item-paragraph
//    family territory).
const nonEmptyTarget = planFor({
  oldDoc: document(bulletList(bulletItem('已有正文'))),
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 0, 0]).contentStart
    return [textTransaction(doc, start + 4, '文')]
  },
  source: '- 已有正文\n',
  canonicalBaseline: '- 已有正文\n'
})
plainRejection('non-empty target', nonEmptyTarget.plan, 'empty-item-fill-target-not-empty')

// 6. Steps spanning two paragraphs.
const foreignStep = planFor({
  oldDoc: document(bulletList(bulletItem('甲'), bulletItem('')), paragraph('乙')),
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 1, 0]).contentStart
    const first = textTransaction(doc, start, '丙')
    const second = textTransaction(first.doc, sourceSyncNodeEntryAtPath(first.doc, [1]).contentStart, '丁')
    return [first, second]
  },
  source: '- 甲\n- \n\n乙\n',
  canonicalBaseline: '- 甲\n- <br />\n\n乙\n'
})
plainRejection('foreign paragraph step', foreignStep.plan, 'empty-item-fill-text-outside-target-paragraph')

// 7. Task item (checkbox) empty fill belongs to the task sentinel family.
const taskTarget = planFor({
  oldDoc: document(bulletList(taskItem(''), taskItem('乙'))),
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 0, 0]).contentStart
    return [textTransaction(doc, start, '甲')]
  },
  source: '- [ ] \n- [ ] 乙\n',
  canonicalBaseline: '- [ ] <br />\n- [ ] 乙\n'
})
plainRejection('task item', taskTarget.plan, 'empty-item-fill-item-kind')

// 8. Item carrying a nested list (childCount > 1) is a different family.
const nestedChildItem = planFor({
  oldDoc: document(
    bulletList(
      bulletItem('甲'),
      schema.nodes.list_item.create(
        { checked: null, label: '•', listType: 'bullet', spread: 'false' },
        [paragraph(''), bulletList(bulletItem('子'))]
      )
    )
  ),
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 1, 0]).contentStart
    return [textTransaction(doc, start, '乙')]
  },
  source: '- 甲\n- \n  - 子\n',
  canonicalBaseline: '- 甲\n- <br />\n  - 子\n'
})
plainRejection('item with nested list', nestedChildItem.plan, 'empty-item-fill-item-shape')

// 9. Stale journal.
const stale = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource,
  canonicalBaseline: incidentPrevious,
  activeJournalOverride: { stale: true }
})
assert.equal(stale.plan.reset, true, 'stale journal must reset')

// 9b. Trace 51037 (live 0.13.208 session): on documents with pre-existing
// serializer/parser round-trip asymmetry, parse(callback canonical) ≢
// expectedDoc on EVERY callback. The owner must still publish — the journal
// checkpoint binds expectedDoc and validateMarkdown gates the bytes; the old
// hard gate deferred forever on exactly the diverged documents the owner
// exists for, handing publication to the drifted legacy mapper.
const asymCallback = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource,
  canonicalBaseline: incidentPrevious,
  callbackDocumentEquivalent: false
})
assert.equal(asymCallback.plan.ok, true, JSON.stringify(asymCallback.plan))
assert.equal(asymCallback.plan.result.markdown, incidentExpected)
assert.equal(asymCallback.plan.proof.callbackDocumentEquivalent, false)

// ---------------------------------------------------------------------------
// Post-recognition failures: recognized fail-closed (legacy must not be
// allowed to publish a drifted placement for a proven fill).
// ---------------------------------------------------------------------------
const recognizedRejection = (label, plan, reason) => {
  assert.equal(plan.ok, false, `${label}: expected rejection`)
  assert.equal(plan.reason, reason, `${label}: ${plan.reason}`)
  assert.equal(plan.recognized, true, `${label}: must be recognized`)
}

// 10. Source row not empty (source/canonical already diverged there).
const occupiedRow = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource.replace('\n\n- \n\nafter fence', '\n\n- 残留\n\nafter fence'),
  canonicalBaseline: incidentPrevious
})
recognizedRejection('occupied authored row', occupiedRow.plan, 'empty-item-fill-authored-row-unproven')

// 11. Row count mismatch: the authored list drifted an extra marker row.
const extraRow = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource.replace('\n\n- \n\nafter fence', '\n\n- \n\n- 多\n\nafter fence'),
  canonicalBaseline: incidentPrevious
})
recognizedRejection('row count mismatch', extraRow.plan, 'empty-item-fill-row-count')

// 12. Canonical baseline row was never the editor-owned empty placeholder.
const canonicalDrifted = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource,
  canonicalBaseline: incidentPrevious.replace('- <br />', '- 别的字')
})
recognizedRejection('canonical row drifted', canonicalDrifted.plan, 'empty-item-fill-canonical-row-not-empty')

// 13. Ordered ordinal mismatch (author wrote 5. where PM proves 2.).
const ordinalMismatch = planFor({
  oldDoc: orderedOldDoc,
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 1, 0]).contentStart
    return [textTransaction(doc, start, '乙')]
  },
  source: '1. 甲\n5. \n',
  canonicalBaseline: '1. 甲\n2. <br />\n'
})
recognizedRejection('ordinal mismatch', ordinalMismatch.plan, 'empty-item-fill-authored-row-unproven')

// 14. validateMarkdown refuses the filled source (e.g. Markdown-sensitive
//     text that would not reparse to the same document).
const invalidSource = planFor({
  oldDoc: incidentOldDoc,
  fillSteps: incidentFill,
  source: incidentSource,
  canonicalBaseline: incidentPrevious,
  validateMarkdown: () => false
})
recognizedRejection('validation refused', invalidSource.plan, 'empty-item-fill-source-invalid')

// 15. A non-plain step (block node insert) inside the journal is not this
//     family (plain reject so structural families stay available).
const structuralJournal = planFor({
  oldDoc: document(bulletList(bulletItem('甲'), bulletItem('')), paragraph('乙')),
  fillSteps: (doc) => {
    const start = sourceSyncNodeEntryAtPath(doc, [0, 1, 0]).contentStart
    const first = textTransaction(doc, start, '丙')
    const state = EditorState.create({ schema, doc: first.doc })
    const second = state.tr.insert(sourceSyncNodeEntryAtPath(first.doc, [1]).beforePos, paragraph('丁'))
    return [first, second]
  },
  source: '- 甲\n- \n\n乙\n',
  canonicalBaseline: '- 甲\n- <br />\n\n乙\n'
})
plainRejection('non-plain step', structuralJournal.plan, 'empty-item-fill-pre-terminal-step-contract')

console.log('test-list-empty-item-text-fill-transaction-owner: all contracts passed')
