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

export const BLOCKQUOTE_SPLIT_TRANSACTION_FAMILY = 'blockquote-paragraph-split'
export const BLOCKQUOTE_SPLIT_TRANSACTION_BOUNDARY = 'transaction-blockquote-paragraph-split'

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

// E0 P3d: repeated Enter over an already-published trailing transient leaves
// SEVERAL consecutive editor-owned empty paragraphs at the quote's tail. The
// authored `>` bytes cannot encode ANY of them; the proof-owned semantic
// bridge collapses the whole run. A split therefore counts as trailing not
// only at the quote's last child, but whenever EVERY paragraph after the
// split index is an empty paragraph.
const trailingEmptySuffix = (children, splitIndex) =>
  splitIndex < children.length &&
  children.slice(splitIndex + 1).every((entry) => {
    const node = entry?.node ?? entry
    return node?.type?.name === 'paragraph' && node.content?.size === 0
  })

const findSplitIndex = (beforeQuote, afterQuote) => {
  const before = quoteChildren(beforeQuote)
  const after = quoteChildren(afterQuote)
  if (after.length !== before.length + 1) return []
  const candidates = []
  for (let index = 0; index < before.length; index += 1) {
    const original = before[index]?.node
    const left = after[index]?.node
    const right = after[index + 1]?.node
    // Enter at the very end of a quote paragraph leaves an empty right
    // paragraph. Authored `> ` separator bytes cannot encode it, so it enters
    // the path-scoped transient ONLY when every paragraph after the split is
    // also empty (a trailing run with a nonempty left sibling). An empty
    // right paragraph before a nonempty sibling has no provable raw/semantic
    // contract and stays unowned.
    const trailingSplit = trailingEmptySuffix(before, index)
    if (
      !isSimpleParagraph(original) ||
      !isSimpleParagraph(left) ||
      !isSimpleParagraph(right, { nonEmpty: !trailingSplit }) ||
      !sourceSyncAttrsEqual(original.attrs, left.attrs) ||
      !sourceSyncAttrsEqual(original.attrs, right.attrs)
    ) continue
    let matched = true
    for (let prefix = 0; prefix < index; prefix += 1) {
      if (before[prefix].node?.eq?.(after[prefix].node) !== true) matched = false
    }
    for (let suffix = index + 1; suffix < before.length; suffix += 1) {
      if (before[suffix].node?.eq?.(after[suffix + 1].node) !== true) matched = false
    }
    if (matched) candidates.push(index)
  }
  return candidates
}

const quoteMatchesPhase = ({
  quote,
  originalQuote,
  splitIndex,
  splitSeen
}) => {
  if (
    quote?.type?.name !== 'blockquote' ||
    !sourceSyncAttrsEqual(quote.attrs, originalQuote.attrs)
  ) return false
  const original = quoteChildren(originalQuote)
  const current = quoteChildren(quote)
  // Mirrors findSplitIndex: the post-split right paragraph may be empty only
  // when every original paragraph after the split index is empty — the
  // whole trailing run then carries the path-scoped transient until the user
  // fills or exits it.
  const trailingSplit = trailingEmptySuffix(original, splitIndex)
  if (!splitSeen) {
    if (current.length !== original.length) return false
    return current.every((entry, index) => {
      if (index === splitIndex) {
        return isSimpleParagraph(entry.node) &&
          sourceSyncAttrsEqual(entry.node.attrs, original[index].node.attrs)
      }
      return entry.node?.eq?.(original[index].node) === true
    })
  }
  if (current.length !== original.length + 1) return false
  return current.every((entry, index) => {
    if (index < splitIndex) return entry.node?.eq?.(original[index].node) === true
    if (index === splitIndex) {
      return isSimpleParagraph(entry.node) &&
        sourceSyncAttrsEqual(entry.node.attrs, original[splitIndex].node.attrs)
    }
    if (index === splitIndex + 1) {
      return isSimpleParagraph(entry.node, { nonEmpty: !trailingSplit }) &&
        sourceSyncAttrsEqual(entry.node.attrs, original[splitIndex].node.attrs)
    }
    return entry.node?.eq?.(original[index - 1].node) === true
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

const classifyBlockquoteSplitJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'blockquote',
    reasonPrefix: 'blockquote-split'
  })
  if (!classification.ok) return classification
  const originalQuote = classification.previousEntry.node
  const finalQuote = classification.nextEntry.node
  if (!sourceSyncAttrsEqual(originalQuote.attrs, finalQuote.attrs)) {
    return rejected('blockquote-split-quote-attrs-changed')
  }
  const candidates = findSplitIndex(originalQuote, finalQuote)
  if (candidates.length !== 1) {
    return rejected('blockquote-split-target-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  const splitIndex = candidates[0]
  const trailingSplit = trailingEmptySuffix(quoteChildren(originalQuote), splitIndex)
  const originalParagraph = quoteChildren(originalQuote)[splitIndex]?.node
  const finalChildren = quoteChildren(finalQuote)
  const leftParagraph = finalChildren[splitIndex]?.node
  const rightParagraph = finalChildren[splitIndex + 1]?.node

  let currentDoc = journal.oldDoc
  let splitSeen = false
  let splitOffset = null
  let splitStepName = null
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('blockquote-split-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('blockquote-split-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('blockquote-split-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('blockquote-split-step-range-invalid')
      }
      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('blockquote-split-step-document-missing')
      }
      const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.nodePath)
      if (
        beforeEntry?.type !== 'blockquote' ||
        !quoteMatchesPhase({
          quote: beforeEntry.node,
          originalQuote,
          splitIndex,
          splitSeen
        })
      ) return rejected('blockquote-split-step-baseline-mismatch')

      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('blockquote-split-step-range-unresolvable')
      }
      const paragraphIndex = directParagraphIndexAt($from, classification.nodePath)
      if (
        paragraphIndex == null ||
        !$from.sameParent?.($to) ||
        $from.before(classification.targetDepth) !== beforeEntry.offset
      ) {
        return rejected('blockquote-split-step-outside-owned-quote')
      }

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('blockquote-split-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('blockquote-split-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(
        stepDoc,
        applied.doc,
        classification.nodePath
      )) return rejected('blockquote-split-neighbour-changed')
      const afterQuote = sourceSyncNodeEntryAtPath(
        applied.doc,
        classification.nodePath
      )?.node
      const beforeCount = beforeEntry.node.childCount
      const afterCount = afterQuote?.childCount

      if (afterCount === beforeCount + 1) {
        if (splitSeen) return rejected('blockquote-split-multiple-structural-steps')
        const slice = step.slice
        if (
          step.structure !== true ||
          step.from !== step.to ||
          paragraphIndex !== splitIndex ||
          !slice ||
          slice.openStart !== 1 ||
          slice.openEnd !== 1 ||
          slice.content?.childCount !== 2 ||
          $from.parentOffset <= 0 ||
          // A middle split keeps text on both sides. Splitting at the paragraph
          // END (the common Enter) is ownable only for the trailing child —
          // anywhere else the empty right paragraph has no transient contract.
          ($from.parentOffset >= $from.parent.content.size && !trailingSplit)
        ) return rejected('blockquote-split-structural-shape')
        let splitNodesValid = true
        slice.content.forEach?.((node) => {
          if (node?.type?.name !== 'paragraph') splitNodesValid = false
        })
        if (!splitNodesValid) return rejected('blockquote-split-structural-slice')
        splitSeen = true
        splitOffset = $from.parentOffset
        splitStepName = step.constructor.name
        if (!quoteMatchesPhase({
          quote: afterQuote,
          originalQuote,
          splitIndex,
          splitSeen: true
        })) return rejected('blockquote-split-structural-result')
      } else if (afterCount === beforeCount) {
        if (
          step.structure === true ||
          !isClosedPlainTextSlice(step.slice)
        ) return rejected('blockquote-split-nontext-followup')
        const allowed = splitSeen
          ? paragraphIndex === splitIndex || paragraphIndex === splitIndex + 1
          : paragraphIndex === splitIndex
        if (!allowed) return rejected('blockquote-split-followup-outside-owned-paragraphs')
        if (!quoteMatchesPhase({
          quote: afterQuote,
          originalQuote,
          splitIndex,
          splitSeen
        })) return rejected('blockquote-split-followup-structure-changed')
      } else {
        return rejected('blockquote-split-child-count-transition')
      }
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('blockquote-split-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!splitSeen) return rejected('blockquote-split-structural-step-missing')
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('blockquote-split-final-document-mismatch')
  }
  return Object.freeze({
    ...classification,
    originalQuote,
    finalQuote,
    splitIndex,
    trailingSplit,
    originalParagraph,
    leftParagraph,
    rightParagraph,
    splitOffset,
    splitStepName
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

const lineAtOffset = (source, offset) => {
  if (!Number.isFinite(offset) || offset < 0 || offset > source.length) return null
  let start = offset
  while (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') start -= 1
  let end = offset
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
  let eol = ''
  if (source.startsWith('\r\n', end)) eol = '\r\n'
  else if (source[end] === '\r') eol = '\r'
  else if (source[end] === '\n') eol = '\n'
  if (!eol) eol = source.match(/\r\n|\r|\n/)?.[0] || '\n'
  return Object.freeze({ start, end, eol })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'blockquote-paragraph-split',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_SPLIT_TRANSACTION_FAMILY,
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

export function createBlockquoteSplitTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('blockquote split owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('blockquote split owner requires validateMarkdown')
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
    boundary = BLOCKQUOTE_SPLIT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('blockquote-split-journal-stale', { reset: true })
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
    ) return rejected('blockquote-split-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('blockquote-split-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('blockquote-split-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyBlockquoteSplitJournal({ journal, expectedDoc })
    if (!classification.ok) {
      return rejected(classification.reason, { proof: classification.proof })
    }
    const textStart = paragraphContentStart(
      classification.previousEntry,
      classification.splitIndex
    )
    const oldText = classification.originalParagraph.textContent
    let rawStart
    let rawEnd
    try {
      rawStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.splitIndex
      })
      rawEnd = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart + oldText.length,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.splitIndex
      })
    } catch {
      return recognizedRejection('blockquote-split-range-mapper-threw')
    }
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rawStart) {
      return recognizedRejection('blockquote-split-range-unmapped')
    }
    if (journal.source.slice(rawStart, rawEnd) !== oldText) {
      return recognizedRejection('blockquote-split-raw-text-mismatch')
    }
    const line = lineAtOffset(journal.source, rawStart)
    if (!line || rawEnd !== line.end) {
      return recognizedRejection('blockquote-split-not-single-line')
    }
    const prefix = journal.source.slice(line.start, rawStart)
    if (!/^ {0,3}>[ \t]*$/.test(prefix)) {
      return recognizedRejection('blockquote-split-prefix-unowned')
    }
    const markerEnd = prefix.indexOf('>') + 1
    const blankPrefix = prefix.slice(0, markerEnd)
    const replacement = `${prefix}${classification.leftParagraph.textContent}` +
      `${line.eol}${blankPrefix}${line.eol}` +
      `${prefix}${classification.rightParagraph.textContent}`
    const markdown = journal.source.slice(0, line.start) +
      replacement +
      journal.source.slice(line.end)
    // A trailing split leaves an empty paragraph the authored `> ` separator
    // bytes cannot encode. Bridge it with the exact-quote-path transient —
    // the same revision-bound semantic context the emptied-paragraph family
    // uses — instead of leaking `<br />` or falling back to whole-doc rewrite.
    const trailingEmptySplit = classification.trailingSplit === true &&
      classification.rightParagraph?.content?.size === 0
    let semanticOk = false
    try {
      semanticOk = validateMarkdown({
        markdown,
        expectedDoc,
        semanticOptions: trailingEmptySplit
          ? { ignoreTrailingEmptyBlockquoteParagraphPaths: [classification.nodePath] }
          : {}
      }) === true
    } catch {
      return recognizedRejection('blockquote-split-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('blockquote-split-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-blockquote-split-proof',
      journalId: journal.journalId,
      family: BLOCKQUOTE_SPLIT_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.nodePath,
      splitIndex: classification.splitIndex,
      splitOffset: classification.splitOffset,
      splitStepName: classification.splitStepName,
      previousText: oldText,
      leftText: classification.leftParagraph.textContent,
      rightText: classification.rightParagraph.textContent,
      trailingEmptySplit,
      transientBlockquotePath: trailingEmptySplit ? classification.nodePath : null,
      prefix,
      blankPrefix,
      eol: line.eol,
      rawStart,
      rawEnd,
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
    family: BLOCKQUOTE_SPLIT_TRANSACTION_FAMILY,
    boundary: BLOCKQUOTE_SPLIT_TRANSACTION_BOUNDARY,
    plan
  })
}
