import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  transactionsFromSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from './transaction-journal.js'

export const PLAIN_PARAGRAPH_TRANSACTION_FAMILY = 'plain-paragraph-inline-replace'
export const PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY = 'transaction-plain-paragraph'

const sameDocument = (left, right) => {
  if (left === right) return true
  if (!left || !right) return false
  return typeof left.eq === 'function' ? left.eq(right) : false
}

const rejected = (reason, {
  family = null,
  deferred = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  owner: null,
  family,
  deferred,
  reset,
  reason,
  proof
})

const isSimplePlainParagraph = (node) => {
  if (
    !node?.isTextblock ||
    node.type?.name !== 'paragraph' ||
    node.content?.size <= 0
  ) return false
  let simple = true
  node.descendants?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) simple = false
    return false
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

const countSimpleTopLevelParagraphs = (doc) => {
  let count = 0
  doc?.forEach?.((node) => {
    if (isSimplePlainParagraph(node)) count += 1
  })
  return count
}

const classifyPlainParagraphJournal = ({ journal, expectedDoc }) => {
  if (!journal?.entries?.length) {
    return rejected('phase1-changed-transaction-count')
  }
  let currentDoc = journal.oldDoc
  for (const entry of journal.entries) {
    if (!sameDocument(entry.beforeDoc, currentDoc)) {
      return rejected('phase1-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('phase1-step-count')

    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('phase1-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('phase1-unresolvable-range')
      }

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameDocument(stepDoc, entryDoc)) {
        return rejected('phase1-step-document-missing')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('phase1-unresolvable-range')
      }
      if (!$from?.sameParent?.($to)) return rejected('phase1-cross-parent-range')
      if ($from.depth !== 1 || $from.parent?.type?.name !== 'paragraph') {
        return rejected('phase1-non-top-level-paragraph')
      }
      if (!isSimplePlainParagraph($from.parent)) {
        return rejected('phase1-non-plain-source-paragraph')
      }
      if (!isClosedPlainTextSlice(step.slice)) {
        return rejected('phase1-structural-slice')
      }
      if (step.structure === true) return rejected('phase1-structural-step')

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('phase1-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) {
        return rejected('phase1-step-apply-failed')
      }
      const topBlockStart = $from.before(1)
      const nextBlock = applied.doc.nodeAt?.(topBlockStart)
      if (!nextBlock?.isTextblock || nextBlock.type?.name !== 'paragraph') {
        return rejected('phase1-result-not-plain-paragraph')
      }
      if (nextBlock.content?.size <= 0) {
        return rejected('phase1-result-empty-paragraph')
      }
      if (!isSimplePlainParagraph(nextBlock)) {
        return rejected('phase1-result-not-plain-paragraph')
      }
      entryDoc = applied.doc
    }

    if (!sameDocument(entryDoc, entry.afterDoc)) {
      return rejected('phase1-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameDocument(currentDoc, expectedDoc)) {
    return rejected('phase1-final-document-mismatch')
  }
  return Object.freeze({
    ok: true,
    family: PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
    reason: 'phase1-plain-paragraph-inline-replace',
    plainParagraphCount: countSimpleTopLevelParagraphs(journal.oldDoc)
  })
}

const createOwnedPlan = ({
  boundary,
  markdown,
  canonical,
  expectedDoc,
  mapperReason,
  proof
}) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: mapperReason || PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
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

/**
 * Plans one revision-bound family of top-level, unmarked paragraph edits from
 * the shared SourceSyncTransactionJournal. Dispatch-time capture is generic;
 * this module classifies the complete journal and replays its exact ReplaceStep
 * chain only at callback/forced-flush time. It owns no mutable lifecycle state.
 */
export function createPlainParagraphTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof mapTransactions !== 'function') {
    throw new TypeError('plain paragraph transaction owner requires mapTransactions')
  }
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('plain paragraph transaction owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('plain paragraph transaction owner requires validateMarkdown')
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
    boundary = PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('plain-paragraph-journal-stale', { reset: true })
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
    ) return rejected('plain-paragraph-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('plain-paragraph-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('plain-paragraph-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyPlainParagraphJournal({ journal, expectedDoc })
    if (!classification.ok) return classification

    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return rejected('phase1-changed-transaction-count')

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
          doc
        }),
        validateMarkdown: (markdown, mappedExpectedDoc) => validateMarkdown({
          markdown,
          expectedDoc: mappedExpectedDoc
        })
      })
    } catch (error) {
      return rejected(`plain-paragraph-mapper-threw:${error?.name || 'Error'}`, {
        family: PLAIN_PARAGRAPH_TRANSACTION_FAMILY
      })
    }
    if (!mapped?.ok || typeof mapped.markdown !== 'string') {
      return rejected(mapped?.reason || 'plain-paragraph-mapper-rejected', {
        family: PLAIN_PARAGRAPH_TRANSACTION_FAMILY
      })
    }

    const proof = Object.freeze({
      kind: 'transaction-plain-paragraph-proof',
      journalId: journal.journalId,
      family: PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
      transactionJournal: verified.proof,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      plainParagraphCount: classification.plainParagraphCount,
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
      mapperReason: mapped.reason,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
