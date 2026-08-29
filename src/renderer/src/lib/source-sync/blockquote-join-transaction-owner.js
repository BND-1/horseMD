import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleAnchoredSubtreeChange,
  onlySourceSyncNodePathChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  sourceSyncNodeEntryAtPath,
  sourceSyncResolvedPositionMatchesPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const BLOCKQUOTE_JOIN_TRANSACTION_FAMILY = 'blockquote-paragraph-join'
export const BLOCKQUOTE_JOIN_TRANSACTION_BOUNDARY = 'transaction-blockquote-paragraph-join'

const rejected = (reason, {
  deferred = false,
  recognized = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  recognized,
  reset,
  reason,
  proof
})

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const quoteChildren = (quote) => {
  const children = []
  quote?.forEach?.((node, offset, index) => {
    children.push(Object.freeze({ node, offset, index }))
  })
  return children
}

const isSimpleParagraph = (node, { nonEmpty = true } = {}) => {
  if (node?.type?.name !== 'paragraph' || !node.isTextblock) return false
  if (nonEmpty && node.content?.size <= 0) return false
  let simple = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
  })
  return simple
}

const isClosedPlainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return true
  if (slice.openStart || slice.openEnd) return false
  let plain = true
  slice.content.forEach?.((node) => {
    if (!node?.isText || (node.marks?.length || 0) > 0) plain = false
  })
  return plain
}

const findJoinIndexes = (beforeQuote, afterQuote) => {
  const before = quoteChildren(beforeQuote)
  const after = quoteChildren(afterQuote)
  if (before.length !== after.length + 1) return []
  const candidates = []
  for (let rightIndex = 1; rightIndex < before.length; rightIndex += 1) {
    const left = before[rightIndex - 1]?.node
    const right = before[rightIndex]?.node
    const merged = after[rightIndex - 1]?.node
    if (
      !isSimpleParagraph(left) ||
      !isSimpleParagraph(right) ||
      !isSimpleParagraph(merged) ||
      !sourceSyncAttrsEqual(left.attrs, right.attrs) ||
      !sourceSyncAttrsEqual(left.attrs, merged.attrs)
    ) continue
    let matched = true
    for (let prefix = 0; prefix < rightIndex - 1; prefix += 1) {
      if (before[prefix].node?.eq?.(after[prefix].node) !== true) matched = false
    }
    for (let suffix = rightIndex + 1; suffix < before.length; suffix += 1) {
      if (before[suffix].node?.eq?.(after[suffix - 1].node) !== true) matched = false
    }
    if (matched) candidates.push(rightIndex)
  }
  return candidates
}

const quoteMatchesPhase = ({
  quote,
  originalQuote,
  rightIndex,
  joinSeen
}) => {
  if (
    quote?.type?.name !== 'blockquote' ||
    !sourceSyncAttrsEqual(quote.attrs, originalQuote.attrs)
  ) return false
  if (!joinSeen) return quote.eq?.(originalQuote) === true

  const original = quoteChildren(originalQuote)
  const current = quoteChildren(quote)
  if (current.length !== original.length - 1) return false
  return current.every((entry, index) => {
    if (index < rightIndex - 1) return entry.node?.eq?.(original[index].node) === true
    if (index === rightIndex - 1) {
      return isSimpleParagraph(entry.node) &&
        sourceSyncAttrsEqual(entry.node.attrs, original[rightIndex - 1].node.attrs)
    }
    return entry.node?.eq?.(original[index + 1].node) === true
  })
}

const directParagraphIndexAt = ($position, nodePath) => {
  const quoteDepth = nodePath?.length || 0
  if (
    !$position ||
    quoteDepth <= 0 ||
    $position.depth !== quoteDepth + 1 ||
    $position.parent?.type?.name !== 'paragraph' ||
    $position.node(quoteDepth)?.type?.name !== 'blockquote' ||
    !sourceSyncResolvedPositionMatchesPath($position, nodePath)
  ) return null
  return $position.index(quoteDepth)
}

const classifyBlockquoteJoinJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'blockquote',
    reasonPrefix: 'blockquote-join'
  })
  if (!classification.ok) return classification
  const originalQuote = classification.previousEntry.node
  const finalQuote = classification.nextEntry.node
  if (!sourceSyncAttrsEqual(originalQuote.attrs, finalQuote.attrs)) {
    return rejected('blockquote-join-quote-attrs-changed')
  }
  const candidates = findJoinIndexes(originalQuote, finalQuote)
  if (candidates.length !== 1) {
    return rejected('blockquote-join-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  const rightIndex = candidates[0]
  const originalChildren = quoteChildren(originalQuote)
  const originalLeft = originalChildren[rightIndex - 1]?.node
  const originalRight = originalChildren[rightIndex]?.node
  const finalMerged = quoteChildren(finalQuote)[rightIndex - 1]?.node

  let currentDoc = journal.oldDoc
  let joinSeen = false
  let joinStepName = null
  let joinStructure = null
  let joinFrom = null
  let joinTo = null
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('blockquote-join-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('blockquote-join-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('blockquote-join-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('blockquote-join-step-range-invalid')
      }
      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('blockquote-join-step-document-missing')
      }
      const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.nodePath)
      if (
        beforeEntry?.type !== 'blockquote' ||
        !quoteMatchesPhase({
          quote: beforeEntry.node,
          originalQuote,
          rightIndex,
          joinSeen
        })
      ) return rejected('blockquote-join-step-baseline-mismatch')

      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('blockquote-join-step-range-unresolvable')
      }
      const fromIndex = directParagraphIndexAt($from, classification.nodePath)
      const toIndex = directParagraphIndexAt($to, classification.nodePath)
      if (
        fromIndex == null ||
        toIndex == null ||
        $from.before(classification.targetDepth) !== beforeEntry.offset ||
        $to.before(classification.targetDepth) !== beforeEntry.offset
      ) return rejected('blockquote-join-step-outside-owned-quote')

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('blockquote-join-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('blockquote-join-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(
        stepDoc,
        applied.doc,
        classification.nodePath
      )) return rejected('blockquote-join-neighbour-changed')
      const afterQuote = sourceSyncNodeEntryAtPath(
        applied.doc,
        classification.nodePath
      )?.node
      const beforeCount = beforeEntry.node.childCount
      const afterCount = afterQuote?.childCount

      if (afterCount === beforeCount - 1) {
        if (joinSeen) return rejected('blockquote-join-multiple-structural-steps')
        const slice = step.slice
        if (
          !slice ||
          slice.size !== 0 ||
          slice.openStart !== 0 ||
          slice.openEnd !== 0 ||
          fromIndex !== rightIndex - 1 ||
          toIndex !== rightIndex ||
          step.to - step.from !== 2 ||
          $from.parentOffset !== $from.parent.content.size ||
          $to.parentOffset !== 0
        ) return rejected('blockquote-join-structural-shape', {
          proof: {
            stepName: step.constructor?.name || null,
            stepJson: step.toJSON?.() || null,
            structure: step.structure === true,
            sliceSize: slice?.size ?? null,
            sliceOpenStart: slice?.openStart ?? null,
            sliceOpenEnd: slice?.openEnd ?? null,
            fromIndex,
            toIndex,
            rightIndex,
            rangeWidth: step.to - step.from,
            fromParentOffset: $from.parentOffset,
            fromParentSize: $from.parent?.content?.size ?? null,
            toParentOffset: $to.parentOffset,
            fromDepth: $from.depth,
            toDepth: $to.depth,
            nodePath: classification.nodePath,
            targetDepth: classification.targetDepth,
            beforeCount,
            afterCount
          }
        })
        const merged = quoteChildren(afterQuote)[rightIndex - 1]?.node
        if (
          !isSimpleParagraph(merged) ||
          !sourceSyncAttrsEqual(merged.attrs, originalLeft.attrs) ||
          merged.textContent !== originalLeft.textContent + originalRight.textContent
        ) return rejected('blockquote-join-structural-result')
        joinSeen = true
        joinStepName = step.constructor.name
        joinStructure = step.structure === true
        joinFrom = step.from
        joinTo = step.to
      } else if (afterCount === beforeCount) {
        if (
          !joinSeen ||
          step.structure === true ||
          !isClosedPlainTextSlice(step.slice) ||
          fromIndex !== rightIndex - 1 ||
          toIndex !== rightIndex - 1 ||
          !$from.sameParent?.($to)
        ) return rejected('blockquote-join-followup-outside-merged-paragraph')
        if (!quoteMatchesPhase({
          quote: afterQuote,
          originalQuote,
          rightIndex,
          joinSeen: true
        })) return rejected('blockquote-join-followup-structure-changed')
      } else {
        return rejected('blockquote-join-child-count-transition')
      }
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('blockquote-join-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!joinSeen) return rejected('blockquote-join-structural-step-missing')
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('blockquote-join-final-document-mismatch')
  }
  return Object.freeze({
    ...classification,
    originalQuote,
    finalQuote,
    rightIndex,
    originalLeft,
    originalRight,
    finalMerged,
    joinStepName,
    joinStructure,
    joinFrom,
    joinTo
  })
}

const paragraphContentStart = (entry, paragraphIndex) => {
  let childOffset = 0
  const quote = entry?.node
  for (let index = 0; index < paragraphIndex; index += 1) {
    childOffset += quote.child(index).nodeSize
  }
  return entry.offset + 2 + childOffset
}

const eolAt = (source, offset) => {
  if (source.startsWith('\r\n', offset)) return '\r\n'
  if (source[offset] === '\r') return '\r'
  if (source[offset] === '\n') return '\n'
  return ''
}

const lineAtOffset = (source, offset) => {
  if (!Number.isFinite(offset) || offset < 0 || offset > source.length) return null
  let start = offset
  while (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') start -= 1
  let end = offset
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
  return Object.freeze({ start, end, eol: eolAt(source, end) })
}

const quotePrefix = (value) => {
  const match = String(value || '').match(/^( {0,3})>([ \t]*)$/)
  return match
    ? Object.freeze({ indent: match[1], spacing: match[2], marker: `${match[1]}>` })
    : null
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'blockquote-paragraph-join',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_JOIN_TRANSACTION_FAMILY,
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

export function createBlockquoteJoinTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('blockquote join owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('blockquote join owner requires validateMarkdown')
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
    boundary = BLOCKQUOTE_JOIN_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('blockquote-join-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({
      checkpoint: journal,
      snapshot,
      expectedDoc
    })
    if (!verified.ok) {
      return rejected(verified.reason, {
        reset: verified.reset,
        proof: verified.proof
      })
    }
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('blockquote-join-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('blockquote-join-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('blockquote-join-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyBlockquoteJoinJournal({ journal, expectedDoc })
    if (!classification.ok) {
      return rejected(classification.reason, { proof: classification.proof })
    }

    const leftStart = paragraphContentStart(
      classification.previousEntry,
      classification.rightIndex - 1
    )
    const rightStart = paragraphContentStart(
      classification.previousEntry,
      classification.rightIndex
    )
    const leftText = classification.originalLeft.textContent
    const rightText = classification.originalRight.textContent
    let leftRawStart
    let leftRawEnd
    let rightRawStart
    let rightRawEnd
    try {
      leftRawStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: leftStart,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.rightIndex - 1
      })
      leftRawEnd = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: leftStart + leftText.length,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.rightIndex - 1
      })
      rightRawStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: rightStart,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.rightIndex
      })
      rightRawEnd = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: rightStart + rightText.length,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.rightIndex
      })
    } catch {
      return recognizedRejection('blockquote-join-range-mapper-threw')
    }
    if (
      !Number.isFinite(leftRawStart) ||
      !Number.isFinite(leftRawEnd) ||
      !Number.isFinite(rightRawStart) ||
      !Number.isFinite(rightRawEnd) ||
      leftRawEnd < leftRawStart ||
      rightRawEnd < rightRawStart ||
      rightRawStart <= leftRawEnd
    ) return recognizedRejection('blockquote-join-range-unmapped')
    if (
      journal.source.slice(leftRawStart, leftRawEnd) !== leftText ||
      journal.source.slice(rightRawStart, rightRawEnd) !== rightText
    ) return recognizedRejection('blockquote-join-raw-text-mismatch')

    const leftLine = lineAtOffset(journal.source, leftRawStart)
    const rightLine = lineAtOffset(journal.source, rightRawStart)
    if (
      !leftLine ||
      !rightLine ||
      leftRawEnd !== leftLine.end ||
      rightRawEnd !== rightLine.end ||
      !leftLine.eol
    ) return recognizedRejection('blockquote-join-not-single-line')
    const leftPrefixRaw = journal.source.slice(leftLine.start, leftRawStart)
    const rightPrefixRaw = journal.source.slice(rightLine.start, rightRawStart)
    const leftPrefix = quotePrefix(leftPrefixRaw)
    const rightPrefix = quotePrefix(rightPrefixRaw)
    if (!leftPrefix || !rightPrefix || leftPrefix.indent !== rightPrefix.indent) {
      return recognizedRejection('blockquote-join-prefix-unowned')
    }

    const blankStart = leftLine.end + leftLine.eol.length
    const blankLine = lineAtOffset(journal.source, blankStart)
    if (
      !blankLine ||
      blankLine.start !== blankStart ||
      !blankLine.eol ||
      rightLine.start !== blankLine.end + blankLine.eol.length
    ) return recognizedRejection('blockquote-join-separator-shape')
    const blankPrefix = quotePrefix(
      journal.source.slice(blankLine.start, blankLine.end)
    )
    if (!blankPrefix || blankPrefix.indent !== leftPrefix.indent) {
      return recognizedRejection('blockquote-join-separator-prefix')
    }

    const markdown = journal.source.slice(0, leftRawStart) +
      classification.finalMerged.textContent +
      journal.source.slice(rightRawEnd)
    let semanticOk = false
    try {
      semanticOk = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return recognizedRejection('blockquote-join-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('blockquote-join-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-blockquote-join-proof',
      journalId: journal.journalId,
      family: BLOCKQUOTE_JOIN_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.nodePath,
      rightIndex: classification.rightIndex,
      joinStepName: classification.joinStepName,
      joinStructure: classification.joinStructure,
      joinFrom: classification.joinFrom,
      joinTo: classification.joinTo,
      leftText,
      rightText,
      mergedText: classification.finalMerged.textContent,
      leftPrefix: leftPrefixRaw,
      blankPrefix: journal.source.slice(blankLine.start, blankLine.end),
      rightPrefix: rightPrefixRaw,
      eol: leftLine.eol,
      rawStart: leftRawStart,
      rawEnd: rightRawEnd,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
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
    family: BLOCKQUOTE_JOIN_TRANSACTION_FAMILY,
    boundary: BLOCKQUOTE_JOIN_TRANSACTION_BOUNDARY,
    plan
  })
}
