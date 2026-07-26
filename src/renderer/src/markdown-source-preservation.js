import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from './mode-visible-map.js'

const commonChange = (previous, next) => {
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

const rawOffsetAtVisible = (markdown, position) =>
  sourceRawFromVisibleIndex(markdown, position.visibleIndex, position.visibleAffinity)

const lineAt = (markdown, offset) => {
  const safe = Math.max(0, Math.min(offset, markdown.length))
  const start = markdown.lastIndexOf('\n', Math.max(0, safe - 1)) + 1
  const next = markdown.indexOf('\n', safe)
  return { start, end: next < 0 ? markdown.length : next }
}

const isTableLine = (line) => line.includes('|')

const isTableSeparatorLine = (line) => {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

const listMarker = (line) => line.match(/^(\s*)(?:[-+*]|\d{1,9}[.)])\s+/)

const markdownLines = (markdown) => {
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

const lineIndexAt = (lines, offset) => {
  const safe = Math.max(0, offset)
  return lines.findIndex((line) => safe >= line.start && safe <= line.end)
}

// A YAML frontmatter block is an atom in ProseMirror, so changing its attrs
// has no visible-text delta for the generic source-preservation path. Locate
// the exact fenced block by its mapped raw offset and replace only that block.
// This keeps every unrelated paragraph/list spelling intact.
const frontmatterBlockAt = (markdown, offset) => {
  const lines = markdownLines(markdown)
  const index = lineIndexAt(lines, offset)
  if (index < 0) return null
  for (let startIndex = 0; startIndex < lines.length; startIndex++) {
    if (lines[startIndex].text.trim() !== '---') continue
    for (let endIndex = startIndex + 1; endIndex < lines.length; endIndex++) {
      if (lines[endIndex].text.trim() !== '---') continue
      if (index >= startIndex && index <= endIndex) {
        return { start: lines[startIndex].start, end: lines[endIndex].end }
      }
      break
    }
  }
  return null
}

export function replaceMarkdownFrontmatterBlock({ source, next, sourceOffset, nextOffset }) {
  const rawSource = String(source || '')
  const rawNext = String(next || '')
  const sourceBlock = frontmatterBlockAt(rawSource, sourceOffset)
  const nextBlock = frontmatterBlockAt(rawNext, nextOffset)
  if (!sourceBlock || !nextBlock) return null
  return rawSource.slice(0, sourceBlock.start) + rawNext.slice(nextBlock.start, nextBlock.end) + rawSource.slice(sourceBlock.end)
}

// Find the syntactic list tree around an offset without parsing the entire
// Markdown again. Blank lines are retained only when they sit between members
// of the same list, so a preceding paragraph's separator is never replaced.
const listBlockAt = (markdown, offset) => {
  const lines = markdownLines(markdown)
  let index = lineIndexAt(lines, offset)
  if (index < 0) return null

  let markerIndex = -1
  for (let current = index; current >= 0; current--) {
    if (listMarker(lines[current].text)) {
      markerIndex = current
      break
    }
    if (lines[current].text.trim() && !/^\s+/.test(lines[current].text)) return null
  }
  if (markerIndex < 0) return null

  const baseIndent = listMarker(lines[markerIndex].text)[1].length
  const belongsToList = (line) => {
    if (!line.text.trim()) return false
    const marker = listMarker(line.text)
    const indent = line.text.match(/^\s*/)[0].length
    return (marker && indent >= baseIndent) || (!marker && indent > baseIndent)
  }

  let startIndex = markerIndex
  let pendingBlankStart = null
  for (let current = markerIndex - 1; current >= 0; current--) {
    if (!lines[current].text.trim()) {
      pendingBlankStart = current
      continue
    }
    if (!belongsToList(lines[current])) break
    startIndex = pendingBlankStart ?? current
    pendingBlankStart = null
  }

  let endIndex = markerIndex
  let pendingBlankEnd = null
  for (let current = markerIndex + 1; current < lines.length; current++) {
    if (!lines[current].text.trim()) {
      pendingBlankEnd = current
      continue
    }
    if (!belongsToList(lines[current])) break
    endIndex = current
    if (pendingBlankEnd !== null) endIndex = current
    pendingBlankEnd = null
  }

  return {
    start: lines[startIndex].start,
    end: lines[endIndex].end,
    indent: baseIndent
  }
}

// List conversion already knows the exact ProseMirror list position before and
// after its transaction. Use those raw offsets to replace only that list tree;
// unlike a whole-document diff this remains correct when nested list indentation
// differs between the user's Markdown and Crepe's serializer.
export function replaceMarkdownListBlock({
  source,
  next,
  sourceOffset,
  nextOffset,
  previous,
  previousOffset
}) {
  const rawSource = String(source || '')
  const rawNext = String(next || '')
  const sourceList = listBlockAt(rawSource, sourceOffset)
  const nextList = listBlockAt(rawNext, nextOffset)
  if (!sourceList || !nextList) return null
  if (previous && Number.isFinite(previousOffset)) {
    const previousList = listBlockAt(String(previous), previousOffset)
    if (!previousList) return null
    const sourceText = comparableListText(rawSource.slice(sourceList.start, sourceList.end))
    const previousText = comparableListText(String(previous).slice(previousList.start, previousList.end))
    if (!sourceText || sourceText !== previousText) return null
  }
  return rawSource.slice(0, sourceList.start) + rawNext.slice(nextList.start, nextList.end) + rawSource.slice(sourceList.end)
}

const comparableListText = (markdown) => markdown
  .split('\n')
  .map((line) => line.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/, '').trim())
  .filter(Boolean)
  .join('\n')

const preserveListTypeChange = ({ source, previous, next, start, previousEnd, nextEnd }) => {
  const previousList = listBlockAt(previous, start)
  const nextList = listBlockAt(next, start)
  if (!previousList || !nextList) return null
  // A nested list can be represented by different indentation widths before
  // and after serialization. Its raw position cannot be proven safely from a
  // visible offset, so use the canonical fallback rather than risk splicing
  // into the parent item. Top-level list blocks retain a stable raw boundary.
  if (previousList.indent > 0 || nextList.indent > 0) return null
  if (start < previousList.start || previousEnd > previousList.end) return null
  if (start < nextList.start || nextEnd > nextList.end) return null

  const listStart = sourceVisiblePositionAtRaw(previous, previousList.start)
  // A list marker itself has no visible character. Use forward affinity to
  // land inside the first item rather than on the newline before the list.
  const rawInsideSource = sourceRawFromVisibleIndex(source, listStart.visibleIndex, 'forward')
  const sourceList = listBlockAt(source, rawInsideSource)
  if (!sourceList) return null

  // Three-or-more-level lists can have a different raw indentation strategy in
  // user Markdown and Crepe's serializer. The global visible stream is then
  // deliberately conservative and reports a mismatch. Compare only this list
  // tree after removing list syntax: it still rejects duplicate/wrong blocks
  // while allowing the bounded replacement promised by list conversion.
  const sourceListText = comparableListText(source.slice(sourceList.start, sourceList.end))
  const previousListText = comparableListText(previous.slice(previousList.start, previousList.end))
  if (!sourceListText || sourceListText !== previousListText) return null

  return {
    markdown: source.slice(0, sourceList.start) + next.slice(nextList.start, nextList.end) + source.slice(sourceList.end),
    preserved: true,
    reason: 'list-type-change'
  }
}

const hasListTypeChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousList = listBlockAt(previous, start)
  const nextList = listBlockAt(next, start)
  if (!previousList || !nextList) return false
  return start >= previousList.start && previousEnd <= previousList.end &&
    start >= nextList.start && nextEnd <= nextList.end
}

// Rich-text table operations add/remove complete rows or columns. Treating
// those changes as a character diff can splice a new row into the preceding
// cell, because pipe and newline syntax has no visible-text counterpart.
const tableBlockAt = (markdown, offset) => {
  let current = lineAt(markdown, offset)
  let line = markdown.slice(current.start, current.end)
  if (!isTableLine(line) && current.start > 0) {
    current = lineAt(markdown, current.start - 1)
    line = markdown.slice(current.start, current.end)
  }
  if (!isTableLine(line)) return null

  let start = current.start
  let end = current.end
  while (start > 0) {
    const previous = lineAt(markdown, start - 1)
    if (!isTableLine(markdown.slice(previous.start, previous.end))) break
    start = previous.start
  }
  while (end < markdown.length) {
    const next = lineAt(markdown, end + 1)
    if (!isTableLine(markdown.slice(next.start, next.end))) break
    end = next.end
  }
  const table = { start, end: end < markdown.length ? end + 1 : end }
  const lines = markdown.slice(table.start, table.end).trimEnd().split('\n')
  return lines.some(isTableSeparatorLine) ? table : null
}

const hasChangedTable = ({ previous, next, start, nextEnd }) => {
  const previousTable = tableBlockAt(previous, start)
  const nextTable = tableBlockAt(next, start) || tableBlockAt(next, nextEnd)
  // A brand-new table only exists on the next side of the diff. It is still a
  // structural change: treating it as ordinary visible text leaks Crepe's
  // empty-cell placeholders into the raw Markdown.
  return Boolean(previousTable || nextTable)
}

// Milkdown keeps a generated `<br />` in empty table cells so its Markdown
// serializer can retain the cell count. Once the complete table has been
// serialized, turn only a cell whose *sole* content is that marker back into
// normal GFM `| |` syntax. A real `text<br>text` line break is untouched.
const normalizeEmptyTableCells = (markdown) => {
  const lines = String(markdown || '').split('\n')
  let index = 0
  while (index < lines.length) {
    if (!isTableLine(lines[index])) {
      index++
      continue
    }
    const start = index
    while (index < lines.length && isTableLine(lines[index])) index++
    const block = lines.slice(start, index)
    if (!block.some(isTableSeparatorLine)) continue
    for (let line = start; line < index; line++) {
      lines[line] = lines[line].replace(/(^|\|)(\s*)<br\s*\/?>\s*(?=\||$)/gi, '$1$2')
    }
  }
  return lines.join('\n')
}

const canonicalResult = (markdown, reason) => ({
  // A newly inserted table has no matching table block in the previous
  // document, so it reaches one of the generic structural fallbacks below.
  // Normalize there as well: otherwise Crepe's empty-cell `<br />` placeholders
  // leak into the user's Markdown on the first save.
  markdown: normalizeEmptyTableCells(markdown),
  preserved: false,
  reason
})

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying the serializer's
// actual delta to the original Markdown, provided both snapshots still expose
// the same visible text stream. Structural-only edits fall back to serialization
// until they have dedicated block-level handling.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical) {
  const sourceMarkdown = String(source || '')
  const previous = String(previousCanonical || '')
  const next = String(nextCanonical || '')
  if (previous === next) return { markdown: sourceMarkdown, preserved: true, reason: 'unchanged' }
  if (!sourceMarkdown || !previous) return canonicalResult(next, 'missing-baseline')

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  if (sourceVisible.text !== previousVisible.text) {
    return canonicalResult(next, 'visible-stream-mismatch')
  }

  const { start, previousEnd, nextEnd } = commonChange(previous, next)
  if (hasChangedTable({
    previous,
    next,
    start,
    nextEnd
  })) {
    // Tables are structural Markdown. A partial raw-source splice can move
    // pipes/newlines into adjacent cells after repeated row/column edits, so
    // prefer Crepe's complete canonical document for every table mutation.
    return canonicalResult(next, 'table-canonical-change')
  }
  const listPreserved = preserveListTypeChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (listPreserved) return listPreserved
  if (hasListTypeChange({ previous, next, start, previousEnd, nextEnd })) {
    return canonicalResult(next, 'list-canonical-change')
  }
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text

  // A heading level, a list marker, or blank structure has no visible-text
  // span. Patching it by character position risks inserting syntax inside the
  // wrong raw construct, so retain the canonical result for now.
  if (startVisible.visibleIndex === endVisible.visibleIndex && !replacementVisible) {
    return canonicalResult(next, 'structural-change')
  }

  const rawStart = rawOffsetAtVisible(sourceMarkdown, startVisible)
  const rawEnd = rawOffsetAtVisible(sourceMarkdown, endVisible)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) {
    return canonicalResult(next, 'unmapped-change')
  }

  return {
    markdown: sourceMarkdown.slice(0, rawStart) + replacement + sourceMarkdown.slice(rawEnd),
    preserved: true,
    reason: 'localized-change'
  }
}
