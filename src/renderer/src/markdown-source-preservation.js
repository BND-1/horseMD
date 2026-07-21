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
  return Boolean(previousTable && nextTable)
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
  if (!sourceMarkdown || !previous) return { markdown: next, preserved: false, reason: 'missing-baseline' }

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  if (sourceVisible.text !== previousVisible.text) {
    return { markdown: next, preserved: false, reason: 'visible-stream-mismatch' }
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
    return {
      markdown: normalizeEmptyTableCells(next),
      preserved: false,
      reason: 'table-canonical-change'
    }
  }
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text

  // A heading level, a list marker, or blank structure has no visible-text
  // span. Patching it by character position risks inserting syntax inside the
  // wrong raw construct, so retain the canonical result for now.
  if (startVisible.visibleIndex === endVisible.visibleIndex && !replacementVisible) {
    return { markdown: next, preserved: false, reason: 'structural-change' }
  }

  const rawStart = rawOffsetAtVisible(sourceMarkdown, startVisible)
  const rawEnd = rawOffsetAtVisible(sourceMarkdown, endVisible)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) {
    return { markdown: next, preserved: false, reason: 'unmapped-change' }
  }

  return {
    markdown: sourceMarkdown.slice(0, rawStart) + replacement + sourceMarkdown.slice(rawEnd),
    preserved: true,
    reason: 'localized-change'
  }
}
