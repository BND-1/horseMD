import { lineEndingNear, markdownLines } from '../markdown-preservation/core.js'
import { listBlockAt } from '../markdown-preservation/lists.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_FAMILY = 'list-empty-item-tail-remove'
export const LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_BOUNDARY = 'transaction-list-empty-item-tail-remove'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const supportedList = (node) =>
  node?.type?.name === 'bullet_list' || node?.type?.name === 'ordered_list'

const plainEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size === 0

const plainNonEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size > 0

const plainItem = (node) =>
  node?.type?.name === 'list_item' && node.attrs?.checked == null

const topLevelEntries = (doc) => topLevelSourceSyncEntries(doc)

const itemChildrenEqualPrefix = (before, after, count) => {
  if (!before || !after || count < 0) return false
  for (let index = 0; index < count; index += 1) {
    if (before.child(index)?.eq?.(after.child(index)) !== true) return false
  }
  return true
}

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('list-empty-item-tail-document-missing')
  }
  const before = topLevelEntries(journal.oldDoc)
  const after = topLevelEntries(expectedDoc)
  if (before.length !== after.length) return rejected('list-empty-item-tail-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('list-empty-item-tail-top-level-change-count')

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    !supportedList(previousList) ||
    previousList.type?.name !== nextList?.type?.name ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    previousList.childCount < 2 ||
    previousList.childCount !== nextList.childCount + 1
  ) return rejected('list-empty-item-tail-list-shape')

  const removedIndex = previousList.childCount - 1
  const removed = previousList.child(removedIndex)
  const previousLeft = previousList.child(removedIndex - 1)
  const nextLeft = nextList.child(removedIndex - 1)
  if (
    !plainItem(removed) ||
    removed.childCount !== 1 ||
    !plainEmptyParagraph(removed.firstChild) ||
    !plainItem(previousLeft) ||
    !plainItem(nextLeft) ||
    !sourceSyncAttrsEqual(previousLeft.attrs, nextLeft.attrs) ||
    previousLeft.childCount !== 1 ||
    !plainNonEmptyParagraph(previousLeft.firstChild) ||
    nextLeft.childCount !== 2 ||
    !itemChildrenEqualPrefix(previousLeft, nextLeft, 1) ||
    !plainEmptyParagraph(nextLeft.child(1))
  ) return rejected('list-empty-item-tail-target-shape')

  for (let index = 0; index < removedIndex - 1; index += 1) {
    if (previousList.child(index)?.eq?.(nextList.child(index)) !== true) {
      return rejected('list-empty-item-tail-sibling-change')
    }
  }

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('list-empty-item-tail-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) || !sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return recognizedRejection('list-empty-item-tail-step-document')
  }
  if (
    step?.constructor?.name !== 'ReplaceStep' ||
    step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    step.to <= step.from ||
    Number(step.slice?.size || 0) !== 0
  ) return recognizedRejection('list-empty-item-tail-step-shape')

  const removedPath = [topLevelIndex, removedIndex]
  const leftPath = [topLevelIndex, removedIndex - 1]
  const removedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, removedPath)
  const leftEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, leftPath)
  if (
    !removedEntry || removedEntry.type !== 'list_item' ||
    !leftEntry || leftEntry.type !== 'list_item'
  ) return recognizedRejection('list-empty-item-tail-path')

  const leftEnd = leftEntry.beforePos + leftEntry.node.nodeSize
  if (
    removedEntry.beforePos !== leftEnd ||
    step.from !== leftEnd - 1 ||
    step.to !== removedEntry.contentStart
  ) return recognizedRejection('list-empty-item-tail-step-range')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('list-empty-item-tail-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex,
    listType: previousList.type.name,
    previousList,
    nextList,
    removedIndex,
    removedPath: Object.freeze(removedPath),
    transientListItemPath: Object.freeze(leftPath),
    transientParagraphPath: Object.freeze([
      topLevelIndex,
      removedIndex - 1,
      nextLeft.childCount - 1
    ]),
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      structure: true,
      sliceSize: Number(step.slice?.size || 0)
    })
  })
}

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
      end: line.end
    })
  })
  .filter(Boolean)

const kindForToken = (token) => /^\d/.test(token || '') ? 'ordered' : 'bullet'

const resolveList = ({ markdown, doc, topLevelIndex, resolveMarkdownOffset }) => {
  const listEntry = topLevelEntries(doc)[topLevelIndex]
  const firstItem = listEntry?.node?.firstChild
  const firstParagraph = firstItem?.firstChild
  if (!listEntry || !firstParagraph) return null
  const anchor = listEntry.contentStart + 1 + 1
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({ markdown, pmPos: anchor, doc, topLevelIndex })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  const block = listBlockAt(markdown, rawOffset)
  if (!block || block.indent !== 0) return null
  const rows = markerRows(markdown, block)
  return Object.freeze({ block, rows, rawOffset })
}

const removeAuthoredTailRow = ({ source, sourceList, removedIndex, listType }) => {
  if (removedIndex !== sourceList.rows.length - 1) return null
  const row = sourceList.rows[removedIndex]
  if (!row) return null
  const kind = listType === 'ordered_list' ? 'ordered' : 'bullet'
  if (kindForToken(row.token) !== kind) return null
  if (row.body.replace(/\u200B/g, '').trim() !== '') return null

  const previous = sourceList.rows[removedIndex - 1]
  if (!previous || kindForToken(previous.token) !== kind) return null
  const previousBreakEnd = previous.end < source.length && source[previous.end] === '\n'
    ? previous.end + 1
    : previous.end
  if (previousBreakEnd !== row.start) return null

  const eol = lineEndingNear(source, row.start)
  const rowEnd = row.end < source.length && source[row.end] === '\n'
    ? row.end + 1
    : row.end
  return Object.freeze({
    markdown: source.slice(0, row.start) + source.slice(rowEnd),
    range: Object.freeze({ start: row.start, end: rowEnd }),
    row: Object.freeze({ token: row.token, spacing: row.spacing, body: row.body, indent: row.indent }),
    eol
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-empty-item-tail-removed',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_FAMILY,
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

export function createListEmptyItemTailRemoveTransactionSourceSyncOwner({ resolveMarkdownOffset } = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('list empty item tail remove owner requires resolveMarkdownOffset')
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
    boundary = LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('list-empty-item-tail-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) {
      return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    }
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('list-empty-item-tail-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('list-empty-item-tail-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('list-empty-item-tail-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const sourceList = resolveList({
      markdown: journal.source,
      doc: journal.oldDoc,
      topLevelIndex: classification.topLevelIndex,
      resolveMarkdownOffset
    })
    const previousList = resolveList({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      topLevelIndex: classification.topLevelIndex,
      resolveMarkdownOffset
    })
    if (!sourceList || !previousList) {
      return recognizedRejection('list-empty-item-tail-range-unmapped')
    }
    if (
      sourceList.rows.length !== classification.previousList.childCount ||
      previousList.rows.length !== classification.previousList.childCount
    ) return recognizedRejection('list-empty-item-tail-row-count')

    const previousRow = previousList.rows[classification.removedIndex]
    if (
      !previousRow ||
      kindForToken(previousRow.token) !== (classification.listType === 'ordered_list' ? 'ordered' : 'bullet') ||
      !/^<br\s*\/?>$/i.test(previousRow.body.trim())
    ) return recognizedRejection('list-empty-item-tail-previous-row-not-empty')

    const removed = removeAuthoredTailRow({
      source: journal.source,
      sourceList,
      removedIndex: classification.removedIndex,
      listType: classification.listType
    })
    if (!removed) return recognizedRejection('list-empty-item-tail-authored-row-unproven')

    const proof = Object.freeze({
      kind: 'transaction-list-empty-item-tail-remove-proof',
      journalId: journal.journalId,
      family: LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_FAMILY,
      listType: classification.listType,
      topLevelIndex: classification.topLevelIndex,
      removedIndex: classification.removedIndex,
      removedPath: classification.removedPath,
      transientEmptyListItemPath: classification.transientListItemPath,
      transientEmptyParagraphPath: classification.transientParagraphPath,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceRange: Object.freeze({
        start: sourceList.block.start,
        end: sourceList.block.end,
        rowCount: sourceList.rows.length
      }),
      previousRange: Object.freeze({
        start: previousList.block.start,
        end: previousList.block.end,
        rowCount: previousList.rows.length
      }),
      removedSourceRow: removed.row,
      rawReplacement: removed.range,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(removed.markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown: removed.markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_FAMILY,
    boundary: LIST_EMPTY_ITEM_TAIL_REMOVE_TRANSACTION_BOUNDARY,
    plan
  })
}
