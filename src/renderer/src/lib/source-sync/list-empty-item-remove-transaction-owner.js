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

export const LIST_EMPTY_ITEM_REMOVE_TRANSACTION_FAMILY = 'list-empty-item-remove'
export const LIST_EMPTY_ITEM_REMOVE_TRANSACTION_BOUNDARY = 'transaction-list-empty-item-remove'

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
    return rejected('list-empty-item-document-missing')
  }
  const before = topLevelEntries(journal.oldDoc)
  const after = topLevelEntries(expectedDoc)
  if (before.length !== after.length) return rejected('list-empty-item-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('list-empty-item-top-level-change-count')
  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    !supportedList(previousList) ||
    previousList.type?.name !== nextList?.type?.name ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    previousList.childCount !== nextList.childCount + 1
  ) return rejected('list-empty-item-list-shape')

  const candidates = []
  for (let removedIndex = 1; removedIndex < previousList.childCount - 1; removedIndex += 1) {
    const removed = previousList.child(removedIndex)
    if (!plainItem(removed) || removed.childCount !== 1 || !plainEmptyParagraph(removed.firstChild)) continue

    const previousLeft = previousList.child(removedIndex - 1)
    const nextLeft = nextList.child(removedIndex - 1)
    if (
      !plainItem(previousLeft) ||
      !plainItem(nextLeft) ||
      !sourceSyncAttrsEqual(previousLeft.attrs, nextLeft.attrs) ||
      nextLeft.childCount !== previousLeft.childCount + 1 ||
      !itemChildrenEqualPrefix(previousLeft, nextLeft, previousLeft.childCount) ||
      !plainEmptyParagraph(nextLeft.child(nextLeft.childCount - 1))
    ) continue

    let siblingsMatch = true
    for (let oldIndex = 0; oldIndex < previousList.childCount; oldIndex += 1) {
      if (oldIndex === removedIndex || oldIndex === removedIndex - 1) continue
      const nextIndex = oldIndex > removedIndex ? oldIndex - 1 : oldIndex
      if (previousList.child(oldIndex)?.eq?.(nextList.child(nextIndex)) !== true) {
        siblingsMatch = false
        break
      }
    }
    if (siblingsMatch) candidates.push({ removedIndex, previousLeft, nextLeft, removed })
  }
  if (candidates.length !== 1) {
    return rejected('list-empty-item-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  const target = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('list-empty-item-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) || !sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return recognizedRejection('list-empty-item-step-document')
  }
  if (
    step?.constructor?.name !== 'ReplaceStep' ||
    step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    step.to <= step.from ||
    Number(step.slice?.size || 0) !== 0
  ) return recognizedRejection('list-empty-item-step-shape')

  const removedPath = [topLevelIndex, target.removedIndex]
  const leftPath = [topLevelIndex, target.removedIndex - 1]
  const rightPath = [topLevelIndex, target.removedIndex + 1]
  const removedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, removedPath)
  const leftEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, leftPath)
  const rightEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, rightPath)
  if (
    !removedEntry || removedEntry.type !== 'list_item' ||
    !leftEntry || leftEntry.type !== 'list_item' ||
    !rightEntry || rightEntry.type !== 'list_item'
  ) return recognizedRejection('list-empty-item-path')

  const leftEnd = leftEntry.beforePos + leftEntry.node.nodeSize
  const removedEnd = removedEntry.beforePos + removedEntry.node.nodeSize
  // ProseMirror's physical Backspace does not delete the whole empty list_item.
  // It removes exactly the closing wrapper boundary of the preceding item and
  // the opening wrapper boundary of the empty item. That joins the empty
  // paragraph into the preceding item; the now-empty wrapper disappears as a
  // consequence of the structural replace. Bind ownership to that exact PM
  // boundary relation instead of accepting any range somewhere inside the list.
  if (
    removedEntry.beforePos !== leftEnd ||
    rightEntry.beforePos !== removedEnd ||
    step.from !== leftEnd - 1 ||
    step.to !== removedEntry.contentStart
  ) return recognizedRejection('list-empty-item-step-range')
  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('list-empty-item-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex,
    listType: previousList.type.name,
    previousList,
    nextList,
    removedIndex: target.removedIndex,
    removedPath: Object.freeze(removedPath),
    transientListItemPath: Object.freeze([topLevelIndex, target.removedIndex - 1]),
    transientParagraphPath: Object.freeze([
      topLevelIndex,
      target.removedIndex - 1,
      target.nextLeft.childCount - 1
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

const removeAuthoredRow = ({ source, sourceList, removedIndex, listType }) => {
  if (sourceList.rows.length <= removedIndex) return null
  const row = sourceList.rows[removedIndex]
  if (kindForToken(row.token) !== (listType === 'ordered_list' ? 'ordered' : 'bullet')) return null
  if (row.body.replace(/\u200B/g, '').trim() !== '') return null

  const previous = sourceList.rows[removedIndex - 1]
  const next = sourceList.rows[removedIndex + 1]
  if (!previous || !next) return null
  if (kindForToken(previous.token) !== kindForToken(row.token) || kindForToken(next.token) !== kindForToken(row.token)) {
    return null
  }

  const eol = lineEndingNear(source, row.start)
  // markdownLines.end points at the LF byte (and its text includes the CR for
  // CRLF). For an interior row, the complete physical terminator therefore
  // always ends one byte after `line.end`, independent of LF vs CRLF.
  const previousBreakEnd = previous.end < source.length && source[previous.end] === '\n'
    ? previous.end + 1
    : previous.end
  const rowEnd = row.end < source.length && source[row.end] === '\n'
    ? row.end + 1
    : row.end
  if (previousBreakEnd !== row.start || rowEnd !== next.start) {
    return null
  }
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
    reason: 'list-empty-item-removed',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_EMPTY_ITEM_REMOVE_TRANSACTION_FAMILY,
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

export function createListEmptyItemRemoveTransactionSourceSyncOwner({ resolveMarkdownOffset } = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('list empty item remove owner requires resolveMarkdownOffset')
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
    boundary = LIST_EMPTY_ITEM_REMOVE_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('list-empty-item-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) {
      return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    }
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('list-empty-item-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('list-empty-item-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('list-empty-item-callback-document-mismatch', { deferred: true })
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
      return recognizedRejection('list-empty-item-range-unmapped')
    }
    if (
      sourceList.rows.length !== classification.previousList.childCount ||
      previousList.rows.length !== classification.previousList.childCount
    ) return recognizedRejection('list-empty-item-row-count')
    const previousRow = previousList.rows[classification.removedIndex]
    if (
      !previousRow ||
      kindForToken(previousRow.token) !== (classification.listType === 'ordered_list' ? 'ordered' : 'bullet') ||
      !/^<br\s*\/?>$/i.test(previousRow.body.trim())
    ) return recognizedRejection('list-empty-item-previous-row-not-empty')

    const removed = removeAuthoredRow({
      source: journal.source,
      sourceList,
      removedIndex: classification.removedIndex,
      listType: classification.listType
    })
    if (!removed) return recognizedRejection('list-empty-item-authored-row-unproven')

    const proof = Object.freeze({
      kind: 'transaction-list-empty-item-remove-proof',
      journalId: journal.journalId,
      family: LIST_EMPTY_ITEM_REMOVE_TRANSACTION_FAMILY,
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
    family: LIST_EMPTY_ITEM_REMOVE_TRANSACTION_FAMILY,
    boundary: LIST_EMPTY_ITEM_REMOVE_TRANSACTION_BOUNDARY,
    plan
  })
}
