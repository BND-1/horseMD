import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
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

const listBlocksInSourceOrder = (markdown) => {
  const blocks = new Map()
  markdownLines(markdown).forEach((line) => {
    if (!listMarker(line.text)) return
    const block = listBlockAt(markdown, line.start)
    if (block) blocks.set(`${block.start}:${block.end}`, block)
  })
  return [...blocks.values()].sort((left, right) => left.start - right.start || left.end - right.end)
}

const bulletMarkerLines = (markdown) => markdownLines(markdown)
  .map((line) => ({
    ...line,
    match: line.text.match(/^(\s*)([-+*])(?=\s+)/)
  }))
  .filter((line) => line.match)

const listMarkerTokenLines = (markdown) => markdownLines(markdown)
  .map((line) => ({
    ...line,
    match: line.text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s+)/)
  }))
  .filter((line) => line.match)

// A new scratch document has no pre-existing source formatting to protect, so
// its complete canonical serialization is the safest structural snapshot.
// Crepe does not retain whether a list input rule began with `-`, `*`, `+`,
// `1.` or `1)`. Carry already-authored tokens forward by list-row ordinal
// while the document is still on the generated scratch path. In particular,
// an immediate rich -> source switch can serialize the same ordered row a
// second time after its one-shot input intent has been consumed; this must not
// turn a visible `1.` into Crepe's default `1)`.
export const preserveGeneratedBulletMarkers = (source, markdown) => {
  const sourceLines = listMarkerTokenLines(source)
  const nextLines = listMarkerTokenLines(markdown)
  if (!sourceLines.length || !nextLines.length) return markdown

  const replacements = []
  const replaceMarker = (sourceLine, nextLine) => {
    const sourceIndent = sourceLine.match[1].length
    const nextIndent = nextLine.match[1].length
    if (sourceIndent !== nextIndent) return
    const sourceMarker = sourceLine.match[2]
    const nextMarker = nextLine.match[2]
    const sourceIsOrdered = /^\d/.test(sourceMarker)
    const nextIsOrdered = /^\d/.test(nextMarker)
    const preserveMarker = !sourceIsOrdered && !nextIsOrdered
      ? sourceMarker
      : sourceIsOrdered && nextIsOrdered &&
          sourceMarker.slice(0, -1) === nextMarker.slice(0, -1)
        ? sourceMarker
        : null
    if (!preserveMarker || preserveMarker === nextMarker) return
    replacements.push({
      start: nextLine.start + nextIndent,
      end: nextLine.start + nextIndent + nextMarker.length,
      marker: preserveMarker
    })
  }

  const sourceBullets = sourceLines.filter((line) => !/^\d/.test(line.match[2]))
  const nextBullets = nextLines.filter((line) => !/^\d/.test(line.match[2]))
  const ordinallyMatchedBullets = new Set()
  if (sourceLines.length === nextLines.length) {
    // Text commonly changes one character at a time after a list input rule.
    // The marker belongs to the list row, not to a completed copy of its text;
    // ordinal + indentation are the stable structural identity while this
    // document still has no authored source formatting to preserve.
    nextLines.forEach((nextLine, index) => replaceMarker(sourceLines[index], nextLine))
    nextBullets.forEach((nextLine, index) => {
      const sourceLine = sourceBullets[index]
      const sourceContent = sourceLine?.text.slice(sourceLine.match[0].length).trim()
      const sourceIsGeneratedDefaultPlaceholder = sourceLine?.match[2] === '*' &&
        /^<br\s*\/?>(?:\s*)$/i.test(sourceContent || '')
      if (
        sourceLine?.match[1].length === nextLine.match[1].length &&
        !sourceIsGeneratedDefaultPlaceholder
      ) {
        ordinallyMatchedBullets.add(nextLine.start)
      }
    })
  }

  // Pressing Enter to add another item does not invoke a list input rule. A
  // later Tab can simultaneously replace an empty top-level row with a nested
  // one, leaving the total document list-row count unchanged but invalidating
  // its global ordinal alignment. Preserve a bullet style only when that level
  // has an unambiguous authored token; a new nested level can inherit the
  // nearest unambiguous ancestor. Mixed-marker levels stay untouched rather
  // than guessing which marker belongs to a new row.
  const markersByIndent = new Map()
  sourceBullets.forEach((line) => {
    const indent = line.match[1].length
    const marker = line.match[2]
    const content = line.text.slice(line.match[0].length).trim()
    // Tab creates a nested `* <br />` before the user has typed a marker or
    // any text. That is a Crepe placeholder, not an authored preference; if
    // it became the level's style, a parent `-` list would drift back to `*`
    // on the next ordinary keystroke. A populated `* item` remains authored
    // and continues to participate in mixed-marker ambiguity detection.
    if (marker === '*' && /^<br\s*\/?>(?:\s*)$/i.test(content)) return
    const prior = markersByIndent.get(indent)
    markersByIndent.set(indent, prior == null ? marker : prior === marker ? marker : false)
  })
  nextBullets.forEach((nextLine) => {
    if (ordinallyMatchedBullets.has(nextLine.start)) return
    const indent = nextLine.match[1].length
    let marker = markersByIndent.get(indent)
    if (!marker) {
      const ancestorIndent = [...markersByIndent.keys()]
        .filter((candidate) => candidate < indent && markersByIndent.get(candidate))
        .sort((left, right) => right - left)[0]
      marker = ancestorIndent == null ? null : markersByIndent.get(ancestorIndent)
    }
    if (!marker || marker === nextLine.match[2]) return
    const start = nextLine.start + indent
    replacements.push({ start, end: start + nextLine.match[2].length, marker })
  })

  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, replacement) => result.slice(0, replacement.start) + replacement.marker + result.slice(replacement.end),
      markdown
    )
}

// Crepe serializes a newly-created, still-empty list item as `- <br />`.
// That `<br />` is an editor placeholder, not authored Markdown.  Unlike a
// line break inside a populated list item, it carries no user content and must
// never become part of the source snapshot: after the next keystroke it makes
// the visible source stream diverge from Crepe's list node and the text can be
// mapped back into the preceding paragraph.
//
// Keep the marker plus its following whitespace so the source remains a valid
// empty list item while the caret is there.  Do not touch `text<br>text`, which
// is a real hard break authored inside a list item.
export const normalizeEmptyListItems = (markdown) => String(markdown || '')
  .replace(
    /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)[ \t]*<br\s*\/?>[ \t]*$/gim,
    '$1'
  )

// Rich-text-created documents have no authored list spacing to preserve yet.
// Crepe can transiently serialize a newly indented item as a loose list
// (`2. item\n\n   1. child`) when several keyboard transactions are batched.
// Generate the compact Markdown users expect from incremental typing, without
// touching existing source documents where that blank line may be intentional.
export const compactGeneratedListSpacing = (markdown) => String(markdown || '')
  .replace(
    /(^[ \t]*(?:[-+*]|\d{1,9}[.)])\s+[^\n]*)\n(?:[ \t]*\n)+(?=[ \t]*(?:[-+*]|\d{1,9}[.)])\s+)/gm,
    '$1\n'
  )

// Before the space is accepted, Markdown's list input rule is represented as a
// literal marker line (`\\-`, `\\*`, `\\+`, `1.`, or `1)`). Once the space turns
// it into a ProseMirror list, that line no longer has visible text to map from.
// Replace exactly that temporary line with the serialized list block while the
// original marker is still known. This is intentionally narrower than normal
// list preservation: it only accepts a standalone marker at the captured
// pre-input source position, or an exact newly-created canonical list.
export const preserveTypedBulletInputRule = ({
  source,
  canonical,
  previousCanonical,
  sourceOffset,
  canonicalOffset,
  marker
}) => {
  const isBullet = /^[-+*]$/.test(marker || '')
  const isOrdered = /^\d{1,9}[.)]$/.test(marker || '')
  if ((!isBullet && !isOrdered) || !Number.isFinite(canonicalOffset)) {
    return null
  }

  const normalizedCanonical = normalizeEmptyListItems(canonical)
  const previous = normalizeEmptyListItems(String(previousCanonical || ''))
  const change = commonChange(previous, normalizedCanonical)
  // `markdownUpdated` can be deferred while a person continues typing. By the
  // time it arrives, the live selection may already be inside a nested list.
  // The input-rule intent belongs to the *first list introduced by this delta*,
  // never whichever nested list happens to own the current caret.
  const canonicalList = listBlocksInSourceOrder(normalizedCanonical)
    .find((block) => block.start >= change.start && block.end <= change.nextEnd) ||
    listBlockAt(normalizedCanonical, canonicalOffset)
  if (!canonicalList) return null
  const canonicalLine = lineAt(normalizedCanonical, canonicalList.start)
  if (!/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(normalizedCanonical.slice(canonicalLine.start, canonicalLine.end))) return null

  // Crepe serializes a freshly-indented nested item as a loose list (a blank
  // line before the child) when several keyboard transactions batch into one
  // deferred markdownUpdated. The generic new-document path compacts this via
  // compactGeneratedListSpacing; the rebuilt list here must match that, or the
  // source gains a spurious blank line that the user never sees in rich text.
  const replacement = compactGeneratedListSpacing(normalizedCanonical
    .slice(canonicalList.start, canonicalList.end)
    .replace(/^(\s*)(?:[-+*]|\d{1,9}[.)])(?=\s)/m, `$1${marker}`))
  if (!replacement) return null

  // Usual path: the dash transaction has already published its escaped
  // literal source line (`\\-`) before Space turns it into a list.
  if (Number.isFinite(sourceOffset)) {
    const sourceLine = lineAt(source, sourceOffset)
    const sourceMatch = source.slice(sourceLine.start, sourceLine.end).match(
      isBullet
        ? /^([ \t]*)\\([-+*])$/
        : /^([ \t]*)(\d{1,9}[.)])$/
    )
    if (sourceMatch?.[2] === marker) {
      return source.slice(0, sourceLine.start) +
        adaptCanonicalRegionToSource(replacement, source, sourceLine) +
        source.slice(sourceLine.end)
    }
  }

  // A fast real keyboard sequence can dispatch Enter, the marker, and Space
  // before `markdownUpdated` has published the transient empty paragraph and
  // escaped marker. In that window the authored source has no raw line for the
  // new block. This is not a character-position mapping problem: we have an
  // exact input-rule intent and an exactly-new list. Rebuild only that list at
  // the matching pre-existing visible boundary, preserving the user's marker.
  const sourceWithoutTrailingLines = String(source || '').replace(/(?:\r\n|\r|\n)+$/, '')
  const previousWithoutTrailingLines = previous.replace(/(?:\r\n|\r|\n)+$/, '')
  const sourceVisible = sourceVisibleIndex(source)
  const previousVisible = sourceVisibleIndex(previous)
  const listWasCreatedInChange = canonicalList.start >= change.start && canonicalList.end <= change.nextEnd
  if (sourceVisible.text === previousVisible.text && listWasCreatedInChange) {
    const atList = sourceVisiblePositionAtRaw(previous, canonicalList.start)
    const sourceInsertAt = sourceRawFromVisibleIndex(source, atList.visibleIndex, 'forward')
    const nextVisibleRaw = sourceVisibleIndex(normalizedCanonical).map
      .find((offset) => offset >= canonicalList.end)
    if (Number.isFinite(sourceInsertAt) && Number.isFinite(nextVisibleRaw)) {
      const suffixGap = normalizedCanonical.slice(canonicalList.end, nextVisibleRaw)
      return source.slice(0, sourceInsertAt) +
        adaptCanonicalRegionToSource(`${replacement}${suffixGap}`, source, {
          start: sourceInsertAt,
          end: sourceInsertAt
        }) +
        source.slice(sourceInsertAt)
    }
  }

  // The same structural reconstruction at document end needs no following
  // visible boundary. It is deliberately limited to canonical trailing empty
  // lines so source-only syntax after the caret cannot be overwritten.
  if (
    sourceWithoutTrailingLines === previousWithoutTrailingLines &&
    listWasCreatedInChange &&
    change.previousEnd === previous.length
  ) {
    // A completely blank new document has no preceding block to separate.
    // Adding the normal two-newline block separator here creates phantom blank
    // lines before the very first list item.
    const separator = sourceWithoutTrailingLines ? '\n\n' : ''
    return `${sourceWithoutTrailingLines}${separator}${replacement}${normalizedCanonical.slice(canonicalList.end)}`
  }
  return null
}

// ProseMirror does not retain the token which triggered a list input rule. For
// bullets that is `-` / `*` / `+`; for ordered lists it is also the punctuation
// choice in `1.` versus `1)`. Crepe can default the latter to `1)` after a
// deletion + recreate sequence, so restore the physical token before it enters
// the generated-document source baseline.
export const restoreTypedBulletMarker = ({
  markdown,
  canonical,
  previousCanonical,
  canonicalOffset,
  marker,
  inheritNested = false
}) => {
  const isBullet = /^[-+*]$/.test(marker || '')
  const isOrdered = /^\d{1,9}[.)]$/.test(marker || '')
  if (!isBullet && !isOrdered) return markdown
  const canonicalText = String(canonical || '')
  const canonicalLines = isBullet ? bulletMarkerLines(canonicalText) : listMarkerTokenLines(canonicalText)
  if (!canonicalLines.length) return markdown

  const previousText = String(previousCanonical || '')
  const change = commonChange(previousText, canonicalText)
  const changedLine = canonicalLines.find((line) =>
    line.end >= change.start && line.start <= change.nextEnd
  )
  const offsetTarget = canonicalLines.reduce((best, line) => {
      if (!Number.isFinite(canonicalOffset)) return best
      const distance = canonicalOffset < line.start
        ? line.start - canonicalOffset
        : canonicalOffset > line.end
          ? canonicalOffset - line.end
          : 0
      return !best || distance < best.distance ? { line, distance } : best
    }, null)
  // The input intent retains the ProseMirror position from before Space. A
  // deferred callback may arrive after the writer has added another item or a
  // nested child, making the full-document delta begin at an older list row.
  // Prefer the captured position whenever it maps; use the delta only when no
  // stable input position was available.
  const previousLines = isOrdered ? listMarkerTokenLines(previousText) : []
  const orderedDefaultCandidates = isOrdered
    ? canonicalLines
        .map((line, ordinal) => ({ line, ordinal }))
        .filter(({ line, ordinal }) =>
          /^\d/.test(line.match[2]) &&
          line.match[2].slice(0, -1) === marker.slice(0, -1) &&
          line.match[2] !== marker &&
          previousLines[ordinal]?.match[2] !== line.match[2]
        )
    : []
  const nearestOrderedDefaultCandidate = orderedDefaultCandidates.reduce((best, candidate) => {
    if (!Number.isFinite(canonicalOffset)) return best
    const { line } = candidate
    const distance = canonicalOffset < line.start
      ? line.start - canonicalOffset
      : canonicalOffset > line.end
        ? canonicalOffset - line.end
        : 0
    return !best || distance < best.distance ? { ...candidate, distance } : best
  }, null)
  // For an ordered input rule, a newly introduced same-number/different-
  // punctuation token (`1.` -> `1)`) is stronger evidence than the broad
  // document delta. IME commits can batch several list operations together;
  // select the candidate nearest to this particular input's captured position
  // so an outer `1.` and a later nested `1.` are restored independently.
  const orderedDefaultCandidate = nearestOrderedDefaultCandidate ||
    orderedDefaultCandidates.at(-1)
  const target = orderedDefaultCandidate
    ? { line: orderedDefaultCandidate.line || orderedDefaultCandidate, distance: 0 }
    : offsetTarget || (changedLine ? { line: changedLine, distance: 0 } : null)
  if (!target || target.distance > 4) return markdown

  if (isOrdered) {
    // Ordered punctuation is item-specific: applying a new `1.` to every row
    // at this depth would corrupt existing `2.` / `3.` rows. The canonical and
    // generated strings share list-row order, so patch only the created row.
    const sourceLines = listMarkerTokenLines(String(markdown || ''))
    const ordinal = canonicalLines.findIndex((line) => line.start === target.line.start)
    const sourceLine = ordinal >= 0 ? sourceLines[ordinal] : null
    if (!sourceLine || !/^\d/.test(sourceLine.match[2])) return markdown
    const start = sourceLine.start + sourceLine.match[1].length
    const end = start + sourceLine.match[2].length
    return markdown.slice(0, start) + marker + markdown.slice(end)
  }

  const sourceLines = bulletMarkerLines(String(markdown || ''))
  const targetBlock = listBlockAt(canonicalText, target.line.start)
  if (!targetBlock) return markdown
  const targetIndent = target.line.match[1].length
  const offsets = canonicalLines
    .map((line, ordinal) => ({ line, ordinal }))
    .filter(({ line }) =>
      line.start >= targetBlock.start &&
      line.end <= targetBlock.end &&
      (line.match[1].length === targetIndent ||
        (inheritNested && line.match[1].length > targetIndent))
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

const listMarkerRow = (line) => {
  const match = line.text.match(/^(\s*)((?:[-+*])|(?:\d{1,9}[.)]))(\s+)(?:\[([ xX])\](\s+))?/)
  if (!match) return null
  return {
    ...line,
    indent: match[1],
    token: match[2],
    spacing: match[3],
    task: match[4] == null ? null : match[4].toLowerCase() === 'x' ? 'x' : ' ',
    taskSpacing: match[5] || '',
    prefixEnd: match[0].length,
    kind: /^\d/.test(match[2]) ? 'ordered' : 'bullet'
  }
}

const listMarkerRows = (markdown, block) => markdownLines(markdown)
  .filter((line) => line.start >= block.start && line.end <= block.end)
  .map(listMarkerRow)
  .filter(Boolean)

// A list-type conversion changes only the marker/checkbox attributes at one
// ProseMirror list level. Patch those prefixes in the authored source instead
// of replacing the whole canonical list tree: outer and nested levels may use
// different compact/loose spacing, indentation, bullet characters and ordered
// punctuation, none of which belongs to the converted level.
const patchConvertedListMarkers = ({ source, sourceList, previous, previousList, next, nextList }) => {
  const sourceRows = listMarkerRows(source, sourceList)
  const previousRows = listMarkerRows(previous, previousList)
  const nextRows = listMarkerRows(next, nextList)
  if (!sourceRows.length || sourceRows.length !== previousRows.length || sourceRows.length !== nextRows.length) {
    return null
  }

  const changes = []
  for (let index = 0; index < sourceRows.length; index += 1) {
    const sourceRow = sourceRows[index]
    const previousRow = previousRows[index]
    const nextRow = nextRows[index]
    if (
      comparableListLine(sourceRow.text) !== comparableListLine(previousRow.text) ||
      comparableListLine(previousRow.text) !== comparableListLine(nextRow.text)
    ) {
      return null
    }
    if (previousRow.kind === nextRow.kind && previousRow.task === nextRow.task) continue

    // Converting an ordered/task list into an unordered list has no authored
    // bullet character to carry over. Prefer HorseMD's typed-list default (`-`)
    // instead of leaking Crepe's serializer default (`*`). This applies only
    // to the converted level; nested rows keep their original marker tokens.
    const token = previousRow.kind === nextRow.kind
      ? sourceRow.token
      : nextRow.kind === 'bullet' ? '-' : nextRow.token
    const task = nextRow.task == null
      ? ''
      : `[${nextRow.task}]${sourceRow.taskSpacing || nextRow.taskSpacing || ' '}`
    changes.push({
      start: sourceRow.start,
      end: sourceRow.end,
      text: `${sourceRow.indent}${token}${sourceRow.spacing}${task}${sourceRow.text.slice(sourceRow.prefixEnd)}`
    })
  }
  if (!changes.length) return null

  return changes
    .sort((left, right) => right.start - left.start)
    .reduce(
      (markdown, change) => markdown.slice(0, change.start) + change.text + markdown.slice(change.end),
      source
    )
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
  .replace(/^<br\s*\/?>$/i, '')

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
    const rawPrevious = String(previous)
    previousList = listBlockAt(rawPrevious, previousOffset)
    if (!previousList) return null
    const sourceText = comparableListText(rawSource.slice(sourceList.start, sourceList.end))
    const previousText = comparableListText(rawPrevious.slice(previousList.start, previousList.end))
    if (!sourceText || sourceText !== previousText) return null
    nextList = narrowListBlockByContent(rawNext, nextList, previousText, nextOffset)
    if (!nextList) return null
    const markerPatched = patchConvertedListMarkers({
      source: rawSource,
      sourceList,
      previous: rawPrevious,
      previousList,
      next: rawNext,
      nextList
    })
    if (markerPatched) return markerPatched
    // This call path represents an explicit list-type conversion. If the
    // authored/canonical rows cannot be aligned exactly, replacing the whole
    // serializer list would rewrite untouched nested levels. Fail closed.
    return null
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

// Enter creates a real empty list item in ProseMirror, but Crepe serializes its
// content as a `<br />` placeholder. The authored source intentionally keeps
// that item as `- ` (without the placeholder). When the first text is typed,
// visible-character mapping alone cannot locate the empty source item because
// list markers are syntax, not visible text; it would otherwise insert the text
// at the preceding paragraph's end. Match the list by its source-order ordinal
// and replace only that list tree using the author's marker style.
export const preserveEmptyListItemTextChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousList = listBlockNear(previous, start, previousEnd)
  const nextList = listBlockNear(next, start, nextEnd)
  if (!previousList || !nextList) return null
  if (!hasEmptyListItem(previous, previousList) || hasEmptyListItem(next, nextList)) return null

  const previousBlocks = listBlocksInSourceOrder(previous)
  const sourceBlocks = listBlocksInSourceOrder(source)
  const previousIndex = previousBlocks.findIndex((block) =>
    block.start === previousList.start && block.end === previousList.end
  )
  const sourceList = previousIndex >= 0 ? sourceBlocks[previousIndex] : null
  if (!sourceList) return null

  const sourceText = comparableListText(source.slice(sourceList.start, sourceList.end))
  const previousText = comparableListText(previous.slice(previousList.start, previousList.end))
  if (sourceText !== previousText) return null

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
    reason: 'empty-list-item-filled'
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

// A list line that starts with a marker AND carries a second marker token in its
// content (`1. alpha   2.beta`) is never valid Markdown — it is the signature of
// the visible-index line mapper merging nested list items, because list indents
// are syntax, not visible text. Used only to detect that corruption.
const STARTS_WITH_LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
const MID_LINE_LIST_MARKER = /[ \t](?:[-+*]|\d{1,9}[.)])/
export const hasMergedListItemLine = (markdown) => String(markdown || '')
  .split('\n')
  .some((line) => {
    if (!STARTS_WITH_LIST_MARKER.test(line)) return false
    const rest = line.replace(STARTS_WITH_LIST_MARKER, '')
    return MID_LINE_LIST_MARKER.test(rest)
  })

// When the preservation result merged nested list items (hasMergedListItemLine)
// but the canonical serialization did not, rebuild the affected top-level list
// tree from the canonical — which is always content-correct — while preserving
// the source's authored marker / compact-spacing style via
// formatCanonicalListLikeSource. This is a fail-closed safety net (constraint:
// never partially overwrite the source with a corrupt merge). Returns the input
// unchanged when no repair is needed or the trees cannot be aligned by ordinal.
export const repairMergedListItems = (markdown, canonical) => {
  const md = String(markdown || '')
  const canon = String(canonical || '')
  if (!hasMergedListItemLine(md) || hasMergedListItemLine(canon)) return md
  const mdTrees = listBlocksInSourceOrder(md)
  const canonTrees = listBlocksInSourceOrder(canon)
  if (!mdTrees.length || mdTrees.length !== canonTrees.length) return md
  for (let index = 0; index < mdTrees.length; index += 1) {
    const tree = mdTrees[index]
    const treeText = md.slice(tree.start, tree.end)
    if (!hasMergedListItemLine(treeText)) continue
    const canonTree = canonTrees[index]
    const sourceStyle = treeText
    const replacement = formatCanonicalListLikeSource(
      sourceStyle,
      sourceStyle,
      canon.slice(canonTree.start, canonTree.end)
    )
    return md.slice(0, tree.start) +
      adaptCanonicalRegionToSource(replacement, md, tree) +
      md.slice(tree.end)
  }
  return md
}
