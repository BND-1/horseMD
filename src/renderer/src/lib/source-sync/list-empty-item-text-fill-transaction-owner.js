import { markdownLines } from '../markdown-preservation/core.js'
import { listBlockAt } from '../markdown-preservation/lists.js'
import { provePendingTextTransactionChain } from './pending-text-transaction-chain.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_FAMILY = 'list-empty-item-text-filled'
export const LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_BOUNDARY = 'transaction-list-empty-item-text-filled'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })
const recognizedRejection = (reason, options = {}) => rejected(reason, { ...options, recognized: true })

const plainParagraph = (node, { allowEmpty = false } = {}) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (!allowEmpty && node.content?.size <= 0) return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) !== 0) plain = false
  })
  return plain
}
const itemListKind = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return null
  const explicit = node.attrs?.listType
  if (explicit == null || explicit === '' || explicit === 'bullet') return 'bullet'
  if (explicit === 'ordered') return 'ordered'
  return null
}
const listKindFor = (node) => {
  if (node?.type?.name === 'bullet_list') return 'bullet'
  if (node?.type?.name === 'ordered_list') return 'ordered'
  return null
}
const isAnchorParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && (node.textContent || '') !== ''

// Derive the paragraph's child-index path by node identity. ResolvedPos.index
// counts the child BELOW the depth, which is off-by-one for alternating list
// nesting (see the nested-bullet split owner for the original evidence).
const paragraphPathForStep = ({ stepDoc, step }) => {
  let $from
  let $to
  try {
    $from = stepDoc.resolve(step.from)
    $to = stepDoc.resolve(step.to)
  } catch {
    return null
  }
  if (!$from.sameParent?.($to) || $from.parent?.type?.name !== 'paragraph') return null
  const path = []
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    const parent = $from.node(depth - 1)
    const child = $from.node(depth)
    let childIndex = -1
    parent.forEach?.((node, _offset, index) => {
      if (node === child) childIndex = index
    })
    if (childIndex < 0) return null
    path.push(childIndex)
  }
  return path
}

// Trace 38723 (0.13.207, 2026-09-12 10:16): after a loose item's continuation
// paragraph is split into an empty sibling (the split itself publishes via the
// legacy middle-block path), an IME composition fills the empty item. The
// empty marker row contributes zero visible characters, so the generic
// locally-aligned mapper drifts the insertion into the PREVIOUS paragraph and
// the strict list-slot gate fail-closes — warning, source stops tracking the
// editor. This owner claims that fill: the journal must be 0..N closed
// plain-text ReplaceSteps landing in the SAME sole paragraph of a proven plain
// (non-task) list item that is EMPTY at chain start, and the authored source
// must carry the item's empty marker row. The patch writes the final paragraph
// text into that row's body; indent, token, spacing, EOL and every other byte
// stay untouched.
const validateTextChain = ({ journal, expectedDoc, textSteps }) => {
  if (!textSteps?.length) return { ok: false, reason: 'empty-item-fill-text-steps-missing' }
  let paragraphPath = null
  for (const textStep of textSteps) {
    const path = paragraphPathForStep({ stepDoc: textStep.stepDoc, step: textStep.step })
    if (!path) return { ok: false, reason: 'empty-item-fill-text-outside-paragraph' }
    if (paragraphPath) {
      if (JSON.stringify(paragraphPath) !== JSON.stringify(path)) {
        return { ok: false, reason: 'empty-item-fill-text-outside-target-paragraph' }
      }
    } else {
      paragraphPath = path
    }
  }

  const oldDoc = journal.oldDoc
  const paragraphEntry = sourceSyncNodeEntryAtPath(oldDoc, paragraphPath)
  if (!paragraphEntry || paragraphEntry.type !== 'paragraph' || paragraphEntry.node.content?.size !== 0) {
    return { ok: false, reason: 'empty-item-fill-target-not-empty' }
  }
  if (paragraphPath[paragraphPath.length - 1] !== 0) {
    return { ok: false, reason: 'empty-item-fill-item-shape' }
  }
  const itemPath = paragraphPath.slice(0, -1)
  const itemIndex = itemPath[itemPath.length - 1]
  const itemEntry = sourceSyncNodeEntryAtPath(oldDoc, itemPath)
  if (!itemEntry || itemEntry.type !== 'list_item' || itemEntry.node.childCount !== 1) {
    return { ok: false, reason: 'empty-item-fill-item-shape' }
  }
  const kind = itemListKind(itemEntry.node)
  if (!kind) return { ok: false, reason: 'empty-item-fill-item-kind' }
  const listPath = itemPath.slice(0, -1)
  const listEntry = sourceSyncNodeEntryAtPath(oldDoc, listPath)
  if (!listEntry || listKindFor(listEntry.node) !== kind) {
    return { ok: false, reason: 'empty-item-fill-list-shape' }
  }

  const filledParagraphEntry = sourceSyncNodeEntryAtPath(expectedDoc, paragraphPath)
  const filledItemEntry = sourceSyncNodeEntryAtPath(expectedDoc, itemPath)
  if (
    !filledParagraphEntry || !plainParagraph(filledParagraphEntry.node) ||
    !filledItemEntry || filledItemEntry.type !== 'list_item' ||
    filledItemEntry.node.childCount !== 1 ||
    !sourceSyncAttrsEqual(filledItemEntry.node.attrs, itemEntry.node.attrs)
  ) return { ok: false, reason: 'empty-item-fill-filled-item-shape' }

  // The anchor is a NON-EMPTY first paragraph of a neighbouring item in the
  // same list: empty paragraphs have no reliable text offset mapping, so the
  // authored row is located through the neighbour and the list block scan.
  const list = listEntry.node
  let anchorParagraphPath = null
  if (itemIndex > 0) {
    const candidate = [...listPath, itemIndex - 1, 0]
    const entry = sourceSyncNodeEntryAtPath(oldDoc, candidate)
    if (isAnchorParagraph(entry?.node)) anchorParagraphPath = candidate
  }
  if (!anchorParagraphPath && itemIndex + 1 < list.childCount) {
    const candidate = [...listPath, itemIndex + 1, 0]
    const entry = sourceSyncNodeEntryAtPath(oldDoc, candidate)
    if (isAnchorParagraph(entry?.node)) anchorParagraphPath = candidate
  }
  if (!anchorParagraphPath) return { ok: false, reason: 'empty-item-fill-anchor-missing' }

  return {
    ok: true,
    proof: {
      listKind: kind,
      listPath: Object.freeze([...listPath]),
      itemPath: Object.freeze([...itemPath]),
      itemIndex,
      paragraphPath: Object.freeze([...paragraphPath]),
      anchorParagraphPath: Object.freeze(anchorParagraphPath),
      finalText: filledParagraphEntry.node.textContent
    }
  }
}

const classify = ({ journal, expectedDoc }) =>
  provePendingTextTransactionChain({
    journal,
    expectedDoc,
    reasonPrefix: 'empty-item-fill',
    requireTerminal: false,
    validateTextChain
  })

const markerRows = (markdown, block) => markdownLines(markdown)
  .map((line) => {
    if (line.start < block.start || line.start > block.end) return null
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match || match[1].length !== block.indent) return null
    return Object.freeze({
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body: match[4],
      start: line.start,
      end: line.end,
      bodyStart: line.start + match[1].length + match[2].length + match[3].length
    })
  })
  .filter(Boolean)

const resolveListRows = ({ markdown, doc, anchorParagraphPath, resolveMarkdownOffset }) => {
  const anchorEntry = sourceSyncNodeEntryAtPath(doc, anchorParagraphPath)
  if (!anchorEntry) return null
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos: anchorEntry.contentStart,
      doc,
      topLevelIndex: anchorParagraphPath[0],
      role: 'empty-item-fill-anchor'
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  const block = listBlockAt(markdown, rawOffset)
  if (!block) return null
  return Object.freeze({ block, rows: markerRows(markdown, block), rawOffset })
}

const tokenMatchesKind = (token, kind) => kind === 'bullet'
  ? /^[-+]$/.test(token) || token === '*'
  : /^\d{1,9}[.)]$/.test(token)

const fillAuthoredRow = ({ source, row, text, kind, list, itemIndex }) => {
  if (!tokenMatchesKind(row.token, kind)) return null
  if (row.body !== '') return null
  if (kind === 'ordered') {
    const start = Number(list.attrs?.order ?? 1)
    const ordinal = Number.parseInt(row.token, 10)
    if (!Number.isInteger(ordinal) || ordinal !== start + itemIndex) return null
  }
  return Object.freeze({
    markdown: source.slice(0, row.bodyStart) + text + source.slice(row.bodyStart),
    row: Object.freeze({
      indent: row.indent,
      token: row.token,
      spacing: row.spacing,
      body: row.body,
      bodyStart: row.bodyStart,
      end: row.end
    }),
    insertion: Object.freeze({ at: row.bodyStart, text })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-empty-item-text-filled',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_FAMILY,
    boundary,
    reason: result.reason,
    baseRevision: proof.transactionJournal.baseRevision,
    baseSourceDigest: proof.transactionJournal.baseSourceDigest,
    baseCanonicalDigest: proof.transactionJournal.baseCanonicalDigest,
    proof,
    result,
    canonical,
    expectedDoc,
    publication: Object.freeze({
      result,
      canonical,
      expectedDoc,
      validationSite: boundary,
      boundary,
      notifyChange: true
    })
  })
}

export function createListEmptyItemTextFillTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('empty item text fill owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('empty item text fill owner requires validateMarkdown')
  }

  const plan = ({
    journal,
    activeJournal,
    snapshot,
    currentSource,
    currentCanonical,
    canonical,
    expectedDoc,
    callbackDocumentEquivalent = false,
    boundary = LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('empty-item-fill-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('empty-item-fill-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('empty-item-fill-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('empty-item-fill-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return rejected(classification.reason, { proof: classification.proof })
    const target = classification.targetProof
    // Family proven from here (chain + empty-item shape): every later failure
    // is a recognized fail-closed so the generic locally-aligned mapper can
    // never publish a drifted placement for this fill again.
    const sourceList = resolveListRows({
      markdown: journal.source,
      doc: journal.oldDoc,
      anchorParagraphPath: target.anchorParagraphPath,
      resolveMarkdownOffset
    })
    const canonicalList = resolveListRows({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      anchorParagraphPath: target.anchorParagraphPath,
      resolveMarkdownOffset
    })
    if (!sourceList || !canonicalList) {
      return recognizedRejection('empty-item-fill-range-unmapped')
    }
    const listEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, target.listPath)
    const itemCount = listEntry?.node?.childCount || 0
    if (
      itemCount < 1 ||
      sourceList.rows.length !== itemCount ||
      canonicalList.rows.length !== itemCount
    ) return recognizedRejection('empty-item-fill-row-count')
    if (target.itemIndex >= sourceList.rows.length) {
      return recognizedRejection('empty-item-fill-row-count')
    }
    const canonicalRow = canonicalList.rows[target.itemIndex]
    if (!/^<br\s*\/?>$/i.test((canonicalRow?.body || '').trim())) {
      return recognizedRejection('empty-item-fill-canonical-row-not-empty')
    }
    const filled = fillAuthoredRow({
      source: journal.source,
      row: sourceList.rows[target.itemIndex],
      text: target.finalText,
      kind: target.listKind,
      list: listEntry.node,
      itemIndex: target.itemIndex
    })
    if (!filled) return recognizedRejection('empty-item-fill-authored-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: filled.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('empty-item-fill-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-empty-item-text-filled-proof',
      journalId: journal.journalId,
      family: LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_FAMILY,
      listKind: target.listKind,
      listPath: target.listPath,
      itemPath: target.itemPath,
      itemIndex: target.itemIndex,
      paragraphPath: target.paragraphPath,
      anchorParagraphPath: target.anchorParagraphPath,
      finalText: target.finalText,
      step: null,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      pendingTextChain: Object.freeze({
        textStepCount: classification.textStepCount,
        textTransactionCount: classification.textTransactionCount
      }),
      transactionJournal: verified.proof,
      sourceRow: filled.row,
      rawInsertion: filled.insertion,
      sourceBlock: Object.freeze({ start: sourceList.block.start, end: sourceList.block.end }),
      canonicalBlock: Object.freeze({ start: canonicalList.block.start, end: canonicalList.block.end }),
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(filled.markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown: filled.markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_FAMILY,
    boundary: LIST_EMPTY_ITEM_TEXT_FILL_TRANSACTION_BOUNDARY,
    plan
  })
}
