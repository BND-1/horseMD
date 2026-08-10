import {
  sourceRawFromVisibleIndex,
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  canonicalTextToSource,
  commonChange,
  lineAt,
  lineEndingNear,
  lineIndexAt,
  listMarker,
  markdownLines,
  rawOffsetAtVisible
} from './core.js'

// Find the syntactic list tree around an offset without parsing the entire
// Markdown again. Blank lines are retained only when they sit between members
// of the same list, so a preceding paragraph's separator is never replaced.
export const listBlockAt = (markdown, offset, { splitBulletMarkers = false } = {}) => {
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
  const baseToken = baseLineMarker[2]
  const baseKind = /^\d/.test(baseToken) ? 'ordered' : 'bullet'
  const belongsToList = (line) => {
    if (!line.text.trim()) return false
    const marker = listMarker(line.text)
    const indent = line.text.match(/^\s*/)[0].length
    if (!marker) return indent > baseIndent
    if (indent > baseIndent) return true
    if (indent < baseIndent) return false
    const token = line.text.match(/^\s*([-+*]|\d{1,9}[.)])\s+/)?.[1] || ''
    const kind = /^\d/.test(token) ? 'ordered' : 'bullet'
    // Markdown parsers commonly canonicalize `-`, `+` and `*` into one
    // bullet-list node. In authored source they can still be intentionally
    // separate neighbouring lists; callers repairing source regions can opt
    // into that stronger boundary so one list's style never leaks into another.
    return kind === baseKind &&
      !(splitBulletMarkers && kind === 'bullet' && token !== baseToken)
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

// The list tree that CONTAINS `offset` at the top level (indent 0). Crepe
// serializes each authored top-level row as a `* ` wrapper plus nested rows;
// an edit inside a nested row must be attributed to that whole wrapper block
// so ordinal alignment against the authored top-level rows stays stable.
const outerTopLevelListBlock = (markdown, offset) => {
  const lines = markdownLines(markdown)
  const index = lineIndexAt(lines, offset)
  if (index < 0) return null
  for (let current = index; current >= 0; current -= 1) {
    const marker = lines[current].text.match(/^(\s*)([-+*]|\d{1,9}[.)])\s+/)
    if (marker && marker[1].length === 0) return listBlockAt(markdown, lines[current].start)
    if (lines[current].text.trim() && !/^\s+/.test(lines[current].text)) break
  }
  return listBlockAt(markdown, offset)
}

// Flatten a canonical list block into item rows (text + token). Besides marker
// rows, this keeps the tokenless continuation produced while Backspace lifts a
// nested item through its outer wrapper.
// A wrapper row (`* <br />` whose following marker line is MORE indented) is a
// Crepe container for the nested rows and has no authored counterpart, so it is
// skipped; a genuinely empty nested item (`3. <br />` with no deeper follower)
// IS a real item that corresponds to an authored row and is kept with empty
// text. `<br />` placeholders count as empty text.
const flatListItemRows = (blockText) => {
  const lines = String(blockText || '').split('\n')
  const parsed = lines.map((line) => {
    const match = line.match(/^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/)
    if (match) {
      return {
        indent: match[1].length,
        token: match[2],
        text: String(match[3] || '').replace(/<br\s*\/?>\s*$/i, '').trim()
      }
    }
    const continuation = line.match(/^(\s+)(\S.*)$/)
    if (!continuation) return null
    return {
      indent: continuation[1].length,
      token: '',
      text: continuation[2].trim()
    }
  })
  const rows = []
  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i]
    if (!row) continue
    if (!row.text) {
      const follower = parsed.slice(i + 1).find((candidate) => candidate)
      if (follower && follower.indent > row.indent) continue

    }
    rows.push({ token: row.token, text: row.text, indent: row.indent })
  }
  return rows
}

// Parse an authored top-level list block into rows with their raw offsets
// relative to the block start. The marker (`- `) is dropped; the author's
// literal numbering (`1. `) stays part of `text`.
const sourceListItemRows = (blockText) => {
  const rows = []
  let lineStart = 0
  let baseIndent = null
  const rawLines = String(blockText || '').split('\n')
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index]
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const breakEnd = lineStart + rawLine.length + (index < rawLines.length - 1 ? 1 : 0)
    const match = line.match(/^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/)
    if (match) {
      if (baseIndent == null) baseIndent = match[1].length
      rows.push({
        start: lineStart,
        end: lineStart + line.length,
        breakEnd,
        contentStart: lineStart + match[1].length + match[2].length + 1,
        indent: match[1].length,
        token: match[2],
        text: String(match[3] || '')
      })
    } else {
      const continuation = line.match(/^(\s+)(\S.*)$/)
      if (continuation && baseIndent != null && continuation[1].length > baseIndent) {
        rows.push({
          start: lineStart,
          end: lineStart + line.length,
          breakEnd,
          contentStart: lineStart + continuation[1].length,
          indent: continuation[1].length,
          token: '',
          text: continuation[2]
        })
      }
    }
    lineStart = breakEnd
  }
  return rows
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

// Nested marker rows also produce their own `listBlockAt` entries. They are
// useful to local list converters, but they must not participate in document-
// wide ordinal matching: `- 1. text` yields one authored top-level block and
// several canonical nested blocks. Counting those nested blocks shifts every
// later list's ordinal and makes edits in an unrelated list fail closed.
const topLevelListBlocksInSourceOrder = (markdown) =>
  listBlocksInSourceOrder(markdown).filter((block) => block.indent === 0)

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

  // A fresh Crepe document is serialized after every keystroke.  When Enter
  // adds another row, the new canonical document has one more list marker than
  // the previous authored snapshot.  The former ordinal-only implementation
  // intentionally gave up in that case, which immediately reverted a typed
  // `-` or `+` list to Crepe's default `*`.
  //
  // Match rows which already have visible text first, then let a newly-added
  // adjacent row inherit the resolved marker of its preceding sibling.  The
  // inheritance is deliberately limited to uninterrupted canonical list rows:
  // a distinct list after a paragraph must wait for its own captured input-rule
  // intent rather than borrowing an unrelated earlier marker.
  const listText = (line) => line.text
    .replace(/^(\s*)(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '$1')
  const sourceByText = new Map()
  for (const sourceLine of sourceLines) {
    const key = `${sourceLine.match[1].length}\u0000${listText(sourceLine)}`
    const matches = sourceByText.get(key) || []
    matches.push(sourceLine)
    sourceByText.set(key, matches)
  }
  const usedSourceLines = new Set()

  const compatibleMarker = (sourceMarker, nextMarker) => {
    const sourceIsOrdered = /^\d/.test(sourceMarker)
    const nextIsOrdered = /^\d/.test(nextMarker)
    if (!sourceIsOrdered && !nextIsOrdered) return sourceMarker
    if (sourceIsOrdered && nextIsOrdered && sourceMarker.slice(0, -1) === nextMarker.slice(0, -1)) {
      return sourceMarker
    }
    return null
  }

  const replacements = []
  let previous = null
  for (let index = 0; index < nextLines.length; index += 1) {
    const nextLine = nextLines[index]
    const nextIndent = nextLine.match[1].length
    const nextMarker = nextLine.match[2]
    const key = `${nextIndent}\u0000${listText(nextLine)}`
    const candidates = sourceByText.get(key)
    const sourceLine = candidates?.shift()
    if (sourceLine) usedSourceLines.add(sourceLine)
    let preserveMarker = sourceLine
      ? compatibleMarker(sourceLine.match[2], nextMarker)
      : null

    // Editing the text of an existing item changes the text key above.  In a
    // generated scratch document that used to make the first changed `-` row
    // fall back to Crepe's serializer default `*`, even though the list shape
    // itself had not changed.  When the number of marker rows is stable, row
    // ordinal + indent + list kind is the structural identity of that item.
    // Use it only as a fallback after exact-text matching so reorders still
    // follow their text anchor, and never carry a marker across a list-type
    // conversion.
    if (!preserveMarker && sourceLines.length === nextLines.length) {
      const ordinalSource = sourceLines[index]
      if (
        ordinalSource &&
        !usedSourceLines.has(ordinalSource) &&
        ordinalSource.match[1].length === nextIndent
      ) {
        preserveMarker = compatibleMarker(ordinalSource.match[2], nextMarker)
        if (preserveMarker) usedSourceLines.add(ordinalSource)
      }
    }

    const uninterruptedFromPrevious = previous &&
      previous.indent === nextIndent &&
      /^(?:\r?\n)$/.test(markdown.slice(previous.end, nextLine.start))
    const newlyNestedFromPrevious = previous &&
      previous.indent < nextIndent &&
      /^(?:\r?\n)$/.test(markdown.slice(previous.end, nextLine.start))
    // Tab creates a child bullet list without a literal `-`/`+` input token,
    // so there is no input-rule intent to restore.  While the child has no
    // authored source row yet, inherit its parent bullet spelling rather than
    // leaking Crepe's `*`.  Only inherit the canonical default `*`: an
    // explicit nested `+`/`-` captured by an input rule must remain explicit.
    if (!preserveMarker && nextMarker === '*' && (uninterruptedFromPrevious || newlyNestedFromPrevious)) {
      preserveMarker = compatibleMarker(previous.marker, nextMarker)
    }
    if (preserveMarker && preserveMarker !== nextMarker) {
      replacements.push({
        start: nextLine.start + nextIndent,
        end: nextLine.start + nextIndent + nextMarker.length,
        marker: preserveMarker
      })
    }
    // Keep the resolved spelling (or canonical fallback) as the inheritance
    // source for the next uninterrupted sibling.
    previous = {
      indent: nextIndent,
      end: nextLine.end,
      marker: preserveMarker || nextMarker
    }
  }

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
  // A deleted list row leaves a standalone `<br />` placeholder in canonical
  // (Crepe keeps an empty item until the next Backspace). Its indentation can
  // shift (`   <br />` -> `      <br />`), so both sides of the delta must
  // normalize the indentation before visible-stream comparison — otherwise
  // deleting a typed row fails closed and "resurrects" in source mode. Keep
  // the `<br />` token itself so the dedicated empty-block mappers still
  // recognize the placeholder.
  .replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, '<br />')

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
  insertionSource = source,
  canonical,
  previousCanonical,
  sourceOffset,
  sourceSlotRawStart,
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
  const listWasCreatedInChange = canonicalList.start >= change.start && canonicalList.end <= change.nextEnd

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

  // The transaction-first mapper may already own a newly-created empty block
  // between two authored blocks. Its raw slot sits exactly between the two
  // paragraph separators. Insert the list into that proven slot instead of
  // asking visible-text fallback logic to guess which blank boundary changed.
  // The insertion happens on `insertionSource` (the caller's current source
  // snapshot, which already contains any unrelated edits made while the input
  // rule was pending) so a late list intent can never overwrite other blocks.
  if (
    Number.isFinite(sourceSlotRawStart) &&
    sourceSlotRawStart > 0 &&
    sourceSlotRawStart < insertionSource.length &&
    listWasCreatedInChange
  ) {
    // The slot is a blank-line boundary. Verify its surrounding bytes are
    // unchanged since capture; a drift means an earlier block was edited and
    // the raw offset no longer owns the same gap.
    const capturedBytes = source.slice(sourceSlotRawStart - 2, sourceSlotRawStart + 2)
    const currentBytes = insertionSource.slice(sourceSlotRawStart - 2, sourceSlotRawStart + 2)
    if (capturedBytes !== currentBytes) return null
    const cleanReplacement = String(replacement || '').replace(/\n+$/, '')
    const afterSlot = insertionSource.slice(sourceSlotRawStart)
    const leadingBreaks = afterSlot.match(/^(?:\r?\n)+/)?.[0].length || 0
    const rest = afterSlot.slice(leadingBreaks)
    if (/^[ \t]*(?:[-+*]|\d{1,9}[.)])\s/.test(rest)) {
      // The canonical list was already written into the source by another
      // preservation path while the input rule was pending. Replace the slot,
      // that list block, and any surplus blank lines with the authored-marker
      // compact block, keeping exactly one paragraph separator after it.
      let blockEndInRest = 0
      let cursor = 0
      let remaining = rest
      for (let count = 0; count < 50; count += 1) {
        const lineEnd = remaining.indexOf('\n')
        const line = lineEnd === -1 ? remaining : remaining.slice(0, lineEnd).replace(/\r$/, '')
        if (!/^[ \t]*(?:[-+*]|\d{1,9}[.)])\s/.test(line)) break
        cursor += lineEnd === -1 ? line.length : lineEnd + 1
        remaining = rest.slice(cursor)
        if (lineEnd === -1) break
      }
      blockEndInRest = cursor
      const trailing = rest.slice(blockEndInRest)
      const breaksAfter = trailing.match(/^(?:\r?\n)+/)?.[0].length || 0
      if (breaksAfter < 2) return null
      const end = sourceSlotRawStart + leadingBreaks + blockEndInRest + (breaksAfter - 2)
      return insertionSource.slice(0, sourceSlotRawStart) + cleanReplacement + insertionSource.slice(end)
    }
    return insertionSource.slice(0, sourceSlotRawStart) +
      adaptCanonicalRegionToSource(cleanReplacement, insertionSource, {
        start: sourceSlotRawStart,
        end: sourceSlotRawStart
      }) +
      insertionSource.slice(sourceSlotRawStart)
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
    return `${sourceWithoutTrailingLines}${separator}${canonicalTextToSource(replacement)}${canonicalTextToSource(normalizedCanonical.slice(canonicalList.end))}`
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
  marker
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
  // The ProseMirror position captured before Space belongs to the literal
  // marker paragraph. Once the input rule has wrapped that paragraph in a
  // (possibly nested) list, mapping that old position can be far from the
  // serialized marker row. Prefer it only when it still lands nearby; otherwise
  // the concrete changed marker line is the reliable target. Previously the
  // distant stale position won and made us abort, so nested `-` lists fell back
  // to Crepe's default `*`.
  const nearbyOffsetTarget = offsetTarget?.distance <= 4 ? offsetTarget : null
  const target = orderedDefaultCandidate
    ? { line: orderedDefaultCandidate.line || orderedDefaultCandidate, distance: 0 }
    : nearbyOffsetTarget || (changedLine ? { line: changedLine, distance: 0 } : null)
  if (!target) return markdown

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

const markdownEscapePunctuation = /[\\`*{}\[\]()#+\-.!_>~|]/

// remark-stringify escapes Markdown-looking text inside a list item so it is
// not reparsed as a nested list or another block (`- \- text`, `3. 2\. text`,
// `4. 2\) text`). Build the visible punctuation spelling plus a raw-boundary
// map. Applying a semantic delta through this map removes only serializer
// escapes introduced by the current rich-text edit while retaining authored
// escapes already present in the source row.
const unescapedPunctuationView = (value) => {
  const input = String(value || '')
  let text = ''
  const boundaries = [0]
  for (let index = 0; index < input.length;) {
    if (
      input[index] === '\\' &&
      index + 1 < input.length &&
      markdownEscapePunctuation.test(input[index + 1])
    ) {
      text += input[index + 1]
      index += 2
      boundaries.push(index)
      continue
    }
    text += input[index]
    index += 1
    boundaries.push(index)
  }
  return { text, boundaries }
}

const comparableListLine = (line) => {
  const content = canonicalTextToSource(String(line || '')
    .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
  )
    .trim()
    .replace(/^<br\s*\/?>$/i, '')
  return unescapedPunctuationView(content).text
}

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

// Canonical Markdown collapses every bullet marker to `*`, so a source list
// whose authored marker is `+` or `-` cannot be located by marker alone. Use
// stable neighbouring item text as fences: from this source segment's first
// item through the item before the next authored top-level list. This keeps
// compactness and marker style local even when Crepe has merged adjacent bullet
// lists into one canonical tree.
const nextTopLevelListFences = (markdown, block) => {
  const lines = markdownLines(markdown)
  const after = lines.findIndex((line) => line.start >= block.end)
  if (after < 0) return []
  for (let index = after; index < lines.length; index += 1) {
    const row = listMarkerRow(lines[index])
    if (row && row.indent.length === block.indent) {
      const nextBlock = listBlockAt(markdown, row.start, { splitBulletMarkers: true })
      if (!nextBlock) return [comparableListLine(row.text)].filter(Boolean)
      return listMarkerRows(markdown, nextBlock)
        .filter((candidate) => candidate.indent.length === block.indent)
        .map((candidate) => comparableListLine(candidate.text))
        .filter(Boolean)
    }
    // Keep a following paragraph as a text fence too. It may itself have been
    // converted into a list in `next`; without this fence, that newly-listified
    // paragraph would be incorrectly absorbed into the preceding source list.
    if (lines[index].text.trim() && !/^\s/.test(lines[index].text) && !row) {
      return [comparableListLine(lines[index].text)].filter(Boolean)
    }
  }
  return []
}

const canonicalListSegmentForSource = ({ source, sourceList, canonical, offset }) => {
  const sourceRows = listMarkerRows(source, sourceList)
  const anchors = sourceRows
    .map((row, sourceIndex) => ({ text: comparableListLine(row.text), sourceIndex }))
    .filter((anchor) => anchor.text)
  if (!anchors.length) return null
  const boundaries = nextTopLevelListFences(source, sourceList)
  // Do not constrain this lookup to `listBlockAt(canonical, changeOffset)`.
  // A just-added sibling can lie past that block's stale end boundary when a
  // deferred Crepe update includes the Enter transaction and its text together.
  // The authored next-list fence below is the real boundary we need here.
  const lines = markdownLines(canonical)
  const candidates = lines
    .map((line, index) => ({ line, index, comparable: comparableListLine(line.text) }))
    .flatMap((candidate) => anchors
      .filter((anchor) => anchor.text === candidate.comparable)
      .map((anchor) => ({ ...candidate, sourceIndex: anchor.sourceIndex })))
  if (!candidates.length) return null
  const candidate = candidates.reduce((best, current) => {
    const distance = Number.isFinite(offset)
      ? Math.abs(current.line.start - offset)
      : 0
    return !best || distance < best.distance ? { ...current, distance } : best
  }, null)
  let last = candidate.index
  let boundaryFound = !boundaries.length
  for (let index = candidate.index + 1; index < lines.length; index += 1) {
    const row = listMarkerRow(lines[index])
    if (
      row &&
      row.indent.length === sourceList.indent &&
      boundaries.includes(comparableListLine(row.text))
    ) {
      boundaryFound = true
      break
    }
    if (/^\s*<br\s*\/?>\s*$/i.test(lines[index].text)) {
      continue
    }
    if (lines[index].text.trim() && !row && !/^\s/.test(lines[index].text)) {
      if (boundaries.includes(comparableListLine(lines[index].text))) boundaryFound = true
      break
    }
    if (lines[index].text.trim()) last = index
  }
  if (!boundaryFound) return null
  return {
    start: candidate.line.start,
    end: lines[last].end,
    indent: sourceList.indent
  }
}

const authoredTopLevelListBlocks = (markdown) => {
  const blocks = new Map()
  markdownLines(markdown).forEach((line) => {
    const row = listMarkerRow(line)
    if (!row || row.indent.length !== 0) return
    const block = listBlockAt(markdown, line.start, { splitBulletMarkers: true })
    if (block) blocks.set(`${block.start}:${block.end}`, block)
  })
  return [...blocks.values()].sort((left, right) => left.start - right.start)
}

const applyStableListRowTextDelta = ({ sourceRow, previousRow, nextRow }) => {
  const sourceContent = sourceRow.text.slice(sourceRow.marker.prefixEnd)
  const previousContent = previousRow.text.slice(previousRow.marker.prefixEnd)
  const nextContent = nextRow.text.slice(nextRow.marker.prefixEnd)
  const sourceView = unescapedPunctuationView(sourceContent)
  const previousView = unescapedPunctuationView(previousContent)
  const nextView = unescapedPunctuationView(nextContent)
  if (sourceView.text !== previousView.text) return null

  const { start, previousEnd, nextEnd } = commonChange(previousView.text, nextView.text)
  const rawStart = sourceView.boundaries[start]
  const rawEnd = sourceView.boundaries[previousEnd]
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null
  const content = sourceContent.slice(0, rawStart) +
    nextView.text.slice(start, nextEnd) +
    sourceContent.slice(rawEnd)
  return sourceRow.text.slice(0, sourceRow.marker.prefixEnd) + content
}

const preserveOrdinalBatchedListRows = ({ source, previous, next, requireMultiple }) => {
  const rows = (markdown) => markdownLines(markdown)
    .map((line) => ({ ...line, marker: listMarkerRow(line) }))
    .filter((line) => line.marker && line.marker.indent.length === 0)
  const sourceRows = rows(source)
  const previousRows = rows(previous)
  const nextRows = rows(next)
  if (!sourceRows.length || sourceRows.length !== previousRows.length || previousRows.length !== nextRows.length) {
    return null
  }
  for (let index = 0; index < previousRows.length; index += 1) {
    const previousRow = previousRows[index]
    const nextRow = nextRows[index]
    if (
      previousRow.marker.token !== nextRow.marker.token ||
      previousRow.marker.indent !== nextRow.marker.indent ||
      previousRow.marker.task !== nextRow.marker.task
    ) return null
    if (index < previousRows.length - 1) {
      const previousGap = previous.slice(previousRow.end, previousRows[index + 1].start)
      const nextGap = next.slice(nextRow.end, nextRows[index + 1].start)
      if (previousGap !== nextGap) return null
    }
  }
  const replacements = []
  for (let index = 0; index < sourceRows.length; index += 1) {
    const sourceRow = sourceRows[index]
    const previousRow = previousRows[index]
    const nextRow = nextRows[index]
    if (comparableListLine(sourceRow.text) !== comparableListLine(previousRow.text)) return null
    if (previousRow.text === nextRow.text) continue
    const replacement = applyStableListRowTextDelta({ sourceRow, previousRow, nextRow })
    if (replacement == null) return null
    if (replacement === sourceRow.text) continue
    replacements.push({ ...sourceRow, replacement })
  }
  if (!replacements.length || (requireMultiple && replacements.length < 2)) return null
  return {
    markdown: replacements
      .sort((left, right) => right.start - left.start)
      .reduce(
        (markdown, replacement) =>
          markdown.slice(0, replacement.start) +
          adaptCanonicalRegionToSource(replacement.replacement, source, replacement) +
          markdown.slice(replacement.end),
        source
      ),
    preserved: true,
    reason: 'batched-list-row-changes'
  }
}

// Text replacement inside an existing item is not a list-structure change.
// When several independently-authored lists coexist, canonical Markdown can
// nevertheless use different markers and loose spacing. Update only stable
// rows whose text changed while requiring the complete canonical row/gap
// skeleton to remain identical; this prevents a local edit from formatting
// untouched neighbouring `-` / `+` / `*` lists like the serializer output.
export const preserveStableListRowChanges = ({ source, previous, next }) => {
  const rows = (markdown) => markdownLines(markdown)
    .map((line) => ({ ...line, marker: listMarkerRow(line) }))
    .filter((line) => line.marker && line.marker.indent.length === 0)
  const before = rows(previous)
  const after = rows(next)
  const hasStableRowTextChange = before.length === after.length && before.some((row, index) =>
    row.text !== after[index]?.text
  )
  if (!hasStableRowTextChange) return null
  return preserveOrdinalBatchedListRows({
    source,
    previous,
    next,
    requireMultiple: false
  })
}

const likelyMultiListDelta = ({ source, previous, next }) => {
  if (authoredTopLevelListBlocks(source).length < 2) return false
  if (sourceVisibleIndex(source).text !== sourceVisibleIndex(previous).text) return false
  const rows = (markdown) => markdownLines(markdown)
    .map((line) => {
      const marker = listMarkerRow(line)
      if (!marker || marker.indent.length !== 0) return null
      return {
        signature: `${marker.token}|${marker.task ?? ''}|${comparableListLine(line.text)}`,
        text: comparableListLine(line.text)
      }
    })
    .filter(Boolean)
  const beforeRows = rows(previous)
  const afterRows = rows(next)
  if (
    beforeRows.length === afterRows.length &&
    beforeRows.every((row, index) => row.text === afterRows[index].text)
  ) return false
  const before = beforeRows.map((row) => row.signature)
  const after = afterRows.map((row) => row.signature)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1
  return Math.max(before.length - prefix - suffix, after.length - prefix - suffix) >= 2
}

const blockedBatchedListResult = (source) => ({
  markdown: source,
  preserved: false,
  reason: 'unmapped-batched-list-change',
  blocked: true
})

// A markdownUpdated callback is sometimes deferred until several ordinary
// list edits have already happened (for example: add an item to `-`, add one
// to a following `+` list, then delete an item from a `*` list). The document
// delta then spans all three lists, so a single changed-list range is not
// meaningful. Reconcile every independently authored top-level list through
// its stable text fences instead. This remains fail-closed: each source block
// must align exactly with its previous canonical counterpart; otherwise the
// caller keeps the authored source untouched.
export const preserveBatchedListBlockChanges = ({
  source,
  previous,
  next,
  requireMultiple = false
}) => {
  const ordinalRows = preserveOrdinalBatchedListRows({ source, previous, next, requireMultiple })
  if (ordinalRows) return ordinalRows
  const stickyBlocked = requireMultiple && likelyMultiListDelta({ source, previous, next })
  const replacements = []
  for (const sourceList of authoredTopLevelListBlocks(source)) {
    const sourcePosition = sourceVisiblePositionAtRaw(source, sourceList.start)
    const previousOffset = sourceRawFromVisibleIndex(previous, sourcePosition.visibleIndex, 'forward')
    const previousList = canonicalListSegmentForSource({
      source,
      sourceList,
      canonical: previous,
      offset: previousOffset
    })
    const nextList = canonicalListSegmentForSource({
      source,
      sourceList,
      canonical: next,
      offset: previousOffset
    })
    if (!previousList || !nextList) {
      if (requireMultiple) return stickyBlocked ? blockedBatchedListResult(source) : null
      continue
    }

    const previousCanonicalList = previous.slice(previousList.start, previousList.end)
    const nextCanonicalList = next.slice(nextList.start, nextList.end)
    // A non-list edit (heading/body text) can run while authored list spelling
    // already differs from canonical (`-` vs `*`, compact vs loose, literal
    // underscores). Such an unchanged list is not part of this transaction.
    // Reformatting it here both normalizes untouched bytes and returns before
    // the real non-list delta is applied.
    if (previousCanonicalList === nextCanonicalList) continue

    const sourceText = comparableListText(source.slice(sourceList.start, sourceList.end))
    const previousText = comparableListText(previousCanonicalList)
    if (!sourceText || sourceText !== previousText) {
      if (requireMultiple) return stickyBlocked ? blockedBatchedListResult(source) : null
      continue
    }

    const replacement = formatCanonicalListLikeSource(
      source.slice(sourceList.start, sourceList.end),
      previousCanonicalList,
      nextCanonicalList
    )
    if (replacement === source.slice(sourceList.start, sourceList.end)) continue
    replacements.push({
      ...sourceList,
      replacement,
      nextStart: nextList.start,
      nextEnd: nextList.end
    })
  }
  if (!replacements.length || (requireMultiple && replacements.length < 2)) {
    return stickyBlocked ? blockedBatchedListResult(source) : null
  }
  const nextRanges = replacements
    .map(({ nextStart, nextEnd }) => ({ start: nextStart, end: nextEnd }))
    .sort((left, right) => left.start - right.start)
  if (nextRanges.some((range, index) => index > 0 && range.start < nextRanges[index - 1].end)) {
    return stickyBlocked ? blockedBatchedListResult(source) : null
  }

  return {
    markdown: replacements
      .sort((left, right) => right.start - left.start)
      .reduce(
        (markdown, replacement) =>
          markdown.slice(0, replacement.start) +
          adaptCanonicalRegionToSource(replacement.replacement, source, replacement) +
          markdown.slice(replacement.end),
        source
      ),
    preserved: true,
    reason: 'batched-list-block-changes'
  }
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
  // After removing the final text from a list item and pressing Enter, Crepe
  // can leave a standalone `<br />` immediately after the surviving list.
  // It is an editor placeholder for the now-empty block, not source authored
  // by the user. Permit that *local* tail while locating the list; the segment
  // formatter stops before it, so we do not persist it or erase real `<br />`
  // content elsewhere in the document.
  const nextTailIsGeneratedEmptyBlock = nextEnd > nextList.end &&
    /^[\s\r\n]*<br\s*\/?>\s*$/i.test(next.slice(nextList.end, nextEnd))
  if (start < previousList.start || start > previousList.end + 2 || previousEnd > previousList.end + 2) return null
  if (
    start < nextList.start ||
    start > nextList.end + 2 ||
    (nextEnd > nextList.end + 2 && !nextTailIsGeneratedEmptyBlock)
  ) return null

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

  // `previousList` may be a canonical bullet tree that starts at an earlier
  // neighbouring list (Crepe normalizes `-`/`+`/`*` into the same node). Map
  // the actual change, not that widened tree's start, back into authored
  // source; otherwise editing a `+` list rewrites the preceding `-` list.
  const changedPosition = sourceVisiblePositionAtRaw(previous, start)
  const rawInsideSource = sourceRawFromVisibleIndex(source, changedPosition.visibleIndex, 'forward')
  let sourceList = listBlockAt(source, rawInsideSource, { splitBulletMarkers: true })
  // A sibling inserted with Enter has a zero-width range in `previous` and
  // starts exactly where the following source list begins. Mapping that
  // boundary "forward" therefore lands on the following (`+`, `*`, …) list,
  // even though the new canonical row belongs to the preceding list. Prefer
  // that preceding authored list only for this exact structural insertion.
  const nextLineAtChange = lineAt(next, start)
  const sourceLineAtMappedPosition = Number.isFinite(rawInsideSource)
    ? lineAt(source, rawInsideSource)
    : null
  const sourceLineMarker = sourceLineAtMappedPosition
    ? listMarker(source.slice(sourceLineAtMappedPosition.start, sourceLineAtMappedPosition.end))
    : null
  if (
    previousEnd === start &&
    listMarker(next.slice(nextLineAtChange.start, nextLineAtChange.end)) &&
    sourceLineAtMappedPosition &&
    rawInsideSource >= sourceLineAtMappedPosition.start &&
    rawInsideSource <= sourceLineAtMappedPosition.end &&
    sourceLineMarker
  ) {
    const precedingList = listBlockAt(source, sourceLineAtMappedPosition.start - 1, { splitBulletMarkers: true })
    if (
      precedingList &&
      precedingList.indent === sourceLineMarker[1].length &&
      precedingList.end < sourceLineAtMappedPosition.start
    ) {
      sourceList = precedingList
    }
  }
  if (!sourceList) {
    // Appending through the paragraph immediately after a list has no visible
    // list character at the delta start. Only in that boundary case fall back
    // to the canonical list start; normal edits must keep the exact changed
    // position above so neighbouring `-`/`+`/`*` lists stay separate.
    const listStart = sourceVisiblePositionAtRaw(previous, previousList.start)
    const fallbackRaw = sourceRawFromVisibleIndex(source, listStart.visibleIndex, 'forward')
    sourceList = listBlockAt(source, fallbackRaw, { splitBulletMarkers: true })
  }
  if (!sourceList) return null

  const narrowedPreviousList = canonicalListSegmentForSource({
    source,
    sourceList,
    canonical: previous,
    offset: start
  })
  const narrowedNextList = canonicalListSegmentForSource({
    source,
    sourceList,
    canonical: next,
    offset: start
  })
  if (!narrowedPreviousList || !narrowedNextList) return null
  const sourceListText = comparableListText(source.slice(sourceList.start, sourceList.end))
  const narrowedPreviousText = comparableListText(previous.slice(narrowedPreviousList.start, narrowedPreviousList.end))
  if (
    !sourceListText ||
    !narrowedPreviousText ||
    !listTextIsSubsequence(sourceListText, narrowedPreviousText) ||
    !listTextIsSubsequence(narrowedPreviousText, sourceListText)
  ) return null

  const replacement = formatCanonicalListLikeSource(
    source.slice(sourceList.start, sourceList.end),
    previous.slice(narrowedPreviousList.start, narrowedPreviousList.end),
    next.slice(narrowedNextList.start, narrowedNextList.end)
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

// remark parses `- 1. 甲乙` as a nested ordered list (`1. 甲`, `2. 乙`): the
// list markers leave the canonical visible stream, while the authored source
// keeps `1. ` as literal item text — the two visible streams diverge from that
// line onward. Every localized mapper then fails and any list-internal edit
// (text change, Enter split that adds an item, item removal) is rolled back to
// the OLD source or glued onto the wrong row. Fix: align the canonical top-level
// list block's FLATTENED item-text sequence (every nested marker row, skipping
// the empty outer `* ` wrappers) against the authored top-level item rows by
// ordinal, then apply the item-level diff (text edit / insert / delete) back
// onto the authored rows. A second marker is literal row text in the source
// (`- 1. xxx`, `- - xxx`) but nested-list syntax in the canonical, so matching
// strips exactly one leading ordered/bullet marker from authored item text.
export const preserveDivergedNestedListChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousList = outerTopLevelListBlock(previous, start)
  if (!previousList) return null

  // Locate the authored counterpart by ordinal: Crepe serializes each authored
  // top-level row as one `* ` wrapper + nested rows, so block order is stable.
  const previousBlocks = topLevelListBlocksInSourceOrder(previous)
  const previousIndex = previousBlocks.findIndex((block) =>
    block.start === previousList.start && block.end === previousList.end
  )
  if (previousIndex < 0) return null
  const sourceBlocks = topLevelListBlocksInSourceOrder(source)
  const sourceList = sourceBlocks[previousIndex]
  if (!sourceList) return null

  const previousItems = flatListItemRows(previous.slice(previousList.start, previousList.end))
  const sourceItems = sourceListItemRows(source.slice(sourceList.start, sourceList.end))
  if (!sourceItems.length) return null
  const nestedMarkerPrefixLength = (row) =>
    row.text.match(/^(?:[-+*]|\d{1,9}[.)])\s+/)?.[0]?.length || 0
  const authoredCanonicalText = (row) => row.text.slice(nestedMarkerPrefixLength(row))
  const nextList = outerTopLevelListBlock(next, start)
  if (!nextList) {
    // Backspace can fully lift the first list row into a plain paragraph. The
    // next canonical then starts with no list marker, so a marker-based lookup
    // cannot discover it. Accept only the exact leading-item transform and
    // require every remaining item to stay unchanged.
    const nextLine = lineAt(next, start)
    const liftedText = next.slice(nextLine.start, nextLine.end).replace(/\r$/, '').trim()
    if (!liftedText || previousItems[0]?.text !== liftedText) return null
    if (authoredCanonicalText(sourceItems[0] || { text: '' }) !== previousItems[0].text) return null
    const remainingPrevious = previousItems.slice(1)
    const remainingSource = sourceItems.slice(1)
    if (remainingPrevious.length !== remainingSource.length) return null
    if (remainingPrevious.some((item, index) => authoredCanonicalText(remainingSource[index]) !== item.text)) return null
    const followingList = topLevelListBlocksInSourceOrder(next)
      .find((block) => block.start > nextLine.end)
    if (remainingPrevious.length) {
      if (!followingList) return null
      const followingItems = flatListItemRows(next.slice(followingList.start, followingList.end))
      if (followingItems.length !== remainingPrevious.length) return null
      if (followingItems.some((item, index) =>
        item.token !== remainingPrevious[index].token || item.text !== remainingPrevious[index].text
      )) return null
    } else if (followingList && followingList.start <= nextLine.end + 2) {
      return null
    }

    const eol = lineEndingNear(source, sourceList.start)
    const sourceBlock = source.slice(sourceList.start, sourceList.end)
    const remainingRaw = remainingSource.length
      ? sourceBlock.slice(remainingSource[0].start)
      : ''
    const replacement = canonicalTextToSource(liftedText) +
      (remainingRaw ? eol + eol + remainingRaw : '')
    const output = source.slice(0, sourceList.start) + replacement + source.slice(sourceList.end)
    const nextReplacementEnd = remainingPrevious.length ? followingList.end : nextLine.end
    const nextBaseline = !remainingPrevious.length &&
      !previous.slice(previousList.end).trim() &&
      !next.slice(nextLine.end).trim()
      ? next
      : previous.slice(0, previousList.start) +
        next.slice(nextLine.start, nextReplacementEnd) +
        previous.slice(previousList.end)
    return {
      markdown: output,
      preserved: true,
      reason: 'diverged-nested-list-change',
      nextBaseline
    }
  }
  const nextItems = flatListItemRows(next.slice(nextList.start, nextList.end))

  // Align every non-empty previous canonical item with an authored row (loose
  // match strips the author's literal numbering prefix `1. `). Enter inside an
  // item splits one authored row into several canonical items, so a row whose
  // text equals the CONCATENATION of consecutive canonical items also aligns
  // (each item records its in-row offset). An empty canonical item is a
  // freshly-Entered row with no authored counterpart yet. Anything unalignable
  // fails closed.
  const aligned = []
  let sourceIndex = 0
  let itemIndex = 0
  while (itemIndex < previousItems.length) {
    const item = previousItems[itemIndex]
    if (!item.text) {
      // An empty canonical item corresponds to an authored EMPTY row
      // (`- 3. `, the Enter step's output) when one is available; otherwise it
      // is a freshly-Entered row with no authored counterpart yet.
      let matchedRow = null
      for (let scan = sourceIndex; scan < sourceItems.length; scan += 1) {
        if (authoredCanonicalText(sourceItems[scan]) === '') {
          matchedRow = scan
          break
        }
      }
      if (matchedRow != null) {
        aligned.push({
          row: matchedRow,
          at: nestedMarkerPrefixLength(sourceItems[matchedRow]),
          span: false
        })
        sourceIndex = matchedRow + 1
      } else {
        aligned.push({ row: null, at: 0, span: false })
      }
      itemIndex += 1
      continue
    }
    if (sourceIndex >= sourceItems.length) return null
    const sourceRow = sourceItems[sourceIndex]
    const target = authoredCanonicalText(sourceRow)
    const prefixLength = nestedMarkerPrefixLength(sourceRow)
    if (target === item.text) {
      aligned.push({ row: sourceIndex, at: prefixLength, span: false })
      sourceIndex += 1
      itemIndex += 1
      continue
    }
    let concatenated = item.text
    let span = 1
    while (span < previousItems.length - itemIndex && concatenated.length < target.length) {
      const follower = previousItems[itemIndex + span]
      if (!follower.text) break
      concatenated += follower.text
      span += 1
    }
    if (concatenated !== target) return null
    let at = prefixLength
    for (let k = 0; k < span; k += 1) {
      const text = previousItems[itemIndex + k].text
      aligned.push({ row: sourceIndex, at, text, span: true })
      at += text.length
    }
    sourceIndex += 1
    itemIndex += span
  }

  // Item-level diff via common prefix/suffix.
  let prefix = 0
  const sameItem = (left, right) => left?.token === right?.token && left?.text === right?.text
  while (prefix < previousItems.length && prefix < nextItems.length &&
    sameItem(previousItems[prefix], nextItems[prefix])) prefix += 1
  let suffix = 0
  while (suffix < previousItems.length - prefix && suffix < nextItems.length - prefix &&
    sameItem(previousItems[previousItems.length - 1 - suffix], nextItems[nextItems.length - 1 - suffix])) {
    suffix += 1
  }
  const previousChanged = previousItems.length - prefix - suffix
  const nextChanged = nextItems.length - prefix - suffix
  if (!previousChanged && !nextChanged) return null

  // Map the diff onto authored rows: prefix rows align 1:1 by ordinal.
  let output = source
  const sourceRows = sourceItems
  let applyOffset = 0
  let insertionCursor = null
  const eol = lineEndingNear(source, sourceList.start)
  const authoredBullet = sourceRows.find((candidate) => /^[-+*]$/.test(candidate.token || ''))?.token || '-'
  const changedCount = Math.max(previousChanged, nextChanged)
  for (let i = 0; i < changedCount; i += 1) {
    const prevIndex = prefix + i
    const nextIndex = prefix + i
    const prevItem = prevIndex < previousItems.length - suffix ? previousItems[prevIndex] : null
    const nextItem = nextIndex < nextItems.length - suffix ? nextItems[nextIndex] : null
    const alignedItem = prevIndex < aligned.length ? aligned[prevIndex] : null
    const row = alignedItem && alignedItem.row != null ? sourceRows[alignedItem.row] : null
    if (prevItem && nextItem && (prevItem.text !== '' || (row != null && alignedItem.row != null))) {
      insertionCursor = null
      // Text change inside the same item.
      if (!row) return null
      const previousNumber = /^\d{1,9}[.)]$/.test(prevItem.token || '') ? prevItem.token : ''
      const nextNumber = /^\d{1,9}[.)]$/.test(nextItem.token || '') ? nextItem.token : ''
      if (!alignedItem.span && previousNumber !== nextNumber) {
        const sourceNumber = row.text.match(/^(\d{1,9}[.)])\s+/)
        if (previousNumber && sourceNumber?.[1] !== previousNumber) return null
        if (!previousNumber && sourceNumber) return null
        const oldPrefixLength = sourceNumber?.[0]?.length || 0
        const newPrefix = nextNumber ? `${nextNumber} ` : ''
        const rawStart = sourceList.start + row.contentStart + applyOffset
        const rawEnd = rawStart + oldPrefixLength
        output = output.slice(0, rawStart) + newPrefix + output.slice(rawEnd)
        applyOffset += newPrefix.length - oldPrefixLength
      }
      if (
        !alignedItem.span &&
        /^[-+*]$/.test(prevItem.token || '') &&
        !nextItem.token &&
        /^[-+*]$/.test(row.token || '')
      ) {
        // A final Backspace lifts the outer bullet item into an indented
        // continuation of the preceding item. Keep the text and replace only
        // the authored marker prefix with the canonical continuation indent.
        const rawStart = sourceList.start + row.start + applyOffset
        const rawEnd = sourceList.start + row.contentStart + applyOffset
        const continuationIndent = ' '.repeat(Math.max(1, Number(nextItem.indent) || row.indent + 2))
        output = output.slice(0, rawStart) + continuationIndent + output.slice(rawEnd)
        applyOffset += continuationIndent.length - (rawEnd - rawStart)
      }
      if (prevItem.text !== nextItem.text) {
        const rowText = row.text
        // Splitting alignment recorded the canonical text's in-row offset
        // (after the author's literal numbering `1. `); fall back to a loose
        // search for 1:1 rows.
        const at = alignedItem.at != null
          ? alignedItem.at
          : rowText.indexOf(prevItem.text, rowText.match(/^\d{1,9}[.)]\s+/)?.[0]?.length || 0)
        if (at < 0 || at + (prevItem.text || '').length > rowText.length) return null
        const rawStart = sourceList.start + row.contentStart + at + applyOffset
        const rawEnd = rawStart + prevItem.text.length
        const authoredText = canonicalTextToSource(nextItem.text)
        output = output.slice(0, rawStart) + authoredText + output.slice(rawEnd)
        applyOffset += authoredText.length - prevItem.text.length
      }
    } else if ((!prevItem || prevItem.text === '') && nextItem) {
      // New item: insert an authored row after the previous aligned row.
      let anchorRow = null
      for (let back = prevIndex - 1; back >= 0; back -= 1) {
        const candidate = aligned[back]
        if (candidate && candidate.row != null) {
          anchorRow = sourceRows[candidate.row]
          break
        }
      }
      const insertAt = insertionCursor != null
        ? insertionCursor
        : anchorRow
          ? sourceList.start + anchorRow.breakEnd + applyOffset
          : sourceList.start + applyOffset
      const anchorHasEol = Boolean(anchorRow && anchorRow.breakEnd > anchorRow.end)
      const leading = insertionCursor == null && anchorRow && !anchorHasEol ? eol : ''
      const prefix = !nextItem.token
        ? ' '.repeat(Math.max(1, Number(nextItem.indent) || 2))
        : /^\d/.test(nextItem.token)
          ? `${authoredBullet} ${nextItem.token} `
          : `${' '.repeat(Math.max(0, Number(nextItem.indent) || 0))}${authoredBullet} `
      const inserted = leading + prefix + canonicalTextToSource(nextItem.text) + eol
      output = output.slice(0, insertAt) + inserted + output.slice(insertAt)
      insertionCursor = insertAt + inserted.length
      applyOffset += inserted.length
    } else if (prevItem && prevItem.text !== '' && !nextItem) {
      insertionCursor = null
      // Item removed: drop its text (span row) or the whole authored row.
      if (!row) return null
      if (alignedItem.span) {
        const rawStart = sourceList.start + row.contentStart + alignedItem.at + applyOffset
        const rawEnd = rawStart + prevItem.text.length
        output = output.slice(0, rawStart) + output.slice(rawEnd)
        applyOffset -= rawEnd - rawStart
      } else {
        const rawStart = sourceList.start + row.start + applyOffset
        const rawEnd = sourceList.start + row.breakEnd + applyOffset
        output = output.slice(0, rawStart) + output.slice(rawEnd)
        applyOffset -= rawEnd - rawStart
      }
    }
  }

  const nextBaseline = previous.slice(0, previousList.start) +
    next.slice(nextList.start, nextList.end) +
    previous.slice(previousList.end)
  return {
    markdown: output,
    preserved: true,
    reason: output === source
      ? 'diverged-nested-list-canonical-only'
      : 'diverged-nested-list-change',
    nextBaseline
  }
}

const listStructure = (markdown, block) => {
  if (!block) return ''
  const lines = markdown.slice(block.start, block.end).split('\n')
  const structure = []
  let loose = false
  let sawMarker = false
  let pendingBlank = false
  for (const line of lines) {
    const match = line.match(/^(\s*)((?:[-+*])|(?:\d{1,9}[.)]))\s+(?:\[([ xX])\]\s+)?/)
    if (match) {
      if (sawMarker && pendingBlank) loose = true
      sawMarker = true
      pendingBlank = false
      const marker = /^\d/.test(match[2]) ? 'ordered' : 'bullet'
      const task = match[3] == null ? '' : `:${match[3].toLowerCase() === 'x' ? 'checked' : 'open'}`
      structure.push(`${match[1].length}:${marker}${task}`)
    } else if (!line.trim()) {
      // A blank line between two members is what separates one Markdown list
      // into two adjacent lists (or marks a loose list). Deleting it merges
      // them in the rich view; that structural edit must reach the list
      // preservation path instead of being mapped as a plain blank-line edit.
      if (sawMarker) pendingBlank = true
    } else {
      pendingBlank = false
    }
  }
  return structure.join('\n') + (loose ? '\nloose' : '')
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
