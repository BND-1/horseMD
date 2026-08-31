import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { provePendingTextTransactionChain } from './pending-text-transaction-chain.js'
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
import {
  transactionsFromSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from './transaction-journal.js'

export const BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY = 'blockquote-paragraph-text-replace'
export const BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY = 'transaction-blockquote-paragraph-text'

const rejected = (reason, {
  deferred = false,
  recognized = false,
  reset = false,
  holdJournal = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  recognized,
  reset,
  holdJournal,
  reason,
  proof
})

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const isSimpleParagraph = (node, { allowEmpty = false } = {}) => {
  if (!node?.isTextblock || node.type?.name !== 'paragraph') return false
  if (!allowEmpty && node.content?.size <= 0) return false
  let simple = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
  })
  return simple
}

// E0 (0.13.171 trace): typing a bare block marker character-by-character
// ("1" then ".") passes through an instant where the paragraph text is
// EXACTLY a list/heading/quote marker prefix. Those bytes inside a `> ` line
// re-parse as a DIFFERENT block type (e.g. `> 1.` is an ordered list), so no
// bounded raw patch can be semantically valid at that instant. The next
// physical transaction always resolves it (the input rule converts it into a
// real list, or the next character makes it plain text), so the journal is
// HELD for that transaction instead of failing closed with a warning.
const SYNTAX_PENDING_MARKER_PREFIX = /^(?:\d{1,9}[.)]|[-*+]|#{1,6}|>)[ \t]*$/

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

const quoteChildren = (quote) => {
  const children = []
  quote?.forEach?.((node, offset, index) => {
    children.push(Object.freeze({ node, offset, index, type: node?.type?.name || 'unknown' }))
  })
  return children
}

const onlyQuoteChildIndexChanged = (beforeQuote, afterQuote, childIndex) => {
  const before = quoteChildren(beforeQuote)
  const after = quoteChildren(afterQuote)
  if (before.length !== after.length || !before[childIndex] || !after[childIndex]) return false
  return before.every((entry, index) =>
    index === childIndex || entry.node?.eq?.(after[index]?.node) === true
  )
}

const classifyBlockquoteParagraphJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleAnchoredSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'blockquote',
    reasonPrefix: 'blockquote-paragraph'
  })
  if (!classification.ok) return classification

  const previousQuote = classification.previousEntry.node
  const nextQuote = classification.nextEntry.node
  if (!sourceSyncAttrsEqual(previousQuote.attrs, nextQuote.attrs)) {
    return rejected('blockquote-paragraph-quote-attrs-changed')
  }
  const beforeChildren = quoteChildren(previousQuote)
  const afterChildren = quoteChildren(nextQuote)
  if (beforeChildren.length !== afterChildren.length) {
    return rejected('blockquote-paragraph-child-count-changed')
  }
  const changed = beforeChildren.filter((entry, index) =>
    entry.node?.eq?.(afterChildren[index]?.node) !== true
  )
  if (changed.length !== 1) {
    return rejected('blockquote-paragraph-change-count')
  }
  const paragraphIndex = changed[0].index
  const previousParagraph = beforeChildren[paragraphIndex]?.node
  const nextParagraph = afterChildren[paragraphIndex]?.node
  if (
    !isSimpleParagraph(previousParagraph) ||
    !isSimpleParagraph(nextParagraph, { allowEmpty: true })
  ) {
    // A NONEMPTY paragraph whose content carries marks (e.g. Milkdown's
    // input rule converted `*e*` into emphasis) is still this family's shape
    // — text in the quote paragraph — so it must fail CLOSED (recognized):
    // the retired legacy branch may not guess a raw mapping for marked bytes.
    // An EMPTY previous paragraph (filling the published transient) belongs
    // to the legacy fill path, and a non-paragraph child (list/heading/code)
    // is another family's shape; both stay available to the next owner.
    const paragraphShaped = (node) =>
      node?.isTextblock && node.type?.name === 'paragraph'
    if (
      paragraphShaped(previousParagraph) &&
      paragraphShaped(nextParagraph) &&
      previousParagraph.content.size > 0
    ) {
      return recognizedRejection('blockquote-paragraph-not-simple-plain')
    }
    return rejected('blockquote-paragraph-not-simple-plain')
  }
  if (!sourceSyncAttrsEqual(previousParagraph.attrs, nextParagraph.attrs)) {
    return rejected('blockquote-paragraph-attrs-changed')
  }
  if (previousParagraph.textContent === nextParagraph.textContent) {
    return rejected('blockquote-paragraph-text-unchanged')
  }

  // Deleting the paragraph's last character (0.13.169 `> ‘` + Backspace) is
  // still THIS family's bounded text delete — but an authored bare `>` line
  // cannot encode an empty quote paragraph at an arbitrary position:
  // CommonMark reads separator `>` lines as paragraph boundaries, not as empty
  // paragraphs. Only exactly one TRAILING empty paragraph after a nonempty
  // sibling can enter the path-scoped semantic transient. A SINGLE-child quote
  // emptied is NOT recognized here: the legacy paragraph-emptied path has
  // owned that shape correctly for years (`>\n>\n` publication), so it stays
  // available. Any other emptied topology has no provable raw/semantic
  // contract, and this legacy-retired family must fail closed rather than let
  // a generic mapper guess the slot.
  if (nextParagraph.content.size === 0) {
    if (beforeChildren.length < 2) {
      return rejected('blockquote-paragraph-emptied-single-child')
    }
    if (paragraphIndex !== beforeChildren.length - 1) {
      return recognizedRejection('blockquote-paragraph-emptied-not-trailing')
    }
  }

  const chain = provePendingTextTransactionChain({
    journal,
    expectedDoc,
    reasonPrefix: 'blockquote-paragraph',
    validateTextChain: ({ textSteps }) => {
      if (!textSteps.length) return { ok: false, reason: 'blockquote-paragraph-step-count' }
      for (const textStep of textSteps) {
        const { step, stepDoc, appliedDoc } = textStep
        let $from
        let $to
        try {
          $from = stepDoc.resolve(step.from)
          $to = stepDoc.resolve(step.to)
        } catch {
          return { ok: false, reason: 'blockquote-paragraph-step-range-unresolvable' }
        }
        if (!$from?.sameParent?.($to)) {
          return { ok: false, reason: 'blockquote-paragraph-cross-parent-range' }
        }
        const beforeEntry = sourceSyncNodeEntryAtPath(stepDoc, classification.nodePath)
        const quoteDepth = classification.targetDepth
        if (
          !beforeEntry ||
          beforeEntry.type !== 'blockquote' ||
          $from.depth !== quoteDepth + 1 ||
          $from.parent?.type?.name !== 'paragraph' ||
          $from.node(quoteDepth)?.type?.name !== 'blockquote' ||
          $from.before(quoteDepth) !== beforeEntry.offset ||
          !sourceSyncResolvedPositionMatchesPath($from, classification.nodePath) ||
          !sourceSyncResolvedPositionMatchesPath($to, classification.nodePath) ||
          $from.index(quoteDepth) !== paragraphIndex ||
          $to.index(quoteDepth) !== paragraphIndex
        ) return { ok: false, reason: 'blockquote-paragraph-step-outside-owned-paragraph' }
        const beforeQuote = beforeEntry.node
        const beforeParagraph = quoteChildren(beforeQuote)[paragraphIndex]?.node
        if (
          !sourceSyncAttrsEqual(beforeQuote.attrs, previousQuote.attrs) ||
          !isSimpleParagraph(beforeParagraph, { allowEmpty: true }) ||
          !sourceSyncAttrsEqual(beforeParagraph.attrs, previousParagraph.attrs)
        ) return { ok: false, reason: 'blockquote-paragraph-step-baseline-mismatch' }
        if (!onlySourceSyncNodePathChanged(
          stepDoc,
          appliedDoc,
          classification.nodePath
        )) return { ok: false, reason: 'blockquote-paragraph-neighbour-changed' }
        const afterQuote = sourceSyncNodeEntryAtPath(appliedDoc, classification.nodePath)?.node
        if (
          afterQuote?.type?.name !== 'blockquote' ||
          !sourceSyncAttrsEqual(afterQuote.attrs, previousQuote.attrs) ||
          !onlyQuoteChildIndexChanged(beforeQuote, afterQuote, paragraphIndex)
        ) return { ok: false, reason: 'blockquote-paragraph-quote-structure-changed' }
        const afterParagraph = quoteChildren(afterQuote)[paragraphIndex]?.node
        if (
          !isSimpleParagraph(afterParagraph, { allowEmpty: true }) ||
          !sourceSyncAttrsEqual(afterParagraph.attrs, previousParagraph.attrs)
        ) return { ok: false, reason: 'blockquote-paragraph-result-not-simple-plain' }
        if (beforeParagraph.eq?.(afterParagraph) === true) {
          return { ok: false, reason: 'blockquote-paragraph-step-unchanged' }
        }
      }
      return { ok: true, proof: { nodePath: classification.nodePath, paragraphIndex } }
    }
  })
  if (!chain.ok) return rejected(chain.reason, { proof: chain.proof })

  return Object.freeze({
    ...classification,
    previousQuote,
    nextQuote,
    paragraphIndex,
    previousParagraph,
    nextParagraph,
    transactionChain: chain
  })
}

const createOwnedPlan = ({
  boundary,
  markdown,
  canonical,
  expectedDoc,
  proof,
  reason = 'blockquote-paragraph-text-change'
}) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
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

export function createBlockquoteParagraphTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof mapTransactions !== 'function') {
    throw new TypeError('blockquote paragraph owner requires mapTransactions')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('blockquote paragraph owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('blockquote paragraph owner requires validateMarkdown')
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
    boundary = BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('blockquote-paragraph-journal-stale', { reset: true })
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
    ) return rejected('blockquote-paragraph-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('blockquote-paragraph-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('blockquote-paragraph-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyBlockquoteParagraphJournal({ journal, expectedDoc })
    if (!classification.ok) {
      return rejected(classification.reason, {
        proof: classification.proof,
        // Classification rejections normally mean "not this family's shape".
        // The emptied-topology rejections are different: the journal IS a
        // quote-paragraph text edit this legacy-retired family matched, but no
        // provable raw/semantic contract exists — they must stay fail-closed.
        recognized: classification.recognized === true
      })
    }
    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return recognizedRejection('blockquote-paragraph-step-count')
    if (SYNTAX_PENDING_MARKER_PREFIX.test(classification.nextParagraph.textContent)) {
      return rejected('blockquote-paragraph-syntax-pending', {
        deferred: true,
        holdJournal: true
      })
    }

    // Map the OWNED paragraph's ORIGINAL text span — published plain text is
    // unambiguous — and splice the FINAL text in place: the same bounded raw
    // patch shape the split family uses. Per-step view evolution is avoided
    // deliberately: an intermediate state can be unrepresentable as authored
    // bytes (the instant a paragraph reads exactly "1.") without invalidating
    // the FINAL mapping. Syntax safety is enforced by the semantic validator
    // on the final candidate, which fails closed on any text that would
    // change block type or acquire marks on re-parse.
    const previousText = classification.previousParagraph.textContent
    const nextText = classification.nextParagraph.textContent
    const textStart = paragraphContentStart(
      classification.previousEntry,
      classification.paragraphIndex
    )
    let rawStart
    let rawEnd
    try {
      rawStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.paragraphIndex
      })
      rawEnd = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: textStart + previousText.length,
        doc: journal.oldDoc,
        topLevelIndex: classification.topLevelIndex,
        paragraphIndex: classification.paragraphIndex
      })
    } catch {
      return recognizedRejection('blockquote-paragraph-range-mapper-threw')
    }
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rawStart) {
      return recognizedRejection('blockquote-paragraph-range-unmapped')
    }
    if (journal.source.slice(rawStart, rawEnd) !== previousText) {
      return recognizedRejection('blockquote-paragraph-raw-text-mismatch')
    }
    const line = lineAtOffset(journal.source, rawStart)
    if (!line || rawEnd !== line.end) {
      return recognizedRejection('blockquote-paragraph-not-single-line')
    }
    const prefix = journal.source.slice(line.start, rawStart)
    if (!/^ {0,3}>[ \t]*$/.test(prefix)) {
      return recognizedRejection('blockquote-paragraph-prefix-unowned')
    }
    const markdown = journal.source.slice(0, line.start) +
      prefix + nextText +
      journal.source.slice(line.end)
    const emptied = nextText.length === 0
    let semanticOk = false
    try {
      semanticOk = validateMarkdown({
        markdown,
        expectedDoc,
        semanticOptions: emptied
          ? { ignoreTrailingEmptyBlockquoteParagraphPaths: [classification.nodePath] }
          : {}
      }) === true
    } catch {
      return recognizedRejection('blockquote-paragraph-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('blockquote-paragraph-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-blockquote-paragraph-proof',
      journalId: journal.journalId,
      family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: classification.nodePath,
      paragraphIndex: classification.paragraphIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      previousText: classification.previousParagraph.textContent,
      nextText: classification.nextParagraph.textContent,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      mapperReason: 'bounded-final-text-patch',
      emptiedParagraph: classification.nextParagraph.content.size === 0,
      transientBlockquotePath: classification.nextParagraph.content.size === 0
        ? classification.nodePath
        : null,
      pendingTextChain: Object.freeze({
        textStepCount: classification.transactionChain.textStepCount,
        textReplacementStepCount: classification.transactionChain.textReplacementStepCount,
        textTransactionCount: classification.transactionChain.textTransactionCount
      }),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown,
      canonical,
      expectedDoc,
      proof,
      reason: proof.emptiedParagraph
        ? 'blockquote-paragraph-emptied'
        : 'blockquote-paragraph-text-change'
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
