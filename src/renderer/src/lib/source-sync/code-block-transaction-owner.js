import { lineEndingNear } from '../markdown-preservation/core.js'
import {
  fencedCodeBlockContent,
  isPlainCodeBlock,
  normalizeCodeBlockText,
  normalizedFenceLine,
  resolveFencedCodeBlockRange
} from './code-block-transaction-common.js'
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  classifySingleTopLevelSubtreeChange,
  onlyTopLevelSourceSyncIndexChanged,
  sameSourceSyncDocument,
  sourceSyncAttrsEqual,
  topLevelSourceSyncEntries
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const CODE_BLOCK_TRANSACTION_FAMILY = 'code-block-content-replace'
export const CODE_BLOCK_TRANSACTION_BOUNDARY = 'transaction-code-block-content'

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

const plainSliceText = (slice) => {
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

const rawContentForDocument = (text, eol) => {
  const normalized = normalizeCodeBlockText(text)
  if (!normalized) return ''
  return normalized.replace(/\n/g, eol) + eol
}

const sourceFenceCollides = (block, nextText) => {
  const token = block?.char === '~' ? '~' : '`'
  const length = Number(block?.length) || 3
  const pattern = new RegExp(`^ {0,3}${token}{${length},}\\s*$`)
  return normalizeCodeBlockText(nextText).split('\n').some((line) => pattern.test(line))
}

const classifyCodeBlockJournal = ({ journal, expectedDoc }) => {
  const classification = classifySingleTopLevelSubtreeChange({
    oldDoc: journal?.oldDoc,
    newDoc: expectedDoc,
    expectedType: 'code_block',
    reasonPrefix: 'code-block'
  })
  if (!classification.ok) return classification
  const previousBlock = classification.previousEntry.node
  const nextBlock = classification.nextEntry.node
  if (!isPlainCodeBlock(previousBlock) || !isPlainCodeBlock(nextBlock)) {
    return rejected('code-block-non-plain-content')
  }
  if (!sourceSyncAttrsEqual(previousBlock.attrs, nextBlock.attrs)) {
    return rejected('code-block-attrs-changed')
  }
  if (previousBlock.textContent === nextBlock.textContent) {
    return rejected('code-block-content-unchanged')
  }

  let currentDoc = journal.oldDoc
  for (const entry of journal.entries || []) {
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('code-block-transaction-chain-mismatch')
    }
    if (!entry.steps?.length) return rejected('code-block-step-count')
    let entryDoc = entry.beforeDoc
    for (let index = 0; index < entry.steps.length; index += 1) {
      const step = entry.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return rejected('code-block-step-not-replace')
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return rejected('code-block-step-range-invalid')
      }
      if (step.structure === true) return rejected('code-block-structural-step')
      if (plainSliceText(step.slice) == null) return rejected('code-block-structural-slice')

      const stepDoc = entry.stepDocs?.[index] || (index === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected('code-block-step-document-missing')
      }
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return rejected('code-block-step-range-unresolvable')
      }
      if (!$from?.sameParent?.($to)) return rejected('code-block-cross-parent-range')
      if (
        $from.depth !== 1 ||
        $from.parent?.type?.name !== 'code_block' ||
        $from.index(0) !== classification.topLevelIndex
      ) return rejected('code-block-step-outside-owned-subtree')
      if (!isPlainCodeBlock($from.parent)) return rejected('code-block-non-plain-content')
      if (!sourceSyncAttrsEqual($from.parent.attrs, previousBlock.attrs)) {
        return rejected('code-block-attrs-changed')
      }

      let applied
      try {
        applied = step.apply(stepDoc)
      } catch {
        return rejected('code-block-step-apply-failed')
      }
      if (applied?.failed || !applied?.doc) return rejected('code-block-step-apply-failed')
      if (!onlyTopLevelSourceSyncIndexChanged(stepDoc, applied.doc, classification.topLevelIndex)) {
        return rejected('code-block-neighbour-changed')
      }
      const resultBlock = topLevelSourceSyncEntries(applied.doc)[classification.topLevelIndex]?.node
      if (!isPlainCodeBlock(resultBlock)) return rejected('code-block-result-not-code-block')
      if (!sourceSyncAttrsEqual(resultBlock.attrs, previousBlock.attrs)) {
        return rejected('code-block-attrs-changed')
      }
      entryDoc = applied.doc
    }
    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected('code-block-transaction-result-mismatch')
    }
    currentDoc = entry.afterDoc
  }
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('code-block-final-document-mismatch')
  }
  return Object.freeze({ ...classification, previousBlock, nextBlock })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: 'fenced-code-block-content-change',
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_TRANSACTION_FAMILY,
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

export function createCodeBlockTransactionSourceSyncOwner({
  resolveMarkdownOffset
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('code block transaction owner requires resolveMarkdownOffset')
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
    boundary = CODE_BLOCK_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('code-block-journal-stale', { reset: true })
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
    ) return rejected('code-block-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('code-block-live-snapshot-stale', { reset: true })
    }
    if (callbackDocumentEquivalent !== true) {
      return rejected('code-block-callback-document-mismatch', { deferred: true })
    }

    const classification = classifyCodeBlockJournal({ journal, expectedDoc })
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
      return recognizedRejection('code-block-range-unmapped')
    }
    if (
      normalizedFenceLine(previousRange.openLine) !== normalizedFenceLine(nextRange.openLine) ||
      normalizedFenceLine(previousRange.closeLine) !== normalizedFenceLine(nextRange.closeLine) ||
      previousRange.char !== nextRange.char ||
      previousRange.length !== nextRange.length
    ) return recognizedRejection('code-block-canonical-fence-changed')

    const previousText = classification.previousBlock.textContent || ''
    const nextText = classification.nextBlock.textContent || ''
    if (fencedCodeBlockContent(journal.source, sourceRange) !== previousText) {
      return recognizedRejection('code-block-source-content-mismatch')
    }
    if (fencedCodeBlockContent(journal.canonical, previousRange) !== previousText) {
      return recognizedRejection('code-block-previous-canonical-content-mismatch')
    }
    if (fencedCodeBlockContent(canonical, nextRange) !== nextText) {
      return recognizedRejection('code-block-next-canonical-content-mismatch')
    }
    if (sourceFenceCollides(sourceRange, nextText)) {
      return recognizedRejection('code-block-source-fence-collision')
    }

    const eol = lineEndingNear(journal.source, sourceRange.contentStart)
    const replacement = rawContentForDocument(nextText, eol)
    const markdown = journal.source.slice(0, sourceRange.contentStart) +
      replacement +
      journal.source.slice(sourceRange.closeStart)
    const mappedBlock = resolveFencedCodeBlockRange({
      markdown,
      doc: expectedDoc,
      entry: classification.nextEntry,
      topLevelIndex: classification.topLevelIndex,
      side: 'mapped-source',
      resolveMarkdownOffset
    })
    if (!mappedBlock || fencedCodeBlockContent(markdown, mappedBlock) !== nextText) {
      return recognizedRejection('code-block-mapped-content-mismatch')
    }

    const proof = Object.freeze({
      kind: 'transaction-code-block-content-proof',
      journalId: journal.journalId,
      family: CODE_BLOCK_TRANSACTION_FAMILY,
      topLevelIndex: classification.topLevelIndex,
      unchangedPrefix: classification.unchangedPrefix,
      unchangedSuffix: classification.unchangedSuffix,
      attrs: classification.previousBlock.attrs,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceRange,
      previousRange,
      nextRange,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      mapperReason: 'fenced-code-block-content-change',
      callbackDocumentEquivalent: true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_TRANSACTION_FAMILY,
    boundary: CODE_BLOCK_TRANSACTION_BOUNDARY,
    plan
  })
}
