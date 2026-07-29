import {
  sourceRawFromVisibleIndex
} from '../../mode-visible-map.js'

export const commonChange = (previous, next) => {
  let start = 0
  const min = Math.min(previous.length, next.length)
  while (start < min && previous[start] === next[start]) start++

  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--
    nextEnd--
  }
  return { start, previousEnd, nextEnd }
}

export const rawOffsetAtVisible = (markdown, position) =>
  sourceRawFromVisibleIndex(markdown, position.visibleIndex, position.visibleAffinity)

export const lineAt = (markdown, offset) => {
  const safe = Math.max(0, Math.min(offset, markdown.length))
  const start = markdown.lastIndexOf('\n', Math.max(0, safe - 1)) + 1
  const next = markdown.indexOf('\n', safe)
  return { start, end: next < 0 ? markdown.length : next }
}

export const rawInsertionAtCanonicalLineEnd = ({
  source,
  previous,
  canonicalOffset,
  mappedSourceOffset,
  sourceVisibleMap
}) => {
  const previousLine = lineAt(previous, canonicalOffset)
  if (canonicalOffset !== previousLine.end) return null

  const sourceLine = lineAt(source, mappedSourceOffset)
  const hiddenTail = source.slice(mappedSourceOffset, sourceLine.end)
  let low = 0
  let high = sourceVisibleMap.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sourceVisibleMap[middle] < mappedSourceOffset) low = middle + 1
    else high = middle
  }
  if (sourceVisibleMap[low] < sourceLine.end) return null

  // Inline closers (``, **, ~~ and closing HTML) are not part of the visible
  // stream. At a line end the generic backward mapping lands before them.
  // Advance past syntax, but stay before authored hard-break whitespace.
  const trailingWhitespace = hiddenTail.match(/[ \t]*$/)?.[0] || ''
  return sourceLine.end - trailingWhitespace.length
}

export const lineEndingNear = (markdown, offset = 0) => {
  const next = markdown.indexOf('\n', Math.max(0, offset))
  if (next >= 0) return markdown[next - 1] === '\r' ? '\r\n' : '\n'
  const previous = markdown.lastIndexOf('\n', Math.max(0, offset - 1))
  if (previous >= 0) return markdown[previous - 1] === '\r' ? '\r\n' : '\n'
  return markdown.includes('\r\n') ? '\r\n' : '\n'
}

export const adaptCanonicalRegionToSource = (replacement, source, region) => {
  const eol = lineEndingNear(source, region.start)
  let adapted = String(replacement || '').replace(/\r\n?|\n/g, eol)
  const sourceRegion = source.slice(region.start, region.end)
  if (region.start === 0 && source.startsWith('\uFEFF') && !adapted.startsWith('\uFEFF')) {
    adapted = '\uFEFF' + adapted
  }
  if (
    sourceRegion.endsWith('\r') &&
    source[region.end] === '\n' &&
    !adapted.endsWith('\r')
  ) {
    adapted += '\r'
  }
  return adapted
}

export const isTableLine = (line) => line.includes('|')

export const listMarker = (line) => line.match(/^(\s*)(?:[-+*]|\d{1,9}[.)])\s+/)

export const markdownLines = (markdown) => {
  const lines = []
  let start = 0
  while (start <= markdown.length) {
    const next = markdown.indexOf('\n', start)
    const end = next < 0 ? markdown.length : next
    lines.push({ start, end, text: markdown.slice(start, end) })
    if (next < 0) break
    start = next + 1
  }
  return lines
}

export const lineIndexAt = (lines, offset) => {
  const safe = Math.max(0, offset)
  return lines.findIndex((line) => safe >= line.start && safe <= line.end)
}
