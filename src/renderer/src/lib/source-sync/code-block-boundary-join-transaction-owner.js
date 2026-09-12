import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import {
  lineEndingForFencedCodeRange,
  resolveFencedCodeSourceRange
} from './fenced-code-source-range.js'
import {
  sameSourceSyncDocument,
  sourceSyncNodeEntryAtPath
} from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY =
  'code-block-boundary-join'
export const CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_BOUNDARY =
  'transaction-code-block-boundary-join'

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

const plainParagraphText = (node) => {
  if (node?.type?.name !== 'paragraph') return null
  let value = ''
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (!child?.isText || child.marks?.length) return null
    value += child.text || ''
  }
  return value
}

const plainCodeText = (node) => {
  if (node?.type?.name !== 'code_block') return null
  let value = ''
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (!child?.isText || child.marks?.length) return null
    value += child.text || ''
  }
  return value
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

const sameOutsideCollapsedPair = ({ before, after, leftIndex }) => {
  if (!before || !after || before.childCount !== after.childCount + 1) return false
  for (let index = 0; index < leftIndex; index += 1) {
    if (before.child(index).eq?.(after.child(index)) !== true) return false
  }
  for (let index = leftIndex + 2; index < before.childCount; index += 1) {
    if (before.child(index).eq?.(after.child(index - 1)) !== true) return false
  }
  return true
}

const classifyBoundaryJoin = (oldDoc, expectedDoc) => {
  if (!oldDoc || !expectedDoc || oldDoc.childCount !== expectedDoc.childCount + 1) {
    return rejected('code-block-boundary-join-topology')
  }
  const candidates = []
  for (let leftIndex = 0; leftIndex < oldDoc.childCount - 1; leftIndex += 1) {
    const left = oldDoc.child(leftIndex)
    const right = oldDoc.child(leftIndex + 1)
    const merged = expectedDoc.child(leftIndex)
    if (!sameOutsideCollapsedPair({ before: oldDoc, after: expectedDoc, leftIndex })) continue

    const leftParagraph = plainParagraphText(left)
    const rightCode = plainCodeText(right)
    const mergedParagraph = plainParagraphText(merged)
    if (
      leftParagraph != null &&
      rightCode != null &&
      rightCode !== '' &&
      mergedParagraph != null &&
      mergedParagraph.startsWith(leftParagraph + rightCode)
    ) {
      candidates.push(Object.freeze({
        mode: 'paragraph-absorbs-code',
        leftIndex,
        codeIndex: leftIndex + 1,
        paragraphIndex: leftIndex,
        mergedIndex: leftIndex,
        initialText: leftParagraph + rightCode,
        finalText: mergedParagraph,
        paragraphText: leftParagraph,
        codeText: rightCode,
        codeAttrs: right.attrs
      }))
    }

    const leftCode = plainCodeText(left)
    const rightParagraph = plainParagraphText(right)
    const mergedCode = plainCodeText(merged)
    if (
      leftCode != null &&
      leftCode !== '' &&
      rightParagraph != null &&
      mergedCode != null &&
      mergedCode.startsWith(leftCode + rightParagraph) &&
      JSON.stringify(left.attrs || {}) === JSON.stringify(merged.attrs || {})
    ) {
      candidates.push(Object.freeze({
        mode: 'code-absorbs-paragraph',
        leftIndex,
        codeIndex: leftIndex,
        paragraphIndex: leftIndex + 1,
        mergedIndex: leftIndex,
        initialText: leftCode + rightParagraph,
        finalText: mergedCode,
        paragraphText: rightParagraph,
        codeText: leftCode,
        codeAttrs: left.attrs
      }))
    }
  }
  if (candidates.length !== 1) {
    return rejected('code-block-boundary-join-candidate-count', {
      proof: { candidateCount: candidates.length, candidates }
    })
  }
  return Object.freeze({ ok: true, ...candidates[0] })
}

const classifyIntermediateJoin = ({ beforeDoc, afterDoc, classification }) => {
  if (!sameOutsideCollapsedPair({
    before: beforeDoc,
    after: afterDoc,
    leftIndex: classification.leftIndex
  })) return false
  const merged = afterDoc.child(classification.mergedIndex)
  if (classification.mode === 'paragraph-absorbs-code') {
    return plainParagraphText(merged) === classification.initialText
  }
  return plainCodeText(merged) === classification.initialText &&
    JSON.stringify(merged.attrs || {}) === JSON.stringify(classification.codeAttrs || {})
}

const replayJournal = ({ journal, expectedDoc, classification }) => {
  if (!Array.isArray(journal?.entries) || !journal.entries.length) {
    return rejected('code-block-boundary-join-entry-missing')
  }
  let currentDoc = journal.oldDoc
  let joined = false
  let textStepCount = 0
  const stepRanges = []

  for (let entryIndex = 0; entryIndex < journal.entries.length; entryIndex += 1) {
    const entry = journal.entries[entryIndex]
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected('code-block-boundary-join-entry-baseline')
    }
    for (let stepIndex = 0; stepIndex < (entry.steps?.length || 0); stepIndex += 1) {
      const step = entry.steps[stepIndex]
      const stepDoc = entry.stepDocs?.[stepIndex] ||
        (stepIndex === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, currentDoc)) {
        return rejected('code-block-boundary-join-step-document')
      }

      if (joined) {
        const mergedEntry = sourceSyncNodeEntryAtPath(currentDoc, [classification.mergedIndex])
        const mergedNode = mergedEntry?.node
        const currentText = classification.mode === 'paragraph-absorbs-code'
          ? plainParagraphText(mergedNode)
          : plainCodeText(mergedNode)
        if (
          step?.constructor?.name !== 'ReplaceStep' ||
          step.structure === true ||
          currentText == null ||
          !plainTextSlice(step.slice) ||
          !Number.isFinite(step.from) ||
          !Number.isFinite(step.to) ||
          step.from < mergedEntry.contentStart ||
          step.to > mergedEntry.contentStart + mergedNode.content.size ||
          step.to < step.from
        ) return rejected('code-block-boundary-join-text-step')
      } else if (
        !['ReplaceStep', 'ReplaceAroundStep'].includes(step?.constructor?.name) ||
        !Number.isFinite(step.from) ||
        !Number.isFinite(step.to)
      ) {
        return rejected('code-block-boundary-join-structural-step')
      }

      let applied
      try { applied = step.apply(currentDoc) } catch { applied = null }
      if (applied?.failed || !applied?.doc) {
        return rejected('code-block-boundary-join-step-apply')
      }
      if (!joined) {
        if (!classifyIntermediateJoin({
          beforeDoc: currentDoc,
          afterDoc: applied.doc,
          classification
        })) return rejected('code-block-boundary-join-structural-result')
      } else {
        if (applied.doc.childCount !== currentDoc.childCount) {
          return rejected('code-block-boundary-join-text-topology')
        }
        for (let index = 0; index < currentDoc.childCount; index += 1) {
          if (index === classification.mergedIndex) continue
          if (currentDoc.child(index).eq?.(applied.doc.child(index)) !== true) {
            return rejected('code-block-boundary-join-text-neighbour')
          }
        }
        const merged = applied.doc.child(classification.mergedIndex)
        const text = classification.mode === 'paragraph-absorbs-code'
          ? plainParagraphText(merged)
          : plainCodeText(merged)
        if (text == null) return rejected('code-block-boundary-join-text-result')
        textStepCount += 1
      }

      stepRanges.push(Object.freeze({
        entryIndex,
        stepIndex,
        stepName: step.constructor.name,
        from: step.from,
        to: step.to,
        sliceSize: Number.isFinite(step.slice?.size) ? step.slice.size : null,
        structure: step.structure === true,
        mode: joined ? 'merged-text' : 'boundary-join'
      }))
      joined = true
      currentDoc = applied.doc
    }
    if (!sameSourceSyncDocument(currentDoc, entry.afterDoc)) {
      return rejected('code-block-boundary-join-entry-result')
    }
  }

  if (!joined || !sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected('code-block-boundary-join-final-document')
  }
  const finalNode = currentDoc.child(classification.mergedIndex)
  const finalText = classification.mode === 'paragraph-absorbs-code'
    ? plainParagraphText(finalNode)
    : plainCodeText(finalNode)
  if (finalText !== classification.finalText) {
    return rejected('code-block-boundary-join-final-text')
  }
  return Object.freeze({
    ok: true,
    textStepCount,
    stepRanges: Object.freeze(stepRanges)
  })
}

const markdownLines = (markdown) => {
  const lines = []
  let start = 0
  while (start < markdown.length) {
    let end = start
    while (end < markdown.length && markdown[end] !== '\n' && markdown[end] !== '\r') end += 1
    let next = end
    if (markdown[next] === '\r' && markdown[next + 1] === '\n') next += 2
    else if (markdown[next] === '\r' || markdown[next] === '\n') next += 1
    lines.push({ start, end, next, text: markdown.slice(start, end), eol: markdown.slice(end, next) })
    start = next
  }
  if (!markdown.length || start === markdown.length) {
    lines.push({ start, end: start, next: start, text: '', eol: '' })
  }
  return lines
}

const lineAtOffset = (markdown, offset) => {
  if (!Number.isFinite(offset)) return null
  const matches = markdownLines(markdown).filter((line) =>
    offset >= line.start && offset <= Math.max(line.end, line.next)
  )
  return matches.length === 1 ? matches[0] : null
}

const resolvePlainParagraphLine = ({
  markdown,
  paragraphText,
  pmPos,
  doc,
  resolveMarkdownOffset
}) => {
  const offsets = []
  for (const position of [pmPos + 1, pmPos]) {
    try {
      const offset = resolveMarkdownOffset({ markdown, pmPos: position, doc })
      if (Number.isFinite(offset)) offsets.push(offset)
    } catch { /* fail closed below */ }
  }
  const matches = []
  for (const offset of offsets) {
    const line = lineAtOffset(markdown, offset)
    if (!line) continue
    const raw = line.text.startsWith('\uFEFF') ? line.text.slice(1) : line.text
    if (
      raw === paragraphText &&
      !matches.some((entry) => entry.start === line.start && entry.end === line.end)
    ) matches.push(line)
  }
  if (matches.length === 1) return matches[0]
  const fallback = markdownLines(markdown).filter((line) => {
    const raw = line.text.startsWith('\uFEFF') ? line.text.slice(1) : line.text
    return raw === paragraphText
  })
  return fallback.length === 1 ? fallback[0] : null
}

const blankGap = (value) => value === '' || value.split(/\r\n|\r|\n/).every((part) => part.trim() === '')

const patchParagraphAbsorbsCode = ({ source, paragraphLine, codeRange, finalText }) => {
  if (paragraphLine.end > codeRange.start) return null
  const gap = source.slice(paragraphLine.next, codeRange.start)
  if (!blankGap(gap)) return null
  const bom = paragraphLine.start === 0 && source.charCodeAt(0) === 0xFEFF ? '\uFEFF' : ''
  // The merged paragraph can still carry the code block's newlines inside
  // its text. Rewrite each with the paragraph line's own EOL so a CRLF
  // document never receives bare LF bytes from this patch.
  const eol = paragraphLine.eol || '\n'
  return Object.freeze({
    start: paragraphLine.start,
    end: codeRange.end,
    replacement: bom + String(finalText || '').replace(/\r\n|\r|\n/g, eol),
    gap
  })
}

// A CRLF document carries its CR characters into the ProseMirror code text
// (`\r\n` stays `\r\n`), while bare `\n` newlines cannot appear inside a
// normalized source. Rewriting every newline with the fence's own EOL keeps
// the authored CRLF bytes intact instead of collapsing them to LF.
const codeContentForSource = (text, eol) =>
  String(text || '').replace(/\r\n|\r|\n/g, eol)

const patchCodeAbsorbsParagraph = ({ source, codeRange, paragraphLine, finalText }) => {
  if (codeRange.endWithEol > paragraphLine.start) return null
  const gap = source.slice(codeRange.endWithEol, paragraphLine.start)
  if (!blankGap(gap)) return null
  const eol = lineEndingForFencedCodeRange(source, codeRange)
  const opening = source.slice(codeRange.start, codeRange.contentStart)
  const closing = source.slice(codeRange.contentEnd, codeRange.end)
  return Object.freeze({
    start: codeRange.start,
    end: paragraphLine.end,
    replacement: opening + codeContentForSource(finalText, eol) + eol + closing,
    gap,
    eol
  })
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY,
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

export function createCodeBlockBoundaryJoinTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('code block boundary join owner requires resolveMarkdownOffset')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('code block boundary join owner requires validateMarkdown')
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
    boundary = CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('code-block-boundary-join-journal-stale', { reset: true })
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
    ) return rejected('code-block-boundary-join-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('code-block-boundary-join-live-snapshot-stale', { reset: true })
    }
    const classification = classifyBoundaryJoin(journal.oldDoc, expectedDoc)
    if (!classification.ok) return classification
    const replayed = replayJournal({ journal, expectedDoc, classification })
    if (!replayed.ok) return replayed

    const codeEntry = sourceSyncNodeEntryAtPath(journal.oldDoc, [classification.codeIndex])
    const paragraphEntry = sourceSyncNodeEntryAtPath(
      journal.oldDoc,
      [classification.paragraphIndex]
    )
    const codeRange = resolveFencedCodeSourceRange({
      markdown: journal.source,
      pmPos: codeEntry?.beforePos,
      doc: journal.oldDoc,
      resolveMarkdownOffset,
      requireEmpty: false
    })
    const paragraphLine = resolvePlainParagraphLine({
      markdown: journal.source,
      paragraphText: classification.paragraphText,
      pmPos: paragraphEntry?.beforePos,
      doc: journal.oldDoc,
      resolveMarkdownOffset
    })
    if (!codeRange || !paragraphLine) {
      return rejected('code-block-boundary-join-source-range')
    }
    // A CRLF document keeps its CR characters inside the ProseMirror code
    // text, so both sides must be normalized before comparing (trace-23324:
    // code text `...排最后` + CRLF content slice failed this check raw).
    const normalizeCodeText = (value) => String(value || '').replace(/\r\n|\r/g, '\n')
    if (normalizeCodeText(journal.source.slice(codeRange.contentStart, codeRange.contentEnd)) !==
      `${normalizeCodeText(classification.codeText)}\n`) {
      return rejected('code-block-boundary-join-source-code-text')
    }

    const patch = classification.mode === 'paragraph-absorbs-code'
      ? patchParagraphAbsorbsCode({
          source: journal.source,
          paragraphLine,
          codeRange,
          finalText: classification.finalText
        })
      : patchCodeAbsorbsParagraph({
          source: journal.source,
          codeRange,
          paragraphLine,
          finalText: classification.finalText
        })
    if (!patch) return rejected('code-block-boundary-join-source-adjacency')
    const markdown = journal.source.slice(0, patch.start) +
      patch.replacement +
      journal.source.slice(patch.end)
    let semanticOk = false
    try { semanticOk = validateMarkdown({ markdown, expectedDoc }) === true } catch {
      return rejected('code-block-boundary-join-semantic-validator-threw')
    }
    if (!semanticOk) return rejected('code-block-boundary-join-semantic-document-mismatch')

    const proof = Object.freeze({
      kind: 'transaction-code-block-boundary-join-proof',
      journalId: journal.journalId,
      family: CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY,
      mode: classification.mode,
      leftIndex: classification.leftIndex,
      codeIndex: classification.codeIndex,
      paragraphIndex: classification.paragraphIndex,
      mergedIndex: classification.mergedIndex,
      codePath: Object.freeze([classification.codeIndex]),
      paragraphPath: Object.freeze([classification.paragraphIndex]),
      mergedPath: Object.freeze([classification.mergedIndex]),
      initialText: classification.initialText,
      finalText: classification.finalText,
      textStepCount: replayed.textStepCount,
      stepRanges: replayed.stepRanges,
      codeRange: Object.freeze({
        start: codeRange.start,
        end: codeRange.end,
        endWithEol: codeRange.endWithEol,
        contentStart: codeRange.contentStart,
        contentEnd: codeRange.contentEnd,
        marker: codeRange.marker,
        markerSize: codeRange.markerSize,
        info: codeRange.info
      }),
      paragraphRange: Object.freeze({
        start: paragraphLine.start,
        end: paragraphLine.end,
        next: paragraphLine.next,
        text: paragraphLine.text
      }),
      patch,
      chainLength: journal.transactionCount,
      stepDetails: journal.stepDetails,
      transactionJournal: verified.proof,
      sourceDigest: sourceSyncDigest(journal.source),
      previousCanonicalDigest: sourceSyncDigest(journal.canonical),
      canonicalDigest: sourceSyncDigest(canonical),
      markdownDigest: sourceSyncDigest(markdown),
      callbackDocumentEquivalent: callbackDocumentEquivalent === true,
      snapshotMatched: true,
      documentMatched: true
    })
    return createOwnedPlan({ boundary, markdown, canonical, expectedDoc, proof })
  }

  return Object.freeze({
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_FAMILY,
    boundary: CODE_BLOCK_BOUNDARY_JOIN_TRANSACTION_BOUNDARY,
    plan
  })
}
