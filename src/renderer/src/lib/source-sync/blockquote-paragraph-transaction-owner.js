import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
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

const isSimpleNonEmptyParagraph = (node) => {
  if (
    !node?.isTextblock ||
    node.type?.name !== 'paragraph' ||
    node.content?.size <= 0
  ) return false
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
    !isSimpleNonEmptyParagraph(previousParagraph) ||
    !isSimpleNonEmptyParagraph(nextParagraph)
  ) return rejected('blockquote-paragraph-not-simple-nonempty')
  if (!sourceSyncAttrsEqual(previousParagraph.attrs, nextParagraph.attrs)) {
    return rejected('blockquote-paragraph-attrs-changed')
  }
  if (previousParagraph.textContent === nextParagraph.textContent) {
    return rejected('blockquote-paragraph-text-unchanged')
  }

  let currentDoc = journal.oldDoc
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('blockquote-paragraph-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('blockquote-paragraph-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('blockquote-paragraph-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('blockquote-paragraph-step-range-invalid')
      }
      if (step.structure === true) return rejected('blockquote-paragraph-structural-step')
      if (!isClosedPlainTextSlice(step.slice)) {
        return rejected('blockquote-paragraph-structural-slice')
      }

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('blockquote-paragraph-step-document-missing')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('blockquote-paragraph-step-range-unresolvable')
      }
      if (!$from?.sameParent?.($to)) {
        return rejected('blockquote-paragraph-cross-parent-range')
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
        $from.index(quoteDepth) !== paragraphIndex
      ) return rejected('blockquote-paragraph-step-outside-owned-paragraph')
      const beforeQuote = beforeEntry.node
      const beforeParagraph = quoteChildren(beforeQuote)[paragraphIndex]?.node
      if (
        !sourceSyncAttrsEqual(beforeQuote.attrs, previousQuote.attrs) ||
        !isSimpleNonEmptyParagraph(beforeParagraph) ||
        !sourceSyncAttrsEqual(beforeParagraph.attrs, previousParagraph.attrs)
      ) return rejected('blockquote-paragraph-step-baseline-mismatch')

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('blockquote-paragraph-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('blockquote-paragraph-step-apply-failed')
      }
      if (!onlySourceSyncNodePathChanged(
        stepDoc,
        applied.doc,
        classification.nodePath
      )) return rejected('blockquote-paragraph-neighbour-changed')
      const afterQuote = sourceSyncNodeEntryAtPath(
        applied.doc,
        classification.nodePath
      )?.node
      if (
        afterQuote?.type?.name !== 'blockquote' ||
        !sourceSyncAttrsEqual(afterQuote.attrs, previousQuote.attrs) ||
        !onlyQuoteChildIndexChanged(beforeQuote, afterQuote, paragraphIndex)
      ) return rejected('blockquote-paragraph-quote-structure-changed')
      const afterParagraph = quoteChildren(afterQuote)[paragraphIndex]?.node
      if (
        !isSimpleNonEmptyParagraph(afterParagraph) ||
        !sourceSyncAttrsEqual(afterParagraph.attrs, previousParagraph.attrs)
      ) return rejected('blockquote-paragraph-result-not-simple-nonempty')
      if (beforeParagraph.eq?.(afterParagraph) === true) {
        return rejected('blockquote-paragraph-step-unchanged')
      }
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('blockquote-paragraph-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('blockquote-paragraph-final-document-mismatch')
  }

  return Object.freeze({
    ...classification,
    previousQuote,
    nextQuote,
    paragraphIndex,
    previousParagraph,
    nextParagraph
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'blockquote-paragraph-text-change',
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
      return rejected(classification.reason, { proof: classification.proof })
    }
    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return recognizedRejection('blockquote-paragraph-step-count')

    let mapped
    try {
      mapped = mapTransactions({
        source: journal.source,
        transactions,
        oldState: { doc: journal.oldDoc },
        newState: { doc: expectedDoc },
        blockHints: [],
        mapPosition: (markdown, pmPos, doc) => resolveMarkdownOffset({
          markdown,
          pmPos,
          doc,
          topLevelIndex: classification.topLevelIndex,
          paragraphIndex: classification.paragraphIndex
        }),
        validateMarkdown: (markdown, mappedExpectedDoc) => validateMarkdown({
          markdown,
          expectedDoc: mappedExpectedDoc
        })
      })
    } catch (error) {
      return recognizedRejection(`blockquote-paragraph-mapper-threw:${error?.name || 'Error'}`)
    }
    if (!mapped?.ok || typeof mapped.markdown !== 'string') {
      return recognizedRejection(mapped?.reason || 'blockquote-paragraph-mapper-rejected')
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
      markdownDigest: sourceSyncDigest(mapped.markdown),
      mapperReason: mapped.reason || null,
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      markdown: mapped.markdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: BLOCKQUOTE_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: BLOCKQUOTE_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
