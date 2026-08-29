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

export const LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_FAMILY = 'list-isolated-empty-ordered-lift'
export const LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_BOUNDARY = 'transaction-list-isolated-empty-ordered-lift'

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
const itemMatchesListSemantics = (node, expectedListType) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const explicitListType = node.attrs?.listType
  return explicitListType == null || explicitListType === '' || explicitListType === expectedListType
}
const topLevelEntries = (doc) => topLevelSourceSyncEntries(doc)

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('isolated-ordered-lift-document-missing')
  }
  const before = topLevelEntries(journal.oldDoc)
  const after = topLevelEntries(expectedDoc)
  if (after.length !== before.length - 1) {
    return rejected('isolated-ordered-lift-top-level-count')
  }

  const candidates = []
  for (let topLevelIndex = 0; topLevelIndex < after.length; topLevelIndex += 1) {
    const previousBullet = before[topLevelIndex]?.node
    const isolatedOrdered = before[topLevelIndex + 1]?.node
    const followingBullet = before[topLevelIndex + 2]?.node
    const nextBullet = after[topLevelIndex]?.node
    const nextFollowingBullet = after[topLevelIndex + 1]?.node
    if (
      previousBullet?.type?.name !== 'bullet_list' ||
      isolatedOrdered?.type?.name !== 'ordered_list' ||
      followingBullet?.type?.name !== 'bullet_list' ||
      nextBullet?.type?.name !== 'bullet_list' ||
      nextFollowingBullet?.type?.name !== 'bullet_list' ||
      followingBullet.eq?.(nextFollowingBullet) !== true ||
      !sourceSyncAttrsEqual(previousBullet.attrs, nextBullet.attrs) ||
      isolatedOrdered.childCount !== 1 ||
      previousBullet.childCount < 1 ||
      nextBullet.childCount !== previousBullet.childCount + 1
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
    for (let oldIndex = topLevelIndex + 2; oldIndex < before.length; oldIndex += 1) {
      if (before[oldIndex]?.node?.eq?.(after[oldIndex - 1]?.node) !== true) {
        suffixMatch = false
        break
      }
    }
    if (!suffixMatch) continue

    const previousLast = previousBullet.lastChild
    const isolatedItem = isolatedOrdered.firstChild
    const followingFirst = followingBullet.firstChild
    const appended = nextBullet.lastChild
    if (
      !itemMatchesListSemantics(previousLast, 'bullet') ||
      previousLast.childCount !== 1 ||
      !plainNonEmptyParagraph(previousLast.firstChild) ||
      !itemMatchesListSemantics(isolatedItem, 'ordered') ||
      isolatedItem.childCount !== 1 ||
      !plainEmptyParagraph(isolatedItem.firstChild) ||
      !itemMatchesListSemantics(followingFirst, 'bullet') ||
      followingFirst.childCount !== 1 ||
      !plainNonEmptyParagraph(followingFirst.firstChild) ||
      isolatedItem.eq?.(appended) !== true
    ) continue

    let existingItemsMatch = true
    for (let index = 0; index < previousBullet.childCount; index += 1) {
      if (previousBullet.child(index)?.eq?.(nextBullet.child(index)) !== true) {
        existingItemsMatch = false
        break
      }
    }
    if (!existingItemsMatch) continue

    candidates.push({
      topLevelIndex,
      previousBullet,
      isolatedOrdered,
      followingBullet,
      nextBullet,
      isolatedItemIndex: 0,
      appendedIndex: nextBullet.childCount - 1
    })
  }

  if (candidates.length !== 1) {
    return rejected('isolated-ordered-lift-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  const target = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('isolated-ordered-lift-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (!sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) || !sameSourceSyncDocument(stepDoc, journal.oldDoc)) {
    return recognizedRejection('isolated-ordered-lift-step-document')
  }
  if (
    step?.constructor?.name !== 'ReplaceStep' ||
    step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    step.to <= step.from ||
    Number(step.slice?.size || 0) !== 0
  ) return recognizedRejection('isolated-ordered-lift-step-shape')

  const bulletPath = [target.topLevelIndex]
  const orderedPath = [target.topLevelIndex + 1]
  const orderedItemPath = [target.topLevelIndex + 1, 0]
  const orderedParagraphPath = [target.topLevelIndex + 1, 0, 0]
  const appendedPath = [target.topLevelIndex, target.appendedIndex]
  const bulletEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, bulletPath)
  const orderedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, orderedPath)
  const orderedItemEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, orderedItemPath)
  const orderedParagraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, orderedParagraphPath)
  const appendedEntry = sourceSyncNodeEntryAtPath(expectedDoc, appendedPath)
  if (
    !bulletEntry || bulletEntry.type !== 'bullet_list' ||
    !orderedEntry || orderedEntry.type !== 'ordered_list' ||
    !orderedItemEntry || orderedItemEntry.type !== 'list_item' ||
    !orderedParagraphEntry || orderedParagraphEntry.type !== 'paragraph' ||
    !plainEmptyParagraph(orderedParagraphEntry.node) ||
    !appendedEntry || appendedEntry.type !== 'list_item'
  ) return recognizedRejection('isolated-ordered-lift-path')

  const bulletEnd = bulletEntry.beforePos + bulletEntry.node.nodeSize
  if (
    orderedEntry.beforePos !== bulletEnd ||
    orderedItemEntry.beforePos !== orderedEntry.contentStart ||
    orderedParagraphEntry.beforePos !== orderedItemEntry.contentStart ||
    step.from !== orderedEntry.beforePos - 1 ||
    step.to !== orderedEntry.contentStart
  ) return recognizedRejection('isolated-ordered-lift-step-range')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('isolated-ordered-lift-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex: target.topLevelIndex,
    previousBullet: target.previousBullet,
    isolatedOrdered: target.isolatedOrdered,
    followingBullet: target.followingBullet,
    nextBullet: target.nextBullet,
    orderedPath: Object.freeze(orderedPath),
    orderedItemPath: Object.freeze(orderedItemPath),
    orderedParagraphPath: Object.freeze(orderedParagraphPath),
    appendedPath: Object.freeze(appendedPath),
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

const resolveListAtPath = ({ markdown, doc, listPath, paragraphPath, resolveMarkdownOffset }) => {
  const listEntry = sourceSyncNodeEntryAtPath(doc, listPath)
  const paragraphEntry = sourceSyncNodeEntryAtPath(doc, paragraphPath)
  if (!listEntry || !paragraphEntry) return null
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos: paragraphEntry.contentStart,
      doc,
      topLevelIndex: listPath[0]
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
    rawOffset,
    node: listEntry.node
  })
}

const isolatedOrderedRowBetween = ({ markdown, leftBlock, rightBlock }) => {
  if (!leftBlock || !rightBlock || leftBlock.end >= rightBlock.start) return null
  const nonBlank = markdownLines(markdown).filter((line) =>
    line.start > leftBlock.end &&
    line.end <= rightBlock.start &&
    line.text.trim()
  )
  if (nonBlank.length !== 1) return null
  const line = nonBlank[0]
  const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
  const match = text.match(/^(\d{1,9}[.)])([ \t]+)(.*)$/)
  if (!match) return null
  return Object.freeze({
    line,
    indent: '',
    token: match[1],
    spacing: match[2],
    body: match[3],
    start: line.start,
    end: line.end
  })
}

const replaceOrderedMarkerWithBullet = ({ source, row, bulletToken }) => {
  if (!row) return null
  if (!/^\d{1,9}[.)]$/.test(row.token)) return null
  if (row.body.replace(/\u200B/g, '').trim() !== '') return null
  if (!/^[-+*]$/.test(bulletToken)) return null
  const tokenStart = row.start + row.indent.length
  const tokenEnd = tokenStart + row.token.length
  return Object.freeze({
    markdown: source.slice(0, tokenStart) + bulletToken + source.slice(tokenEnd),
    range: Object.freeze({ start: tokenStart, end: tokenEnd }),
    previousToken: row.token,
    nextToken: bulletToken,
    row: Object.freeze({ token: row.token, spacing: row.spacing, body: row.body, indent: row.indent })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-isolated-empty-ordered-lifted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_FAMILY,
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

export function createListIsolatedEmptyOrderedLiftTransactionSourceSyncOwner({ resolveMarkdownOffset } = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('isolated empty ordered lift owner requires resolveMarkdownOffset')
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
    boundary = LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('isolated-ordered-lift-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) {
      return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    }
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('isolated-ordered-lift-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('isolated-ordered-lift-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('isolated-ordered-lift-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const bulletList = resolveListAtPath({
      markdown: journal.source,
      doc: journal.oldDoc,
      listPath: [classification.topLevelIndex],
      paragraphPath: [
        classification.topLevelIndex,
        classification.previousBullet.childCount - 1,
        0
      ],
      resolveMarkdownOffset
    })
    const followingBulletList = resolveListAtPath({
      markdown: journal.source,
      doc: journal.oldDoc,
      listPath: [classification.topLevelIndex + 2],
      paragraphPath: [classification.topLevelIndex + 2, 0, 0],
      resolveMarkdownOffset
    })
    const previousBulletList = resolveListAtPath({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      listPath: [classification.topLevelIndex],
      paragraphPath: [
        classification.topLevelIndex,
        classification.previousBullet.childCount - 1,
        0
      ],
      resolveMarkdownOffset
    })
    const previousFollowingBulletList = resolveListAtPath({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      listPath: [classification.topLevelIndex + 2],
      paragraphPath: [classification.topLevelIndex + 2, 0, 0],
      resolveMarkdownOffset
    })
    if (!bulletList || !followingBulletList || !previousBulletList || !previousFollowingBulletList) {
      return recognizedRejection('isolated-ordered-lift-range-unmapped')
    }
    if (
      bulletList.rows.length !== classification.previousBullet.childCount ||
      previousBulletList.rows.length !== classification.previousBullet.childCount ||
      followingBulletList.rows.length !== classification.followingBullet.childCount ||
      previousFollowingBulletList.rows.length !== classification.followingBullet.childCount
    ) return recognizedRejection('isolated-ordered-lift-row-count')

    const sourceBulletRow = bulletList.rows.at(-1)
    const sourceOrderedRow = isolatedOrderedRowBetween({
      markdown: journal.source,
      leftBlock: bulletList.block,
      rightBlock: followingBulletList.block
    })
    const previousOrderedRow = isolatedOrderedRowBetween({
      markdown: journal.canonical,
      leftBlock: previousBulletList.block,
      rightBlock: previousFollowingBulletList.block
    })
    const orderedStart = Number(classification.isolatedOrdered.attrs?.order ?? 1)
    const sourceOrderedNumber = Number.parseInt(sourceOrderedRow?.token || '', 10)
    const previousOrderedNumber = Number.parseInt(previousOrderedRow?.token || '', 10)
    if (
      !sourceBulletRow || !/^[-+*]$/.test(sourceBulletRow.token) ||
      !sourceOrderedRow || !/^\d{1,9}[.)]$/.test(sourceOrderedRow.token) ||
      !previousOrderedRow || !/^\d{1,9}[.)]$/.test(previousOrderedRow.token) ||
      !Number.isInteger(orderedStart) || orderedStart < 0 ||
      sourceOrderedNumber !== orderedStart ||
      previousOrderedNumber !== orderedStart ||
      !/^<br\s*\/?>$/i.test(previousOrderedRow.body.trim())
    ) return recognizedRejection('isolated-ordered-lift-source-shape')

    const replaced = replaceOrderedMarkerWithBullet({
      source: journal.source,
      row: sourceOrderedRow,
      bulletToken: sourceBulletRow.token
    })
    if (!replaced) return recognizedRejection('isolated-ordered-lift-authored-row-unproven')

    const proof = Object.freeze({
      kind: 'transaction-list-isolated-empty-ordered-lift-proof',
      journalId: journal.journalId,
      family: LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      orderedPath: classification.orderedPath,
      orderedItemPath: classification.orderedItemPath,
      appendedPath: classification.appendedPath,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceBulletToken: sourceBulletRow.token,
      orderedStart,
      sourceBoundary: Object.freeze({
        leftEnd: bulletList.block.end,
        rightStart: followingBulletList.block.start
      }),
      previousBoundary: Object.freeze({
        leftEnd: previousBulletList.block.end,
        rightStart: previousFollowingBulletList.block.start
      }),
      orderedSourceRow: replaced.row,
      rawReplacement: replaced.range,
      previousToken: replaced.previousToken,
      nextToken: replaced.nextToken,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(replaced.markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown: replaced.markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_FAMILY,
    boundary: LIST_ISOLATED_EMPTY_ORDERED_LIFT_TRANSACTION_BOUNDARY,
    plan
  })
}
