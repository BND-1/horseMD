import { markdownLines } from '../markdown-preservation/core.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_NESTED_BULLET_SPLIT_TRANSACTION_FAMILY = 'list-nested-bullet-item-split'
export const LIST_NESTED_BULLET_SPLIT_TRANSACTION_BOUNDARY = 'transaction-list-nested-bullet-item-split'

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
const plainBulletItem = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const explicit = node.attrs?.listType
  return explicit == null || explicit === '' || explicit === 'bullet'
}
const falseSpread = (node) => node?.attrs?.spread === false || node?.attrs?.spread === 'false'

const classify = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('nested-bullet-split-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) return rejected('nested-bullet-split-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('nested-bullet-split-top-level-change-count')

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    previousList?.type?.name !== 'bullet_list' || nextList?.type?.name !== 'bullet_list' ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    nextList.childCount !== previousList.childCount
  ) return rejected('nested-bullet-split-list-shape')

  const candidates = []
  for (let parentIndex = 0; parentIndex < previousList.childCount; parentIndex += 1) {
    const previousParent = previousList.child(parentIndex)
    const nextParent = nextList.child(parentIndex)
    if (
      !plainBulletItem(previousParent) || previousParent.childCount !== 2 ||
      !plainParagraph(previousParent.firstChild) ||
      !plainBulletItem(nextParent) || nextParent.childCount !== 2 ||
      !sourceSyncAttrsEqual(previousParent.attrs, nextParent.attrs) ||
      nextParent.firstChild?.eq?.(previousParent.firstChild) !== true
    ) continue
    const previousNested = previousParent.child(1)
    const nextNested = nextParent.child(1)
    if (
      previousNested?.type?.name !== 'bullet_list' || !falseSpread(previousNested) ||
      nextNested?.type?.name !== 'bullet_list' ||
      !sourceSyncAttrsEqual(previousNested.attrs, nextNested.attrs) ||
      nextNested.childCount !== previousNested.childCount + 1
    ) continue

    for (let targetIndex = 0; targetIndex < previousNested.childCount; targetIndex += 1) {
      const target = previousNested.child(targetIndex)
      if (!plainBulletItem(target) || target.childCount !== 1 || !plainParagraph(target.firstChild)) continue
      const left = nextNested.child(targetIndex)
      const right = nextNested.child(targetIndex + 1)
      if (
        !plainBulletItem(left) || !plainBulletItem(right) ||
        left.childCount !== 1 || right.childCount !== 1 ||
        !sourceSyncAttrsEqual(left.attrs, target.attrs) || !sourceSyncAttrsEqual(right.attrs, target.attrs) ||
        !plainParagraph(left.firstChild) || !plainParagraph(right.firstChild, { allowEmpty: true })
      ) continue
      const previousText = target.firstChild.textContent
      const leftText = left.firstChild.textContent
      const rightText = right.firstChild.textContent
      const splitOffset = leftText.length
      if (
        splitOffset <= 0 || splitOffset > previousText.length ||
        leftText + rightText !== previousText
      ) continue

      let nestedMatch = true
      for (let nestedIndex = 0; nestedIndex < previousNested.childCount; nestedIndex += 1) {
        if (nestedIndex === targetIndex) continue
        const nextIndex = nestedIndex > targetIndex ? nestedIndex + 1 : nestedIndex
        if (previousNested.child(nestedIndex)?.eq?.(nextNested.child(nextIndex)) !== true) {
          nestedMatch = false
          break
        }
      }
      if (!nestedMatch) continue

      let outerMatch = true
      for (let outerIndex = 0; outerIndex < previousList.childCount; outerIndex += 1) {
        if (outerIndex === parentIndex) continue
        if (previousList.child(outerIndex)?.eq?.(nextList.child(outerIndex)) !== true) {
          outerMatch = false
          break
        }
      }
      if (outerMatch) {
        candidates.push({
          parentIndex,
          targetIndex,
          previousParent,
          previousNested,
          nextNested,
          target,
          left,
          right,
          previousText,
          leftText,
          rightText,
          splitOffset
        })
      }
    }
  }
  if (candidates.length !== 1) {
    return rejected('nested-bullet-split-target-count', { proof: { candidateCount: candidates.length } })
  }
  const match = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('nested-bullet-split-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(stepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('nested-bullet-split-step-document')
  if (
    step?.constructor?.name !== 'ReplaceStep' || step.structure !== true ||
    !Number.isFinite(step.from) || step.from !== step.to ||
    Number(step.slice?.size || 0) !== 4 ||
    step.slice?.openStart !== 2 || step.slice?.openEnd !== 2
  ) return recognizedRejection('nested-bullet-split-step-shape')

  const targetPath = [topLevelIndex, match.parentIndex, 1, match.targetIndex]
  const paragraphPath = [...targetPath, 0]
  const paragraphEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, paragraphPath)
  const sliceContent = step.slice?.content
  const sliceLeft = sliceContent?.childCount === 2 ? sliceContent.child(0) : null
  const sliceRight = sliceContent?.childCount === 2 ? sliceContent.child(1) : null
  if (
    !paragraphEntry || paragraphEntry.type !== 'paragraph' ||
    sliceLeft?.type?.name !== 'list_item' || sliceRight?.type?.name !== 'list_item' ||
    sliceLeft.childCount !== 1 || sliceRight.childCount !== 1 ||
    !sourceSyncAttrsEqual(sliceLeft.attrs, match.target.attrs) ||
    !sourceSyncAttrsEqual(sliceRight.attrs, match.target.attrs) ||
    sliceLeft.firstChild?.type?.name !== 'paragraph' || sliceLeft.firstChild.content?.size !== 0 ||
    sliceRight.firstChild?.type?.name !== 'paragraph' || sliceRight.firstChild.content?.size !== 0
  ) return recognizedRejection('nested-bullet-split-step-slice')
  if (step.from !== paragraphEntry.contentStart + match.splitOffset) {
    return recognizedRejection('nested-bullet-split-step-range')
  }

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('nested-bullet-split-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex,
    parentIndex: match.parentIndex,
    targetIndex: match.targetIndex,
    targetPath: Object.freeze(targetPath),
    paragraphPath: Object.freeze(paragraphPath),
    leftPath: Object.freeze([topLevelIndex, match.parentIndex, 1, match.targetIndex]),
    rightPath: Object.freeze([topLevelIndex, match.parentIndex, 1, match.targetIndex + 1]),
    previousText: match.previousText,
    leftText: match.leftText,
    rightText: match.rightText,
    splitOffset: match.splitOffset,
    step: Object.freeze({
      name: step.constructor.name,
      from: step.from,
      to: step.to,
      structure: true,
      sliceSize: Number(step.slice?.size || 0),
      openStart: step.slice?.openStart,
      openEnd: step.slice?.openEnd
    })
  })
}

const lineAtRawOffset = (markdown, rawOffset) => markdownLines(markdown)
  .find((line) => rawOffset >= line.start && rawOffset <= line.end) || null
const bulletRow = (source, line) => {
  if (!line) return null
  const bareText = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
  const match = bareText.match(/^([ \t]*)([-+*])([ \t]+)(.*)$/)
  if (!match) return null
  const contentEnd = line.start + bareText.length
  const physicalEnd = line.end < source.length && source[line.end] === '\n' ? line.end + 1 : line.end
  const eol = source.slice(contentEnd, physicalEnd)
  return Object.freeze({
    indent: match[1],
    token: match[2],
    spacing: match[3],
    body: match[4],
    start: line.start,
    contentEnd,
    physicalEnd,
    eol,
    bodyStart: line.start + match[1].length + match[2].length + match[3].length
  })
}

const resolveTargetRow = ({ markdown, doc, classification, resolveMarkdownOffset }) => {
  const paragraphEntry = sourceSyncNodeEntryAtPath(doc, classification.paragraphPath)
  if (!paragraphEntry) return null
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos: paragraphEntry.contentStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      role: 'nested-split-target'
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  const row = bulletRow(markdown, lineAtRawOffset(markdown, rawOffset))
  return row ? Object.freeze({ row, rawOffset }) : null
}

const escapedPlainTextBoundary = ({ raw, text, offset }) => {
  const source = String(raw || '')
  const expected = String(text || '')
  const target = Number(offset)
  if (!Number.isInteger(target) || target < 0 || target > expected.length) return null
  let rawIndex = 0
  let textIndex = 0
  let boundary = target === 0 ? 0 : null
  const escapable = /[\\`*{}\[\]()#+\-.!_>~|]/
  while (textIndex < expected.length) {
    if (rawIndex >= source.length) return null
    const expectedChar = expected[textIndex]
    if (source[rawIndex] === expectedChar) {
      rawIndex += 1
    } else if (
      source[rawIndex] === '\\' && rawIndex + 1 < source.length &&
      source[rawIndex + 1] === expectedChar && escapable.test(expectedChar)
    ) {
      rawIndex += 2
    } else {
      return null
    }
    textIndex += 1
    if (textIndex === target) boundary = rawIndex
  }
  if (rawIndex !== source.length || boundary == null) return null
  return boundary
}

const patchAuthoredSplit = ({ source, resolved, classification }) => {
  const { row } = resolved
  if (
    row.indent !== '  ' || row.spacing !== ' ' ||
    (row.eol !== '\n' && row.eol !== '\r\n')
  ) return null
  const rawBoundary = escapedPlainTextBoundary({
    raw: row.body,
    text: classification.previousText,
    offset: classification.splitOffset
  })
  if (!Number.isFinite(rawBoundary)) return null
  const insertionAt = row.bodyStart + rawBoundary
  if (insertionAt < row.bodyStart || insertionAt > row.contentEnd) return null
  const insertion = `${row.eol}${row.indent}${row.token}${row.spacing}`
  return Object.freeze({
    markdown: source.slice(0, insertionAt) + insertion + source.slice(insertionAt),
    insertionAt,
    insertion,
    sourceRow: Object.freeze({
      indent: row.indent,
      token: row.token,
      spacing: row.spacing,
      body: row.body,
      eol: row.eol,
      rawSplitOffset: rawBoundary
    })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-nested-bullet-item-split',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_BULLET_SPLIT_TRANSACTION_FAMILY,
    boundary,
    reason: result.reason,
    baseRevision: proof.transactionJournal.baseRevision,
    baseSourceDigest: proof.transactionJournal.baseSourceDigest,
    baseCanonicalDigest: proof.transactionJournal.baseCanonicalDigest,
    proof,
    result,
    canonical,
    expectedDoc,
    publication: Object.freeze({ result, canonical, expectedDoc, validationSite: boundary, boundary, notifyChange: true })
  })
}

export function createListNestedBulletSplitTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('nested bullet split owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('nested bullet split owner requires validateMarkdown')
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
    boundary = LIST_NESTED_BULLET_SPLIT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) return rejected('nested-bullet-split-journal-stale', { reset: true })
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('nested-bullet-split-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('nested-bullet-split-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('nested-bullet-split-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const resolved = resolveTargetRow({
      markdown: journal.source,
      doc: journal.oldDoc,
      classification,
      resolveMarkdownOffset
    })
    if (!resolved) return recognizedRejection('nested-bullet-split-range-unmapped')
    const patched = patchAuthoredSplit({ source: journal.source, resolved, classification })
    if (!patched) return recognizedRejection('nested-bullet-split-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('nested-bullet-split-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-nested-bullet-split-proof',
      journalId: journal.journalId,
      family: LIST_NESTED_BULLET_SPLIT_TRANSACTION_FAMILY,
      listType: 'bullet_list',
      topLevelIndex: classification.topLevelIndex,
      parentIndex: classification.parentIndex,
      targetIndex: classification.targetIndex,
      targetPath: classification.targetPath,
      paragraphPath: classification.paragraphPath,
      leftPath: classification.leftPath,
      rightPath: classification.rightPath,
      splitOffset: classification.splitOffset,
      previousText: classification.previousText,
      leftText: classification.leftText,
      rightText: classification.rightText,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceRow: patched.sourceRow,
      rawInsertion: Object.freeze({ at: patched.insertionAt, text: patched.insertion }),
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(patched.markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown: patched.markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_BULLET_SPLIT_TRANSACTION_FAMILY,
    boundary: LIST_NESTED_BULLET_SPLIT_TRANSACTION_BOUNDARY,
    plan
  })
}
