import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import {
  adaptCanonicalRegionToSource,
  lineAt,
  lineIndexAt,
  markdownLines,
  rawOffsetAtVisible
} from './core.js'

const lineRegion = (markdown, start, end) => {
  const first = lineAt(markdown, start)
  // `end` is exclusive. When a structural insertion is exactly a newline,
  // the unchanged suffix starts at `end` on a new line and must travel with
  // the replacement.
  const last = lineAt(markdown, Math.max(start, end))
  return { start: first.start, end: last.end }
}

const isBlockPrefix = (value) =>
  /^\s*(?:#{1,6}|>|[-+*]|\d{1,9}[.)])?\s*$/.test(value)

export const hasStructuralPrefixChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousLine = lineAt(previous, start)
  const nextLine = lineAt(next, start)
  return isBlockPrefix(previous.slice(previousLine.start, previousEnd)) &&
    isBlockPrefix(next.slice(nextLine.start, nextEnd))
}

// A user edit before a later visible-stream mismatch is safe only when the
// bounded visible context agrees at the exact ordinal positions.
export const preserveLocallyAlignedTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousVisible = sourceVisibleIndex(previous)
  const sourceVisible = sourceVisibleIndex(source)
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const visibleStart = startVisible.visibleIndex
  const visibleEnd = endVisible.visibleIndex
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  const previousChangedVisible = previousVisible.text.slice(visibleStart, visibleEnd)
  if (!previousChangedVisible && !replacementVisible) return null

  const changedLines = lineRegion(previous, start, previousEnd)
  const lineVisibleStart = sourceVisiblePositionAtRaw(previous, changedLines.start).visibleIndex
  const lineVisibleEnd = sourceVisiblePositionAtRaw(previous, changedLines.end).visibleIndex
  const contextStart = Math.max(lineVisibleStart, visibleStart - 64)
  const contextEnd = Math.min(lineVisibleEnd, visibleEnd + 64)
  if (
    sourceVisible.text.slice(contextStart, visibleStart) !==
      previousVisible.text.slice(contextStart, visibleStart) ||
    sourceVisible.text.slice(visibleStart, visibleEnd) !== previousChangedVisible ||
    sourceVisible.text.slice(visibleEnd, contextEnd) !==
      previousVisible.text.slice(visibleEnd, contextEnd)
  ) {
    return null
  }

  const rawStart = rawOffsetAtVisible(source, startVisible)
  const rawEnd = rawOffsetAtVisible(source, endVisible)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) return null
  return {
    markdown: source.slice(0, rawStart) +
      adaptCanonicalRegionToSource(replacement, source, { start: rawStart, end: rawEnd }) +
      source.slice(rawEnd),
    preserved: true,
    reason: 'locally-aligned-change'
  }
}

// A canonical block is a run of non-blank lines bounded by blank lines. The
// change [start, end) must stay inside one block; crossing a blank-line
// boundary is a structural edit and belongs to the list/table/paragraph paths.
const blockSpan = (markdown, start, end) => {
  const lines = markdownLines(markdown)
  const index = lineIndexAt(lines, start)
  if (index < 0) return null
  const blank = (line) => /^\s*$/.test(line.text)
  let first = index
  while (first > 0 && !blank(lines[first - 1])) first -= 1
  let last = index
  while (last < lines.length - 1 && !blank(lines[last + 1])) last += 1
  // The change end must sit inside the same block (allowing `end === block
  // end`). If it lands past the block, the edit spans multiple canonical
  // blocks and must not use this fallback.
  if (end > lines[last].end) return null
  return { start: lines[first].start, end: lines[last].end }
}

// When the visible streams diverge (source and canonical disagree about how
// the authored bytes map to blocks — a mid-line `* ` that remark parses as a
// list item while the author kept it as paragraph text), both
// preserveLocallyAlignedTextChange and preserveChangedLineRegion fail and the
// façade would roll the edit back: a rich-text deletion never reaches the
// source. If the user's edit is confined to a single canonical block and that
// block's exact text occurs exactly once in the authored source, apply the
// block-level delta directly to the source spelling. Repeated text is
// ambiguous and stays untouched (fail closed).
export const preserveDivergedBlockTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousBlock = blockSpan(previous, start, previousEnd)
  const nextBlock = blockSpan(next, start, nextEnd)
  if (!previousBlock || !nextBlock) return null
  const previousText = previous.slice(previousBlock.start, previousBlock.end)
  const nextText = next.slice(nextBlock.start, nextBlock.end)
  if (!previousText || !nextText || previousText === nextText) return null
  if (
    start < previousBlock.start ||
    previousEnd > previousBlock.end ||
    start < nextBlock.start ||
    nextEnd > nextBlock.end
  ) {
    return null
  }

  // The canonical block may spell punctuation with backslash escapes or HTML
  // entities (`\*`, `&#x20;`) that the authored source keeps literal. Try the
  // verbatim block first; if it does not occur, retry with the canonical
  // spelling converted back to plain Markdown.
  const candidates = [previousText]
  const unescapedPrevious = unescapeCanonicalBlock(previousText)
  if (unescapedPrevious && unescapedPrevious !== previousText) {
    candidates.push(unescapedPrevious)
  }
  let first = -1
  let matched = ''
  for (const candidate of candidates) {
    const found = source.indexOf(candidate)
    if (found >= 0 && source.indexOf(candidate, found + 1) < 0) {
      first = found
      matched = candidate
      break
    }
  }
  if (first < 0 || !matched) return null

  const replacement = unescapeCanonicalBlock(nextText)
  if (!replacement) return null
  // A Crepe-only empty-paragraph `<br />` placeholder must never enter
  // authored source through this fallback; those edits belong to the
  // paragraph-emptied handlers that run before the divergence path.
  if (/^[ \t]*(?:[ \t]*>[ \t]*)*<br\s*\/?>[ \t]*$/im.test(replacement)) return null

  return {
    markdown: source.slice(0, first) +
      adaptCanonicalRegionToSource(
        replacement,
        source,
        { start: first, end: first + matched.length }
      ) +
      source.slice(first + matched.length),
    preserved: true,
    reason: 'diverged-block-change'
  }
}

// A deletion that spans several canonical blocks (a whole tail, or rows from
// several list trees) inside a diverged document defeats every localized
// mapper above and previously rolled back to the OLD source — the deletion
// silently vanished and saving resurrected the content. When the edit is a
// pure visible-text deletion, anchor the canonical's pre-deletion context in
// the authored visible stream (unique occurrence required) and delete the
// mapped raw range. The deleted raw text must match the canonical deletion
// after list markers are stripped; anything else stays fail-closed.
export const preserveDivergedVisibleDelete = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  // Pure deletion only: the replacement must carry no visible text.
  const replacement = next.slice(start, nextEnd)
  if (sourceVisibleIndex(replacement).text) return null

  const prevVis = sourceVisibleIndex(previous).text
  const srcVis = sourceVisibleIndex(source).text
  if (!prevVis || prevVis === srcVis) return null

  const vStart = sourceVisiblePositionAtRaw(previous, start).visibleIndex
  const vEnd = sourceVisiblePositionAtRaw(previous, previousEnd).visibleIndex
  if (vEnd <= vStart) return null
  const delVis = prevVis.slice(vStart, vEnd)
  if (!delVis) return null

  const CTX = 24
  const ctxBefore = prevVis.slice(Math.max(0, vStart - CTX), vStart)
  if (!ctxBefore) return null
  const anchorBefore = srcVis.indexOf(ctxBefore)
  if (anchorBefore < 0) return null
  if (srcVis.indexOf(ctxBefore, anchorBefore + 1) >= 0) return null

  const deleteStartVis = anchorBefore + ctxBefore.length
  let deleteEndVis
  if (vEnd >= prevVis.length) {
    deleteEndVis = srcVis.length
  } else {
    const ctxAfter = prevVis.slice(vEnd, Math.min(prevVis.length, vEnd + CTX))
    if (!ctxAfter) return null
    const anchorAfter = srcVis.indexOf(ctxAfter, deleteStartVis)
    if (anchorAfter < 0) return null
    deleteEndVis = anchorAfter
  }

  const rawStart = rawOffsetAtVisible(source, {
    visibleIndex: deleteStartVis,
    visibleAffinity: 'backward'
  })
  const rawEnd = rawOffsetAtVisible(source, {
    visibleIndex: deleteEndVis,
    visibleAffinity: 'forward'
  })
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) return null

  // Verify the raw range actually deletes what the canonical deleted (after
  // list markers are stripped — the canonical keeps them as syntax while the
  // authored source keeps them as item text).
  const stripMarkers = (text) => String(text || '')
    .split('\n')
    .map((line) => line.replace(/^[ \t]*(?:[-+*][ \t]+)?(?:\d{1,9}[.)][ \t]+)?/, ''))
    .join('\n')
  const deletedRawVis = sourceVisibleIndex(stripMarkers(source.slice(rawStart, rawEnd))).text
  if (deletedRawVis !== delVis) return null

  return {
    markdown: source.slice(0, rawStart) + source.slice(rawEnd),
    preserved: true,
    reason: 'diverged-visible-delete'
  }
}

const escapePunctuation = /[\\`*{}\[\]()#+\-.!_>~|]/

// Convert a canonical block's escaped spelling back to the plain Markdown the
// author would have typed (`\*` → `*`, `&#x20;` → ` `, `&amp;` → `&`). This
// is the source-spelling twin used only to locate the authored block and to
// spell the replacement; unescapable text is left verbatim.
const unescapeCanonicalBlock = (value) => String(value || '')
  .replace(new RegExp(`\\\\(${escapePunctuation.source})`, 'g'), '$1')
  .replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, name) => {
    if (name.startsWith('#')) {
      try {
        const code = name[1].toLowerCase() === 'x'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10)
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return decodeNamedCharacterReference(name) || match
  })

export const visibleLineEntries = (markdown) => markdownLines(markdown)
  .map((line) => ({
    ...line,
    visible: sourceVisibleIndex(line.text).text.trim()
  }))
  .filter((line) => line.visible)

export const sameVisibleLines = (left, right) =>
  left.length === right.length &&
  left.every((line, index) => line.visible === right[index].visible)

const sourceLineRegionFromCanonical = (source, previous, previousRegion) => {
  const sourceLines = visibleLineEntries(source)
  const previousLines = visibleLineEntries(previous)
  if (!sameVisibleLines(sourceLines, previousLines)) return null

  const touched = []
  previousLines.forEach((line, index) => {
    if (line.end >= previousRegion.start && line.start <= previousRegion.end) touched.push(index)
  })

  if (touched.length) {
    const first = sourceLines[touched[0]]
    const last = sourceLines[touched[touched.length - 1]]
    return {
      start: lineAt(source, first.start).start,
      end: lineAt(source, last.end).end
    }
  }

  const before = previousLines.reduce(
    (found, line, index) => line.end < previousRegion.start ? index : found,
    -1
  )
  const after = previousLines.findIndex((line) => line.start > previousRegion.end)
  const start = before >= 0
    ? lineAt(source, sourceLines[before].end).end
    : 0
  const end = after >= 0
    ? lineAt(source, sourceLines[after].start).start
    : source.length
  return { start, end }
}

// Structural edits have no visible-character span. Replace only the touched
// authored lines and keep the complete-document serializer out of this path.
export const preserveChangedLineRegion = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd,
  reason,
  transformReplacement = (value) => value
}) => {
  const previousRegion = lineRegion(previous, start, previousEnd)
  const nextRegion = lineRegion(next, start, nextEnd)
  const startVisible = sourceVisiblePositionAtRaw(previous, previousRegion.start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousRegion.end)
  const sourceStartRaw = sourceRawFromVisibleIndex(source, startVisible.visibleIndex, 'forward')
  const sourceEndRaw = sourceRawFromVisibleIndex(source, endVisible.visibleIndex, 'backward')
  let sourceRegion = Number.isFinite(sourceStartRaw) && Number.isFinite(sourceEndRaw)
    ? {
        start: lineAt(source, sourceStartRaw).start,
        end: lineAt(source, sourceEndRaw).end
      }
    : null
  const previousText = sourceVisibleIndex(previous.slice(previousRegion.start, previousRegion.end)).text
  const sourceText = sourceRegion
    ? sourceVisibleIndex(source.slice(sourceRegion.start, sourceRegion.end)).text
    : null
  if (!sourceRegion || sourceText !== previousText) {
    sourceRegion = sourceLineRegionFromCanonical(source, previous, previousRegion)
  }
  if (!sourceRegion) return null

  return {
    markdown: source.slice(0, sourceRegion.start) +
      adaptCanonicalRegionToSource(
        transformReplacement(next.slice(nextRegion.start, nextRegion.end)),
        source,
        sourceRegion
      ) +
      source.slice(sourceRegion.end),
    preserved: true,
    reason
  }
}
