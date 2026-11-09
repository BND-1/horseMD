// Source reprint engine entry (docs/source-reprint-architecture.md).
import { reprintSource } from './reprint.js'

export { reprintSource, sameNode } from './reprint.js'
import { separateAdjacentLists } from './list-boundaries.js'
export { listsReadAsOne } from './list-boundaries.js'
export { buildInlineMap, pmInlineUnits } from './inline-map.js'

// A list item can begin with at most one blank line (CommonMark 5.2): a
// marker alone on its line, then a blank line, ends the item, and what
// follows at the item's indentation leaves the list. The blank lines between
// such a marker line and its indented continuation are removed.
const EMPTY_MARKER_LINE = /^((?:[ \t]*>)*[ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/
export function joinEmptyItemContinuations(markdown) {
  const lines = String(markdown).split('\n')
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index])
    const marker = EMPTY_MARKER_LINE.exec(lines[index].replace(/\r$/, ''))
    if (!marker) continue
    let next = index + 1
    while (next < lines.length && /^(?:[ \t]*>)*[ \t]*\r?$/.test(lines[next])) next += 1
    if (next === index + 1 || next >= lines.length) continue
    const column = marker[1].replace(/\t/g, '    ').length + marker[2].length + 1
    const lead = /^((?:[ \t]*>)*)([ \t]*)/.exec(lines[next])
    if (lead[1].length !== (/^(?:[ \t]*>)*/.exec(marker[1])[0] || '').length) continue
    if (lead[2].replace(/\t/g, '    ').length < column - lead[1].length) continue
    index = next - 1
  }
  return out.join('\n')
}

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
    // Two lists directly adjacent in the editor must not read back as one
    // (list-boundaries.js).
    const separated = separateAdjacentLists(result.markdown, editorDoc, remark)
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
    // Verified and not read back the same: an item whose first line became
    // empty keeps the blank line the authored text had after it, which now
    // ends the item (CommonMark 5.2). Kept only if it then verifies.
    const joined = joinEmptyItemContinuations(result.markdown)
    if (joined !== result.markdown) {
      let joinedOk = false
      try { joinedOk = equivalent(joined, editorDoc, { literalEmphasis: false }) === true } catch { joinedOk = false }
      if (joinedOk) return { ...result, markdown: joined, notes: [...(result.notes || []), { level: 'empty-item-continuation' }], verified: true, escape }
    }
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
