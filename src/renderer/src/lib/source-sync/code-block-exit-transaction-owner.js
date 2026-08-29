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
  sameSourceSyncDocument,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const CODE_BLOCK_EXIT_TRANSACTION_FAMILY = 'code-block-exit'
export const CODE_BLOCK_EXIT_TRANSACTION_BOUNDARY = 'transaction-code-block-exit'

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
  if (node?.type?.name !== 'paragraph') return null
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

const topLevelBefore = (doc, index) => {
  let position = 0
  for (let cursor = 0; cursor < index; cursor += 1) position += doc.child(cursor).nodeSize
  return position
}

const sameTopLevelExceptInsertion = (before, after, insertedIndex) => {
  if (!before || !after || after.childCount !== before.childCount + 1) return false
  for (let index = 0; index < insertedIndex; index += 1) {
    if (before.child(index).eq?.(after.child(index)) !== true) return false
  }
  for (let index = insertedIndex; index < before.childCount; index += 1) {
    if (before.child(index).eq?.(after.child(index + 1)) !== true) return false
  }
  return true
}

const classifyCoalesced = (journal, expectedDoc) => {
  const oldDoc = journal?.oldDoc
  if (!oldDoc || !expectedDoc || expectedDoc.childCount !== oldDoc.childCount + 1) {
    return rejected('code-block-exit-coalesced-topology')
  }
  const candidates = []
  for (let insertedIndex = 1; insertedIndex < expectedDoc.childCount; insertedIndex += 1) {
    const previous = oldDoc.child(insertedIndex - 1)
    const inserted = expectedDoc.child(insertedIndex)
    const finalText = plainParagraphText(inserted)
    if (
      previous?.type?.name === 'code_block' &&
      isPlainCodeBlock(previous) &&
      previous.content.size > 0 &&
      finalText != null &&
      sameTopLevelExceptInsertion(oldDoc, expectedDoc, insertedIndex)
    ) candidates.push({
      insertedIndex,
      codeIndex: insertedIndex - 1,
      codeBlock: previous,
      finalText
    })
  }
  if (candidates.length !== 1) {
    return rejected('code-block-exit-coalesced-candidate-count', {
      proof: { candidateCount: candidates.length }
    })
  }
  return Object.freeze({ ok: true, mode: 'coalesced', ...candidates[0] })
}

const hasStagedProvenance = (journal) => Boolean(
  journal?.baseFamily === CODE_BLOCK_EXIT_TRANSACTION_FAMILY &&
  journal?.baseReason === CODE_BLOCK_EXIT_TRANSACTION_FAMILY &&
  journal?.baseOwner === SOURCE_SYNC_OWNERS.TRANSACTION
)

const classifyStaged = (journal, expectedDoc) => {
  const oldDoc = journal.oldDoc
  if (!oldDoc || !expectedDoc || oldDoc.childCount !== expectedDoc.childCount) {
    return rejected('code-block-exit-staged-topology')
  }
  const changed = []
  for (let index = 0; index < oldDoc.childCount; index += 1) {
    if (oldDoc.child(index).eq?.(expectedDoc.child(index)) !== true) changed.push(index)
  }
  if (changed.length !== 1) return rejected('code-block-exit-staged-change-count')
  const insertedIndex = changed[0]
  const codeBlock = insertedIndex > 0 ? oldDoc.child(insertedIndex - 1) : null
  if (
    !isPlainCodeBlock(codeBlock) ||
    codeBlock.content.size <= 0
  ) return rejected('code-block-exit-staged-predecessor')
  const previousText = plainParagraphText(oldDoc.child(insertedIndex))
  const finalText = plainParagraphText(expectedDoc.child(insertedIndex))
  if (previousText !== '' || finalText == null || finalText === '') {
    return rejected('code-block-exit-staged-paragraph')
  }
  if (!hasStagedProvenance(journal)) {
    return rejected('code-block-exit-staged-provenance')
  }
  return Object.freeze({
    ok: true,
    mode: 'staged',
    insertedIndex,
    codeIndex: insertedIndex - 1,
    codeBlock,
    finalText
  })
}

const applyTextSteps = ({
  journal,
  currentDoc,
  insertedIndex,
  startEntryIndex = 0,
  startStepIndex = 0
}) => {
  let document = currentDoc
  let textStepCount = 0
  const stepRanges = []
  for (let entryIndex = startEntryIndex; entryIndex < journal.entries.length; entryIndex += 1) {
    const entry = journal.entries[entryIndex]
    const firstStep = entryIndex === startEntryIndex ? startStepIndex : 0
    for (let stepIndex = firstStep; stepIndex < (entry.steps?.length || 0); stepIndex += 1) {
      const step = entry.steps[stepIndex]
      const stepDoc = entry.stepDocs?.[stepIndex] || (stepIndex === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, document)) {
        return rejected('code-block-exit-text-step-document')
      }
      const paragraphEntry = sourceSyncNodeEntryAtPath(document, [insertedIndex])
      const paragraph = paragraphEntry?.node
      let $from
      let $to
      try {
        $from = document.resolve(step?.from)
        $to = document.resolve(step?.to)
      } catch {
        return rejected('code-block-exit-text-step-range')
      }
      if (
        step?.constructor?.name !== 'ReplaceStep' ||
        step.structure === true ||
        plainParagraphText(paragraph) == null ||
        !plainTextSlice(step.slice) ||
        !Number.isFinite(step.from) ||
        !Number.isFinite(step.to) ||
        !$from?.sameParent?.($to) ||
        $from.depth !== 1 ||
        $from.parent !== paragraph ||
        $from.index(0) !== insertedIndex ||
        step.from < paragraphEntry.contentStart ||
        step.to > paragraphEntry.contentStart + paragraph.content.size ||
        step.to < step.from
      ) return rejected('code-block-exit-text-step')
      let applied
      try { applied = step.apply(document) } catch { applied = null }
      if (applied?.failed || !applied?.doc) return rejected('code-block-exit-text-step-apply')
      if (applied.doc.childCount !== document.childCount) {
        return rejected('code-block-exit-text-step-topology')
      }
      for (let index = 0; index < document.childCount; index += 1) {
        if (index === insertedIndex) continue
        if (document.child(index).eq?.(applied.doc.child(index)) !== true) {
          return rejected('code-block-exit-text-step-neighbour')
        }
      }
      if (plainParagraphText(applied.doc.child(insertedIndex)) == null) {
        return rejected('code-block-exit-text-step-result')
      }
      stepRanges.push(Object.freeze({
        entryIndex,
        stepIndex,
        stepName: step.constructor.name,
        from: step.from,
        to: step.to,
        sliceSize: Number.isFinite(step.slice?.size) ? step.slice.size : null
      }))
      textStepCount += 1
      document = applied.doc
    }
  }
  return Object.freeze({ ok: true, finalDoc: document, textStepCount, stepRanges: Object.freeze(stepRanges) })
}

const replayCoalesced = ({ journal, expectedDoc, classification }) => {
  if (!Array.isArray(journal.entries) || !journal.entries.length) {
    return rejected('code-block-exit-entry-missing')
  }
  const firstEntry = journal.entries[0]
  const firstStep = firstEntry.steps?.[0]
  const firstDoc = firstEntry.stepDocs?.[0] || firstEntry.beforeDoc
  if (!firstDoc || !sameSourceSyncDocument(firstDoc, journal.oldDoc)) {
    return rejected('code-block-exit-insert-step-document')
  }
  const insertPosition = topLevelBefore(journal.oldDoc, classification.insertedIndex)
  const inserted = firstStep?.slice?.content?.childCount === 1
    ? firstStep.slice.content.child(0)
    : null
  if (
    firstStep?.constructor?.name !== 'ReplaceStep' ||
    firstStep.structure === true ||
    firstStep.from !== insertPosition ||
    firstStep.to !== insertPosition ||
    firstStep.slice?.openStart !== 0 ||
    firstStep.slice?.openEnd !== 0 ||
    plainParagraphText(inserted) !== ''
  ) return rejected('code-block-exit-insert-step')
  let applied
  try { applied = firstStep.apply(firstDoc) } catch { applied = null }
  if (applied?.failed || !applied?.doc) return rejected('code-block-exit-insert-step-apply')
  if (!sameTopLevelExceptInsertion(journal.oldDoc, applied.doc, classification.insertedIndex)) {
    return rejected('code-block-exit-insert-step-result')
  }
  if (plainParagraphText(applied.doc.child(classification.insertedIndex)) !== '') {
    return rejected('code-block-exit-insert-step-paragraph')
  }
  const text = applyTextSteps({
    journal,
    currentDoc: applied.doc,
    insertedIndex: classification.insertedIndex,
    startEntryIndex: 0,
    startStepIndex: 1
  })
  if (!text.ok) return text
  if (!sameSourceSyncDocument(text.finalDoc, expectedDoc)) {
    return rejected('code-block-exit-final-document')
  }
  return Object.freeze({
    ok: true,
    textStepCount: text.textStepCount,
    stepRanges: Object.freeze([
      Object.freeze({
        entryIndex: 0,
        stepIndex: 0,
        stepName: firstStep.constructor.name,
        from: firstStep.from,
        to: firstStep.to,
        sliceSize: Number.isFinite(firstStep.slice?.size) ? firstStep.slice.size : null,
        mode: 'insert-paragraph'
      }),
      ...text.stepRanges.map((entry) => Object.freeze({ ...entry, mode: 'paragraph-text' }))
    ])
  })
}

const replayStaged = ({ journal, expectedDoc, classification }) => {
  const text = applyTextSteps({
    journal,
    currentDoc: journal.oldDoc,
    insertedIndex: classification.insertedIndex
  })
  if (!text.ok) return text
  if (!sameSourceSyncDocument(text.finalDoc, expectedDoc)) {
    return rejected('code-block-exit-final-document')
  }
  return Object.freeze({
    ok: true,
    textStepCount: text.textStepCount,
    stepRanges: Object.freeze(text.stepRanges.map((entry) =>
      Object.freeze({ ...entry, mode: 'paragraph-text' })
    ))
  })
}

const insertionPatch = ({ source, range, text }) => {
  const eol = lineEndingNear(source, range.closeEnd)
  const insertionOffset = range.nextNonblank?.start ?? source.length
  const gap = source.slice(range.endWithEol, insertionOffset)
  const prefix = gap.length ? '' : eol
  const suffix = insertionOffset < source.length ? `${eol}${eol}` : eol
  return Object.freeze({
    start: insertionOffset,
    end: insertionOffset,
    replacement: `${prefix}${text}${suffix}`,
    eol,
    gap
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: CODE_BLOCK_EXIT_TRANSACTION_FAMILY,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_EXIT_TRANSACTION_FAMILY,
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

export function createCodeBlockExitTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('code block exit owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('code block exit owner requires validateMarkdown')
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
    boundary = CODE_BLOCK_EXIT_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('code-block-exit-journal-stale', { reset: true })
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
    ) return rejected('code-block-exit-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('code-block-exit-live-snapshot-stale', { reset: true })
    }
    if (!callbackDocumentEquivalent) return rejected('code-block-exit-callback-document-mismatch')

    const classification =
      journal.oldDoc?.childCount === expectedDoc.childCount
        ? classifyStaged(journal, expectedDoc)
        : classifyCoalesced(journal, expectedDoc)
    if (!classification.ok) return classification
    const replayed = classification.mode === 'coalesced'
      ? replayCoalesced({ journal, expectedDoc, classification })
      : replayStaged({ journal, expectedDoc, classification })
    if (!replayed.ok) return replayed

    const codeEntry = sourceSyncNodeEntryAtPath(
      journal.oldDoc,
      [classification.codeIndex]
    )
    const resolveRange = ({ markdown, side }) => resolveFencedCodeBlockRange({
      markdown,
      doc: journal.oldDoc,
      entry: codeEntry,
      topLevelIndex: classification.codeIndex,
      side,
      resolveMarkdownOffset
    })
    const sourceRange = resolveRange({ markdown: journal.source, side: 'source' })
    const previousRange = resolveRange({
      markdown: journal.canonical,
      side: 'previous-canonical'
    })
    if (!sourceRange || !previousRange) {
      return recognizedRejection('code-block-exit-source-range')
    }

    const codeText = classification.codeBlock.textContent || ''
    if (
      fencedCodeBlockContent(journal.source, sourceRange) !== codeText ||
      fencedCodeBlockContent(journal.canonical, previousRange) !== codeText
    ) return recognizedRejection('code-block-exit-source-content-mismatch')
    const language = codeBlockLanguage(classification.codeBlock)
    if (!validCodeBlockLanguage(language)) {
      return recognizedRejection('code-block-exit-language-invalid')
    }
    const sourceInfo = parseLanguageOnlyFenceInfo(journal.source, sourceRange)
    const previousInfo = parseLanguageOnlyFenceInfo(journal.canonical, previousRange)
    if (
      !sourceInfo ||
      !previousInfo ||
      sourceInfo.language !== language ||
      previousInfo.language !== language
    ) return recognizedRejection('code-block-exit-language-mismatch')

    let markdown = journal.source
    let patch = null
    if (classification.finalText) {
      patch = insertionPatch({
        source: journal.source,
        range: sourceRange,
        text: classification.finalText
      })
      markdown = journal.source.slice(0, patch.start) +
        patch.replacement +
        journal.source.slice(patch.end)
    }
    let semanticOk = false
    try { semanticOk = validateMarkdown({ markdown, expectedDoc }) === true } catch {
      return recognizedRejection('code-block-exit-semantic-validator-threw')
    }
    if (!semanticOk) return recognizedRejection('code-block-exit-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-code-block-exit-proof',
      journalId: journal.journalId,
      family: CODE_BLOCK_EXIT_TRANSACTION_FAMILY,
      mode: classification.finalText
        ? classification.mode === 'staged' ? 'staged-text' : 'coalesced-text'
        : 'pending-empty-paragraph',
      codeIndex: classification.codeIndex,
      insertedIndex: classification.insertedIndex,
      codePath: Object.freeze([classification.codeIndex]),
      paragraphPath: Object.freeze([classification.insertedIndex]),
      finalText: classification.finalText,
      textStepCount: replayed.textStepCount,
      stepRanges: replayed.stepRanges,
      language,
      sourceRange: Object.freeze({
        start: sourceRange.start,
        end: sourceRange.end,
        endWithEol: sourceRange.endWithEol,
        contentStart: sourceRange.contentStart,
        contentEnd: sourceRange.contentEnd,
        char: sourceRange.char,
        length: sourceRange.length,
        infoRaw: sourceRange.infoRaw,
        nextNonblankStart: sourceRange.nextNonblank?.start ?? null
      }),
      previousRange: Object.freeze({
        start: previousRange.start,
        end: previousRange.end,
        endWithEol: previousRange.endWithEol,
        contentStart: previousRange.contentStart,
        contentEnd: previousRange.contentEnd,
        char: previousRange.char,
        length: previousRange.length,
        infoRaw: previousRange.infoRaw
      }),
      patch,
      sourceUnchanged: !classification.finalText,
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
    family: CODE_BLOCK_EXIT_TRANSACTION_FAMILY,
    boundary: CODE_BLOCK_EXIT_TRANSACTION_BOUNDARY,
    plan
  })
}
