import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import {
  adaptCanonicalRegionToSource,
  canonicalFreshTextToSource,
  canonicalTextToSource,
  lineAt,
  lineIndexAt,
  lineEndingNear,
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

// A document can have a permanent visible-stream divergence before the block
// being edited (nested `- 4. text`, a literal mid-line `*`, serializer-only
// entities, etc.). Ordinal visible offsets then point at the wrong source
// location even though the changed text and its immediate context are unique.
// For a single-line text delta, locate that bounded context in the authored
// visible stream and apply only the corresponding raw range. Structural and
// multi-line changes stay with their dedicated handlers.
export const preserveUniquelyAnchoredTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousStartLine = lineAt(previous, start)
  const previousEndLine = lineAt(previous, Math.max(start, previousEnd - 1))
  const nextStartLine = lineAt(next, start)
  const nextEndLine = lineAt(next, Math.max(start, nextEnd - 1))
  if (
    previousStartLine.start !== previousEndLine.start ||
    nextStartLine.start !== nextEndLine.start
  ) return null

  const previousVisible = sourceVisibleIndex(previous)
  const sourceVisible = sourceVisibleIndex(source)
  const startPosition = sourceVisiblePositionAtRaw(previous, start)
  const endPosition = sourceVisiblePositionAtRaw(previous, previousEnd)
  const visibleStart = startPosition.visibleIndex
  const visibleEnd = endPosition.visibleIndex
  const changedVisible = previousVisible.text.slice(visibleStart, visibleEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  if ((!changedVisible && !replacementVisible) || /\r|\n/.test(replacement)) return null

  const before = previousVisible.text.slice(Math.max(0, visibleStart - 32), visibleStart)
  const after = previousVisible.text.slice(visibleEnd, visibleEnd + 32)
  const context = before + changedVisible + after
  if (!context) return null
  const contextAt = sourceVisible.text.indexOf(context)
  if (contextAt < 0 || sourceVisible.text.indexOf(context, contextAt + 1) >= 0) return null

  const mappedStart = contextAt + before.length
  const mappedEnd = mappedStart + changedVisible.length
  const rawStart = sourceRawFromVisibleIndex(source, mappedStart, startPosition.visibleAffinity)
  const rawEnd = sourceRawFromVisibleIndex(source, mappedEnd, endPosition.visibleAffinity)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) return null
  if (sourceVisibleIndex(source.slice(rawStart, rawEnd)).text !== changedVisible) return null

  return {
    markdown: source.slice(0, rawStart) +
      adaptCanonicalRegionToSource(replacement, source, { start: rawStart, end: rawEnd }) +
      source.slice(rawEnd),
    preserved: true,
    reason: 'uniquely-anchored-text-change'
  }
}

// Source represents an empty rich paragraph as an empty authored row while
// canonical uses `<br />`. Their visible streams are equal, but every offset
// at that zero-width row has two valid raw affinities. A later ordinary edit
// can therefore map to the heading/paragraph before the empty row and glue
// blocks together. When source/previous/next retain the same row skeleton and
// the edit stays inside one row, row ordinal is the stronger identity.
export const preserveOrdinalLineTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceLines = markdownLines(source)
  const previousLines = markdownLines(previous)
  const nextLines = markdownLines(next)
  if (
    sourceLines.length !== previousLines.length ||
    previousLines.length !== nextLines.length
  ) {
    return null
  }
  const hasEmptyPlaceholderDivergence = previousLines.some((line, index) => (
    /^\s*(?:>\s*)*<br\s*\/?>\s*$/i.test(line.text) &&
    !sourceLines[index]?.text.trim()
  ))
  if (!hasEmptyPlaceholderDivergence) return null

  const previousStartLine = lineAt(previous, start)
  const previousEndLine = lineAt(previous, Math.max(start, previousEnd - 1))
  const nextStartLine = lineAt(next, start)
  const nextEndLine = lineAt(next, Math.max(start, nextEnd - 1))
  if (
    previousStartLine.start !== previousEndLine.start ||
    nextStartLine.start !== nextEndLine.start
  ) {
    return null
  }

  const row = previousLines.findIndex((line) => (
    line.start === previousStartLine.start && line.end === previousStartLine.end
  ))
  if (row < 0 || nextLines[row]?.start !== nextStartLine.start) return null
  const sourceLine = sourceLines[row]
  const previousLine = previousLines[row]
  const nextLine = nextLines[row]
  if (
    sourceVisibleIndex(sourceLine.text).text !==
    sourceVisibleIndex(previousLine.text).text
  ) {
    return null
  }

  const replacement = sourceLine.text === previousLine.text
    ? canonicalFreshTextToSource(nextLine.text)
    : adaptCanonicalRegionToSource(nextLine.text, source, sourceLine)
  return {
    markdown: source.slice(0, sourceLine.start) + replacement + source.slice(sourceLine.end),
    preserved: true,
    reason: 'ordinal-line-text-change'
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

const nonBlankBlockSpans = (markdown) => {
  const lines = markdownLines(markdown)
  const spans = []
  let first = -1
  const push = (last) => {
    if (first < 0 || last < first) return
    spans.push({ start: lines[first].start, end: lines[last].end })
    first = -1
  }
  lines.forEach((line, index) => {
    if (/^\s*$/.test(line.text)) {
      push(index - 1)
      return
    }
    if (first < 0) first = index
  })
  push(lines.length - 1)
  return spans
}

// When the visible streams diverge (source and canonical disagree about how
// the authored bytes map to blocks — a mid-line `* ` that remark parses as a
// list item while the author kept it as paragraph text), both
// preserveLocallyAlignedTextChange and preserveChangedLineRegion fail and the
// façade would roll the edit back: a rich-text deletion never reaches the
// source. If the user's edit is confined to a single canonical block and that
// block can be mapped one-to-one to an authored source block, apply the
// block-level delta directly to the source spelling. Equal-count repeated
// blocks map by ordinal; merged/split or otherwise ambiguous blocks stay
// untouched (fail closed).
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

  // Prefer a one-to-one block occurrence mapping over a whole-document
  // substring search. Short paragraph text such as “测试” can occur inside
  // headings, list items, and quotes many times while the standalone block is
  // still unambiguous. Repeated standalone blocks are also safe when source
  // and canonical contain the same number of equivalent blocks: their ordinal
  // identity survives unrelated serializer divergence elsewhere. If remark
  // merged/split one of those blocks, the counts differ and this path refuses
  // to guess; the stricter legacy unique-substring fallback remains below.
  const blockKey = (value) => unescapeCanonicalBlock(value)
    .replace(/\r\n|\r/g, '\n')
  const targetKey = blockKey(previousText)
  const previousMatches = nonBlankBlockSpans(previous)
    .filter((block) => blockKey(previous.slice(block.start, block.end)) === targetKey)
  const targetOrdinal = previousMatches.findIndex((block) => (
    block.start === previousBlock.start && block.end === previousBlock.end
  ))
  const sourceMatches = nonBlankBlockSpans(source)
    .filter((block) => blockKey(source.slice(block.start, block.end)) === targetKey)
  if (
    targetOrdinal >= 0 &&
    previousMatches.length > 0 &&
    sourceMatches.length === previousMatches.length
  ) {
    const sourceBlock = sourceMatches[targetOrdinal]
    first = sourceBlock.start
    matched = source.slice(sourceBlock.start, sourceBlock.end)
  }

  for (const candidate of candidates) {
    if (first >= 0) break
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
  // A zero-width change on a line boundary (an empty trailing line or a blank
  // separator between blocks) maps ambiguously: the visible-index fallback
  // pulls the region into the previous line and glues a newly inserted block
  // (list/quote/heading) onto it. When the change is a pure insertion at an
  // authored empty line, the source region is exactly that empty line.
  if (
    sourceRegion &&
    previousRegion.start === previousRegion.end &&
    (previousRegion.start === previous.length ||
      lineAt(previous, previousRegion.start).start === previousRegion.start)
  ) {
    const boundary = lineAt(source, Math.min(previousRegion.start, source.length))
    if (boundary.start === previousRegion.start || previousRegion.start >= source.length) {
      sourceRegion = { start: previousRegion.start, end: previousRegion.start }
    }
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

// Deeply diverged documents (unclosed backticks, escaped markers, zero-width
// sentinels) fail every full-document visible-stream mapper. Typing at the
// document end in such a file frequently folds the typed block into the
// canonical final line (an input rule merges a typed `1. ` with a trailing
// authored `2` paragraph into `21. …`, then list rows continue), while the
// authored source still ends with that plain line.
//
// When the whole change lives in the final canonical block, the authored
// source's final line has the same inline text as the canonical pre-edit line
// (spelling may differ in backtick runs), and the canonical post-edit final
// line starts with that pre-edit line, splice the typed continuation onto the
// authored line and append the remaining canonical rows verbatim. The user's
// bytes survive and a reopen renders the same content.
export const preserveDivergedTailBlockAppend = ({
  source,
  previous,
  next,
  start,
  nextEnd
}) => {
  // No hard `nextEnd`-to-end guard here: commonChange's shared suffix can
  // legitimately include a closing fence row (a ` ``` ` -> ` ```` ` extension
  // shares the trailing three ticks), so `nextEnd` may sit well before the end
  // of a genuinely tail edit. The anchor checks below (start must fall on or
  // after the last visible line) are the strict tail-only gate.
  if (previous.slice(0, start) !== next.slice(0, start)) return null
  const stripBacktickSpans = (value) => value.replace(/`+([^`]+)`+/g, '$1')
  // Compare the final non-empty line of the canonical pre-edit document with
  // the authored source's final non-empty line (spelling may differ in
  // backtick runs). Canonical often carries a trailing blank line that the
  // authored source does not.
  const lastVisibleLine = (value, offset = 0) => {
    const body = value.replace(/\r?\n$/, '')
    const lines = body.split('\n')
    let skipped = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const text = lines[index]
      // Empty list items (`23. <br />` in canonical, `- ` in authored source)
      // carry no visible text but are still the anchor a continuation fills.
      // Only pure blank lines and standalone `<br />` placeholders are skipped.
      const content = text.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s*(?:\[[ xX]\]\s*)?/, '')
      const isBrPlaceholder = !/^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(text) &&
        /^<br\s*\/?>\s*$/.test(content.trim())
      if (
        (content.trim() && !isBrPlaceholder) ||
        /^\s*(?:[-+*]|\d{1,9}[.)])\s*$/.test(text)
      ) {
        if (skipped < offset) {
          skipped += 1
          continue
        }
        let start = 0
        for (let before = 0; before < index; before += 1) start += lines[before].length + 1
        return { text, start }
      }
    }
    return null
  }
  // A complete paired fence block: the first non-empty line opens a fence
  // (optionally with an info string), the last non-empty line is a bare
  // closing fence of the same character run, and no inner line can close it
  // early. Blank lines inside the fence are legal content.
  const isCompleteFenceBlock = (value) => {
    const body = String(value || '').replace(/\r?\n$/, '')
    const lines = body.split('\n').filter((line) => line.trim() !== '')
    if (lines.length < 2) return false
    const open = lines[0].match(/^\s*(`{3,}|~{3,})/)
    if (!open) return false
    const close = lines[lines.length - 1].match(/^\s*(`{3,}|~{3,})\s*$/)
    if (!close || close[1][0] !== open[1][0] || close[1].length < open[1].length) return false
    for (let index = 1; index < lines.length - 1; index += 1) {
      const inner = lines[index].match(/^\s*(`{3,}|~{3,})\s*$/)
      if (inner && inner[1][0] === open[1][0] && inner[1].length >= open[1].length) return false
    }
    return true
  }
  let previousAnchor = lastVisibleLine(previous)
  let sourceAnchor = lastVisibleLine(source)
  let previousLine = previousAnchor?.text
  let sourceLine = sourceAnchor?.text
  if (!previousLine || !sourceLine || !previousAnchor || !sourceAnchor) return null
  // List markers are semantically interchangeable (`-`/`+`/`*` bullets,
  // `1.`/`1)` ordered). Diverged documents frequently spell the same row
  // differently in source vs canonical; the tail anchor must treat those as
  // equal or the precise tail mapper gives up and a line-region mapper glues
  // the typed row onto the previous authored line.
  const markerNormalized = (line) => String(line || '')
    .replace(/^(\s*)[-+*](?=\s)/, (match, ws) => `${ws}*`)
    .replace(/^(\s*)(\d{1,9})[.)](?=\s)/, (match, ws, num) => `${ws}${num}.`)
    .replace(/&#x20;/g, ' ')
    .replace(/\u200B/g, '')
  const equivalentLine = (left, right) =>
    markerNormalized(stripBacktickSpans(left.trimEnd())) ===
    markerNormalized(stripBacktickSpans(right.trimEnd()))
  // A file whose authored tail is a lone fence line (` ``` `) keeps that line
  // as literal text in canonical (`\`\`\``). Hand-typing a code block after
  // it makes the input rule absorb the canonical literal into a real fenced
  // block, so the canonical tail anchor (`\`\`\``) no longer exists. The
  // authored lone fence line becomes the block's opening fence; fall back to
  // the previous visible line and let the fresh-row path reuse the authored
  // fence line below.
  // Canonical escapes a lone literal fence line per backtick (`\`` + `\`` +
  // `\``), so the literal is `\`\`\``, not one backslash before three ticks.
  const escapedFenceLiteral = (line) => /^\s*(?:\\`){3}\s*$/.test(String(line || ''))
  const loneFenceLine = (line) => /^\s*(?:`{3,}|~{3,})\s*$/.test(String(line || ''))
  const nextTailStartsFence = (() => {
    const tail = String(next || '').replace(/\r?\n$/, '')
    const tailLines = tail.split('\n')
    for (let index = tailLines.length - 1; index >= 0; index -= 1) {
      const text = tailLines[index].trim()
      if (text) return /^(?:`{3,}|~{3,})/.test(text)
    }
    return false
  })()
  if (
    !equivalentLine(sourceLine, previousLine) &&
    escapedFenceLiteral(previousLine) &&
    loneFenceLine(sourceLine) &&
    nextTailStartsFence
  ) {
    const fallbackPrevious = lastVisibleLine(previous, 1)
    const fallbackSource = lastVisibleLine(source, 1)
    if (
      fallbackPrevious &&
      fallbackSource &&
      equivalentLine(fallbackSource.text, fallbackPrevious.text)
    ) {
      previousAnchor = fallbackPrevious
      sourceAnchor = fallbackSource
      previousLine = fallbackPrevious.text
      sourceLine = fallbackSource.text
    }
  }
  if (!equivalentLine(sourceLine, previousLine)) return null
  const previousLineStart = previousAnchor.start
  // The canonical line at the change start continues the pre-edit line
  // (an input rule may fold the typed marker into it: `2` + `1. …` = `21. …`).
  const nextLineStart = next.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextLineEnd = next.indexOf('\n', start)
  const nextLineAtStart = nextLineEnd < 0
    ? next.slice(nextLineStart)
    : next.slice(nextLineStart, nextLineEnd)
  const foldCase = start >= previousLineStart &&
    markerNormalized(nextLineAtStart).startsWith(markerNormalized(previousLine)) &&
    nextLineAtStart.length > previousLine.length
  const freshRowCase = start > previousLineStart + previousLine.length &&
    !nextLineAtStart.startsWith(previousLine)
  // The canonical final line itself was deleted (a trailing list row or a
  // typed paragraph). The authored source must drop its matching final line.
  const previousLineCount = previous.split('\n').filter((line) => line === previousLine).length
  const nextLineCount = next.split('\n').filter((line) => line === previousLine).length
  const nextTailLine = lastVisibleLine(next)?.text
  const deleteCase = start >= previousLineStart &&
    nextLineCount < previousLineCount &&
    nextLineCount === 0 &&
    // A deleted trailing row leaves the previous authored row as canonical's
    // new final line. A *replaced* row (`\`` -> `` `f` ``) changes spelling
    // instead, and must go through the fold path, not deletion.
    !!nextTailLine &&
    (
      nextTailLine.trim() === '' ||
      previous.split('\n').some((line) => equivalentLine(line, nextTailLine))
    )
  // Fence extension: the user types a fence row inside a tail fenced block, so
  // Crepe re-fences the whole block with a longer run (` ``` ` -> ` ```` `) and
  // the typed row becomes content. previous and next share the opening fence
  // position; only the fence lengths and content rows differ. Replacing the
  // authored tail fence segment with canonical's is byte-safe here because the
  // content rows are proven visible-equal and canonicalFreshTextToSource keeps
  // fence-interior rows verbatim.
  const lastFenceSegment = (value) => {
    const body = String(value || '').replace(/\r?\n$/, '')
    const lines = body.split('\n')
    let fence = null
    let openIndex = -1
    let openStart = -1
    let openLen = 0
    let last = null
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]
      if (fence) {
        const close = text.match(/^\s*(`{3,}|~{3,})\s*$/)
        if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
          let closeStart = 0
          for (let before = 0; before < index; before += 1) closeStart += lines[before].length + 1
          last = {
            openStart,
            openLen,
            openEnd: openStart + lines[openIndex].length,
            closeStart,
            closeEnd: closeStart + text.length
          }
          fence = null
          openIndex = -1
        }
      } else {
        const open = text.match(/^\s*(`{3,}|~{3,})/)
        if (open) {
          fence = { char: open[1][0], length: open[1].length }
          openIndex = index
          let startOffset = 0
          for (let before = 0; before < index; before += 1) startOffset += lines[before].length + 1
          openStart = startOffset
          openLen = open[1].length
        }
      }
    }
    return last
  }
  const prevSeg = lastFenceSegment(previous)
  const nextSeg = lastFenceSegment(next)
  if (
    prevSeg &&
    nextSeg &&
    start >= prevSeg.openStart &&
    start <= prevSeg.openEnd &&
    nextSeg.openLen > prevSeg.openLen &&
    nextSeg.openStart === prevSeg.openStart
  ) {
    const srcSeg = lastFenceSegment(source)
    if (srcSeg) {
      const prevContent = previous.slice(prevSeg.openEnd, prevSeg.closeStart)
      const srcContent = source.slice(srcSeg.openEnd, srcSeg.closeStart)
      if (sourceVisibleIndex(srcContent).text === sourceVisibleIndex(prevContent).text) {
        const nextSegment = next.slice(nextSeg.openStart, nextSeg.closeEnd)
        return {
          markdown: source.slice(0, srcSeg.openStart) +
            canonicalFreshTextToSource(nextSegment) +
            source.slice(srcSeg.closeEnd),
          preserved: true,
          reason: 'diverged-tail-fence-extend'
        }
      }
    }
  }
  let continuation = ''
  let remaining = ''
  let keepTailBreaks = false
  let fenceBlockCase = false
  if (foldCase) {
    continuation = nextLineAtStart.slice(previousLine.length)
    if (!continuation || /[\r\n]/.test(continuation)) return null
    remaining = nextLineEnd < 0 ? '' : next.slice(nextLineEnd)
  } else if (freshRowCase) {
    // Typing inside an existing tail fenced block: canonical grows content
    // rows between a paired open/close fence. The last visible line is the
    // CLOSING fence, so anchoring there would drop the new content rows.
    // Anchor on the opening fence (previous second-to-last visible line),
    // reuse the authored open AND close fence lines and insert only the new
    // canonical content rows between them.
    const prevLastLine = lastVisibleLine(previous)
    const prevSecondLastLine = lastVisibleLine(previous, 1)
    // A tail EMPTY fence pair (opening line directly followed by the closing
    // line) is the only safe "typing inside a new tail code block" anchor. A
    // non-empty block whose content happens to end with a fence-like row must
    // not be treated as an empty pair, so validate with a fence state machine
    // instead of pattern-matching the last two visible lines.
    const tailEmptyFencePair = (value) => {
      const body = String(value || '').replace(/\r?\n$/, '')
      const lines = body.split('\n')
      let fence = null
      let openIndex = -1
      let pairOpen = -1
      let pairClose = -1
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]
        if (fence) {
          const close = text.match(/^\s*(`{3,}|~{3,})\s*$/)
          if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
            if (openIndex === index - 1) {
              pairOpen = openIndex
              pairClose = index
            }
            fence = null
            openIndex = -1
          }
        } else {
          const open = text.match(/^\s*(`{3,}|~{3,})/)
          if (open) {
            fence = { char: open[1][0], length: open[1].length }
            openIndex = index
          }
        }
      }
      return pairOpen >= 0 ? { openIndex: pairOpen, closeIndex: pairClose } : null
    }
    const prevTailPair = tailEmptyFencePair(previous)
    const prevTailIsPairedFence = !!prevTailPair && !!prevLastLine && !!prevSecondLastLine &&
      /^\s*(?:`{3,}|~{3,})\s*$/.test(prevLastLine.text) &&
      /^\s*(?:`{3,}|~{3,})\s*$/.test(prevSecondLastLine.text)
    if (prevTailIsPairedFence) {
      const srcLastLine = lastVisibleLine(source)
      const srcSecondLastLine = lastVisibleLine(source, 1)
      const srcTailPair = tailEmptyFencePair(source)
      if (
        !srcTailPair || !srcLastLine || !srcSecondLastLine ||
        !/^\s*(?:`{3,}|~{3,})\s*$/.test(srcLastLine.text) ||
        !/^\s*(?:`{3,}|~{3,})\s*$/.test(srcSecondLastLine.text)
      ) {
        return null
      }
      const sourceFenceOpenStart = srcSecondLastLine.start
      const sourceFenceOpenText = srcSecondLastLine.text
      // The canonical opening fence shares the previous raw offset (the common
      // prefix includes it; the delta starts after it).
      let fenceOpenEnd = next.indexOf('\n', prevSecondLastLine.start)
      if (fenceOpenEnd < 0) fenceOpenEnd = next.length
      remaining = next.slice(fenceOpenEnd)
      // Keep the authored closing fence; strip canonical's closing fence line
      // and its terminal padding from the appended content rows.
      const parts = remaining.split('\n')
      let lastNonEmpty = -1
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index].trim()) {
          lastNonEmpty = index
          break
        }
      }
      if (lastNonEmpty < 0) return null
      let closeStart = 0
      for (let before = 0; before < lastNonEmpty; before += 1) {
        closeStart += parts[before].length + 1
      }
      const contentRows = remaining.slice(0, closeStart).replace(/^\n+/, '')
      if (!/\S/.test(String(contentRows).replace(/<br\s*\/?>/gi, ''))) return null
      if (/^\s*<br\s*\/?>\s*$/m.test(contentRows)) return null
      const sourceTail = source.slice(sourceFenceOpenStart + sourceFenceOpenText.length)
      return {
        markdown: source.slice(0, sourceFenceOpenStart) + sourceFenceOpenText +
          '\n' + canonicalFreshTextToSource(contentRows) +
          sourceTail.replace(/^\n/, ''),
        preserved: true,
        reason: 'diverged-tail-fence-content'
      }
    }
    // Everything after the anchor line in canonical (empty items, blanks and
    // the newly typed rows) is appended verbatim after the authored anchor.
    const nextLines = next.split('\n')
    let anchorInNext = -1
    for (let index = nextLines.length - 1; index >= 0; index -= 1) {
      if (equivalentLine(nextLines[index], previousLine)) {
        let offset = 0
        for (let before = 0; before < index; before += 1) offset += nextLines[before].length + 1
        anchorInNext = offset + nextLines[index].length
        break
      }
    }
    if (anchorInNext < 0) return null
    remaining = next.slice(anchorInNext)
    // A hand-typed fenced code block serializes as an opening fence, content
    // rows and a closing fence. Complete paired fences are self-contained tail
    // blocks; the structural guard below must not refuse them. When the
    // authored tail already ends with a lone fence line (a leftover unclosed
    // fence), that line becomes the block's opening fence and canonical's
    // opening line is skipped so the authored file does not gain a duplicate.
    fenceBlockCase = isCompleteFenceBlock(remaining)
    if (fenceBlockCase) {
      const sourceTrailFirstLine = source.slice(sourceAnchor.start + sourceLine.length)
        .split('\n').find((line) => line.trim() !== '')
      if (sourceTrailFirstLine && /^\s*(?:`{3,}|~{3,})/.test(sourceTrailFirstLine)) {
        const parts = remaining.split('\n')
        const firstNonEmpty = parts.findIndex((line) => line.trim() !== '')
        if (firstNonEmpty >= 0 && /^\s*(?:`{3,}|~{3,})/.test(parts[firstNonEmpty])) {
          parts.splice(firstNonEmpty, 1)
          remaining = parts.join('\n')
        }
      }
    }
    // Enter inside an authored list continues the same list. Canonical may
    // serialize the new row with Crepe's default marker and a loose blank
    // line (`* 第二项` after `- 第一项`). On diverged documents the list
    // mappers cannot align the continuation, so this tail mapper restores
    // the authored marker and compact spacing itself. Genuinely new
    // nested/outer blocks (different indentation or list type) keep their
    // canonical spelling.
    const authoredMarker = sourceLine.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
    const firstRemaining = remaining.split('\n').find((line) => line.trim())
    // A brand-new list created from a plain paragraph/heading is owned by the
    // input-rule intent mapper, which restores the typed marker (`-` instead
    // of Crepe's `*`). The tail mapper only owns continuations and genuinely
    // new blocks that follow an existing authored list row.
    if (
      !/^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(previousLine) &&
      /^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(firstRemaining || '')
    ) {
      return null
    }
    const firstIndent = firstRemaining?.match(/^\s*/)?.[0] || ''
    const firstMarker = firstRemaining?.trim().match(/^(?:[-+*]|\d{1,9}[.)])/)?.[0] || ''
    const sameListType = /^\d/.test(authoredMarker?.[2] || '') === /^\d/.test(firstMarker)
    const continuedSameList = !!(authoredMarker &&
      firstRemaining &&
      firstIndent === authoredMarker[1] &&
      sameListType &&
      /^[-+*]|\d{1,9}[.)]/.test(firstRemaining.trim()))
    if (continuedSameList) {
      keepTailBreaks = true
      const authoredToken = authoredMarker[2]
      // On diverged documents the list/input-rule mappers cannot align a
      // same-list continuation, so restore the authored marker and compact
      // spacing here. (Clean documents never reach this branch — it only runs
      // inside the diverged visible-stream path.)
      remaining = remaining.replace(/^\n+/, '\n')
      if (/^\d/.test(authoredToken)) {
        remaining = remaining.replace(/^(\s*\d{1,9})[.)](?=\s)/, `$1${authoredToken.slice(-1)}`)
      } else {
        remaining = remaining.replace(/^(\s*)[-+*](?=\s)/, `$1${authoredToken}`)
      }
    } else {
      // The authored final line may carry trailing blank lines (authored
      // spacing between blocks). Preserve them before the appended rows; a
      // Markdown block boundary needs at least two line endings, so top up
      // when the authored tail has fewer (without inventing trailing blank
      // lines after the appended content — the facade caps that separately).
      const sourceTailBreaks = source.slice(sourceAnchor.start + sourceLine.length)
      const breakCount = (sourceTailBreaks.match(/\n/g) || []).length
      remaining = sourceTailBreaks +
        '\n'.repeat(Math.max(0, 2 - breakCount)) +
        remaining.replace(/^\n+/, '')
    }
    // A canonical tail that only grew blank lines (Enter inside an empty
    // trailing block) has no authored content to append; the empty-block
    // mappers own that transition and must not be bypassed.
    // A canonical tail that only grew blank lines or `<br />` placeholders
    // (held Space, Enter inside an empty trailing block) has no authored
    // content to append; the empty-block mappers own those transitions.
    if (!/\S/.test(String(remaining).replace(/<br\s*\/?>/gi, ''))) return null
    // A `<br />` placeholder embedded in the appended rows (held-space and
    // empty-block transitions) belongs to the dedicated empty/leading-space
    // mappers, which know how to collapse it; never append it verbatim.
    if (/^\s*<br\s*\/?>\s*$/m.test(remaining)) return null
  } else if (deleteCase) {
    const tailBreaks = source.slice(sourceAnchor.start + sourceLine.length)
    // Deleting a leading-space paragraph down to its bare whitespace leaves a
    // blank canonical row (` `); the authored row must shrink to that blank
    // rather than keep the deleted content.
    const blankTail = nextTailLine.trim() === '' ? nextTailLine : ''
    return {
      markdown: source.slice(0, sourceAnchor.start) + blankTail + tailBreaks,
      preserved: true,
      reason: 'diverged-tail-line-delete'
    }
  } else {
    return null
  }
  // Remaining canonical rows must stay plain/list rows; headings and quotes
  // change block structure and are refused. Complete paired fenced blocks
  // were structurally validated above and are the only structural exception.
  if (!fenceBlockCase) {
    // A foldCase fence extension (typing `` ` `` after a ` ``` ` closing row
    // re-fences the block: ` ``` ` -> ` ```` `) leaves the remaining rows as a
    // complete paired fence too. Validate the spliced result structurally
    // instead of refusing the fence rows outright.
    const fenceFoldCase = foldCase && continuation &&
      isCompleteFenceBlock(sourceLine + continuation + remaining)
    if (!fenceFoldCase) {
      for (const line of remaining.split('\n')) {
        if (/^\s*(```|~~~|#{1,6}\s|>)/.test(line)) return null
      }
    }
  }
  // Splice the continuation onto the authored final line, then append the
  // remaining canonical rows.
  const prefix = source.slice(0, sourceAnchor.start)
  // Canonical rows are appended verbatim structurally, but serializer escapes
  // (`\~`, `&#x20;`, leading-space entities) must be translated back to the
  // authored spelling through the same context-aware path every other
  // canonical write uses.
  const normalizedRemaining = keepTailBreaks
    ? remaining
    : remaining.replace(
        /(?:\r?\n)+$/,
        /(?:\r?\n)$/.test(source) ? '\n' : ''
      )
  return {
    markdown: prefix + sourceLine +
      canonicalFreshTextToSource(continuation) +
      canonicalFreshTextToSource(normalizedRemaining),
    preserved: true,
    reason: 'diverged-tail-block-append'
  }
}
