// Source reprint engine entry (docs/source-reprint-architecture.md).
import { reprintSource } from './reprint.js'

export { reprintSource, sameNode } from './reprint.js'
import { separateAdjacentLists } from './list-boundaries.js'
export { buildInlineMap, pmInlineUnits } from './inline-map.js'

/**
 * Reprint and verify against the editor document. `equivalent(markdown, doc)`
 * must compare parse(markdown) with `doc` directly (never via canonical).
 * Minimal escaping first (writes exactly what was typed), then full escaping.
 */
export function reprintVerified({ source, editorDoc, previousDoc = null, parse, parseTree = null, remark, serialize, equivalent, newListMarkers = null }) {
  let last = null
  const candidates = []
  // Exact patches first; 'block' (changed text blocks printed whole, marked
  // degraded) is the last step before giving up. Verified strictly first:
  // bold / italic written as literal `*` (Option A, Typora parity) is only
  // for places Markdown cannot spell them at all — a `minimal` patch that
  // left `gamm**\`a\`…**` literal used to win although `full` / `block`
  // spell it (`gam&#x6D;**…`), and reopening showed asterisks.
  for (const escape of ['minimal', 'full', 'segment', 'block']) {
    let result
    try {
      result = reprintSource({ source, editorDoc, previousDoc, parse, parseTree, remark, serialize, escape, newListMarkers })
    } catch (error) {
      return { ok: false, reason: 'reprint-threw', error: String(error?.stack || error) }
    }
    if (!result.ok) return result
    // An edit that makes an authored ordered list directly adjacent to
    // another must not merge them on reopen (list-boundaries.js).
    const separated = separateAdjacentLists(result.markdown, editorDoc, previousDoc, remark)
    if (separated.unresolved) {
      last = { ...result, reason: 'reprint-merged-lists' }
      continue
    }
    if (separated.changed) result = { ...result, markdown: separated.markdown, notes: [...(result.notes || []), { level: 'list-boundary' }] }
    last = result
    candidates.push({ result, escape })
    let verified = false
    try {
      verified = equivalent(result.markdown, editorDoc, { literalEmphasis: false }) === true
    } catch {
      verified = false
    }
    if (verified) return { ...result, verified: true, escape }
  }
  // Then the literal spelling, in the same order.
  for (const { result, escape } of candidates) {
    let verified = false
    try {
      verified = equivalent(result.markdown, editorDoc) === true
    } catch {
      verified = false
    }
    if (verified) return { ...result, verified: true, escape, literalEmphasis: true }
  }
  return { ...last, ok: false, verified: false, reason: 'reprint-verify-failed' }
}
