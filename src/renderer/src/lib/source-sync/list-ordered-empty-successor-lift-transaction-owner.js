import { listBlockAt } from '../markdown-preservation/lists.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_FAMILY = 'list-ordered-empty-successor-lift'
export const LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_BOUNDARY = 'transaction-list-ordered-empty-successor-lift'

const rejected = (reason, { deferred = false, recognized = false, reset = false, proof = null } = {}) =>
  Object.freeze({ ok: false, decision: 'rejected', deferred, recognized, reset, reason, proof })
const recognizedRejection = (reason, options = {}) => rejected(reason, { ...options, recognized: true })

const emptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size === 0
const nonEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && node.isTextblock && node.content?.size > 0
const orderedItem = (node) => {
  if (node?.type?.name !== 'list_item' || node.attrs?.checked != null) return false
  const listType = node.attrs?.listType
  return listType == null || listType === '' || listType === 'ordered'
}
const attrsWithoutLabel = (attrs) => Object.fromEntries(
  Object.entries(attrs || {})
    .filter(([key, value]) => key !== 'label' && value != null)
    .sort(([left], [right]) => left.localeCompare(right))
)
const attrsEqualExceptLabel = (left, right) =>
  JSON.stringify(attrsWithoutLabel(left)) === JSON.stringify(attrsWithoutLabel(right))
const labelMeta = (label) => {
  const match = String(label || '').match(/^(\d{1,9})([.)])$/)
  return match ? Object.freeze({ ordinal: Number(match[1]), delimiter: match[2], token: match[0] }) : null
}

const classifyTopology = ({ oldDoc, expectedDoc }) => {
  const changed = classifySingleTopLevelSubtreeChange({
    oldDoc,
    newDoc: expectedDoc,
    expectedType: 'ordered_list',
    reasonPrefix: 'ordered-successor-lift'
  })
  if (!changed.ok) return rejected(changed.reason, { proof: changed.proof })
  const previousList = changed.previousEntry.node
  const nextList = changed.nextEntry.node
  if (
    previousList.childCount !== 3 ||
    nextList.childCount !== 2 ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs)
  ) return rejected('ordered-successor-lift-list-shape')

  const previousItem = previousList.child(0)
  const removedItem = previousList.child(1)
  const successorItem = previousList.child(2)
  const finalPrevious = nextList.child(0)
  const finalSuccessor = nextList.child(1)
  if (
    !orderedItem(previousItem) || previousItem.childCount !== 1 || !nonEmptyParagraph(previousItem.firstChild) ||
    !orderedItem(removedItem) || removedItem.childCount !== 1 || !emptyParagraph(removedItem.firstChild) ||
    !orderedItem(successorItem) || successorItem.childCount !== 1 || !nonEmptyParagraph(successorItem.firstChild) ||
    !orderedItem(finalPrevious) || finalPrevious.childCount !== 2 ||
    finalPrevious.firstChild?.eq?.(previousItem.firstChild) !== true ||
    !emptyParagraph(finalPrevious.child(1)) ||
    !sourceSyncAttrsEqual(previousItem.attrs, finalPrevious.attrs) ||
    !orderedItem(finalSuccessor) || finalSuccessor.childCount !== 1 ||
    finalSuccessor.firstChild?.eq?.(successorItem.firstChild) !== true ||
    !attrsEqualExceptLabel(successorItem.attrs, finalSuccessor.attrs)
  ) return rejected('ordered-successor-lift-item-shape')

  const order = Number(previousList.attrs?.order ?? 1)
  const previousLabel = labelMeta(previousItem.attrs?.label)
  const removedLabel = labelMeta(removedItem.attrs?.label)
  const successorLabel = labelMeta(successorItem.attrs?.label)
  const finalSuccessorLabel = labelMeta(finalSuccessor.attrs?.label)
  if (
    !Number.isInteger(order) || order < 0 ||
    !previousLabel || !removedLabel || !successorLabel || !finalSuccessorLabel ||
    previousLabel.ordinal !== order ||
    removedLabel.ordinal !== order + 1 ||
    successorLabel.ordinal !== order + 2 ||
    finalSuccessorLabel.ordinal !== order + 1 ||
    previousLabel.delimiter !== removedLabel.delimiter ||
    removedLabel.delimiter !== successorLabel.delimiter ||
    finalSuccessorLabel.delimiter !== successorLabel.delimiter
  ) return rejected('ordered-successor-lift-label-sequence')

  return Object.freeze({
    ok: true,
    topLevelIndex: changed.topLevelIndex,
    unchangedPrefix: changed.unchangedPrefix,
    unchangedSuffix: changed.unchangedSuffix,
    previousList,
    nextList,
    previousItem,
    removedItem,
    successorItem,
    finalPrevious,
    finalSuccessor,
    order,
    previousLabel,
    removedLabel,
    successorLabel,
    finalSuccessorLabel
  })
}

const classifyJournal = ({ journal, expectedDoc, topology }) => {
  if (
    journal.transactionCount !== 2 ||
    journal.stepCount !== 2 ||
    journal.entries?.length !== 2 ||
    journal.entries[0]?.stepCount !== 1 ||
    journal.entries[1]?.stepCount !== 1
  ) return recognizedRejection('ordered-successor-lift-transaction-count')

  const firstEntry = journal.entries[0]
  const secondEntry = journal.entries[1]
  const firstStep = firstEntry.steps?.[0]
  const secondStep = secondEntry.steps?.[0]
  const firstStepDoc = firstEntry.stepDocs?.[0] || firstEntry.beforeDoc
  const secondStepDoc = secondEntry.stepDocs?.[0] || secondEntry.beforeDoc
  if (
    !sameSourceSyncDocument(firstEntry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(firstStepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(secondEntry.beforeDoc, firstEntry.afterDoc) ||
    !sameSourceSyncDocument(secondStepDoc, firstEntry.afterDoc) ||
    !sameSourceSyncDocument(secondEntry.afterDoc, expectedDoc)
  ) return recognizedRejection('ordered-successor-lift-step-document')

  if (
    firstStep?.constructor?.name !== 'ReplaceStep' ||
    firstStep.structure !== true ||
    Number(firstStep.slice?.size || 0) !== 0 ||
    !Number.isFinite(firstStep.from) || !Number.isFinite(firstStep.to) || firstStep.to <= firstStep.from
  ) return recognizedRejection('ordered-successor-lift-first-step-shape')

  const top = topology.topLevelIndex
  const removedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, [top, 1])
  if (
    !removedEntry ||
    firstStep.from !== removedEntry.beforePos - 1 ||
    firstStep.to !== removedEntry.contentStart
  ) return recognizedRejection('ordered-successor-lift-first-step-range')

  let firstApplied
  try { firstApplied = firstStep.apply(firstStepDoc) } catch { firstApplied = null }
  if (firstApplied?.failed || !firstApplied?.doc || !sameSourceSyncDocument(firstApplied.doc, firstEntry.afterDoc)) {
    return recognizedRejection('ordered-successor-lift-first-step-result')
  }
  const intermediateDoc = firstEntry.afterDoc
  const intermediateList = sourceSyncNodeEntryAtPath(intermediateDoc, [top])?.node
  const intermediatePrevious = intermediateList?.child?.(0)
  const intermediateSuccessor = intermediateList?.child?.(1)
  if (
    intermediateList?.type?.name !== 'ordered_list' ||
    intermediateList.childCount !== 2 ||
    !sourceSyncAttrsEqual(intermediateList.attrs, topology.previousList.attrs) ||
    !orderedItem(intermediatePrevious) || intermediatePrevious.childCount !== 2 ||
    intermediatePrevious.firstChild?.eq?.(topology.previousItem.firstChild) !== true ||
    !emptyParagraph(intermediatePrevious.child(1)) ||
    !sourceSyncAttrsEqual(intermediatePrevious.attrs, topology.previousItem.attrs) ||
    intermediateSuccessor?.eq?.(topology.successorItem) !== true
  ) return recognizedRejection('ordered-successor-lift-intermediate-shape')

  if (
    secondStep?.constructor?.name !== 'ReplaceAroundStep' ||
    secondStep.structure !== true ||
    Number(secondStep.slice?.size || 0) !== 2 ||
    secondStep.slice?.openStart !== 0 || secondStep.slice?.openEnd !== 0 ||
    secondStep.insert !== 1 ||
    !Number.isFinite(secondStep.from) || !Number.isFinite(secondStep.to) ||
    !Number.isFinite(secondStep.gapFrom) || !Number.isFinite(secondStep.gapTo)
  ) return recognizedRejection('ordered-successor-lift-second-step-shape')

  const intermediateSuccessorEntry = sourceSyncNodeEntryAtPath(intermediateDoc, [top, 1])
  const sliceItem = secondStep.slice?.content?.firstChild
  if (
    !intermediateSuccessorEntry ||
    secondStep.from !== intermediateSuccessorEntry.beforePos ||
    secondStep.to !== intermediateSuccessorEntry.beforePos + intermediateSuccessorEntry.node.nodeSize ||
    secondStep.gapFrom !== intermediateSuccessorEntry.contentStart ||
    secondStep.gapTo !== secondStep.to - 1 ||
    sliceItem?.type?.name !== 'list_item' ||
    sliceItem.childCount !== 0 ||
    !sourceSyncAttrsEqual(sliceItem.attrs, topology.finalSuccessor.attrs)
  ) return recognizedRejection('ordered-successor-lift-second-step-range')

  let secondApplied
  try { secondApplied = secondStep.apply(secondStepDoc) } catch { secondApplied = null }
  if (secondApplied?.failed || !secondApplied?.doc || !sameSourceSyncDocument(secondApplied.doc, expectedDoc)) {
    return recognizedRejection('ordered-successor-lift-second-step-result')
  }

  return Object.freeze({
    ok: true,
    intermediateDoc,
    firstStep: Object.freeze({
      name: firstStep.constructor.name,
      from: firstStep.from,
      to: firstStep.to,
      structure: true,
      sliceSize: 0
    }),
    secondStep: Object.freeze({
      name: secondStep.constructor.name,
      from: secondStep.from,
      to: secondStep.to,
      gapFrom: secondStep.gapFrom,
      gapTo: secondStep.gapTo,
      insert: secondStep.insert,
      structure: true,
      sliceSize: Number(secondStep.slice?.size || 0),
      openStart: secondStep.slice?.openStart,
      openEnd: secondStep.slice?.openEnd
    })
  })
}

const normalizeBlockRange = (markdown, block) => {
  if (!block || !Number.isInteger(block.start) || !Number.isInteger(block.end)) return null
  let end = block.end
  if (end > block.start && markdown[end - 1] === '\r' && markdown[end] === '\n') end -= 1
  if (block.start < 0 || end <= block.start || end > markdown.length) return null
  return Object.freeze({ start: block.start, end, indent: block.indent })
}
const trimOwnedFragmentEnd = (value) => String(value || '').replace(/(?:\r\n|\r|\n)+$/, '')

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'list-ordered-empty-successor-lifted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_FAMILY,
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

export function createListOrderedEmptySuccessorLiftTransactionSourceSyncOwner({
  mapOrderedLift,
  resolveMarkdownOffset
} = {}) {
  if (typeof mapOrderedLift !== 'function') {
    throw new TypeError('ordered empty successor lift owner requires mapOrderedLift')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('ordered empty successor lift owner requires resolveMarkdownOffset')
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
    boundary = LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) return rejected('ordered-successor-lift-journal-stale', { reset: true })
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('ordered-successor-lift-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('ordered-successor-lift-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('ordered-successor-lift-callback-document-mismatch', { deferred: true })
    }

    const topology = classifyTopology({ oldDoc: journal.oldDoc, expectedDoc })
    if (!topology.ok) return topology
    const journalProof = classifyJournal({ journal, expectedDoc, topology })
    if (!journalProof.ok) return journalProof

    const resolveRange = ({ markdown, doc, paragraphPath }) => {
      const paragraphEntry = sourceSyncNodeEntryAtPath(doc, paragraphPath)
      if (!paragraphEntry) return null
      let rawOffset
      try {
        rawOffset = resolveMarkdownOffset({ markdown, pmPos: paragraphEntry.contentStart, doc, topLevelIndex: topology.topLevelIndex })
      } catch { return null }
      if (!Number.isFinite(rawOffset)) return null
      const block = normalizeBlockRange(markdown, listBlockAt(markdown, rawOffset))
      return block?.indent === 0 ? Object.freeze({ ...block, rawOffset, pmPos: paragraphEntry.contentStart }) : null
    }

    const sourceRange = resolveRange({ markdown: journal.source, doc: journal.oldDoc, paragraphPath: [topology.topLevelIndex, 0, 0] })
    const previousRange = resolveRange({ markdown: journal.canonical, doc: journal.oldDoc, paragraphPath: [topology.topLevelIndex, 0, 0] })
    const nextRange = resolveRange({ markdown: canonical, doc: expectedDoc, paragraphPath: [topology.topLevelIndex, 0, 0] })
    if (!sourceRange || !previousRange || !nextRange) {
      return recognizedRejection('ordered-successor-lift-range-unmapped')
    }

    const sourceFragment = journal.source.slice(sourceRange.start, sourceRange.end)
    const previousFragment = journal.canonical.slice(previousRange.start, previousRange.end)
    const nextFragment = canonical.slice(nextRange.start, nextRange.end)
    let mapped
    try { mapped = mapOrderedLift({ source: sourceFragment, previous: previousFragment, next: nextFragment }) } catch (error) {
      return recognizedRejection(`ordered-successor-lift-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped || mapped.preserved === false || typeof mapped.markdown !== 'string') {
      return recognizedRejection(mapped?.reason || 'ordered-successor-lift-mapper-rejected')
    }
    if (mapped.reason !== 'diverged-empty-ordered-backspace-lift') {
      return recognizedRejection('ordered-successor-lift-mapper-family-mismatch')
    }
    if (
      typeof mapped.nextBaseline === 'string' &&
      trimOwnedFragmentEnd(mapped.nextBaseline) !== trimOwnedFragmentEnd(nextFragment)
    ) return recognizedRejection('ordered-successor-lift-mapper-partial-baseline')

    const trailingEol = String(mapped.markdown || '').match(/(\r\n|\r|\n)$/)?.[1] || ''
    const sourceSuffix = journal.source.slice(sourceRange.end)
    const suffixOwnsRowTerminator = /^(?:\r\n|\r|\n)/.test(sourceSuffix)
    const boundaryEolGrowth = mapped.trailingBoundaryNewlineGrowth === 1 && trailingEol && !suffixOwnsRowTerminator
      ? trailingEol
      : ''
    const replacement = trimOwnedFragmentEnd(mapped.markdown) + boundaryEolGrowth
    const markdown = journal.source.slice(0, sourceRange.start) + replacement + sourceSuffix
    const top = topology.topLevelIndex
    const proof = Object.freeze({
      kind: 'transaction-list-ordered-empty-successor-lift-proof',
      journalId: journal.journalId,
      family: LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_FAMILY,
      listType: 'ordered_list',
      topLevelIndex: top,
      removedIndex: 1,
      removedPath: Object.freeze([top, 1]),
      previousPath: Object.freeze([top, 0]),
      successorOldPath: Object.freeze([top, 2]),
      successorIntermediatePath: Object.freeze([top, 1]),
      successorFinalPath: Object.freeze([top, 1]),
      transientEmptyListItemPath: Object.freeze([top, 0]),
      transientEmptyParagraphPath: Object.freeze([top, 0, 1]),
      listOrder: topology.order,
      previousLabel: topology.previousLabel.token,
      removedLabel: topology.removedLabel.token,
      successorOldLabel: topology.successorLabel.token,
      successorFinalLabel: topology.finalSuccessorLabel.token,
      firstStep: journalProof.firstStep,
      secondStep: journalProof.secondStep,
      stepDetails: journal.stepDetails,
      chainLength: journal.transactionCount,
      transactionJournal: verified.proof,
      sourceRange,
      previousRange,
      nextRange,
      mapperReason: mapped.reason,
      trailingBoundaryNewlineGrowth: boundaryEolGrowth ? 1 : 0,
      suffixOwnedRowTerminator: suffixOwnsRowTerminator,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_FAMILY,
    boundary: LIST_ORDERED_EMPTY_SUCCESSOR_LIFT_TRANSACTION_BOUNDARY,
    plan
  })
}
