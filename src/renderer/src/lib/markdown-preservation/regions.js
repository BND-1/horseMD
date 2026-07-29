import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  lineAt,
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
