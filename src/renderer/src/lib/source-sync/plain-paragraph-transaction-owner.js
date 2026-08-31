import { mapPlainTextTransactionsToSource } from '../source-transaction-sync.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  transactionsFromSourceSyncTransactionJournal,
  verifySourceSyncTransactionJournalCheckpoint
} from './transaction-journal.js'

export const PLAIN_PARAGRAPH_TRANSACTION_FAMILY = 'plain-paragraph-inline-replace'
export const PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY = 'transaction-plain-paragraph'
export const PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY = 'plain-paragraph-terminal-split'
export const PLAIN_PARAGRAPH_SPLIT_TRANSACTION_BOUNDARY = 'transaction-plain-paragraph-split'

const plainLineAtOffset = (source, offset) => {
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

const classifyPlainParagraphJournal = ({ journal, expectedDoc, requireTerminalSplit = false }) => {
  if (!journal?.entries?.length) {
    return rejected('phase1-changed-transaction-count')
  }
  const entries = journal.entries
  let currentDoc = journal.oldDoc
  let splitSeen = false
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]
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
      let terminalSplit = false
      if (step.structure === true) {
        // E0 P3 (0.13.170 16:38:54 trace): a pending text chain (e.g. Chinese
        // IME commit) followed by an IMMEDIATE Enter is one journal. Accept
        // exactly one terminal top-level split — the FINAL step of the FINAL
        // entry — and delegate its raw mapping to the transaction mapper's
        // proven block-split branch (author-EOL separator + empty-slot hint).
        // The split-created empty paragraph is a top-level empty paragraph,
        // which the semantic comparator already ignores; no transient needed.
        // Anything structural before it (including the first of two split
        // steps) rejects here, which also makes a second split unreachable.
        const isFinalStep = entryIndex === entries.length - 1 && index === entry.steps.length - 1
        if (step.from !== step.to || !isFinalStep || splitSeen) {
          return rejected('phase1-structural-step')
        }
        terminalSplit = true
        splitSeen = true
      } else if (!isClosedPlainTextSlice(step.slice)) {
        return rejected('phase1-structural-slice')
      }

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
      // The terminal split keeps the full pre-split text as its left
      // paragraph (a split leaving an empty LEFT side is rejected here and
      // also has no mapper contract).
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
  if (requireTerminalSplit && !splitSeen) {
    return rejected('phase1-terminal-split-missing')
  }
  return Object.freeze({
    ok: true,
    family: requireTerminalSplit
      ? PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
      : PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
    reason: requireTerminalSplit
      ? 'phase1-plain-paragraph-terminal-split'
      : 'phase1-plain-paragraph-inline-replace',
    terminalSplit: splitSeen,
    plainParagraphCount: countSimpleTopLevelParagraphs(journal.oldDoc)
  })
}

const createOwnedPlan = ({
  boundary,
  family,
  reason,
  markdown,
  canonical,
  expectedDoc,
  proof
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
    family,
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
 *
 * With `requireTerminalSplit` the SAME classification is narrowed to journals
 * that end in exactly one terminal top-level split (0.13.170 16:38:54 trace:
 * Chinese-IME pending text + immediate Enter). That variant registers as its
 * own focused family so plain-text-only journals keep their existing owners.
 */
export function createPlainParagraphTransactionSourceSyncOwner({
  mapTransactions = mapPlainTextTransactionsToSource,
  resolveMarkdownOffset,
  validateMarkdown,
  requireTerminalSplit = false
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
    boundary = requireTerminalSplit
      ? PLAIN_PARAGRAPH_SPLIT_TRANSACTION_BOUNDARY
      : PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY
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

    const classification = classifyPlainParagraphJournal({
      journal,
      expectedDoc,
      requireTerminalSplit
    })
    if (!classification.ok) return classification

    const transactions = transactionsFromSourceSyncTransactionJournal(journal)
    if (!transactions.length) return rejected('phase1-changed-transaction-count')

    let mappedMarkdown = null
    let mapperReason = null
    if (requireTerminalSplit) {
      // Publish the terminal split with a MINIMAL separator: boundary bytes
      // the author already has after the paragraph stay untouched (the
      // generic empty-slot blank would double the author's spacing and break
      // the downstream list-marker byte contracts). Mirrors the
      // blockquote-split family: map the ORIGINAL paragraph text span
      // (published plain text is unambiguous), splice the FINAL left text,
      // and add only the missing boundary bytes. The empty right paragraph is
      // a top-level transient the semantic comparator already ignores.
      const entries = journal.entries
      let paragraphIndex = null
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex]
        for (let stepIndex = 0; stepIndex < entry.steps.length; stepIndex += 1) {
          const step = entry.steps[stepIndex]
          const stepDoc = entry.stepDocs?.[stepIndex] || (stepIndex === 0 ? entry.beforeDoc : null)
          let $from
          try {
            $from = stepDoc.resolve(step.from)
          } catch {
            return rejected('plain-paragraph-split-position-unresolvable', {
              family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
            })
          }
          const index = $from.index(0)
          if (paragraphIndex == null) paragraphIndex = index
          if (index !== paragraphIndex) {
            return rejected('plain-paragraph-split-cross-paragraph', {
              family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
            })
          }
        }
      }
      const originalParagraph = journal.oldDoc.child(paragraphIndex)
      const originalText = originalParagraph.textContent
      let paragraphStart = 0
      for (let index = 0; index < paragraphIndex; index += 1) {
        paragraphStart += journal.oldDoc.child(index).nodeSize
      }
      const textStart = paragraphStart + 1
      let rawStart
      let rawEnd
      try {
        rawStart = resolveMarkdownOffset({
          markdown: journal.source,
          pmPos: textStart,
          doc: journal.oldDoc
        })
        rawEnd = resolveMarkdownOffset({
          markdown: journal.source,
          pmPos: textStart + originalText.length,
          doc: journal.oldDoc
        })
      } catch {
        return rejected('plain-paragraph-split-range-mapper-threw', {
          family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
        })
      }
      if (
        !Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rawStart ||
        journal.source.slice(rawStart, rawEnd) !== originalText
      ) {
        return rejected('plain-paragraph-split-raw-text-mismatch', {
          family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
        })
      }
      const line = plainLineAtOffset(journal.source, rawStart)
      if (!line || rawEnd !== line.end || line.start !== rawStart) {
        return rejected('plain-paragraph-split-not-single-line', {
          family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
        })
      }
      let boundaryBreaks = 0
      let cursor = line.end
      while (journal.source.startsWith(line.eol, cursor)) {
        boundaryBreaks += 1
        cursor += line.eol.length
      }
      const separator = line.eol.repeat(Math.max(0, 2 - boundaryBreaks))
      const finalLeftText = expectedDoc.child(paragraphIndex).textContent
      const markdown = journal.source.slice(0, line.start) +
        finalLeftText + separator +
        journal.source.slice(line.end)
      let semanticOk = false
      try {
        semanticOk = validateMarkdown({ markdown, expectedDoc }) === true
      } catch {
        return rejected('plain-paragraph-split-semantic-validator-threw', {
          family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
        })
      }
      if (!semanticOk) {
        return rejected('plain-paragraph-split-semantic-document-mismatch', {
          family: PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
        })
      }
      mappedMarkdown = markdown
      mapperReason = 'minimal-boundary-split'
    } else {
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
      mappedMarkdown = mapped.markdown
      mapperReason = mapped.reason || null
    }

    const proof = Object.freeze({
      kind: requireTerminalSplit
        ? 'transaction-plain-paragraph-split-proof'
        : 'transaction-plain-paragraph-proof',
      journalId: journal.journalId,
      family: classification.family,
      transactionJournal: verified.proof,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      terminalSplit: classification.terminalSplit === true,
      plainParagraphCount: classification.plainParagraphCount,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(mappedMarkdown),
      mapperReason,
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({
      boundary,
      family: classification.family,
      reason: requireTerminalSplit
        ? 'plain-paragraph-split'
        : (mapperReason || PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY),
      markdown: mappedMarkdown,
      canonical,
      expectedDoc,
      proof
    })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: requireTerminalSplit
      ? PLAIN_PARAGRAPH_SPLIT_TRANSACTION_FAMILY
      : PLAIN_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: requireTerminalSplit
      ? PLAIN_PARAGRAPH_SPLIT_TRANSACTION_BOUNDARY
      : PLAIN_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
