import { markdownLines } from '../markdown-preservation/core.js'
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

export const LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_FAMILY = 'list-empty-item-first-lift'
export const LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_BOUNDARY = 'transaction-list-empty-item-first-lift'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const plainEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size === 0

const plainNonEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size > 0

const plainItem = (node) =>
  node?.type?.name === 'list_item' && node.attrs?.checked == null

const topLevelEntries = (doc) => topLevelSourceSyncEntries(doc)

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('list-empty-item-first-document-missing')
  }
  const before = topLevelEntries(journal.oldDoc)
  const after = topLevelEntries(expectedDoc)
  if (after.length !== before.length + 1) {
    return rejected('list-empty-item-first-top-level-count')
  }

  const candidates = []
  for (let topLevelIndex = 0; topLevelIndex < before.length; topLevelIndex += 1) {
    const previousList = before[topLevelIndex]?.node
    const lifted = after[topLevelIndex]?.node
    const nextList = after[topLevelIndex + 1]?.node
    if (
      previousList?.type?.name !== 'bullet_list' ||
      nextList?.type?.name !== 'bullet_list' ||
      !plainEmptyParagraph(lifted) ||
      !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
      previousList.childCount < 2 ||
      previousList.childCount !== nextList.childCount + 1
    ) continue

    let prefixMatch = true
    for (let index = 0; index < topLevelIndex; index += 1) {
      if (before[index]?.node?.eq?.(after[index]?.node) !== true) {
        prefixMatch = false
        break
      }
    }
    if (!prefixMatch) continue

    let suffixMatch = true
    for (let oldIndex = topLevelIndex + 1; oldIndex < before.length; oldIndex += 1) {
      if (before[oldIndex]?.node?.eq?.(after[oldIndex + 1]?.node) !== true) {
        suffixMatch = false
        break
      }
    }
    if (!suffixMatch) continue

    const removed = previousList.firstChild
    const successor = previousList.child(1)
    const nextSuccessor = nextList.firstChild
    if (
      !plainItem(removed) ||
      removed.childCount !== 1 ||
      !plainEmptyParagraph(removed.firstChild) ||
      !plainItem(successor) ||
      successor.childCount !== 1 ||
      !plainNonEmptyParagraph(successor.firstChild) ||
      successor.eq?.(nextSuccessor) !== true
    ) continue

    let remainingMatch = true
    for (let oldIndex = 1; oldIndex < previousList.childCount; oldIndex += 1) {
      if (previousList.child(oldIndex)?.eq?.(nextList.child(oldIndex - 1)) !== true) {
        remainingMatch = false
        break
      }
    }
    if (!remainingMatch) continue

    candidates.push({ topLevelIndex, previousList, nextList, removed, successor })
  }

  if (candidates.length !== 1) {
    return rejected('list-empty-item-first-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  const target = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('list-empty-item-first-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) || !sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return recognizedRejection('list-empty-item-first-step-document')
  }
  if (
    step?.constructor?.name !== 'ReplaceAroundStep' ||
    step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    !Number.isFinite(step.gapFrom) || !Number.isFinite(step.gapTo) ||
    !Number.isInteger(step.insert) ||
    step.to <= step.from || step.gapTo <= step.gapFrom ||
    Number(step.slice?.size || 0) !== 1 ||
    step.slice?.openStart !== 0 || step.slice?.openEnd !== 1 ||
    step.insert !== 0
  ) return recognizedRejection('list-empty-item-first-step-shape')

  const listPath = [target.topLevelIndex]
  const firstItemPath = [target.topLevelIndex, 0]
  const firstParagraphPath = [target.topLevelIndex, 0, 0]
  const successorPath = [target.topLevelIndex, 1]
  const listEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, listPath)
  const firstItemEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, firstItemPath)
  const firstParagraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, firstParagraphPath)
  const successorEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, successorPath)
  const sliceList = step.slice?.content?.firstChild
  if (
    !listEntry || listEntry.type !== 'bullet_list' ||
    !firstItemEntry || firstItemEntry.type !== 'list_item' ||
    !firstParagraphEntry || firstParagraphEntry.type !== 'paragraph' ||
    !successorEntry || successorEntry.type !== 'list_item' ||
    sliceList?.type?.name !== 'bullet_list' ||
    sliceList.childCount !== 0
  ) return recognizedRejection('list-empty-item-first-path')

  const firstParagraphEnd = firstParagraphEntry.beforePos + firstParagraphEntry.node.nodeSize
  if (
    step.from !== listEntry.beforePos ||
    firstItemEntry.beforePos !== listEntry.contentStart ||
    step.gapFrom !== firstParagraphEntry.beforePos ||
    step.gapTo !== firstParagraphEnd ||
    step.to !== successorEntry.beforePos
  ) return recognizedRejection('list-empty-item-first-step-range')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('list-empty-item-first-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex: target.topLevelIndex,
    listType: 'bullet_list',
    previousList: target.previousList,
    nextList: target.nextList,
    removedIndex: 0,
    removedPath: Object.freeze(firstItemPath),
    liftedParagraphPath: Object.freeze([target.topLevelIndex]),
    remainingListPath: Object.freeze([target.topLevelIndex + 1]),
    successorOldPath: Object.freeze(successorPath),
    successorNewPath: Object.freeze([target.topLevelIndex + 1, 0]),
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      gapFrom: step.gapFrom,
      gapTo: step.gapTo,
      insert: step.insert,
      structure: true,
      sliceSize: Number(step.slice?.size || 0),
      openStart: step.slice?.openStart,
      openEnd: step.slice?.openEnd
    })
  })
}

const markerRows = (markdown, block) => markdownLines(markdown)
  .map((line) => {
    if (line.start < block.start || line.start > block.end) return null
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)([-+*])([ \t]+)(.*)$/)
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

const resolveList = ({ markdown, doc, topLevelIndex, resolveMarkdownOffset }) => {
  const successorParagraph = sourceSyncNodeEntryAtPath(doc, [topLevelIndex, 1, 0])
  if (!successorParagraph) return null
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos: successorParagraph.contentStart,
      doc,
      topLevelIndex
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  const block = listBlockAt(markdown, rawOffset)
  if (!block || block.indent !== 0) return null
  return Object.freeze({
    block,
    rows: markerRows(markdown, block),
    rawOffset
  })
}

const removeAuthoredFirstRow = ({ source, sourceList }) => {
  const row = sourceList.rows[0]
  const next = sourceList.rows[1]
  if (!row || !next) return null
  if (row.body.replace(/\u200B/g, '').trim() !== '') return null
  const rowEnd = row.end < source.length && source[row.end] === '\n'
    ? row.end + 1
    : row.end
  if (rowEnd !== next.start) return null
  return Object.freeze({
    markdown: source.slice(0, row.start) + source.slice(rowEnd),
    range: Object.freeze({ start: row.start, end: rowEnd }),
    row: Object.freeze({ token: row.token, spacing: row.spacing, body: row.body, indent: row.indent })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-empty-item-first-lifted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_FAMILY,
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

export function createListEmptyItemFirstLiftTransactionSourceSyncOwner({ resolveMarkdownOffset } = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('list empty item first lift owner requires resolveMarkdownOffset')
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
    boundary = LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('list-empty-item-first-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) {
      return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    }
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('list-empty-item-first-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('list-empty-item-first-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('list-empty-item-first-callback-document-mismatch', { deferred: true })
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
      return recognizedRejection('list-empty-item-first-range-unmapped')
    }
    if (
      sourceList.rows.length !== classification.previousList.childCount ||
      previousList.rows.length !== classification.previousList.childCount
    ) return recognizedRejection('list-empty-item-first-row-count')

    const previousRow = previousList.rows[0]
    if (!previousRow || !/^<br\s*\/?>$/i.test(previousRow.body.trim())) {
      return recognizedRejection('list-empty-item-first-previous-row-not-empty')
    }

    const removed = removeAuthoredFirstRow({ source: journal.source, sourceList })
    if (!removed) return recognizedRejection('list-empty-item-first-authored-row-unproven')

    const proof = Object.freeze({
      kind: 'transaction-list-empty-item-first-lift-proof',
      journalId: journal.journalId,
      family: LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_FAMILY,
      listType: classification.listType,
      topLevelIndex: classification.topLevelIndex,
      removedIndex: 0,
      removedPath: classification.removedPath,
      liftedParagraphPath: classification.liftedParagraphPath,
      remainingListPath: classification.remainingListPath,
      successorOldPath: classification.successorOldPath,
      successorNewPath: classification.successorNewPath,
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
    family: LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_FAMILY,
    boundary: LIST_EMPTY_ITEM_FIRST_LIFT_TRANSACTION_BOUNDARY,
    plan
  })
}
