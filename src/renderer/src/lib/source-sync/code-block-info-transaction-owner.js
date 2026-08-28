import {
  codeBlockLanguage,
  codeBlockNonLanguageAttrsEqual,
  fencedCodeBlockContent,
  isPlainCodeBlock,
  normalizedFenceLine,
  parseLanguageOnlyFenceInfo,
  resolveFencedCodeBlockRange,
  validCodeBlockLanguage
} from './code-block-transaction-common.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  onlyTopLevelSourceSyncIndexChanged,
  sameSourceSyncDocument,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const CODE_BLOCK_INFO_TRANSACTION_FAMILY = 'code-block-info-string-change'
export const CODE_BLOCK_INFO_TRANSACTION_BOUNDARY = 'transaction-code-block-info-string'

const rejected = (reason, {
  deferred = false,
  reset = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  reset,
  reason,
  proof
})

const classifyCodeBlockInfoJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'code_block',
    reasonPrefix: 'code-block-info'
  })
  if (!classification.ok) return classification
  const previousBlock = classification.previousEntry.node
  const nextBlock = classification.nextEntry.node
  if (!isPlainCodeBlock(previousBlock) || !isPlainCodeBlock(nextBlock)) {
    return rejected('code-block-info-non-plain-content')
  }
  if (previousBlock.textContent !== nextBlock.textContent) {
    return rejected('code-block-info-content-changed')
  }
  if (!codeBlockNonLanguageAttrsEqual(previousBlock.attrs, nextBlock.attrs)) {
    return rejected('code-block-info-non-language-attrs-changed')
  }
  const previousLanguage = codeBlockLanguage(previousBlock)
  const nextLanguage = codeBlockLanguage(nextBlock)
  if (previousLanguage === nextLanguage) {
    return rejected('code-block-info-language-unchanged')
  }
  if (!validCodeBlockLanguage(nextLanguage)) {
    return rejected('code-block-info-language-invalid')
  }

  let currentDoc = journal.oldDoc
  let currentLanguage = previousLanguage
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('code-block-info-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('code-block-info-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'AttrStep') {
        return rejected('code-block-info-step-not-attr')
      }
      if (step.attr !== 'language') return rejected('code-block-info-step-attr')
      if (!Number.isFinite(step.pos)) return rejected('code-block-info-step-pos-invalid')
      if (typeof step.value !== 'string') return rejected('code-block-info-step-value-invalid')
      if (!validCodeBlockLanguage(step.value)) return rejected('code-block-info-language-invalid')

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('code-block-info-step-document-missing')
      }
      const beforeEntry = topLevelSourceSyncEntries(stepDoc)[classification.topLevelIndex]
      if (
        !beforeEntry ||
        beforeEntry.offset !== step.pos ||
        beforeEntry.type !== 'code_block' ||
        !isPlainCodeBlock(beforeEntry.node)
      ) return rejected('code-block-info-step-outside-owned-subtree')
      if (beforeEntry.node.textContent !== previousBlock.textContent) {
        return rejected('code-block-info-content-changed')
      }
      if (!codeBlockNonLanguageAttrsEqual(beforeEntry.node.attrs, previousBlock.attrs)) {
        return rejected('code-block-info-non-language-attrs-changed')
      }
      if (codeBlockLanguage(beforeEntry.node) !== currentLanguage) {
        return rejected('code-block-info-language-chain-mismatch')
      }

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('code-block-info-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) return rejected('code-block-info-step-apply-failed')
      if (!onlyTopLevelSourceSyncIndexChanged(stepDoc, applied.doc, classification.topLevelIndex)) {
        return rejected('code-block-info-neighbour-changed')
      }
      const resultBlock = topLevelSourceSyncEntries(applied.doc)[classification.topLevelIndex]?.node
      if (!isPlainCodeBlock(resultBlock)) return rejected('code-block-info-result-not-code-block')
      if (resultBlock.textContent !== previousBlock.textContent) {
        return rejected('code-block-info-content-changed')
      }
      if (!codeBlockNonLanguageAttrsEqual(resultBlock.attrs, previousBlock.attrs)) {
        return rejected('code-block-info-non-language-attrs-changed')
      }
      if (codeBlockLanguage(resultBlock) !== step.value) {
        return rejected('code-block-info-step-result-mismatch')
      }
      currentLanguage = step.value
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('code-block-info-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('code-block-info-final-document-mismatch')
  }
  if (currentLanguage !== nextLanguage) {
    return rejected('code-block-info-final-language-mismatch')
  }
  return Object.freeze({
    ...classification,
    previousBlock,
    nextBlock,
    previousLanguage,
    nextLanguage
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'fenced-code-block-info-string-change',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_INFO_TRANSACTION_FAMILY,
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

export function createCodeBlockInfoTransactionSourceSyncOwner({
  resolveMarkdownOffset
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('code block info transaction owner requires resolveMarkdownOffset')
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
    boundary = CODE_BLOCK_INFO_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('code-block-info-journal-stale', { reset: true })
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
    ) return rejected('code-block-info-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('code-block-info-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('code-block-info-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyCodeBlockInfoJournal({ journal, expectedDoc })
    if (!classification.ok) return classification

    const resolveRange = ({ markdown, doc, entry, side }) =>
      resolveFencedCodeBlockRange({
        markdown,
        doc,
        entry,
        topLevelIndex: classification.topLevelIndex,
        side,
        resolveMarkdownOffset
      })

    const sourceRange = resolveRange({
      markdown: journal.source,
      doc: journal.oldDoc,
      entry: classification.previousEntry,
      side: 'source'
    })
    const previousRange = resolveRange({
      markdown: journal.canonical,
      doc: journal.oldDoc,
      entry: classification.previousEntry,
      side: 'previous-canonical'
    })
    const nextRange = resolveRange({
      markdown: canonical,
      doc: expectedDoc,
      entry: classification.nextEntry,
      side: 'next-canonical'
    })
    if (!sourceRange || !previousRange || !nextRange) {
      return rejected('code-block-info-range-unmapped')
    }

    const sourceInfo = parseLanguageOnlyFenceInfo(journal.source, sourceRange)
    const previousInfo = parseLanguageOnlyFenceInfo(journal.canonical, previousRange)
    const nextInfo = parseLanguageOnlyFenceInfo(canonical, nextRange)
    if (!sourceInfo) return rejected('code-block-info-source-not-language-only')
    if (!previousInfo) return rejected('code-block-info-previous-not-language-only')
    if (!nextInfo) return rejected('code-block-info-next-not-language-only')
    if (
      sourceInfo.language !== classification.previousLanguage ||
      previousInfo.language !== classification.previousLanguage ||
      nextInfo.language !== classification.nextLanguage
    ) return rejected('code-block-info-language-source-mismatch')

    const unchangedText = classification.previousBlock.textContent || ''
    if (
      fencedCodeBlockContent(journal.source, sourceRange) !== unchangedText ||
      fencedCodeBlockContent(journal.canonical, previousRange) !== unchangedText ||
      fencedCodeBlockContent(canonical, nextRange) !== unchangedText
    ) return rejected('code-block-info-content-source-mismatch')
    if (
      previousRange.char !== nextRange.char ||
      previousRange.length !== nextRange.length ||
      normalizedFenceLine(previousRange.closeLine) !== normalizedFenceLine(nextRange.closeLine) ||
      journal.canonical.slice(0, previousRange.infoStart) !== canonical.slice(0, nextRange.infoStart) ||
      journal.canonical.slice(previousRange.infoEnd) !== canonical.slice(nextRange.infoEnd)
    ) return rejected('code-block-info-canonical-outside-info-changed')

    const replacementInfo = sourceInfo.leading +
      classification.nextLanguage +
      sourceInfo.trailing
    const markdown = journal.source.slice(0, sourceRange.infoStart) +
      replacementInfo +
      journal.source.slice(sourceRange.infoEnd)
    const mappedRange = resolveRange({
      markdown,
      doc: expectedDoc,
      entry: classification.nextEntry,
      side: 'mapped-source'
    })
    const mappedInfo = parseLanguageOnlyFenceInfo(markdown, mappedRange)
    if (
      !mappedRange ||
      !mappedInfo ||
      mappedInfo.language !== classification.nextLanguage ||
      mappedRange.char !== sourceRange.char ||
      mappedRange.length !== sourceRange.length ||
      mappedRange.closeLine !== sourceRange.closeLine ||
      fencedCodeBlockContent(markdown, mappedRange) !== unchangedText
    ) return rejected('code-block-info-mapped-source-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-code-block-info-proof',
      journalId: journal.journalId,
      family: CODE_BLOCK_INFO_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      previousLanguage: classification.previousLanguage,
      nextLanguage: classification.nextLanguage,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceRange,
      previousRange,
      nextRange,
      sourceInfo,
      previousInfo,
      nextInfo,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      mapperReason: 'fenced-code-block-info-string-change',
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_INFO_TRANSACTION_FAMILY,
    boundary: CODE_BLOCK_INFO_TRANSACTION_BOUNDARY,
    plan
  })
}
