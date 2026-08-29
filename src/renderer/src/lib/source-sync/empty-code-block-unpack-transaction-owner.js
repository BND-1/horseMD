import { lineEndingNear } from '../markdown-preservation/core.js'
import {
  codeBlockLanguage,
  fencedCodeBlockContent,
  isPlainCodeBlock,
  parseLanguageOnlyFenceInfo,
  resolveFencedCodeBlockRange,
  validCodeBlockLanguage
} from './code-block-transaction-common.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  onlyTopLevelSourceSyncIndexChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY =
  'empty-code-block-backspace-unpack'
export const EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_BOUNDARY =
  'transaction-empty-code-block-backspace-unpack'

const rejected = (reason, {
  deferred = false,
  holdJournal = false,
  recognized = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  holdJournal,
  recognized,
  reset,
  reason,
  proof
})

const recognizedRejection = (reason, options = {}) => rejected(reason, {
  ...options,
  recognized: true
})

const isPlainParagraph = (node) => {
  if (!node?.isTextblock || node.type?.name !== 'paragraph') return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) plain = false
  })
  return plain
}

const plainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return ''
  if (slice.openStart || slice.openEnd) return null
  let text = ''
  let plain = true
  slice.content.forEach?.((node) => {
    if (!node?.isText || (node.marks?.length || 0) > 0) {
      plain = false
      return
    }
    text += node.text || ''
  })
  return plain ? text : null
}

const emptyParagraphSlice = (slice) => {
  if (
    !slice ||
    slice.openStart !== 0 ||
    slice.openEnd !== 0 ||
    slice.content?.childCount !== 1
  ) return null
  const paragraph = slice.content.child(0)
  return isPlainParagraph(paragraph) && paragraph.content.size === 0
    ? paragraph
    : null
}

const singleTopLevelReplacement = ({ oldDoc, newDoc }) => {
  if (!oldDoc || !newDoc) return rejected('empty-code-block-unpack-document-missing')
  const before = topLevelSourceSyncEntries(oldDoc)
  const after = topLevelSourceSyncEntries(newDoc)
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix].node?.eq?.(after[prefix].node) === true
  ) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix].node?.eq?.(
      after[after.length - 1 - suffix].node
    ) === true
  ) suffix += 1
  if (
    before.length - prefix - suffix !== 1 ||
    after.length - prefix - suffix !== 1
  ) {
    return rejected('empty-code-block-unpack-top-level-change-count', {
      proof: {
        prefix,
        suffix,
        beforeChanged: before.length - prefix - suffix,
        afterChanged: after.length - prefix - suffix
      }
    })
  }
  const previousEntry = before[prefix]
  const nextEntry = after[prefix]
  if (
    previousEntry.type !== 'code_block' ||
    nextEntry.type !== 'paragraph'
  ) {
    return rejected('empty-code-block-unpack-node-types', {
      proof: {
        previousType: previousEntry.type,
        nextType: nextEntry.type
      }
    })
  }
  if (!isPlainCodeBlock(previousEntry.node) || previousEntry.node.content.size !== 0) {
    return rejected('empty-code-block-unpack-source-not-empty')
  }
  if (!isPlainParagraph(nextEntry.node)) {
    return rejected('empty-code-block-unpack-result-not-plain-paragraph')
  }
  return Object.freeze({
    ok: true,
    topLevelIndex: prefix,
    previousEntry,
    nextEntry,
    unchangedPrefix: prefix,
    unchangedSuffix: suffix
  })
}

const targetOnlyChanged = (beforeDoc, afterDoc, topLevelIndex) => {
  const before = topLevelSourceSyncEntries(beforeDoc)
  const after = topLevelSourceSyncEntries(afterDoc)
  if (before.length !== after.length || topLevelIndex >= before.length) return false
  for (let index = 0; index < before.length; index += 1) {
    if (index === topLevelIndex) continue
    if (before[index].node?.eq?.(after[index].node) !== true) return false
  }
  return true
}

const classifyUnpackJournal = ({ journal, expectedDoc }) => {
  const classification = singleTopLevelReplacement({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc
  })
  if (!classification.ok) return classification
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    return rejected('empty-code-block-unpack-entry-count')
  }

  const targetIndex = classification.topLevelIndex
  const originalBlock = classification.previousEntry.node
  const finalParagraph = classification.nextEntry.node
  let currentDoc = journal.oldDoc
  let stepOrdinal = 0
  let paragraphAttrs = null
  const stepRanges = []

  for (const entry of journal.entries) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('empty-code-block-unpack-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('empty-code-block-unpack-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('empty-code-block-unpack-step-document-missing')
      }
      if (
        step?.constructor?.name !== 'ReplaceStep' ||
        step.structure === true ||
        !Number.isFinite(step.from) ||
        !Number.isFinite(step.to)
      ) return rejected('empty-code-block-unpack-step-shape')

      let applied
      if (stepOrdinal === 0) {
        const beforeEntry = topLevelSourceSyncEntries(stepDoc)[targetIndex]
        const replacementParagraph = emptyParagraphSlice(step.slice)
        if (
          beforeEntry?.type !== 'code_block' ||
          beforeEntry.node?.eq?.(originalBlock) !== true ||
          step.from !== beforeEntry.beforePos ||
          step.to !== beforeEntry.beforePos + beforeEntry.node.nodeSize ||
          !replacementParagraph
        ) return rejected('empty-code-block-unpack-replacement-step')
        paragraphAttrs = replacementParagraph.attrs
        try {
          applied = step.apply(stepDoc)
        } catch {
          return rejected('empty-code-block-unpack-step-apply-failed')
        }
        if (applied?.failed || !applied?.doc) {
          return rejected('empty-code-block-unpack-step-apply-failed')
        }
        if (!targetOnlyChanged(stepDoc, applied.doc, targetIndex)) {
          return rejected('empty-code-block-unpack-neighbour-changed')
        }
        const resultEntry = topLevelSourceSyncEntries(applied.doc)[targetIndex]
        if (
          resultEntry?.type !== 'paragraph' ||
          !isPlainParagraph(resultEntry.node) ||
          resultEntry.node.content.size !== 0 ||
          !sourceSyncAttrsEqual(resultEntry.node.attrs, paragraphAttrs)
        ) return rejected('empty-code-block-unpack-replacement-result')
      } else {
        if (plainTextSlice(step.slice) == null) {
          return rejected('empty-code-block-unpack-structural-followup')
        }
        let $from
        let $to
        try {
          $from = stepDoc.resolve(step.from)
          $to = stepDoc.resolve(step.to)
        } catch {
          return rejected('empty-code-block-unpack-followup-range')
        }
        if (
          !$from?.sameParent?.($to) ||
          $from.depth !== 1 ||
          $from.parent?.type?.name !== 'paragraph' ||
          $from.index(0) !== targetIndex ||
          !isPlainParagraph($from.parent) ||
          !sourceSyncAttrsEqual($from.parent.attrs, paragraphAttrs)
        ) return rejected('empty-code-block-unpack-followup-outside-paragraph')
        try {
          applied = step.apply(stepDoc)
        } catch {
          return rejected('empty-code-block-unpack-step-apply-failed')
        }
        if (applied?.failed || !applied?.doc) {
          return rejected('empty-code-block-unpack-step-apply-failed')
        }
        if (!onlyTopLevelSourceSyncIndexChanged(stepDoc, applied.doc, targetIndex)) {
          return rejected('empty-code-block-unpack-neighbour-changed')
        }
        const resultEntry = topLevelSourceSyncEntries(applied.doc)[targetIndex]
        if (
          resultEntry?.type !== 'paragraph' ||
          !isPlainParagraph(resultEntry.node) ||
          !sourceSyncAttrsEqual(resultEntry.node.attrs, paragraphAttrs)
        ) return rejected('empty-code-block-unpack-followup-result')
      }

      stepRanges.push(Object.freeze({
        ordinal: stepOrdinal,
        name: step.constructor.name,
        from: step.from,
        to: step.to,
        sliceSize: Number.isFinite(step.slice?.size) ? step.slice.size : null
      }))
      entryDoc = applied.doc
      stepOrdinal += 1
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('empty-code-block-unpack-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('empty-code-block-unpack-final-document-mismatch')
  }
  if (
    finalParagraph.type?.name !== 'paragraph' ||
    !isPlainParagraph(finalParagraph) ||
    !sourceSyncAttrsEqual(finalParagraph.attrs, paragraphAttrs)
  ) return rejected('empty-code-block-unpack-final-paragraph')

  return Object.freeze({
    ...classification,
    originalBlock,
    finalParagraph,
    paragraphAttrs,
    stepRanges: Object.freeze(stepRanges)
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'empty-fenced-code-block-backspace-unpack',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY,
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

export function createEmptyCodeBlockUnpackTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('empty code block unpack owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('empty code block unpack owner requires validateMarkdown')
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
    boundary = EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('empty-code-block-unpack-journal-stale', { reset: true })
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
    ) return rejected('empty-code-block-unpack-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('empty-code-block-unpack-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('empty-code-block-unpack-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyUnpackJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    const resolveRange = ({ markdown, side }) => resolveFencedCodeBlockRange({
      markdown,
      doc: journal.oldDoc,
      entry: classification.previousEntry,
      topLevelIndex: classification.topLevelIndex,
      side,
      resolveMarkdownOffset
    })
    const sourceRange = resolveRange({ markdown: journal.source, side: 'source' })
    const previousRange = resolveRange({
      markdown: journal.canonical,
      side: 'previous-canonical'
    })
    if (!sourceRange || !previousRange) {
      return recognizedRejection('empty-code-block-unpack-range-unmapped')
    }
    if (
      fencedCodeBlockContent(journal.source, sourceRange) !== '' ||
      fencedCodeBlockContent(journal.canonical, previousRange) !== ''
    ) return recognizedRejection('empty-code-block-unpack-source-content-mismatch')

    const language = codeBlockLanguage(classification.originalBlock)
    if (!validCodeBlockLanguage(language)) {
      return recognizedRejection('empty-code-block-unpack-language-invalid')
    }
    const sourceInfo = parseLanguageOnlyFenceInfo(journal.source, sourceRange)
    const previousInfo = parseLanguageOnlyFenceInfo(journal.canonical, previousRange)
    if (!sourceInfo || !previousInfo) {
      return recognizedRejection('empty-code-block-unpack-info-invalid')
    }
    if (sourceInfo.language !== language || previousInfo.language !== language) {
      return recognizedRejection('empty-code-block-unpack-language-mismatch')
    }

    const finalText = classification.finalParagraph.textContent || ''
    const sourceHasClosingEol = journal.source[sourceRange.closeEnd] === '\n'
    const sourceBlockEnd = sourceRange.closeEnd + (sourceHasClosingEol ? 1 : 0)
    const eol = lineEndingNear(journal.source, sourceRange.closeEnd)
    const paragraphPrefix = finalText ? sourceRange.indent || '' : ''
    const replacement = `${paragraphPrefix}${finalText}${sourceHasClosingEol ? eol : ''}`
    const markdown = journal.source.slice(0, sourceRange.start) +
      replacement +
      journal.source.slice(sourceBlockEnd)

    let semanticOk = false
    try {
      semanticOk = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return recognizedRejection('empty-code-block-unpack-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('empty-code-block-unpack-semantic-document-mismatch')
    }

    const forcedFlush = boundary.endsWith('forced-flush')
    const proof = Object.freeze({
      kind: 'transaction-empty-code-block-unpack-proof',
      journalId: journal.journalId,
      family: EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY,
      mode: finalText ? 'coalesced-text' : forcedFlush ? 'forced-empty' : 'pending-empty',
      topLevelIndex: classification.topLevelIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      language,
      paragraphAttrs: classification.paragraphAttrs,
      finalText,
      stepRanges: classification.stepRanges,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceRange,
      previousRange,
      rawReplacement: Object.freeze({
        start: sourceRange.start,
        end: sourceBlockEnd,
        replacement,
        eol
      }),
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })

    if (!finalText && !forcedFlush) {
      return rejected('empty-code-block-unpack-awaiting-content', {
        deferred: true,
        holdJournal: true,
        proof
      })
    }
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_FAMILY,
    boundary: EMPTY_CODE_BLOCK_UNPACK_TRANSACTION_BOUNDARY,
    plan
  })
}
