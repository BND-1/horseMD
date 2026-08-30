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

export const LIST_NESTED_BULLET_JOIN_TRANSACTION_FAMILY = 'list-nested-bullet-item-join'
export const LIST_NESTED_BULLET_JOIN_TRANSACTION_BOUNDARY = 'transaction-list-nested-bullet-item-join'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })
const recognizedRejection = (reason, options = {}) => rejected(reason, { ...options, recognized: true })

const plainParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock || node.content?.size <= 0) return false
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
    return rejected('nested-bullet-join-document-missing')
  }
  const before = topLevelSourceSyncEntries(journal.oldDoc)
  const after = topLevelSourceSyncEntries(expectedDoc)
  if (before.length !== after.length) return rejected('nested-bullet-join-top-level-count')
  const changed = before
    .map((entry, index) => entry.node?.eq?.(after[index]?.node) === true ? null : index)
    .filter((index) => index != null)
  if (changed.length !== 1) return rejected('nested-bullet-join-top-level-change-count')

  const topLevelIndex = changed[0]
  const previousList = before[topLevelIndex].node
  const nextList = after[topLevelIndex].node
  if (
    previousList?.type?.name !== 'bullet_list' || nextList?.type?.name !== 'bullet_list' ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs) ||
    nextList.childCount !== previousList.childCount
  ) return rejected('nested-bullet-join-list-shape')

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
      previousNested.childCount < 2 || nextNested.childCount !== previousNested.childCount - 1
    ) continue

    for (let targetIndex = 1; targetIndex < previousNested.childCount; targetIndex += 1) {
      const previousItem = previousNested.child(targetIndex - 1)
      const targetItem = previousNested.child(targetIndex)
      const joinedItem = nextNested.child(targetIndex - 1)
      if (
        !plainBulletItem(previousItem) || previousItem.childCount !== 1 || !plainParagraph(previousItem.firstChild) ||
        !plainBulletItem(targetItem) || targetItem.childCount !== 1 || !plainParagraph(targetItem.firstChild) ||
        !plainBulletItem(joinedItem) || joinedItem.childCount !== 2 ||
        !sourceSyncAttrsEqual(previousItem.attrs, targetItem.attrs) ||
        !sourceSyncAttrsEqual(previousItem.attrs, joinedItem.attrs) ||
        joinedItem.child(0)?.eq?.(previousItem.firstChild) !== true ||
        joinedItem.child(1)?.eq?.(targetItem.firstChild) !== true
      ) continue

      let nestedMatch = true
      for (let oldIndex = 0; oldIndex < previousNested.childCount; oldIndex += 1) {
        if (oldIndex === targetIndex - 1 || oldIndex === targetIndex) continue
        const nextIndex = oldIndex > targetIndex ? oldIndex - 1 : oldIndex
        if (previousNested.child(oldIndex)?.eq?.(nextNested.child(nextIndex)) !== true) {
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
          previousItem,
          targetItem,
          joinedItem,
          previousText: previousItem.firstChild.textContent,
          targetText: targetItem.firstChild.textContent
        })
      }
    }
  }
  if (candidates.length !== 1) {
    return rejected('nested-bullet-join-target-count', { proof: { candidateCount: candidates.length } })
  }
  const match = candidates[0]

  if (journal.transactionCount !== 1 || journal.stepCount !== 1 || journal.entries.length !== 1) {
    return recognizedRejection('nested-bullet-join-transaction-count')
  }
  const entry = journal.entries[0]
  const step = entry.steps?.[0]
  const stepDoc = entry.stepDocs?.[0] || entry.beforeDoc
  if (
    !sameSourceSyncDocument(entry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(stepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(entry.afterDoc, expectedDoc)
  ) return recognizedRejection('nested-bullet-join-step-document')
  if (
    step?.constructor?.name !== 'ReplaceStep' || step.structure !== true ||
    !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
    Number(step.slice?.size || 0) !== 0 || step.slice?.openStart !== 0 || step.slice?.openEnd !== 0
  ) return recognizedRejection('nested-bullet-join-step-shape')

  const previousPath = [topLevelIndex, match.parentIndex, 1, match.targetIndex - 1]
  const targetPath = [topLevelIndex, match.parentIndex, 1, match.targetIndex]
  const previousEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, previousPath)
  const targetEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, targetPath)
  const previousEnd = previousEntry?.beforePos + previousEntry?.node?.nodeSize
  if (
    !previousEntry || previousEntry.type !== 'list_item' ||
    !targetEntry || targetEntry.type !== 'list_item' ||
    previousEnd !== targetEntry.beforePos ||
    step.from !== targetEntry.beforePos - 1 ||
    step.to !== targetEntry.contentStart
  ) return recognizedRejection('nested-bullet-join-step-range')

  let applied
  try { applied = step.apply(stepDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc || !sameSourceSyncDocument(applied.doc, expectedDoc)) {
    return recognizedRejection('nested-bullet-join-step-result')
  }

  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex,
    parentIndex: match.parentIndex,
    targetIndex: match.targetIndex,
    previousPath: Object.freeze(previousPath),
    targetPath: Object.freeze(targetPath),
    joinedPath: Object.freeze([topLevelIndex, match.parentIndex, 1, match.targetIndex - 1]),
    previousParagraphPath: Object.freeze([...previousPath, 0]),
    targetParagraphPath: Object.freeze([...targetPath, 0]),
    previousText: match.previousText,
    targetText: match.targetText,
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
  return Object.freeze({
    indent: match[1],
    token: match[2],
    spacing: match[3],
    body: match[4],
    start: line.start,
    bodyStart: line.start + match[1].length + match[2].length + match[3].length,
    contentEnd,
    physicalEnd,
    eol: source.slice(contentEnd, physicalEnd)
  })
}
const authoredPlainTextMatches = (raw, text) => {
  const source = String(raw || '')
  const expected = String(text || '')
  const escapable = /[\\`*{}\[\]()#+\-.!_>~|]/
  let rawIndex = 0
  for (let textIndex = 0; textIndex < expected.length; textIndex += 1) {
    const expectedChar = expected[textIndex]
    if (source[rawIndex] === expectedChar) {
      rawIndex += 1
    } else if (
      source[rawIndex] === '\\' && rawIndex + 1 < source.length &&
      source[rawIndex + 1] === expectedChar && escapable.test(expectedChar)
    ) {
      rawIndex += 2
    } else {
      return false
    }
  }
  return rawIndex === source.length
}

const resolveRows = ({ markdown, doc, classification, resolveMarkdownOffset }) => {
  const previousParagraph = sourceSyncNodeEntryAtPath(doc, classification.previousParagraphPath)
  const targetParagraph = sourceSyncNodeEntryAtPath(doc, classification.targetParagraphPath)
  if (!previousParagraph || !targetParagraph) return null
  let previousOffset
  let targetOffset
  try {
    previousOffset = resolveMarkdownOffset({
      markdown,
      pmPos: previousParagraph.contentStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      role: 'nested-join-previous'
    })
    targetOffset = resolveMarkdownOffset({
      markdown,
      pmPos: targetParagraph.contentStart,
      doc,
      topLevelIndex: classification.topLevelIndex,
      role: 'nested-join-target'
    })
  } catch {
    return null
  }
  if (!Number.isFinite(previousOffset) || !Number.isFinite(targetOffset)) return null
  const previous = bulletRow(markdown, lineAtRawOffset(markdown, previousOffset))
  const target = bulletRow(markdown, lineAtRawOffset(markdown, targetOffset))
  return previous && target ? Object.freeze({ previous, target }) : null
}

const patchAuthoredJoin = ({ source, rows, classification }) => {
  const { previous, target } = rows
  if (
    previous.indent !== '  ' || target.indent !== '  ' ||
    previous.token !== target.token || previous.spacing !== ' ' || target.spacing !== ' ' ||
    (previous.eol !== '\n' && previous.eol !== '\r\n') || target.eol !== previous.eol ||
    previous.physicalEnd !== target.start ||
    !authoredPlainTextMatches(previous.body, classification.previousText) ||
    !authoredPlainTextMatches(target.body, classification.targetText)
  ) return null
  const replacement = `${target.eol}    `
  return Object.freeze({
    markdown: source.slice(0, target.start) + replacement + source.slice(target.bodyStart),
    range: Object.freeze({ start: target.start, end: target.bodyStart, replacement }),
    previousRow: Object.freeze({
      indent: previous.indent,
      token: previous.token,
      spacing: previous.spacing,
      body: previous.body,
      eol: previous.eol
    }),
    targetRow: Object.freeze({
      indent: target.indent,
      token: target.token,
      spacing: target.spacing,
      body: target.body,
      eol: target.eol
    })
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-nested-bullet-item-joined',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_NESTED_BULLET_JOIN_TRANSACTION_FAMILY,
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

export function createListNestedBulletJoinTransactionSourceSyncOwner({ resolveMarkdownOffset, validateMarkdown } = {}) {
  if (typeof resolveMarkdownOffset !== 'function') throw new TypeError('nested bullet join owner requires resolveMarkdownOffset')
  if (typeof validateMarkdown !== 'function') throw new TypeError('nested bullet join owner requires validateMarkdown')

  const plan = ({
    journal,
    activeJournal,
    snapshot,
    currentSource,
    currentCanonical,
    canonical,
    expectedDoc,
    callbackDocumentEquivalent = false,
    boundary = LIST_NESTED_BULLET_JOIN_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) return rejected('nested-bullet-join-journal-stale', { reset: true })
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('nested-bullet-join-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('nested-bullet-join-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('nested-bullet-join-callback-document-mismatch', { deferred: true })
    }

    const classification = classify({ journal, expectedDoc })
    if (!classification.ok) return classification
    const rows = resolveRows({ markdown: journal.source, doc: journal.oldDoc, classification, resolveMarkdownOffset })
    if (!rows) return recognizedRejection('nested-bullet-join-range-unmapped')
    const patched = patchAuthoredJoin({ source: journal.source, rows, classification })
    if (!patched) return recognizedRejection('nested-bullet-join-source-row-unproven')

    let valid = false
    try { valid = validateMarkdown({ markdown: patched.markdown, expectedDoc }) === true } catch { valid = false }
    if (!valid) return recognizedRejection('nested-bullet-join-source-invalid')

    const proof = Object.freeze({
      kind: 'transaction-list-nested-bullet-join-proof',
      journalId: journal.journalId,
      family: LIST_NESTED_BULLET_JOIN_TRANSACTION_FAMILY,
      listType: 'bullet_list',
      topLevelIndex: classification.topLevelIndex,
      parentIndex: classification.parentIndex,
      targetIndex: classification.targetIndex,
      previousPath: classification.previousPath,
      targetPath: classification.targetPath,
      joinedPath: classification.joinedPath,
      previousParagraphPath: classification.previousParagraphPath,
      targetParagraphPath: classification.targetParagraphPath,
      previousText: classification.previousText,
      targetText: classification.targetText,
      step: classification.step,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      previousSourceRow: patched.previousRow,
      targetSourceRow: patched.targetRow,
      rawReplacement: patched.range,
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
    family: LIST_NESTED_BULLET_JOIN_TRANSACTION_FAMILY,
    boundary: LIST_NESTED_BULLET_JOIN_TRANSACTION_BOUNDARY,
    plan
  })
}
