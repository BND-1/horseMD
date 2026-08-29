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

export const LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_FAMILY = 'list-ordered-empty-successor-chain-lift'
export const LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_BOUNDARY = 'transaction-list-ordered-empty-successor-chain-lift'

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
    reasonPrefix: 'ordered-successor-chain'
  })
  if (!changed.ok) return rejected(changed.reason, { proof: changed.proof })
  const previousList = changed.previousEntry.node
  const nextList = changed.nextEntry.node
  if (
    previousList.childCount < 4 ||
    nextList.childCount !== previousList.childCount - 1 ||
    !sourceSyncAttrsEqual(previousList.attrs, nextList.attrs)
  ) return rejected('ordered-successor-chain-list-shape')

  const order = Number(previousList.attrs?.order ?? 1)
  if (!Number.isInteger(order) || order < 0) return rejected('ordered-successor-chain-order')

  const oldItems = []
  const emptyIndexes = []
  let delimiter = null
  for (let index = 0; index < previousList.childCount; index += 1) {
    const item = previousList.child(index)
    if (!orderedItem(item) || item.childCount !== 1 || item.firstChild?.type?.name !== 'paragraph') {
      return rejected('ordered-successor-chain-plain-item-shape')
    }
    const label = labelMeta(item.attrs?.label)
    if (!label || label.ordinal !== order + index || (delimiter != null && label.delimiter !== delimiter)) {
      return rejected('ordered-successor-chain-old-label-sequence')
    }
    delimiter ||= label.delimiter
    const empty = emptyParagraph(item.firstChild)
    if (!empty && !nonEmptyParagraph(item.firstChild)) {
      return rejected('ordered-successor-chain-paragraph-shape')
    }
    if (empty) emptyIndexes.push(index)
    oldItems.push(Object.freeze({ item, label, empty }))
  }
  if (emptyIndexes.length !== 1) {
    return rejected('ordered-successor-chain-target-count', { proof: { candidateCount: emptyIndexes.length } })
  }
  const removedIndex = emptyIndexes[0]
  const successorCount = previousList.childCount - removedIndex - 1
  if (removedIndex < 1 || successorCount < 2) {
    return rejected('ordered-successor-chain-target-position')
  }

  for (let index = 0; index < nextList.childCount; index += 1) {
    const nextItem = nextList.child(index)
    if (index < removedIndex - 1) {
      if (nextItem.eq?.(oldItems[index].item) !== true) {
        return rejected('ordered-successor-chain-prefix-item-changed')
      }
      continue
    }
    if (index === removedIndex - 1) {
      const previousItem = oldItems[removedIndex - 1].item
      if (
        !orderedItem(nextItem) || nextItem.childCount !== 2 ||
        nextItem.firstChild?.eq?.(previousItem.firstChild) !== true ||
        !emptyParagraph(nextItem.child(1)) ||
        !sourceSyncAttrsEqual(nextItem.attrs, previousItem.attrs)
      ) return rejected('ordered-successor-chain-previous-item-shape')
      continue
    }

    const oldIndex = index + 1
    const oldEntry = oldItems[oldIndex]
    const finalLabel = labelMeta(nextItem.attrs?.label)
    if (
      !orderedItem(nextItem) || nextItem.childCount !== 1 ||
      nextItem.firstChild?.eq?.(oldEntry.item.firstChild) !== true ||
      !attrsEqualExceptLabel(nextItem.attrs, oldEntry.item.attrs) ||
      !finalLabel || finalLabel.ordinal !== order + index || finalLabel.delimiter !== delimiter
    ) return rejected('ordered-successor-chain-final-successor-shape')
  }

  return Object.freeze({
    ok: true,
    topLevelIndex: changed.topLevelIndex,
    unchangedPrefix: changed.unchangedPrefix,
    unchangedSuffix: changed.unchangedSuffix,
    previousList,
    nextList,
    oldItems: Object.freeze(oldItems),
    removedIndex,
    successorCount,
    order,
    delimiter
  })
}

const classifyJournal = ({ journal, expectedDoc, topology }) => {
  const { successorCount, removedIndex } = topology
  if (
    journal.transactionCount !== 2 ||
    journal.stepCount !== successorCount + 1 ||
    journal.entries?.length !== 2 ||
    journal.entries[0]?.stepCount !== 1 ||
    journal.entries[1]?.stepCount !== successorCount
  ) return recognizedRejection('ordered-successor-chain-transaction-count')

  const firstEntry = journal.entries[0]
  const secondEntry = journal.entries[1]
  const firstStep = firstEntry.steps?.[0]
  const firstStepDoc = firstEntry.stepDocs?.[0] || firstEntry.beforeDoc
  if (
    !sameSourceSyncDocument(firstEntry.beforeDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(firstStepDoc, journal.oldDoc) ||
    !sameSourceSyncDocument(secondEntry.beforeDoc, firstEntry.afterDoc) ||
    !sameSourceSyncDocument(secondEntry.afterDoc, expectedDoc)
  ) return recognizedRejection('ordered-successor-chain-step-document')

  if (
    firstStep?.constructor?.name !== 'ReplaceStep' ||
    firstStep.structure !== true ||
    Number(firstStep.slice?.size || 0) !== 0 ||
    !Number.isFinite(firstStep.from) || !Number.isFinite(firstStep.to) || firstStep.to <= firstStep.from
  ) return recognizedRejection('ordered-successor-chain-first-step-shape')

  const top = topology.topLevelIndex
  const removedEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, [top, removedIndex])
  if (
    !removedEntry ||
    firstStep.from !== removedEntry.beforePos - 1 ||
    firstStep.to !== removedEntry.contentStart
  ) return recognizedRejection('ordered-successor-chain-first-step-range')

  let firstApplied
  try { firstApplied = firstStep.apply(firstStepDoc) } catch { firstApplied = null }
  if (firstApplied?.failed || !firstApplied?.doc || !sameSourceSyncDocument(firstApplied.doc, firstEntry.afterDoc)) {
    return recognizedRejection('ordered-successor-chain-first-step-result')
  }

  const intermediateDoc = firstEntry.afterDoc
  const intermediateList = sourceSyncNodeEntryAtPath(intermediateDoc, [top])?.node
  if (
    intermediateList?.type?.name !== 'ordered_list' ||
    intermediateList.childCount !== topology.previousList.childCount - 1 ||
    !sourceSyncAttrsEqual(intermediateList.attrs, topology.previousList.attrs)
  ) return recognizedRejection('ordered-successor-chain-intermediate-list')

  for (let index = 0; index < intermediateList.childCount; index += 1) {
    if (index < removedIndex - 1) {
      if (intermediateList.child(index)?.eq?.(topology.oldItems[index].item) !== true) {
        return recognizedRejection('ordered-successor-chain-intermediate-prefix')
      }
      continue
    }
    if (index === removedIndex - 1) {
      const previousItem = topology.oldItems[removedIndex - 1].item
      const intermediatePrevious = intermediateList.child(index)
      if (
        !orderedItem(intermediatePrevious) || intermediatePrevious.childCount !== 2 ||
        intermediatePrevious.firstChild?.eq?.(previousItem.firstChild) !== true ||
        !emptyParagraph(intermediatePrevious.child(1)) ||
        !sourceSyncAttrsEqual(intermediatePrevious.attrs, previousItem.attrs)
      ) return recognizedRejection('ordered-successor-chain-intermediate-previous')
      continue
    }
    if (intermediateList.child(index)?.eq?.(topology.oldItems[index + 1].item) !== true) {
      return recognizedRejection('ordered-successor-chain-intermediate-successor')
    }
  }

  const relabelSteps = []
  let currentDoc = intermediateDoc
  for (let offset = 0; offset < successorCount; offset += 1) {
    const step = secondEntry.steps?.[offset]
    const stepDoc = secondEntry.stepDocs?.[offset]
    if (!stepDoc || !sameSourceSyncDocument(stepDoc, currentDoc)) {
      return recognizedRejection('ordered-successor-chain-relabel-step-document')
    }
    if (
      step?.constructor?.name !== 'ReplaceAroundStep' ||
      step.structure !== true ||
      Number(step.slice?.size || 0) !== 2 ||
      step.slice?.openStart !== 0 || step.slice?.openEnd !== 0 ||
      step.insert !== 1 ||
      !Number.isFinite(step.from) || !Number.isFinite(step.to) ||
      !Number.isFinite(step.gapFrom) || !Number.isFinite(step.gapTo)
    ) return recognizedRejection('ordered-successor-chain-relabel-step-shape')

    const finalIndex = removedIndex + offset
    const oldIndex = removedIndex + 1 + offset
    const oldSuccessor = topology.oldItems[oldIndex]
    const finalSuccessor = topology.nextList.child(finalIndex)
    const currentEntry = sourceSyncNodeEntryAtPath(stepDoc, [top, finalIndex])
    const currentLabel = labelMeta(currentEntry?.node?.attrs?.label)
    const finalLabel = labelMeta(finalSuccessor?.attrs?.label)
    const sliceItem = step.slice?.content?.firstChild
    if (
      !currentEntry || currentEntry.node?.eq?.(oldSuccessor.item) !== true ||
      !currentLabel || currentLabel.token !== oldSuccessor.label.token ||
      !finalLabel || finalLabel.ordinal !== oldSuccessor.label.ordinal - 1 || finalLabel.delimiter !== topology.delimiter ||
      step.from !== currentEntry.beforePos ||
      step.to !== currentEntry.beforePos + currentEntry.node.nodeSize ||
      step.gapFrom !== currentEntry.contentStart ||
      step.gapTo !== step.to - 1 ||
      sliceItem?.type?.name !== 'list_item' || sliceItem.childCount !== 0 ||
      !sourceSyncAttrsEqual(sliceItem.attrs, finalSuccessor.attrs)
    ) return recognizedRejection('ordered-successor-chain-relabel-step-range')

    let applied
    try { applied = step.apply(stepDoc) } catch { applied = null }
    if (applied?.failed || !applied?.doc) {
      return recognizedRejection('ordered-successor-chain-relabel-step-result')
    }
    const expectedAfter = offset + 1 < successorCount
      ? secondEntry.stepDocs?.[offset + 1]
      : expectedDoc
    if (!expectedAfter || !sameSourceSyncDocument(applied.doc, expectedAfter)) {
      return recognizedRejection('ordered-successor-chain-relabel-step-result')
    }
    currentDoc = applied.doc
    relabelSteps.push(Object.freeze({
      index: offset,
      oldPath: Object.freeze([top, oldIndex]),
      currentPath: Object.freeze([top, finalIndex]),
      finalPath: Object.freeze([top, finalIndex]),
      oldLabel: oldSuccessor.label.token,
      finalLabel: finalLabel.token,
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
    }))
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return recognizedRejection('ordered-successor-chain-final-document')
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
    relabelSteps: Object.freeze(relabelSteps)
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
    reason: 'list-ordered-empty-successor-chain-lifted',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_FAMILY,
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

export function createListOrderedEmptySuccessorChainTransactionSourceSyncOwner({
  mapOrderedChain,
  resolveMarkdownOffset
} = {}) {
  if (typeof mapOrderedChain !== 'function') {
    throw new TypeError('ordered empty successor chain owner requires mapOrderedChain')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('ordered empty successor chain owner requires resolveMarkdownOffset')
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
    boundary = LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) return rejected('ordered-successor-chain-journal-stale', { reset: true })
    const verified = verifySourceSyncTransactionJournalCheckpoint({ checkpoint: journal, snapshot, expectedDoc })
    if (!verified.ok) return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    if (
      typeof currentSource !== 'string' || typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' || !expectedDoc
    ) return rejected('ordered-successor-chain-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('ordered-successor-chain-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('ordered-successor-chain-callback-document-mismatch', { deferred: true })
    }

    const topology = classifyTopology({ oldDoc: journal.oldDoc, expectedDoc })
    if (!topology.ok) return topology
    const journalProof = classifyJournal({ journal, expectedDoc, topology })
    if (!journalProof.ok) return journalProof

    const resolveRange = ({ markdown, doc }) => {
      const paragraphEntry = sourceSyncNodeEntryAtPath(doc, [topology.topLevelIndex, 0, 0])
      if (!paragraphEntry) return null
      let rawOffset
      try {
        rawOffset = resolveMarkdownOffset({
          markdown,
          pmPos: paragraphEntry.contentStart,
          doc,
          topLevelIndex: topology.topLevelIndex
        })
      } catch { return null }
      if (!Number.isFinite(rawOffset)) return null
      const block = normalizeBlockRange(markdown, listBlockAt(markdown, rawOffset))
      return block?.indent === 0 ? Object.freeze({ ...block, rawOffset, pmPos: paragraphEntry.contentStart }) : null
    }

    const sourceRange = resolveRange({ markdown: journal.source, doc: journal.oldDoc })
    const previousRange = resolveRange({ markdown: journal.canonical, doc: journal.oldDoc })
    const nextRange = resolveRange({ markdown: canonical, doc: expectedDoc })
    if (!sourceRange || !previousRange || !nextRange) {
      return recognizedRejection('ordered-successor-chain-range-unmapped')
    }

    const sourceFragment = journal.source.slice(sourceRange.start, sourceRange.end)
    const previousFragment = journal.canonical.slice(previousRange.start, previousRange.end)
    const nextFragment = canonical.slice(nextRange.start, nextRange.end)
    let mapped
    try {
      mapped = mapOrderedChain({
        source: sourceFragment,
        previous: previousFragment,
        next: nextFragment,
        removedIndex: topology.removedIndex,
        listOrder: topology.order,
        successorCount: topology.successorCount
      })
    } catch (error) {
      return recognizedRejection(`ordered-successor-chain-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped || mapped.preserved === false || typeof mapped.markdown !== 'string') {
      return recognizedRejection(mapped?.reason || 'ordered-successor-chain-mapper-rejected')
    }
    if (mapped.reason !== 'diverged-empty-ordered-backspace-successor-chain') {
      return recognizedRejection('ordered-successor-chain-mapper-family-mismatch')
    }
    if (
      mapped.removedIndex !== topology.removedIndex ||
      mapped.successorCount !== topology.successorCount
    ) return recognizedRejection('ordered-successor-chain-mapper-proof-mismatch')
    if (
      typeof mapped.nextBaseline === 'string' &&
      trimOwnedFragmentEnd(mapped.nextBaseline) !== trimOwnedFragmentEnd(nextFragment)
    ) return recognizedRejection('ordered-successor-chain-mapper-partial-baseline')

    const trailingEol = String(mapped.markdown || '').match(/(\r\n|\r|\n)$/)?.[1] || ''
    const sourceSuffix = journal.source.slice(sourceRange.end)
    const suffixOwnsRowTerminator = /^(?:\r\n|\r|\n)/.test(sourceSuffix)
    const boundaryEolGrowth = mapped.trailingBoundaryNewlineGrowth === 1 && trailingEol && !suffixOwnsRowTerminator
      ? trailingEol
      : ''
    const replacement = trimOwnedFragmentEnd(mapped.markdown) + boundaryEolGrowth
    const markdown = journal.source.slice(0, sourceRange.start) + replacement + sourceSuffix
    const top = topology.topLevelIndex
    const previousIndex = topology.removedIndex - 1
    const proof = Object.freeze({
      kind: 'transaction-list-ordered-empty-successor-chain-proof',
      journalId: journal.journalId,
      family: LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_FAMILY,
      listType: 'ordered_list',
      topLevelIndex: top,
      removedIndex: topology.removedIndex,
      successorCount: topology.successorCount,
      removedPath: Object.freeze([top, topology.removedIndex]),
      previousPath: Object.freeze([top, previousIndex]),
      transientEmptyListItemPath: Object.freeze([top, previousIndex]),
      transientEmptyParagraphPath: Object.freeze([top, previousIndex, 1]),
      listOrder: topology.order,
      previousLabel: topology.oldItems[previousIndex].label.token,
      removedLabel: topology.oldItems[topology.removedIndex].label.token,
      successorOldLabels: Object.freeze(
        topology.oldItems.slice(topology.removedIndex + 1).map((entry) => entry.label.token)
      ),
      successorFinalLabels: Object.freeze(
        Array.from({ length: topology.successorCount }, (_, offset) =>
          labelMeta(topology.nextList.child(topology.removedIndex + offset).attrs?.label)?.token || null
        )
      ),
      firstStep: journalProof.firstStep,
      relabelSteps: journalProof.relabelSteps,
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
    family: LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_FAMILY,
    boundary: LIST_ORDERED_EMPTY_SUCCESSOR_CHAIN_TRANSACTION_BOUNDARY,
    plan
  })
}
