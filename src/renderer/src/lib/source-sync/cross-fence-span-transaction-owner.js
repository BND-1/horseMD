// Cross-fence block-span replacement owner (P5c, trace-86199 12:37 incident).
//
// A selection delete / undo-restore that spans a fenced code block produces a
// PM shape the localized mappers refuse by design (the `localized-fence-
// crossing` guard protects author fence bytes), and the legacy fallback then
// holds a no-op — the committed source silently stops tracking the editor
// (trace-86199: the restored ```text block survived in PM but vanished from
// the source baseline). This owner owns the whole-span shape instead: the
// changed top-level window between the journal's oldDoc and expectedDoc.
//
// Contract (all fail-closed after the family gate):
//   - the changed window (unique .eq() prefix/suffix derivation) must contain
//     at least one code_block somewhere in its subtrees on either side;
//   - the window must contain NO table (the table-padding divergence
//     dimension is explicitly out of scope — table owners keep it);
//   - a 1:1 code_block↔code_block window is NOT claimed (that is the code
//     content-edit family, owned earlier in the registry);
//   - the span must be interior (≥1 stable block on both sides) so two
//     block-level source anchors exist;
//   - the source byte range is resolved via the block-level PM→markdown
//     offset mapper (same channel every other owner uses), replaced with the
//     serialized new window (P7 style-following serializer), keeping the
//     source's own EOL and the author's pre-window separation gap;
//   - top-level editor-only empty paragraphs in the new window are skipped
//     (they have no Markdown bytes; the shared comparator bridges them).
//
// Everything else — including stale journals, unresolved anchors, serializer
// failure and semantic mismatch — is a recognized rejection: fail closed,
// never silently hold.
import { SOURCE_SYNC_OWNERS } from './proof.js'
import { sourceSyncDigest } from './snapshot.js'
import { sourceSyncNodeEntryAtPath } from './top-level-subtree.js'
import { verifySourceSyncTransactionJournalCheckpoint } from './transaction-journal.js'

export const CROSS_FENCE_SPAN_TRANSACTION_FAMILY = 'cross-fence-span'
export const CROSS_FENCE_SPAN_TRANSACTION_BOUNDARY = 'transaction-cross-fence-span'

const rejected = (reason, {
  deferred = false,
  reset = false,
  recognized = false,
  proof = null
} = {}) => Object.freeze({
  ok: false,
  decision: 'rejected',
  deferred,
  reset,
  recognized,
  reason,
  proof
})

const subtreeContainsType = (node, typeName) => {
  if (!node) return false
  if (node.type?.name === typeName) return true
  for (let index = 0; index < node.childCount; index += 1) {
    if (subtreeContainsType(node.child(index), typeName)) return true
  }
  return false
}

const isEditorOnlyEmptyParagraph = (node) =>
  node?.type?.name === 'paragraph' && String(node.textContent || '').length === 0

const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/

// The production block-level mapper resolves to an offset INSIDE the block's
// raw text (e.g. after a heading's `## ` marker) — snap to the start of that
// line so span boundaries never split a marker prefix.
const snapToLineStart = (markdown, offset) => markdown.lastIndexOf('\n', offset - 1) + 1

// The block-level offset mapper anchors on a block's VISIBLE TEXT — for a
// code block that is a content line, not its opening fence line. Snap a
// resolved offset up across the content to the opening fence so the span
// range covers the fence bytes (the same job resolveFencedCodeSourceRange
// does for the focused code owners).
const snapUpToFenceLine = (markdown, offset) => {
  let current = offset
  for (let guard = 0; guard < 8 && current > 0; guard += 1) {
    // Search from current-2: the char at current-1 is the line BREAK that
    // ends the previous line, and lastIndexOf would find it and no-op.
    const prevBreak = markdown.lastIndexOf('\n', current - 2)
    const prevLineStart = prevBreak + 1
    const prevLine = markdown.slice(prevLineStart, current).replace(/[\r\n]+$/, '')
    if (!FENCE_LINE_RE.test(prevLine)) break
    current = prevLineStart
    if (prevBreak < 0) break
  }
  return current
}

// The changed top-level window between two docs: the unique run of equal
// leading blocks (prefix) and equal trailing blocks (suffix) leaves the
// changed span in the middle. Mirrors how a human sees "the edited region".
const changedTopLevelWindow = (oldDoc, newDoc) => {
  const oldCount = oldDoc.childCount
  const newCount = newDoc.childCount
  let prefix = 0
  while (
    prefix < oldCount && prefix < newCount &&
    oldDoc.child(prefix).eq(newDoc.child(prefix))
  ) prefix += 1
  let suffix = 0
  while (
    suffix < oldCount - prefix && suffix < newCount - prefix &&
    oldDoc.child(oldCount - 1 - suffix).eq(newDoc.child(newCount - 1 - suffix))
  ) suffix += 1
  return {
    prefix,
    suffix,
    oldWindowStart: prefix,
    oldWindowEnd: oldCount - suffix,
    newWindowStart: prefix,
    newWindowEnd: newCount - suffix
  }
}

const windowBlocks = (doc, start, end) => {
  const blocks = []
  for (let index = start; index < end; index += 1) blocks.push(doc.child(index))
  return blocks
}

const createOwnedPlan = ({ boundary, markdown, canonical, expectedDoc, proof }) => {
  const result = Object.freeze({
    markdown,
    preserved: true,
    reason: CROSS_FENCE_SPAN_TRANSACTION_FAMILY,
    integrityProof: proof
  })
  return Object.freeze({
    ok: true,
    decision: 'owned',
    owner: SOURCE_SYNC_OWNERS.TRANSACTION,
    family: CROSS_FENCE_SPAN_TRANSACTION_FAMILY,
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

export function createCrossFenceSpanTransactionSourceSyncOwner({
  resolveMarkdownOffset,
  serializeNodes,
  validateMarkdown
} = {}) {
  if (typeof resolveMarkdownOffset !== 'function') {
    throw new TypeError('cross fence span owner requires resolveMarkdownOffset')
  }
  if (typeof serializeNodes !== 'function') {
    throw new TypeError('cross fence span owner requires serializeNodes')
  }
  if (typeof validateMarkdown !== 'function') {
    throw new TypeError('cross fence span owner requires validateMarkdown')
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
    boundary = CROSS_FENCE_SPAN_TRANSACTION_BOUNDARY
  } = {}) => {
    if (!journal || activeJournal !== journal) {
      return rejected('cross-fence-span-journal-stale', { reset: true })
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
    ) return rejected('cross-fence-span-plan-incomplete', { reset: true })
    if (currentSource !== snapshot.source || currentCanonical !== snapshot.canonical) {
      return rejected('cross-fence-span-live-snapshot-stale', { reset: true })
    }
    const window = changedTopLevelWindow(journal.oldDoc, expectedDoc)
    const oldWindow = windowBlocks(journal.oldDoc, window.oldWindowStart, window.oldWindowEnd)
    const newWindow = windowBlocks(expectedDoc, window.newWindowStart, window.newWindowEnd)

    // ---- family gate (before this point every rejection is "not my shape") ----
    if (!oldWindow.length && !newWindow.length) {
      return rejected('cross-fence-span-empty-window')
    }
    const oldHasFence = oldWindow.some((node) => subtreeContainsType(node, 'code_block'))
    const newHasFence = newWindow.some((node) => subtreeContainsType(node, 'code_block'))
    if (!oldHasFence && !newHasFence) {
      return rejected('cross-fence-span-no-fence-in-span')
    }
    const oldHasTable = oldWindow.some((node) => subtreeContainsType(node, 'table'))
    const newHasTable = newWindow.some((node) => subtreeContainsType(node, 'table'))
    if (oldHasTable || newHasTable) {
      // Tables carry the alignment-padding divergence dimension — their
      // serialization would rewrite author bytes. Not this family.
      return rejected('cross-fence-span-table-in-span')
    }
    if (
      oldWindow.length === 1 && newWindow.length === 1 &&
      oldWindow[0].type?.name === 'code_block' && newWindow[0].type?.name === 'code_block'
    ) {
      // Pure code content edit — the code-block content family owns it.
      return rejected('cross-fence-span-code-content-edit')
    }
    if (window.prefix < 1 || window.suffix < 1) {
      // An edge span (doc start/end) has only one anchor — keep out of v1.
      return rejected('cross-fence-span-edge-span')
    }
    // ---- family recognized: every later failure fails closed ----
    const recognized = { recognized: true }

    // Leading editor-only empty paragraphs contribute no source bytes, so the
    // span anchor is the first window block that HAS bytes (trace-86199
    // undo-restore: old window = [empty paragraph, …] — anchoring on the empty
    // paragraph would be unresolvable by the block-level mapper).
    let anchorIndex = window.oldWindowStart
    while (
      anchorIndex < window.oldWindowEnd &&
      isEditorOnlyEmptyParagraph(journal.oldDoc.child(anchorIndex))
    ) anchorIndex += 1
    const firstWindowEntry = anchorIndex < window.oldWindowEnd
      ? sourceSyncNodeEntryAtPath(journal.oldDoc, [anchorIndex])
      : null
    // The suffix anchor needs resolvable bytes too — a leading empty
    // paragraph in the suffix run (common right after an undo) maps to no
    // source line, so skip forward to the first suffix block that has text.
    let suffixAnchorIndex = window.oldWindowEnd
    while (
      suffixAnchorIndex < journal.oldDoc.childCount &&
      isEditorOnlyEmptyParagraph(journal.oldDoc.child(suffixAnchorIndex))
    ) suffixAnchorIndex += 1
    const firstSuffixEntry = suffixAnchorIndex < journal.oldDoc.childCount
      ? sourceSyncNodeEntryAtPath(journal.oldDoc, [suffixAnchorIndex])
      : null
    if (!firstSuffixEntry || (anchorIndex < window.oldWindowEnd && !firstWindowEntry)) {
      return rejected('cross-fence-span-anchor-entry-missing', recognized)
    }
    let spanStart = null
    let suffixStart = null
    try {
      if (firstWindowEntry) {
        spanStart = resolveMarkdownOffset({
          markdown: journal.source,
          pmPos: firstWindowEntry.beforePos,
          doc: journal.oldDoc
        })
      }
      suffixStart = resolveMarkdownOffset({
        markdown: journal.source,
        pmPos: firstSuffixEntry.beforePos,
        doc: journal.oldDoc
      })
    } catch {
      return rejected('cross-fence-span-anchor-resolution-threw', recognized)
    }
    if (!Number.isInteger(suffixStart) || suffixStart < 0) {
      return rejected('cross-fence-span-source-range-unresolved', recognized)
    }
    // Either anchor may be a code block whose text resolves mid-fence — snap
    // both up to the opening fence line so fence bytes stay inside the span.
    suffixStart = snapUpToFenceLine(journal.source, snapToLineStart(journal.source, suffixStart))
    if (firstWindowEntry) {
      if (!Number.isInteger(spanStart) || spanStart < 0) {
        return rejected('cross-fence-span-source-range-unresolved', recognized)
      }
      spanStart = snapUpToFenceLine(journal.source, snapToLineStart(journal.source, spanStart))
      if (spanStart >= suffixStart) {
        return rejected('cross-fence-span-source-range-unresolved', recognized)
      }
    } else {
      // The whole old window is editor-only empties: a pure insertion at the
      // suffix anchor with an empty removal range.
      spanStart = suffixStart
    }

    // The separation the author uses between the prefix and this span is
    // reused between the (new) span and the suffix, so block spacing outside
    // the window is never rewritten.
    const preGapMatch = journal.source.slice(0, spanStart).match(/(?:\r\n|\n)+$/)
    const preGap = preGapMatch ? preGapMatch[0] : '\n'
    const regionUsesCrLf = journal.source.slice(spanStart, suffixStart).includes('\r\n')
    const eol = regionUsesCrLf ? '\r\n' : '\n'

    const serializedBlocks = newWindow.filter((node) => !isEditorOnlyEmptyParagraph(node))
    let serialized = ''
    if (serializedBlocks.length) {
      try {
        serialized = serializeNodes(serializedBlocks)
      } catch {
        return rejected('cross-fence-span-serializer-threw', recognized)
      }
      if (typeof serialized !== 'string' || !serialized.trim()) {
        return rejected('cross-fence-span-serializer-empty', recognized)
      }
      serialized = serialized
        .replace(/\r\n|\r/g, '\n')
        .replace(/(?:\n)+$/, '')
        .replace(/\n/g, eol)
    }
    const replacement = serialized ? serialized + preGap : ''
    const markdown = journal.source.slice(0, spanStart) + replacement + journal.source.slice(suffixStart)

    let semanticOk = false
    try {
      semanticOk = validateMarkdown({ markdown, expectedDoc }) === true
    } catch {
      return rejected('cross-fence-span-semantic-validator-threw', recognized)
    }
    if (!semanticOk) return rejected('cross-fence-span-semantic-document-mismatch', recognized)

    const proof = Object.freeze({
      kind: 'transaction-cross-fence-span-proof',
      journalId: journal.journalId,
      family: CROSS_FENCE_SPAN_TRANSACTION_FAMILY,
      prefix: window.prefix,
      suffix: window.suffix,
      oldWindowStart: window.oldWindowStart,
      oldWindowEnd: window.oldWindowEnd,
      newWindowStart: window.newWindowStart,
      newWindowEnd: window.newWindowEnd,
      oldWindowTypes: Object.freeze(oldWindow.map((node) => node.type?.name || '?')),
      newWindowTypes: Object.freeze(newWindow.map((node) => node.type?.name || '?')),
      spanStart,
      suffixStart,
      preGap,
      replacementLength: replacement.length,
      serializedBlockCount: serializedBlocks.length,
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
    family: CROSS_FENCE_SPAN_TRANSACTION_FAMILY,
    boundary: CROSS_FENCE_SPAN_TRANSACTION_BOUNDARY,
    plan
  })
}
