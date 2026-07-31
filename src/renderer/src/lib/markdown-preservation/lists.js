import {
  sourceRawFromVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  commonChange,
  lineAt,
  lineIndexAt,
  listMarker,
  markdownLines
} from './core.js'

// Find the syntactic list tree around an offset without parsing the entire
// Markdown again. Blank lines are retained only when they sit between members
// of the same list, so a preceding paragraph's separator is never replaced.
export const listBlockAt = (markdown, offset) => {
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

  const baseLineMarker = lines[markerIndex].text.match(/^(\s*)([-+*]|\d{1,9}[.)])\s+/)
  const baseIndent = baseLineMarker[1].length
  const baseKind = /^\d/.test(baseLineMarker[2]) ? 'ordered' : 'bullet'
  const belongsToList = (line) => {
    if (!line.text.trim()) return false
    const marker = listMarker(line.text)
    const indent = line.text.match(/^\s*/)[0].length
    if (!marker) return indent > baseIndent
    if (indent > baseIndent) return true
    if (indent < baseIndent) return false
    const token = line.text.match(/^\s*([-+*]|\d{1,9}[.)])\s+/)?.[1] || ''
    const kind = /^\d/.test(token) ? 'ordered' : 'bullet'
    return kind === baseKind
  }

  let startIndex = markerIndex
  for (let current = markerIndex - 1; current >= 0; current--) {
    if (!lines[current].text.trim()) {
      continue
    }
    if (!belongsToList(lines[current])) break
    // The previous member owns the pending separator. Starting at the blank
    // line would split one loose Markdown list into several independent blocks.
    startIndex = current
  }

  let endIndex = markerIndex
  for (let current = markerIndex + 1; current < lines.length; current++) {
    if (!lines[current].text.trim()) {
      continue
    }
    if (!belongsToList(lines[current])) break
    endIndex = current
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

const bulletMarkerLines = (markdown) => markdownLines(markdown)
  .map((line) => ({
    ...line,
    match: line.text.match(/^(\s*)([-+*])(?=\s+)/)
  }))
  .filter((line) => line.match)

// ProseMirror's bullet-list node does not retain whether the user triggered
// the input rule with "-", "*" or "+". Crepe therefore serializes every new
// bullet list with its configured default marker. Match the just-created item
// by structural ordinal and restore only that marker; later list edits then use
// the authored marker through formatCanonicalListLikeSource.
export const restoreTypedBulletMarker = ({
  markdown,
  canonical,
  previousCanonical,
  canonicalOffset,
  marker
}) => {
  if (!/^[-+*]$/.test(marker || '')) return markdown
  const canonicalText = String(canonical || '')
  const canonicalLines = bulletMarkerLines(canonicalText)
  if (!canonicalLines.length) return markdown

  const previousText = String(previousCanonical || '')
  const change = commonChange(previousText, canonicalText)
  const changedLine = canonicalLines.find((line) =>
    line.end >= change.start && line.start <= change.nextEnd
  )
  const target = changedLine
    ? { line: changedLine, distance: 0 }
    : canonicalLines.reduce((best, line) => {
      if (!Number.isFinite(canonicalOffset)) return best
      const distance = canonicalOffset < line.start
        ? line.start - canonicalOffset
        : canonicalOffset > line.end
          ? canonicalOffset - line.end
          : 0
      return !best || distance < best.distance ? { line, distance } : best
    }, null)
  if (!target || target.distance > 4) return markdown

  const sourceLines = bulletMarkerLines(String(markdown || ''))
  const targetBlock = listBlockAt(canonicalText, target.line.start)
  if (!targetBlock) return markdown
  const targetIndent = target.line.match[1].length
  const offsets = canonicalLines
    .map((line, ordinal) => ({ line, ordinal }))
    .filter(({ line }) =>
      line.start >= targetBlock.start &&
      line.end <= targetBlock.end &&
      line.match[1].length === targetIndent
    )
    .map(({ ordinal }) => sourceLines[ordinal])
    .filter(Boolean)
    .map((line) => line.start + line.match[1].length)
    .filter((offset) => markdown[offset] !== marker)
    .sort((left, right) => right - left)
  return offsets.reduce(
    (result, offset) => result.slice(0, offset) + marker + result.slice(offset + 1),
    markdown
  )
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

const comparableListLine = (line) => line
  .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
  .trim()

const comparableListText = (markdown) => markdown
  .split('\n')
  .map(comparableListLine)
  .filter(Boolean)
  .join('\n')

const listTextIsSubsequence = (candidate, target) => {
  const candidateLines = candidate.split('\n').filter(Boolean)
  const targetLines = target.split('\n').filter(Boolean)
  let targetIndex = 0
  return candidateLines.every((line) => {
    while (targetIndex < targetLines.length && targetLines[targetIndex] !== line) targetIndex += 1
    if (targetIndex >= targetLines.length) return false
    targetIndex += 1
    return true
  })
}

const narrowListBlockByContent = (markdown, block, comparable, offset) => {
  const target = comparable.split('\n').filter(Boolean)
  if (!target.length) return null
  const lines = markdownLines(markdown)
    .filter((line) => line.start >= block.start && line.end <= block.end)
    .map((line) => ({ ...line, comparable: comparableListLine(line.text) }))
    .filter((line) => line.comparable)
  const candidates = []
  for (let start = 0; start <= lines.length - target.length; start += 1) {
    if (!target.every((text, index) => lines[start + index].comparable === text)) continue
    const first = lines[start]
    const last = lines[start + target.length - 1]
    const distance = offset < first.start
      ? first.start - offset
      : offset > last.end
        ? offset - last.end
        : 0
    candidates.push({ start: first.start, end: last.end, indent: block.indent, distance })
  }
  if (!candidates.length) return null
  candidates.sort((left, right) => left.distance - right.distance)
  const { distance: _distance, ...region } = candidates[0]
  return region
}

// List conversion already knows the exact ProseMirror list position before and
// after its transaction. Use those raw offsets to replace only that list tree.
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
  let nextList = listBlockAt(rawNext, nextOffset)
  if (!sourceList || !nextList) return null
  let previousList = null
  if (previous && Number.isFinite(previousOffset)) {
    previousList = listBlockAt(String(previous), previousOffset)
    if (!previousList) return null
    const sourceText = comparableListText(rawSource.slice(sourceList.start, sourceList.end))
    const previousText = comparableListText(String(previous).slice(previousList.start, previousList.end))
    if (!sourceText || sourceText !== previousText) return null
    nextList = narrowListBlockByContent(rawNext, nextList, previousText, nextOffset)
    if (!nextList) return null
  }
  const replacement = formatCanonicalListLikeSource(
    rawSource.slice(sourceList.start, sourceList.end),
    previousList
      ? String(previous).slice(previousList.start, previousList.end)
      : rawNext.slice(nextList.start, nextList.end),
    rawNext.slice(nextList.start, nextList.end)
  )
  return rawSource.slice(0, sourceList.start) +
    adaptCanonicalRegionToSource(replacement, rawSource, sourceList) +
    rawSource.slice(sourceList.end)
}

export const preserveListBlockChange = ({ source, previous, next, start, previousEnd, nextEnd }) => {
  const previousChangedLine = lineAt(previous, start)
  const nextChangedLine = lineAt(next, start)
  const previousChangedText = previous.slice(previousChangedLine.start, previousChangedLine.end)
  const nextChangedText = next.slice(nextChangedLine.start, nextChangedLine.end)
  if (
    previousChangedText.trim() &&
    !listMarker(previousChangedText) &&
    listMarker(nextChangedText) &&
    comparableListLine(nextChangedText) === previousChangedText.trim()
  ) {
    return null
  }

  const previousList = listBlockNear(previous, start, previousEnd)
  const nextList = listBlockNear(next, start, nextEnd)
  if (!previousList || !nextList) return null
  if (previousList.indent > 0 || nextList.indent > 0) return null
  if (start < previousList.start || start > previousList.end + 2 || previousEnd > previousList.end + 2) return null
  if (start < nextList.start || start > nextList.end + 2 || nextEnd > nextList.end + 2) return null

  const previousListText = comparableListText(previous.slice(previousList.start, previousList.end))
  const nextListText = comparableListText(next.slice(nextList.start, nextList.end))
  if (
    !previousListText ||
    !nextListText ||
    (
      !listTextIsSubsequence(previousListText, nextListText) &&
      !listTextIsSubsequence(nextListText, previousListText)
    )
  ) {
    return null
  }

  const listStart = sourceVisiblePositionAtRaw(previous, previousList.start)
  const rawInsideSource = sourceRawFromVisibleIndex(source, listStart.visibleIndex, 'forward')
  const sourceList = listBlockAt(source, rawInsideSource)
  if (!sourceList) return null

  const sourceListText = comparableListText(source.slice(sourceList.start, sourceList.end))
  if (!sourceListText || sourceListText !== previousListText) return null

  const replacement = formatCanonicalListLikeSource(
    source.slice(sourceList.start, sourceList.end),
    previous.slice(previousList.start, previousList.end),
    next.slice(nextList.start, nextList.end)
  )
  return {
    markdown: source.slice(0, sourceList.start) +
      adaptCanonicalRegionToSource(replacement, source, sourceList) +
      source.slice(sourceList.end),
    preserved: true,
    reason: 'list-type-change'
  }
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

export const hasListStructureChange = ({ previous, next, start, previousEnd, nextEnd }) => {
  const previousList = listBlockNear(previous, start, previousEnd)
  const nextList = listBlockNear(next, start, nextEnd)
  if (!previousList && !nextList) return false
  if (!previousList || !nextList) return true
  return listStructure(previous, previousList) !== listStructure(next, nextList)
}

export const hasEmptyListItem = (markdown, block) => {
  if (!block) return false
  return markdown
    .slice(block.start, block.end)
    .split('\n')
    .some((line) => /^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s*)?$/.test(line))
}
