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

const listBlockNear = (markdown, ...offsets) => {
  for (const offset of offsets) {
    if (!Number.isFinite(offset)) continue
    for (const candidate of [offset, offset - 1, offset - 2]) {
      if (candidate < 0) continue
      const block = listBlockAt(markdown, candidate)
      if (block) return block
    }
  }
  return null
}

const listMarkerMeta = (markdown) => {
  const rows = String(markdown || '').split('\n').map((line) => {
    const match = line.match(/^(\s*)((?:[-+*])|(?:\d{1,9}[.)]))(\s+)(?:\[([ xX])\]\s+)?/)
    if (!match) return null
    return {
      indent: match[1].length,
      token: match[2],
      spacing: match[3],
      kind: /^\d/.test(match[2]) ? 'ordered' : 'bullet'
    }
  })
  const indents = [...new Set(rows.filter(Boolean).map((row) => row.indent))].sort((a, b) => a - b)
  return rows.map((row) => row
    ? { ...row, depth: indents.indexOf(row.indent) }
    : null)
}

const formatCanonicalListLikeSource = (sourceList, previousList, nextList) => {
  const sourceLines = String(sourceList || '').split('\n')
  const previousMeta = listMarkerMeta(previousList)
  const sourceMeta = listMarkerMeta(sourceList)
  const sourceStyle = new Map()
  const previousKind = new Map()
  sourceMeta.forEach((item) => {
    if (item && !sourceStyle.has(item.depth)) sourceStyle.set(item.depth, item)
  })
  previousMeta.forEach((item) => {
    if (item && !previousKind.has(item.depth)) previousKind.set(item.depth, item.kind)
  })

  // A compact authored list has no blank separator immediately before another
  // item marker. Crepe serializes the same list as loose Markdown; keep the
  // author's compact/loose choice when a real list structure edit occurs.
  const sourceIsCompact = sourceLines.every((line, index) => {
    if (index === 0 || !listMarker(line)) return true
    return sourceLines[index - 1].trim() !== ''
  })

  const nextLines = String(nextList || '').split('\n')
  const nextMeta = listMarkerMeta(nextList)
  const styled = nextLines.map((line, index) => {
    const meta = nextMeta[index]
    if (!meta) return line
    const authored = sourceStyle.get(meta.depth)
    if (!authored || previousKind.get(meta.depth) !== meta.kind || authored.kind !== meta.kind) return line
    const token = meta.kind === 'ordered'
      ? meta.token.replace(/[.)]$/, authored.token.slice(-1))
      : authored.token
    return line.replace(/^(\s*)((?:[-+*])|(?:\d{1,9}[.)]))/, `$1${token}`)
  })

  if (!sourceIsCompact) return styled.join('\n')
  return styled.filter((line, index, lines) => {
    if (line.trim()) return true
    const nextNonBlank = lines.slice(index + 1).find((candidate) => candidate.trim())
    return !nextNonBlank || !listMarker(nextNonBlank)
  }).join('\n')
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
  let previousList = null
  if (previous && Number.isFinite(previousOffset)) {
    previousList = listBlockAt(String(previous), previousOffset)
    if (!previousList) return null
    const sourceText = comparableListText(rawSource.slice(sourceList.start, sourceList.end))
    const previousText = comparableListText(String(previous).slice(previousList.start, previousList.end))
    if (!sourceText || sourceText !== previousText) return null
  }
  const replacement = formatCanonicalListLikeSource(
    rawSource.slice(sourceList.start, sourceList.end),
    previousList
      ? String(previous).slice(previousList.start, previousList.end)
      : rawNext.slice(nextList.start, nextList.end),
    rawNext.slice(nextList.start, nextList.end)
  )
  return rawSource.slice(0, sourceList.start) + replacement + rawSource.slice(sourceList.end)
}

const comparableListText = (markdown) => markdown
  .split('\n')
  .map((line) => line.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/, '').trim())
  .filter(Boolean)
  .join('\n')

const preserveListBlockChange = ({ source, previous, next, start, previousEnd, nextEnd }) => {
  const previousList = listBlockNear(previous, start, previousEnd)
  const nextList = listBlockNear(next, start, nextEnd)
  if (!previousList || !nextList) return null
  // A nested list can be represented by different indentation widths before
  // and after serialization. Its raw position cannot be proven safely from a
  // visible offset, so use the canonical fallback rather than risk splicing
  // into the parent item. Top-level list blocks retain a stable raw boundary.
  if (previousList.indent > 0 || nextList.indent > 0) return null
  // Inserting/removing a list item can make the canonical delta begin in the
  // one blank separator immediately after the list. Accept that local boundary
  // while still rejecting a change that belongs to a distant block.
  if (start < previousList.start || start > previousList.end + 2 || previousEnd > previousList.end + 2) return null
  if (start < nextList.start || start > nextList.end + 2 || nextEnd > nextList.end + 2) return null

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

  const replacement = formatCanonicalListLikeSource(
    source.slice(sourceList.start, sourceList.end),
    previous.slice(previousList.start, previousList.end),
    next.slice(nextList.start, nextList.end)
  )
  return {
    markdown: source.slice(0, sourceList.start) + replacement + source.slice(sourceList.end),
    preserved: true,
    reason: 'list-type-change'
  }
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

const tableShape = (markdown, table) => {
  if (!table) return ''
  return markdown
    .slice(table.start, table.end)
    .trimEnd()
    .split('\n')
    .map((line) => {
      if (isTableSeparatorLine(line)) {
        return line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => {
            const value = cell.trim()
            return `${value.startsWith(':') ? 'l' : ''}${value.endsWith(':') ? 'r' : ''}`
          })
          .join('|')
      }
      return line.split('|').length
    })
    .join('\n')
}

const hasTableStructureChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousTable = tableBlockAt(previous, start) || tableBlockAt(previous, previousEnd)
  const nextTable = tableBlockAt(next, start) || tableBlockAt(next, nextEnd)
  if (!previousTable && !nextTable) return false
  if (!previousTable || !nextTable) return true
  return tableShape(previous, previousTable) !== tableShape(next, nextTable)
}

const replaceChangedTableBlock = ({ source, previous, next, start, previousEnd, nextEnd }) => {
  const previousTable = tableBlockAt(previous, start) || tableBlockAt(previous, previousEnd)
  const nextTable = tableBlockAt(next, start) || tableBlockAt(next, nextEnd)
  if (!previousTable || !nextTable) return null

  const tableStart = sourceVisiblePositionAtRaw(previous, previousTable.start)
  const rawInsideSource = sourceRawFromVisibleIndex(source, tableStart.visibleIndex, 'forward')
  const sourceTable = tableBlockAt(source, rawInsideSource)
  if (!sourceTable) return null

  const sourceText = sourceVisibleIndex(source.slice(sourceTable.start, sourceTable.end)).text
  const previousText = sourceVisibleIndex(previous.slice(previousTable.start, previousTable.end)).text
  if (sourceText !== previousText) return null

  return {
    markdown: source.slice(0, sourceTable.start) +
      normalizeEmptyTableCells(next.slice(nextTable.start, nextTable.end)) +
      source.slice(sourceTable.end),
    preserved: true,
    reason: 'table-block-change'
  }
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

const listStructure = (markdown, block) => {
  if (!block) return ''
  return markdown
    .slice(block.start, block.end)
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)((?:[-+*])|(?:\d{1,9}[.)]))\s+(?:\[([ xX])\]\s+)?/)
      if (!match) return ''
      const marker = /^\d/.test(match[2]) ? 'ordered' : 'bullet'
      const task = match[3] == null ? '' : `:${match[3].toLowerCase() === 'x' ? 'checked' : 'open'}`
      return `${match[1].length}:${marker}${task}`
    })
    .filter(Boolean)
    .join('\n')
}

const hasListStructureChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousList = listBlockNear(previous, start, previousEnd)
  const nextList = listBlockNear(next, start, nextEnd)
  if (!previousList && !nextList) return false
  if (!previousList || !nextList) return true
  return listStructure(previous, previousList) !== listStructure(next, nextList)
}

const hasEmptyListItem = (markdown, block) => {
  if (!block) return false
  return markdown
    .slice(block.start, block.end)
    .split('\n')
    .some((line) => /^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s*)?$/.test(line))
}

const lineRegion = (markdown, start, end) => {
  const first = lineAt(markdown, start)
  // `end` is exclusive. When a structural insertion is exactly a newline,
  // the unchanged suffix starts at `end` on a new line and must travel with
  // the replacement; using `end - 1` would retain only the inserted blank line
  // and accidentally drop that suffix.
  const last = lineAt(markdown, Math.max(start, end))
  return { start: first.start, end: last.end }
}

const isBlockPrefix = (value) =>
  /^\s*(?:#{1,6}|>|[-+*]|\d{1,9}[.)])?\s*$/.test(value)

const hasStructuralPrefixChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousLine = lineAt(previous, start)
  const nextLine = lineAt(next, start)
  return isBlockPrefix(previous.slice(previousLine.start, previousEnd)) &&
    isBlockPrefix(next.slice(nextLine.start, nextEnd))
}

const appendBlockAtDocumentEnd = (source, canonicalBlock) => {
  const sourceTrailingNewlines = source.match(/\n*$/)?.[0].length || 0
  const block = canonicalBlock.replace(/^\n+/, '').replace(/\n+$/, '')
  if (!block) return null
  const separator = '\n'.repeat(Math.max(0, 2 - sourceTrailingNewlines))
  const finalNewline = sourceTrailingNewlines > 0 ? '\n' : ''
  return source + separator + block + finalNewline
}

const trailingEmptyBlock = (markdown) => {
  const match = markdown.match(/(?:^|\n{2})<br\s*\/?>\n*$/i)
  if (!match) return null
  const prefixLength = match[0].startsWith('\n\n') ? 2 : 0
  return {
    start: match.index + prefixLength,
    end: markdown.length
  }
}

const standaloneEmptyBlockLines = (markdown) => markdownLines(markdown)
  .filter((line) => /^\s*<br\s*\/?>\s*$/i.test(line.text))

const withoutStandaloneEmptyBlockLines = (markdown) => String(markdown || '')
  .replace(/(^|\n)[ \t]*<br\s*\/?>[ \t]*(?=\n|$)/gi, '$1')

const rangeTouches = (range, start, end) =>
  range.start <= Math.max(start, end) && range.end >= Math.min(start, end)

const hasDedicatedBlockSyntax = (markdown) => markdownLines(markdown).some(({ text }) => {
  const trimmed = text.trim()
  if (!trimmed) return false
  return !!listMarker(text) ||
    isTableLine(text) ||
    /^(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(trimmed)
})

// A paragraph inserted between two existing blocks is first serialized by
// Crepe as a standalone `<br />` line. The raw Markdown deliberately does not
// receive that editor placeholder. When the user types into the paragraph, map
// the complete gap between its unchanged neighboring visible lines and replace
// that bounded gap. Character-affinity mapping cannot handle this case because
// the empty paragraph has no visible index and otherwise lands at the end of
// the preceding paragraph.
const preserveMiddleEmptyBlock = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousEmpty = standaloneEmptyBlockLines(previous)
  const nextEmpty = standaloneEmptyBlockLines(next)
  const previousChangedEmpty = previousEmpty.some((range) =>
    rangeTouches(range, start, previousEnd)
  )
  const nextChangedEmpty = nextEmpty.some((range) =>
    rangeTouches(range, start, nextEnd)
  )
  const previousChangedText = withoutStandaloneEmptyBlockLines(
    previous.slice(start, previousEnd)
  ).trim()
  const nextChangedText = withoutStandaloneEmptyBlockLines(
    next.slice(start, nextEnd)
  ).trim()

  // Creating one or more empty paragraphs is an intermediate editor state.
  // Advance the canonical baseline but do not leak `<br />` into user source.
  if (
    nextEmpty.length > previousEmpty.length &&
    nextChangedEmpty &&
    !previousChangedText &&
    !nextChangedText
  ) {
    return {
      markdown: source,
      preserved: true,
      reason: 'middle-empty-block-created'
    }
  }

  const directBlockInsertion =
    previousEnd === start &&
    !previousChangedText &&
    !!nextChangedText
  if ((!previousChangedEmpty && !directBlockInsertion) || !nextChangedText) return null
  if (hasDedicatedBlockSyntax(next.slice(start, nextEnd))) return null

  const previousLines = visibleLineEntries(previous)
  const sourceLines = visibleLineEntries(source)
  if (!sameVisibleLines(sourceLines, previousLines)) return null

  let beforeIndex = -1
  for (let index = 0; index < previousLines.length; index += 1) {
    if (previousLines[index].end <= start) beforeIndex = index
  }
  const afterIndex = previousLines.findIndex((line) => line.start >= previousEnd)
  if (beforeIndex < 0 || afterIndex < 0 || afterIndex <= beforeIndex) return null

  const previousBefore = previousLines[beforeIndex]
  const previousAfter = previousLines[afterIndex]
  const sourceBefore = sourceLines[beforeIndex]
  const sourceAfter = sourceLines[afterIndex]
  if (
    directBlockInsertion &&
    previous.slice(previousBefore.end, previousAfter.start).trim()
  ) {
    return null
  }
  const delta = nextEnd - previousEnd
  const nextBefore = lineAt(next, previousBefore.start)
  const nextAfter = lineAt(next, previousAfter.start + delta)
  if (
    sourceVisibleIndex(next.slice(nextBefore.start, nextBefore.end)).text.trim() !== previousBefore.visible ||
    sourceVisibleIndex(next.slice(nextAfter.start, nextAfter.end)).text.trim() !== previousAfter.visible
  ) {
    return null
  }

  const sourceGap = source.slice(sourceBefore.end, sourceAfter.start)
  // A standalone `<br />` already present in raw source is user-authored, not
  // our deferred empty paragraph. Leave that case to the generic mapper.
  if (standaloneEmptyBlockLines(sourceGap).length) return null

  const nextGap = next.slice(nextBefore.end, nextAfter.start)
  return {
    markdown: source.slice(0, sourceBefore.end) +
      withoutStandaloneEmptyBlockLines(nextGap) +
      source.slice(sourceAfter.start),
    preserved: true,
    reason: previousChangedEmpty
      ? 'middle-empty-block-filled'
      : 'middle-block-inserted'
  }
}

// An empty paragraph at the document end is a real ProseMirror node, but Crepe
// serializes it as a standalone `<br />` block. That token is an editor
// placeholder, not text the user authored. Keep the raw source unchanged when
// Enter creates it, advance only the canonical baseline, then append the real
// block when subsequent input replaces the placeholder.
const preserveTrailingEmptyBlock = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceEmpty = trailingEmptyBlock(source)
  const previousEmpty = trailingEmptyBlock(previous)
  const nextEmpty = trailingEmptyBlock(next)

  if (!sourceEmpty && !previousEmpty && nextEmpty) {
    return {
      markdown: source,
      preserved: true,
      reason: 'trailing-empty-block-created'
    }
  }

  if (
    !sourceEmpty &&
    previousEmpty &&
    !nextEmpty &&
    start <= previousEmpty.end &&
    previousEnd >= previousEmpty.start
  ) {
    const markdown = appendBlockAtDocumentEnd(source, next.slice(start, nextEnd))
    if (markdown !== null) {
      return {
        markdown,
        preserved: true,
        reason: 'trailing-empty-block-filled'
      }
    }
  }

  return null
}

const preserveAppendedParagraph = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd,
  replacementVisible
}) => {
  const replacement = next.slice(start, nextEnd)
  const previousTrailingNewlines = previous.match(/\n*$/)?.[0].length || 0
  const replacementLeadingNewlines = replacement.match(/^\n*/)?.[0].length || 0
  if (
    start !== previous.length ||
    previousEnd !== start ||
    !replacementVisible ||
    (
      replacementLeadingNewlines === 0 &&
      previousTrailingNewlines < 2
    )
  ) {
    return null
  }

  // Crepe may represent an empty trailing paragraph with two canonical
  // newlines. When text is entered into it, the common diff inserts the block
  // after those newlines (`replacement === "text\n\n"`), not as a replacement
  // beginning with `\n`. Build the authored paragraph separator explicitly;
  // otherwise visible-index mapping inserts the text at the previous heading
  // or paragraph's last character and every later block collapses into it.
  const markdown = appendBlockAtDocumentEnd(source, replacement)
  if (markdown === null) return null

  return {
    markdown,
    preserved: true,
    reason: 'appended-paragraph'
  }
}

const visibleLineEntries = (markdown) => markdownLines(markdown)
  .map((line) => ({
    ...line,
    visible: sourceVisibleIndex(line.text).text.trim()
  }))
  .filter((line) => line.visible)

const sameVisibleLines = (left, right) =>
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

  // A syntax-only insertion can fall entirely between two visible lines.
  // Preserve that exact gap by mapping its previous/next visible-line ordinal.
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

// Structural edits have no visible-character span, so the normal character
// patch cannot locate them. Expand only to the touched canonical lines, map
// those line boundaries through the global visible stream, and replace the
// corresponding authored lines. This is deliberately a local fallback: it may
// normalize the line the user structurally changed, but never the whole file.
const preserveChangedLineRegion = ({
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
      transformReplacement(next.slice(nextRegion.start, nextRegion.end)) +
      source.slice(sourceRegion.end),
    preserved: true,
    reason
  }
}

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying only the serializer's
// localized delta. Structural edits are bounded to a list, table, or touched
// lines; an ambiguous mapping keeps the authored source instead of normalizing
// the complete document.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical) {
  const sourceMarkdown = String(source || '')
  const previous = String(previousCanonical || '')
  const next = String(nextCanonical || '')
  if (previous === next) return { markdown: sourceMarkdown, preserved: true, reason: 'unchanged' }
  if (!previous) {
    if (!sourceMarkdown) {
      return {
        markdown: normalizeEmptyTableCells(next),
        preserved: true,
        reason: 'new-document'
      }
    }
    return { markdown: sourceMarkdown, preserved: false, reason: 'missing-baseline' }
  }

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  const { start, previousEnd, nextEnd } = commonChange(previous, next)
  const trailingEmptyPreserved = preserveTrailingEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (trailingEmptyPreserved) return trailingEmptyPreserved
  const middleEmptyPreserved = preserveMiddleEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (middleEmptyPreserved) return middleEmptyPreserved
  if (sourceVisible.text !== previousVisible.text) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'visible-mismatch-line-change'
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'visible-stream-mismatch' }
  }
  const tableStructureChanged = hasTableStructureChange({
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (tableStructureChanged) {
    const tablePreserved = replaceChangedTableBlock({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (tablePreserved) return tablePreserved
    const linesPreserved = preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'table-line-change',
      transformReplacement: normalizeEmptyTableCells
    })
    if (linesPreserved) return linesPreserved
    return { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-table-change' }
  }

  const listStructureChanged = hasListStructureChange({
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (listStructureChanged) {
    const listPreserved = preserveListBlockChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (listPreserved) return listPreserved
    const linesPreserved = preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'list-line-change'
    })
    if (linesPreserved) return linesPreserved
    return { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-list-change' }
  }

  if (hasStructuralPrefixChange({ previous, next, start, previousEnd, nextEnd })) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'structural-line-change'
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-structural-change' }
  }
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  const appendedParagraph = preserveAppendedParagraph({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd,
    replacementVisible
  })
  if (appendedParagraph) return appendedParagraph

  // Enter in a list is emitted as two transactions: first an empty list item,
  // then text inserted into that item. The second transaction has no previous
  // visible span, so a global forward-affinity mapping lands at the paragraph
  // after the list. Reapply this bounded list through its item sequence instead
  // and retain the authored marker/compactness style.
  const previousListAtChange = listBlockAt(previous, start)
  const nextListAtChange = listBlockAt(next, start)
  if (startVisible.visibleIndex === endVisible.visibleIndex &&
      hasEmptyListItem(previous, previousListAtChange) &&
      nextListAtChange) {
    const listPreserved = preserveListBlockChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (listPreserved) return { ...listPreserved, reason: 'list-empty-item-change' }
  }

  // A heading level, a list marker, or blank structure has no visible-text
  // span. Patching it by character position risks inserting syntax inside the
  // wrong raw construct, so replace only the affected authored lines.
  if (startVisible.visibleIndex === endVisible.visibleIndex && !replacementVisible) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'structural-line-change'
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-structural-change' }
  }

  const rawStart = rawOffsetAtVisible(sourceMarkdown, startVisible)
  const rawEnd = rawOffsetAtVisible(sourceMarkdown, endVisible)
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'mapped-line-change'
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-change' }
  }

  return {
    markdown: sourceMarkdown.slice(0, rawStart) + replacement + sourceMarkdown.slice(rawEnd),
    preserved: true,
    reason: 'localized-change'
  }
}
