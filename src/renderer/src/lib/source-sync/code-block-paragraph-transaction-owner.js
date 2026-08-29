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

export const CODE_BLOCK_PARAGRAPH_TRANSACTION_FAMILY = 'code-block-to-paragraph'
export const CODE_BLOCK_PARAGRAPH_TRANSACTION_BOUNDARY =
  'transaction-code-block-to-paragraph'

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

const plainParagraphText = (node) => {
  if (!node?.isTextblock || node.type?.name !== 'paragraph') return null
  let text = ''
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (!child?.isText || child.marks?.length) return null
    text += child.text || ''
  }
  return text
}

const plainTextSlice = (slice) => {
  if (!slice || slice.openStart !== 0 || slice.openEnd !== 0) return false
  for (let index = 0; index < (slice.content?.childCount || 0); index += 1) {
    const child = slice.content.child(index)
    if (!child?.isText || child.marks?.length) return false
  }
  return true
}

const emptyParagraphWrapper = (slice) => {
  if (
    !slice ||
    slice.openStart !== 0 ||
    slice.openEnd !== 0 ||
    slice.content?.childCount !== 1
  ) return null
  const paragraph = slice.content.child(0)
  return plainParagraphText(paragraph) === '' ? paragraph : null
}

const targetOnlyChanged = (beforeDoc, afterDoc, targetIndex) => {
  const before = topLevelSourceSyncEntries(beforeDoc)
  const after = topLevelSourceSyncEntries(afterDoc)
  if (before.length !== after.length || targetIndex < 0 || targetIndex >= before.length) {
    return false
  }
  for (let index = 0; index < before.length; index += 1) {
    if (index === targetIndex) continue
    if (before[index].node?.eq?.(after[index].node) !== true) return false
  }
  return true
}

const conversionStepDetails = (step) => Object.freeze({
  name: step.constructor.name,
  from: step.from,
  to: step.to,
  gapFrom: step.gapFrom,
  gapTo: step.gapTo,
  insert: step.insert,
  structure: step.structure === true,
  sliceSize: Number.isFinite(step.slice?.size) ? step.slice.size : null
})

const textStepDetails = (step, entryIndex, stepIndex) => Object.freeze({
  entryIndex,
  stepIndex,
  name: step.constructor.name,
  from: step.from,
  to: step.to,
  structure: step.structure === true,
  sliceSize: Number.isFinite(step.slice?.size) ? step.slice.size : null
})

const replayCodeBlockParagraphJournal = ({ journal, expectedDoc }) => {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected('code-block-paragraph-document-missing')
  }
  const firstEntry = journal.entries[0]
  const firstStep = firstEntry?.steps?.[0]
  const firstDoc = firstEntry?.stepDocs?.[0] || firstEntry?.beforeDoc
  if (!firstStep || !firstDoc || !sameSourceSyncDocument(firstDoc, journal.oldDoc)) {
    return rejected('code-block-paragraph-conversion-step-missing')
  }

  const oldEntries = topLevelSourceSyncEntries(journal.oldDoc)
  const targetIndex = oldEntries.findIndex((entry) => entry.beforePos === firstStep.from)
  const originalEntry = targetIndex >= 0 ? oldEntries[targetIndex] : null
  const originalBlock = originalEntry?.node
  const paragraphWrapper = emptyParagraphWrapper(firstStep.slice)
  if (
    firstStep.constructor?.name !== 'ReplaceAroundStep' ||
    firstStep.structure !== true ||
    !originalEntry ||
    originalEntry.type !== 'code_block' ||
    firstStep.to !== originalEntry.beforePos + originalBlock.nodeSize ||
    firstStep.gapFrom !== originalEntry.contentStart ||
    firstStep.gapTo !== originalEntry.contentStart + originalBlock.content.size ||
    firstStep.insert !== 1 ||
    !paragraphWrapper
  ) return rejected('code-block-paragraph-conversion-step')

  let applied
  try { applied = firstStep.apply(firstDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc) {
    return recognizedRejection('code-block-paragraph-conversion-apply')
  }
  if (!targetOnlyChanged(firstDoc, applied.doc, targetIndex)) {
    return recognizedRejection('code-block-paragraph-conversion-neighbour')
  }
  const convertedEntry = topLevelSourceSyncEntries(applied.doc)[targetIndex]
  const convertedText = plainParagraphText(convertedEntry?.node)
  if (
    convertedEntry?.type !== 'paragraph' ||
    convertedText == null ||
    convertedText !== (originalBlock.textContent || '') ||
    !sourceSyncAttrsEqual(convertedEntry.node.attrs, paragraphWrapper.attrs)
  ) return recognizedRejection('code-block-paragraph-conversion-result')

  let currentDoc = applied.doc
  let paragraphAttrs = convertedEntry.node.attrs
  const textSteps = []
  for (let entryIndex = 0; entryIndex < journal.entries.length; entryIndex += 1) {
    const entry = journal.entries[entryIndex]
    const firstIndex = entryIndex === 0 ? 1 : 0
    const expectedBefore = entryIndex === 0 ? journal.oldDoc : currentDoc
    if (!sameSourceSyncDocument(entry.beforeDoc, expectedBefore)) {
      return recognizedRejection('code-block-paragraph-transaction-chain')
    }
    let entryDoc = entryIndex === 0 ? applied.doc : entry.beforeDoc
    for (let stepIndex = firstIndex; stepIndex < (entry.steps?.length || 0); stepIndex += 1) {
      const step = entry.steps[stepIndex]
      const stepDoc = entry.stepDocs?.[stepIndex] || (stepIndex === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return recognizedRejection('code-block-paragraph-followup-document')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step?.from)
        $to = stepDoc.resolve(step?.to)
      } catch {
        return recognizedRejection('code-block-paragraph-followup-range')
      }
      const paragraphEntry = topLevelSourceSyncEntries(stepDoc)[targetIndex]
      if (
        step?.constructor?.name !== 'ReplaceStep' ||
        step.structure === true ||
        !plainTextSlice(step.slice) ||
        !Number.isFinite(step.from) ||
        !Number.isFinite(step.to) ||
        step.to < step.from ||
        !$from?.sameParent?.($to) ||
        $from.depth !== 1 ||
        $from.parent?.type?.name !== 'paragraph' ||
        $from.index(0) !== targetIndex ||
        paragraphEntry?.node !== $from.parent ||
        plainParagraphText($from.parent) == null ||
        !sourceSyncAttrsEqual($from.parent.attrs, paragraphAttrs) ||
        step.from < paragraphEntry.contentStart ||
        step.to > paragraphEntry.contentStart + paragraphEntry.node.content.size
      ) return recognizedRejection('code-block-paragraph-followup-step')

      let next
      try { next = step.apply(stepDoc) } catch { next = null }
      if (next?.failed || !next?.doc) {
        return recognizedRejection('code-block-paragraph-followup-apply')
      }
      if (!onlyTopLevelSourceSyncIndexChanged(stepDoc, next.doc, targetIndex)) {
        return recognizedRejection('code-block-paragraph-followup-neighbour')
      }
      const nextEntry = topLevelSourceSyncEntries(next.doc)[targetIndex]
      if (
        nextEntry?.type !== 'paragraph' ||
        plainParagraphText(nextEntry.node) == null ||
        !sourceSyncAttrsEqual(nextEntry.node.attrs, paragraphAttrs)
      ) return recognizedRejection('code-block-paragraph-followup-result')
      textSteps.push(textStepDetails(step, entryIndex, stepIndex))
      entryDoc = next.doc
    }
    const expectedAfter = entry.afterDoc
    if (entryIndex === 0) {
      if (!sameSourceSyncDocument(entryDoc, expectedAfter)) {
        return recognizedRejection('code-block-paragraph-transaction-result')
      }
    } else if (!sameSourceSyncDocument(entryDoc, expectedAfter)) {
      return recognizedRejection('code-block-paragraph-transaction-result')
    }
    currentDoc = expectedAfter
  }

  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return recognizedRejection('code-block-paragraph-final-document')
  }
  if (!targetOnlyChanged(journal.oldDoc, expectedDoc, targetIndex)) {
    return recognizedRejection('code-block-paragraph-final-neighbour')
  }
  const finalEntry = topLevelSourceSyncEntries(expectedDoc)[targetIndex]
  return Object.freeze({
    ok: true,
    recognized: true,
    topLevelIndex: targetIndex,
    previousEntry: originalEntry,
    nextEntry: finalEntry,
    originalBlock,
    finalParagraph: finalEntry?.node,
    paragraphAttrs,
    conversionStep: conversionStepDetails(firstStep),
    textSteps: Object.freeze(textSteps),
    stepCount: 1 + textSteps.length
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'code-block-converted-to-paragraph',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_PARAGRAPH_TRANSACTION_FAMILY,
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

export function createCodeBlockParagraphTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('code block paragraph owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('code block paragraph owner requires validateMarkdown')
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
    boundary = CODE_BLOCK_PARAGRAPH_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('code-block-paragraph-journal-stale', { reset: true })
    }
    const verified = verifySourceSyncTransactionJournalCheckpoint({
      checkpoint: journal,
      snapshot,
      expectedDoc
    })
    if (!verified.ok) {
      return rejected(verified.reason, { reset: verified.reset, proof: verified.proof })
    }
    if (
      typeof currentSource !== 'string' ||
      typeof currentCanonical !== 'string' ||
      typeof canonical !== 'string' ||
      !expectedDoc
    ) return rejected('code-block-paragraph-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('code-block-paragraph-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('code-block-paragraph-callback-document-mismatch', { deferred: true })
    }

    const classification = replayCodeBlockParagraphJournal({ journal, expectedDoc })
    if (!classification.ok) return classification
    const previousText = classification.originalBlock?.textContent || ''
    const finalText = plainParagraphText(classification.finalParagraph)
    if (
      !isPlainCodeBlock(classification.originalBlock) ||
      !previousText ||
      previousText.includes('\n')
    ) return recognizedRejection('code-block-paragraph-source-node')
    if (finalText == null || !finalText || finalText.includes('\n')) {
      return recognizedRejection('code-block-paragraph-final-node')
    }

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
      return recognizedRejection('code-block-paragraph-fenced-range')
    }
    if (sourceRange.indent || previousRange.indent) {
      return recognizedRejection('code-block-paragraph-indented-fence')
    }
    if (
      fencedCodeBlockContent(journal.source, sourceRange) !== previousText ||
      fencedCodeBlockContent(journal.canonical, previousRange) !== previousText
    ) return recognizedRejection('code-block-paragraph-content-mismatch')

    const previousLanguage = codeBlockLanguage(classification.originalBlock)
    if (!validCodeBlockLanguage(previousLanguage)) {
      return recognizedRejection('code-block-paragraph-language-invalid')
    }
    const sourceInfo = parseLanguageOnlyFenceInfo(journal.source, sourceRange)
    const previousInfo = parseLanguageOnlyFenceInfo(journal.canonical, previousRange)
    if (!sourceInfo || !previousInfo) {
      return recognizedRejection('code-block-paragraph-info-invalid')
    }
    if (
      sourceInfo.language !== previousLanguage ||
      previousInfo.language !== previousLanguage
    ) return recognizedRejection('code-block-paragraph-language-mismatch')

    const hasClosingEol = sourceRange.endWithEol > sourceRange.end
    const eol = lineEndingNear(journal.source, sourceRange.closeEnd)
    const replacement = `${finalText}${hasClosingEol ? eol : ''}`
    const markdown = journal.source.slice(0, sourceRange.start) +
      replacement +
      journal.source.slice(sourceRange.endWithEol)
    let semanticOk = false
    try { semanticOk = validateMarkdown({ markdown, expectedDoc }) === true } catch {
      return recognizedRejection('code-block-paragraph-semantic-validator-threw')
    }
    if (!semanticOk) {
      return recognizedRejection('code-block-paragraph-semantic-document-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-code-block-paragraph-proof',
      journalId: journal.journalId,
      family: CODE_BLOCK_PARAGRAPH_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      nodePath: Object.freeze([classification.topLevelIndex]),
      previousLanguage,
      previousText,
      finalText,
      paragraphAttrs: classification.paragraphAttrs,
      conversionStep: classification.conversionStep,
      textSteps: classification.textSteps,
      stepCount: classification.stepCount,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceRange: Object.freeze({
        start: sourceRange.start,
        end: sourceRange.end,
        endWithEol: sourceRange.endWithEol,
        contentStart: sourceRange.contentStart,
        contentEnd: sourceRange.contentEnd,
        marker: sourceRange.char,
        markerSize: sourceRange.length,
        info: sourceInfo.language,
        infoRaw: sourceRange.infoRaw,
        indent: sourceRange.indent,
        eol
      }),
      previousRange: Object.freeze({
        start: previousRange.start,
        end: previousRange.end,
        endWithEol: previousRange.endWithEol,
        marker: previousRange.char,
        markerSize: previousRange.length,
        info: previousInfo.language,
        infoRaw: previousRange.infoRaw,
        indent: previousRange.indent
      }),
      rawReplacement: Object.freeze({
        start: sourceRange.start,
        end: sourceRange.endWithEol,
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
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_PARAGRAPH_TRANSACTION_FAMILY,
    boundary: CODE_BLOCK_PARAGRAPH_TRANSACTION_BOUNDARY,
    plan
  })
}
