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

  const baseLineMarker = lines[markerIndex].text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=[ \t]+|$)/)
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
    const token = line.text.match(/^\s*([-+*]|\d{1,9}[.)])(?=[ \t]+|$)/)?.[1] || ''
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

// Return only the list ITEM rooted at the marker owning `offset`, including
// indented continuation/nested rows but never a same-or-shallower sibling.
// This is deliberately narrower than listBlockAt: an escaped standalone marker
// (`\\-`) gives us exact source-row ownership, so replacing the surrounding
// loose list would duplicate already-authored siblings.
const listItemAt = (markdown, offset) => {
  const lines = markdownLines(markdown)
  let index = lineIndexAt(lines, offset)
  if (index < 0) return null
  let markerIndex = -1
  for (let current = index; current >= 0; current -= 1) {
    if (listMarker(lines[current].text)) {
      markerIndex = current
      break
    }
    if (lines[current].text.trim() && !/^\s+/.test(lines[current].text)) return null
  }
  if (markerIndex < 0) return null
  const rootMatch = lines[markerIndex].text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=[ \t]+|$)/)
  if (!rootMatch) return null
  const rootIndent = rootMatch[1].length
  let endIndex = markerIndex
  for (let current = markerIndex + 1; current < lines.length; current += 1) {
    const line = lines[current]
    if (!line.text.trim()) continue
    const marker = listMarker(line.text)
    const indent = line.text.match(/^\s*/)?.[0]?.length || 0
    if (marker) {
      if (indent <= rootIndent) break
      endIndex = current
      continue
    }
    if (indent <= rootIndent) break
    endIndex = current
  }
  return {
    start: lines[markerIndex].start,
    end: lines[endIndex].end,
    indent: rootIndent,
    token: rootMatch[2]
  }
}

// A physical Space input rule can remap the pre-Space PM position into the
// PREVIOUS sibling once the literal paragraph becomes a list item. Therefore
// canonicalOffset is not authoritative for an already-published `\\-`. The
// previous canonical still contains that literal marker, though, and its
// visible position identifies its occurrence even when several `\\-` lines
// exist. Count same-indent bullet rows before that literal; after Space the new
// item occupies exactly that ordinal among same-indent bullets.
const bulletItemFromOwnedLiteralTransition = ({
  source,
  sourceLine,
  previous,
  next,
  marker
}) => {
  const sourceVisible = sourceVisiblePositionAtRaw(source, sourceLine.start).visibleIndex
  const previousLines = markdownLines(previous)
  const literalCandidates = previousLines
    .map((line) => {
      const match = line.text.match(/^(\s*)\\([-+*])$/)
      if (!match || match[2] !== marker) return null
      const visible = sourceVisiblePositionAtRaw(previous, line.start).visibleIndex
      return { line, match, distance: Math.abs(visible - sourceVisible) }
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance)
  if (!literalCandidates.length) return null
  if (literalCandidates[1]?.distance === literalCandidates[0].distance) return null
  const literal = literalCandidates[0]
  const indent = literal.match[1].length
  const bulletsBefore = previousLines.filter((line) => {
    if (line.start >= literal.line.start) return false
    const match = line.text.match(/^(\s*)([-+*])(?=[ \t]+|$)/)
    return Boolean(match && match[1].length === indent)
  }).length
  const nextBullets = markdownLines(next).filter((line) => {
    const match = line.text.match(/^(\s*)([-+*])(?=[ \t]+|$)/)
    return Boolean(match && match[1].length === indent)
  })
  const targetLine = nextBullets[bulletsBefore]
  return targetLine ? listItemAt(next, targetLine.start) : null
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
        text: String(match[3] || '').replace(/<br\s*\/?>\s*$/i, '').trim(),
        raw: line
      }
    }
    const continuation = line.match(/^(\s+)(\S.*)$/)
    if (!continuation) return null
    return {
      indent: continuation[1].length,
      token: '',
      text: continuation[2].trim(),
      raw: line
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
    rows.push({ token: row.token, text: row.text, indent: row.indent, raw: row.raw })
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
    // A bare empty item (`1.`, `-`) is a real authored row: remark parses it
    // as an empty list item, and the fingerprint already counts it as one
    // empty slot. The marker space is optional, so parse both spellings and
    // report the empty text with its content boundary after the marker.
    const match = line.match(/^(\s*)([-+*]|\d{1,9}[.)])(?:[ \t]+(.*))?$/)
    if (match) {
      if (baseIndent == null) baseIndent = match[1].length
      rows.push({
        start: lineStart,
        end: lineStart + line.length,
        breakEnd,
        contentStart: lineStart + match[1].length + match[2].length + (match[3] != null ? 1 : 0),
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
    // A nested EMPTY marker row is serialized with one structural blank line
    // before it (RS-64: CommonMark reads a bare nested marker as continuation
    // text without that separator). The Tab-sink inheritance must accept that
    // separator too, or it is dead code for exactly its target shape — the
    // new empty nested row — and a typed `-` leaks Crepe's `*` (0.13.183
    // trace 12:33:45).
    const separatorFromPrevious = previous
      ? markdown.slice(previous.end, nextLine.start)
      : ''
    const newlyNestedFromPrevious = previous &&
      previous.indent < nextIndent &&
      (/^(?:\r?\n)$/.test(separatorFromPrevious) ||
        /^\r?\n\r?\n$/.test(separatorFromPrevious))
    // Tab creates a child bullet list without a literal `-`/`+` input token,
    // so there is no input-rule intent to restore.  While the child has no
    // authored source row yet, inherit its parent bullet spelling rather than
    // leaking Crepe's `*`.  Only inherit the canonical default `*`: an
    // explicit nested `+`/`-` captured by an input rule must remain explicit.
    if (!preserveMarker && nextMarker === '*' && (uninterruptedFromPrevious || newlyNestedFromPrevious)) {
      preserveMarker = compatibleMarker(previous.marker, nextMarker)
    }
    // Enter at the end of a nested item exits to a NEW EMPTY row at a
    // SHALLOWER indent (e.g. `  * child` → new top-level empty bullet). The
    // previous sibling is deeper, so neither inheritance above applies and a
    // typed `-` used to flicker to the serializer default `*` until the next
    // edit re-matched by text. The new row is still empty and carries no
    // text anchor of its own; inherit the authored spelling of the nearest
    // PRECEDING canonical row at the SAME indent (looking it up by position
    // in the source list). Inheritance reads the spelling only — the source
    // row is NOT consumed, because its text-matched counterpart already used
    // it and the spelling legitimately describes the whole level.
    if (!preserveMarker && nextMarker === '*' && !listText(nextLine).trim()) {
      for (let back = index - 1; back >= 0; back -= 1) {
        const backLine = nextLines[back]
        if (!backLine) break
        const backIndent = backLine.match[1].length
        if (backIndent > nextIndent) continue
        if (backIndent < nextIndent) break
        // The nearest same-indent canonical row's authored spelling — find it
        // in the source by exact text (this row was proven to exist above us
        // with a stable spelling), else by the last source row at this indent.
        const backText = listText(backLine)
        const byText = sourceByText
          .get(`${nextIndent} ${backText}`)
          ?.find((candidate) => candidate.match[1].length === nextIndent)
        const sameLevelSource = byText ||
          sourceLines.filter((candidate) => candidate.match[1].length === nextIndent).at(-1)
        if (sameLevelSource) {
          const inherited = compatibleMarker(sameLevelSource.match[2], nextMarker)
          if (inherited) preserveMarker = inherited
        }
        break
      }
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

// Crepe does not reliably retain the ordered-list delimiter (`1.` vs `1)`)
// across structural edits: removing an empty ordered item can re-serialize a
// FOLLOWING ordered list's markers from `1)` to `1.` in the same transaction.
// That serializer-only flip inflates the common-change span so the following
// list's text is treated as edited content, which used to make the
// empty-item-removed mapper fail its guard and let the empty-list-fill mapper
// replace the whole list block (deleting the following list). The authored
// delimiter lives in the source and is carried forward by the list mappers,
// so normalizing it here — line-start ordered markers only, never literal
// text, and length-preserving — makes the diff see only the real edit.
export const normalizeOrderedListDelimiters = (markdown) => String(markdown || '')
  .replace(/^([ \t]*)(\d{1,9})[.)](?=[ \t]|$)/gm, '$1$2.')

// Rich-text-created documents have no authored list spacing to preserve yet.
// Crepe can transiently serialize a newly indented NON-EMPTY item as a loose
// list (`2. item\n\n   1. child`) when several keyboard transactions are
// batched. Generate the compact Markdown users expect from incremental typing.
//
// An EMPTY nested item is different: `1. parent\n   1. ` is not parsed back as
// a nested ordered list by remark; it becomes a hard break plus literal `1.` in
// the parent paragraph. Crepe serializes that editor state as
// `1. parent\n\n   1. <br />`. After normalizeEmptyListItems removes the
// editor-only `<br />`, the blank line is still structural authored Markdown and
// must remain. Only preserve that separator when the next row is both deeper
// and empty; same-level empty rows and non-empty nested rows remain compact.
export const compactGeneratedListSpacing = (markdown) => String(markdown || '')
  .replace(
    /(^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+[^\n]*)\n(?:[ \t]*\n)+(?=([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)([^\n]*))/gm,
    (match, currentLine, currentIndent, nextIndent, _markerSpacing, nextBody) => {
      const nestedEmptyItem =
        nextIndent.length > currentIndent.length &&
        String(nextBody || '').trim() === ''
      return nestedEmptyItem ? match : `${currentLine}\n`
    }
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

  // Strongest ownership proof: the previous dash callback has already written
  // an exact standalone escaped marker (`\\-`, `\\*`, `\\+`) into source. In
  // that case the captured PM/canonical offset owns ONE list item, not the
  // entire loose list block around it. Crepe can serialize an older sibling
  // list and this new empty item as one canonical list; rebuilding that whole
  // block here duplicated the siblings in the real human Enter→Enter→'-'→Space
  // sequence. Isolate only the item rooted at the captured offset.
  let ownedSourceLine = null
  if (Number.isFinite(sourceOffset)) {
    const sourceLine = lineAt(source, sourceOffset)
    const sourceMatch = source.slice(sourceLine.start, sourceLine.end).match(
      isBullet
        ? /^([ \t]*)\\([-+*])$/
        : /^([ \t]*)(\d{1,9}[.)])$/
    )
    if (sourceMatch?.[2] === marker) ownedSourceLine = sourceLine
  }
  const ownedCanonicalItem = ownedSourceLine && isBullet
    ? bulletItemFromOwnedLiteralTransition({
        source,
        sourceLine: ownedSourceLine,
        previous,
        next: normalizedCanonical,
        marker
      })
    : null
  if (ownedSourceLine && isBullet && (
    !ownedCanonicalItem ||
    !/^[-+*]$/.test(ownedCanonicalItem.token) ||
    ownedCanonicalItem.end < change.start || ownedCanonicalItem.start > change.nextEnd
  )) return null

  // Without exact escaped-bullet ownership, retain the established deferred-
  // batch behavior (including ordered lists): the first list introduced by the
  // delta wins over a potentially stale live caret.
  const canonicalList = ownedCanonicalItem ||
    listBlocksInSourceOrder(normalizedCanonical)
      .find((block) => block.start >= change.start && block.end <= change.nextEnd) ||
    listBlockAt(normalizedCanonical, canonicalOffset)
  if (!canonicalList) return null
  const canonicalLine = lineAt(normalizedCanonical, canonicalList.start)
  if (!/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(normalizedCanonical.slice(canonicalLine.start, canonicalLine.end))) return null

  // Crepe serializes a freshly-indented nested item as a loose list (a blank
  // line before the child) when several keyboard transactions batch into one
  // deferred markdownUpdated. The generic new-document path compacts this via
  // compactGeneratedListSpacing; the rebuilt region must match that, or source
  // gains a spurious blank line that the user never sees in rich text.
  const replacement = compactGeneratedListSpacing(normalizedCanonical
    .slice(canonicalList.start, canonicalList.end)
    .replace(/^(\s*)(?:[-+*]|\d{1,9}[.)])(?=\s)/m, `$1${marker}`))
  if (!replacement) return null
  const listWasCreatedInChange = canonicalList.start >= change.start && canonicalList.end <= change.nextEnd

  if (ownedSourceLine) {
    return source.slice(0, ownedSourceLine.start) +
      adaptCanonicalRegionToSource(replacement, source, ownedSourceLine) +
      source.slice(ownedSourceLine.end)
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
    sourceSlotRawStart <= source.length &&
    sourceSlotRawStart <= insertionSource.length &&
    listWasCreatedInChange
  ) {
    // The slot is a blank-line boundary. Verify its surrounding bytes are
    // unchanged since capture; a drift means an earlier block was edited and
    // the raw offset no longer owns the same gap.
    const contextStart = Math.max(0, sourceSlotRawStart - 24)
    const capturedBefore = source.slice(contextStart, sourceSlotRawStart)
    const currentBefore = insertionSource.slice(
      sourceSlotRawStart - capturedBefore.length,
      sourceSlotRawStart
    )
    if (capturedBefore !== currentBefore) return null
    const isTailSlot = sourceSlotRawStart === source.length
    if (!isTailSlot) {
      const capturedAfter = source.slice(sourceSlotRawStart, sourceSlotRawStart + 24)
      const currentAfter = insertionSource.slice(sourceSlotRawStart, sourceSlotRawStart + capturedAfter.length)
      if (capturedAfter !== currentAfter) return null
    }
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
      const trailingBreaks = trailing.match(/^(?:\r?\n)+/)?.[0] || ''
      const breaksAfter = (trailingBreaks.match(/\r\n|\n/g) || []).length
      // `blockEndInRest` already consumed the line break terminating the last
      // list row. One further break is therefore the normal blank-line block
      // separator (`item\n\nnext`). Requiring two here rejected the ordinary
      // case and let the serializer's `*` survive.
      if (breaksAfter < 1) return null
      const end = sourceSlotRawStart + leadingBreaks + blockEndInRest + trailingBreaks.length
      const eol = lineEndingNear(insertionSource, sourceSlotRawStart)
      const adaptedReplacement = adaptCanonicalRegionToSource(cleanReplacement, insertionSource, {
        start: sourceSlotRawStart,
        end: sourceSlotRawStart
      })
      return insertionSource.slice(0, sourceSlotRawStart) +
        adaptedReplacement + eol + eol + insertionSource.slice(end)
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

// Apply the input-rule reconstruction only to source bytes whose ownership is
// proven by the captured intent. When the current authored source is still the
// captured snapshot, the standalone marker line is the complete owned range:
// generic preservation is allowed to disagree inside that line, but nowhere
// before or after it. This keeps a correct `\\-` -> `- ` reconstruction
// from being rejected merely because the generic candidate already rewrote
// the same marker to Crepe's default `* `.
export const preserveOwnedTypedBulletInputRule = ({
  source,
  currentSource = source,
  preservedSource = currentSource,
  ...args
}) => {
  const captured = String(source || '')
  const current = String(currentSource || '')
  const preserved = String(preservedSource || '')
  const isBullet = /^[-+*]$/.test(args.marker || '')
  const isOrdered = /^\d{1,9}[.)]$/.test(args.marker || '')
  let ownedLine = null

  if (current === captured && Number.isFinite(args.sourceOffset)) {
    const line = lineAt(captured, args.sourceOffset)
    const match = captured.slice(line.start, line.end).match(
      isBullet
        ? /^([ \t]*)\\([-+*])$/
        : isOrdered
          ? /^([ \t]*)(\d{1,9}[.)])$/
          : /$a/
    )
    if (match?.[2] === args.marker) ownedLine = line
  }

  const markdown = preserveTypedBulletInputRule({
    source: captured,
    insertionSource: ownedLine ? current : preserved,
    ...args
  })
  if (typeof markdown !== 'string') return null

  if (ownedLine) {
    const prefix = current.slice(0, ownedLine.start)
    const suffix = current.slice(ownedLine.end)
    return markdown.startsWith(prefix) && markdown.endsWith(suffix)
      ? markdown
      : null
  }

  // For a delayed intent whose captured snapshot is no longer current, retain
  // the previous fail-closed raw-slot proof. No attempt is made to merge
  // unrelated edits or to relocate a stale slot.
  if (Number.isFinite(args.sourceSlotRawStart)) {
    const boundary = args.sourceSlotRawStart
    if (
      markdown.slice(0, boundary) !== preserved.slice(0, boundary) ||
      markdown.slice(0, boundary) !== captured.slice(0, boundary)
    ) {
      return null
    }
  }
  return markdown
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
  // Only restore the same ordinal with different punctuation (`1.` -> `1)`
  // or the reverse). Entering a new row makes the changed canonical line a
  // *different* ordinal (`2.` after typing `1.`); rewriting it would corrupt
  // the auto-numbered next item and fail the list-slot integrity check.
  const changedOrderedCandidate = isOrdered && changedLine &&
    /^\d{1,9}[.)]$/.test(changedLine.match[2]) &&
    changedLine.match[2].slice(0, -1) === marker.slice(0, -1) &&
    changedLine.match[2] !== marker
    ? changedLine
    : null
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
  // The full-document delta is only a reliable target while the intent's own
  // captured position lands on the same changed row. After Enter creates the
  // next auto-numbered item, the change begins on the *new* row while the
  // stale intent still points at the old item: applying the old marker there
  // would rewrite `2.` back to `1.` and trip the list-slot integrity check.
  const offsetTargetLine = offsetTarget ? offsetTarget.line : null
  const changedLineMatchesOffset = Boolean(
    changedLine && offsetTargetLine &&
    changedLine.start === offsetTargetLine.start &&
    changedLine.end === offsetTargetLine.end
  )
  // Only a *nearby* offset (the intent's own captured position) can veto the
  // changed-line fallback: after Enter the caret sits on the new auto-numbered
  // row while the stale intent still belongs to the old item. A far-away or
  // missing offset is a stale pre-input position, so the concrete changed row
  // remains the reliable target (deferred callback / nested-list cases).
  const offsetIsTrustworthy = Boolean(offsetTarget && offsetTarget.distance <= 4)
  const fallbackTarget = changedLine &&
    (!offsetTarget || !offsetIsTrustworthy || changedLineMatchesOffset)
    ? { line: changedLine, distance: 0 }
    : null
  const target = changedOrderedCandidate
    ? { line: changedOrderedCandidate, distance: 0 }
    : orderedDefaultCandidate
      ? { line: orderedDefaultCandidate.line || orderedDefaultCandidate, distance: 0 }
      : nearbyOffsetTarget || fallbackTarget
  if (!target) return markdown

  if (isOrdered) {
    // Ordered punctuation is item-specific: applying a new `1.` to every row
    // at this depth would corrupt existing `2.` / `3.` rows. The canonical and
    // generated strings share list-row order, so patch only the created row.
    // The typed ordinal is part of the intent: `1.` may only restore a row
    // that already carries the same ordinal (`1)` -> `1.`). Enter auto-numbers
    // the next row as `2.`, so a stale `1.` intent must never rewrite it;
    // doing so trips the list-slot integrity check and blocks saving.
    if (target.line.match[2].slice(0, -1) !== marker.slice(0, -1)) return markdown
    const sourceLines = listMarkerTokenLines(String(markdown || ''))
    const lineContent = (line) => line.text
      .replace(/^\s*\d{1,9}[.)]\s+/, '')
      .replace(/<br\s*\/?>\s*$/i, '')
      .trim()
    // Source and canonical do not always have the same marker-row ordinal:
    // an authored line such as `- 1. text` is one source row but can serialize
    // as an outer bullet plus a nested ordered row. For repeated item text,
    // retain the occurrence ordinal within the same indent/content group
    // instead of using the document-global list-row index.
    const targetContent = lineContent(target.line)
    const canonicalMatches = canonicalLines.filter((line) =>
      line.match[1].length === target.line.match[1].length &&
      lineContent(line) === targetContent
    )
    const targetOccurrence = canonicalMatches.findIndex((line) => line.start === target.line.start)
    const sourceMatches = sourceLines.filter((line) =>
      line.match[1].length === target.line.match[1].length &&
      lineContent(line) === targetContent
    )
    const sourceLine = sourceMatches[targetOccurrence] || null
    if (Array.isArray(globalThis.__hmListMarkerRestoreTrace)) {
      globalThis.__hmListMarkerRestoreTrace.push({
        marker,
        canonicalOffset,
        changedLine: changedLine ? { start: changedLine.start, end: changedLine.end, token: changedLine.match[2], text: changedLine.text } : null,
        target: { start: target.line.start, end: target.line.end, token: target.line.match[2], text: target.line.text },
        targetOccurrence,
        canonicalMatches: canonicalMatches.map((line) => ({ start: line.start, token: line.match[2], text: line.text })),
        sourceMatches: sourceMatches.map((line) => ({ start: line.start, token: line.match[2], text: line.text })),
        sourceLine: sourceLine ? { start: sourceLine.start, token: sourceLine.match[2], text: sourceLine.text } : null
      })
      if (globalThis.__hmListMarkerRestoreTrace.length > 20) globalThis.__hmListMarkerRestoreTrace.shift()
    }
    if (!sourceLine || !/^\d/.test(sourceLine.match[2])) return markdown
    const start = sourceLine.start + sourceLine.match[1].length
    const end = start + sourceLine.match[2].length
    return markdown.slice(0, start) + marker + markdown.slice(end)
  }

  const targetBlock = listBlockAt(canonicalText, target.line.start)
  if (!targetBlock) return markdown
  const targetIndent = target.line.match[1].length
  const targetRows = canonicalLines
    .filter((line) =>
      line.start >= targetBlock.start &&
      line.end <= targetBlock.end &&
      line.match[1].length === targetIndent
    )
  if (!targetRows.length) return markdown

  // `sourceLines[ordinal]` uses the ordinal of every bullet in the complete
  // document. That is wrong once an earlier list has a different authored
  // marker or nesting: the first row of this newly-created list can be paired
  // with an unrelated old row, leaving the typed `-` as Crepe's `*`. Locate
  // this list locally by its first item text, then align only rows within that
  // source block. The visible text is a stronger anchor than a global marker
  // ordinal and remains valid when earlier source/canonical streams diverge.
  const bulletContent = (line) => line.text
    .replace(/^\s*[-+*]\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/<br\s*\/?>\s*$/i, '')
    .trim()
  const sourceBulletLines = bulletMarkerLines(String(markdown || ''))
  const sourceVisibleHint = sourceVisiblePositionAtRaw(previousText, targetBlock.start)
  const sourceRawHint = sourceRawFromVisibleIndex(
    String(markdown || ''),
    sourceVisibleHint.visibleIndex,
    'forward'
  )
  const firstContent = bulletContent(targetRows[0])
  const firstCandidates = sourceBulletLines
    .filter((line) => line.match[1].length === targetIndent && bulletContent(line) === firstContent)
    .sort((left, right) => Math.abs(left.start - sourceRawHint) - Math.abs(right.start - sourceRawHint))
  const sourceFirst = firstCandidates[0]
  const sourceBlock = sourceFirst
    ? listBlockAt(String(markdown || ''), sourceFirst.start)
    : null
  const sourceRows = sourceBlock
    ? sourceBulletLines.filter((line) =>
        line.start >= sourceBlock.start &&
        line.end <= sourceBlock.end &&
        line.match[1].length === targetIndent
      )
    : []
  if (sourceRows.length < targetRows.length) return markdown

  const offsets = []
  for (let index = 0; index < targetRows.length; index += 1) {
    const targetRow = targetRows[index]
    const matchingRows = sourceRows.filter((row) => bulletContent(row) === bulletContent(targetRow))
    const sourceRow = matchingRows.length === 1 ? matchingRows[0] : sourceRows[index]
    if (!sourceRow || bulletContent(sourceRow) !== bulletContent(targetRow)) return markdown
    const offset = sourceRow.start + sourceRow.match[1].length
    if (markdown[offset] !== marker) offsets.push(offset)
  }
  return offsets
    .sort((left, right) => right - left)
    .reduce(
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

const markdownIndentWidth = (indent) => {
  let width = 0
  for (const character of String(indent || '')) {
    width += character === '\t' ? 4 - (width % 4) : 1
  }
  return width
}

const indentAtLeast = (indent, minimumWidth) => {
  const width = markdownIndentWidth(indent)
  return width >= minimumWidth
    ? indent
    : `${indent}${' '.repeat(minimumWidth - width)}`
}

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
    const previousIndentWidth = markdownIndentWidth(previousRow.indent)
    const nextIndentWidth = markdownIndentWidth(nextRow.indent)
    // When an ancestor marker grows (`- ` -> `1. `), canonical Markdown moves
    // descendant markers right by the extra content-indent column. Preserve a
    // wider authored indent exactly, but raise a narrower one to the new
    // parse-safe minimum. Decreasing marker width never rewrites authored
    // indentation, and tabs remain untouched when already sufficient.
    const indent = nextIndentWidth > previousIndentWidth
      ? indentAtLeast(sourceRow.indent, nextIndentWidth)
      : sourceRow.indent
    const markerChanged =
      previousRow.kind !== nextRow.kind ||
      previousRow.task !== nextRow.task
    if (!markerChanged && indent === sourceRow.indent) continue

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
      text: `${indent}${token}${sourceRow.spacing}${task}${sourceRow.text.slice(sourceRow.prefixEnd)}`
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
    const nextNonBlankIndex = lines.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.trim()
    )
    if (nextNonBlankIndex < 0) return true
    const nextNonBlank = lines[nextNonBlankIndex]
    if (!listMarker(nextNonBlank)) return true

    // RS-64: a compact parent item followed immediately by a BARE nested empty
    // marker is not valid nested-list Markdown: CommonMark treats the marker as
    // continuation text (`parent\n*`). Crepe's canonical deliberately inserts
    // one blank line before `  * <br />` / `   1. <br />`; that separator is
    // structural, not loose-list formatting. Keep exactly the blank line
    // immediately before a nested empty marker while still removing ordinary
    // serializer padding from compact authored lists.
    const nextRowMeta = nextMeta[nextNonBlankIndex]
    const nestedEmptyListItem = Boolean(
      nextRowMeta?.depth > 0 && !comparableListLine(nextNonBlank)
    )
    if (nestedEmptyListItem) return nextNonBlankIndex === index + 1
    return false
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
    .replace(/^\s*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX]\]\s+)?/, '')
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
  // Filling an authored empty item with exactly `1.` / `1)` is serialized by
  // Crepe as a protective `1\\.` / `1\\)`. The generic unescaped view below
  // intentionally removes punctuation escapes for ordinary text deltas, but
  // doing that for the entire newly-filled body changes Markdown structure.
  if (!previousContent.trim() && /^\s*\d{1,9}\\[.)]\s*$/.test(nextContent)) {
    return sourceRow.text.slice(0, sourceRow.marker.prefixEnd) + nextContent
  }
  // After the ordered input rule's transient `1. ` frame, typing ordinary
  // body text makes Crepe serialize the same bullet item back as the literal
  // text `1\\. body`. The generic punctuation view deliberately erases that
  // protective escape and would persist `- 1. body`, changing the authored
  // bullet into nested ordered-list syntax. Restore the canonical escaped body
  // only for this exact reversible transition: the prior body must consist of
  // one ordered marker plus whitespace, and next must use the same number and
  // delimiter as an escaped literal followed by whitespace/body text.
  const previousTransientOrdered = previousContent.match(/^\s*(\d{1,9})([.)])[ \t]+$/)
  const nextEscapedOrderedLiteral = nextContent.match(/^\s*(\d{1,9})\\([.)])(?:[ \t]+.*)?$/)
  if (
    previousTransientOrdered &&
    nextEscapedOrderedLiteral &&
    previousTransientOrdered[1] === nextEscapedOrderedLiteral[1] &&
    previousTransientOrdered[2] === nextEscapedOrderedLiteral[2]
  ) {
    return sourceRow.text.slice(0, sourceRow.marker.prefixEnd) + nextContent
  }

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
  const filledTrailingEmptyItem = /(?:^|\r?\n)[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]*\r?\n?$/.test(source) &&
    /(?:\r?\n){2,}$/.test(next)
  let markdown = replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (updated, replacement) =>
        updated.slice(0, replacement.start) +
        adaptCanonicalRegionToSource(replacement.replacement, source, replacement) +
        updated.slice(replacement.end),
      source
    )
  if (filledTrailingEmptyItem) {
    markdown += lineEndingNear(source, source.length)
  }
  return {
    markdown,
    preserved: true,
    reason: 'batched-list-row-changes',
    // The first characters typed into a newly-created final list item replace
    // `- ` while ProseMirror retains the following empty paragraph. That
    // paragraph owns one additional terminal newline. Ordinary edits to an
    // already-authored non-empty final item do not satisfy this guard and keep
    // their exact trailing-EOL count.
    trailingNewlineGrowth: filledTrailingEmptyItem ? 1 : 0
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

// A fast continuation can arrive as one canonical insertion that starts at
// the end of an existing list row, adds one or more sibling rows, exits the
// list, and fills the adjacent paragraph. On a globally diverged document the
// normal visible offset can point at an earlier duplicate. Anchor the exact
// unchanged row by its complete comparable line instead, require that anchor
// to be unique, and splice only the insertion before an unchanged suffix.
export const preserveDivergedListContinuation = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  if (previousEnd !== start || nextEnd <= start) return null
  const previousRange = lineAt(previous, start)
  const previousLine = {
    ...previousRange,
    text: previous.slice(previousRange.start, previousRange.end)
  }
  if (start !== previousLine.end) return null
  const previousMarker = listMarkerRow(previousLine)
  if (!previousMarker || previousMarker.indent.length !== 0) return null
  const replacement = next.slice(start, nextEnd)
  if (!replacement.includes('\n')) return null

  const target = comparableListLine(previousLine.text)
  if (!target) return null
  const candidates = markdownLines(source)
    .map((line) => ({ ...line, marker: listMarkerRow(line) }))
    .filter((line) =>
      line.marker &&
      line.marker.indent.length === previousMarker.indent.length &&
      comparableListLine(line.text) === target
    )
  if (candidates.length !== 1) return null
  const sourceLine = candidates[0]
  const sourceKind = /^\d/.test(sourceLine.marker.token) ? 'ordered' : 'bullet'
  const previousKind = /^\d/.test(previousMarker.token) ? 'ordered' : 'bullet'
  if (sourceKind !== previousKind) return null

  // The untouched following region is the right fence. Visible equivalence is
  // sufficient here because only the zero-width insertion is replaced; no
  // suffix byte is copied from canonical Markdown.
  if (
    sourceVisibleIndex(source.slice(sourceLine.end)).text !==
    sourceVisibleIndex(previous.slice(previousLine.end)).text
  ) return null

  const eol = lineEndingNear(source, sourceLine.end)
  const sourceToken = sourceLine.marker.token
  const adaptedRows = replacement
    .replace(/\r?\n(?:[ \t]*\r?\n)+(?=[ \t]*(?:[-+*]|\d{1,9}[.)])\s)/g, eol)
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*)([-+*]|\d{1,9})([.)]?)(?=\s)/, (whole, indent, token, punctuation) => {
      if (indent.length !== sourceLine.marker.indent.length) return whole
      const rowKind = /^\d/.test(token) ? 'ordered' : 'bullet'
      if (rowKind !== sourceKind) return whole
      return sourceKind === 'bullet'
        ? `${indent}${sourceToken}`
        : `${indent}${token}${sourceToken.slice(-1)}`
    }))
    .join(eol)
  // `markdownLines()` keeps the `\r` in a CRLF row's text range. The edit
  // belongs before that line ending, never between `\r` and `\n`.
  const sourceContentEnd = sourceLine.text.endsWith('\r')
    ? sourceLine.end - 1
    : sourceLine.end
  const insertion = adaptCanonicalRegionToSource(adaptedRows, source, {
    start: sourceContentEnd,
    end: sourceContentEnd
  })
  return {
    markdown: source.slice(0, sourceContentEnd) + insertion + source.slice(sourceContentEnd),
    preserved: true,
    reason: 'diverged-list-continuation'
  }
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
        text: comparableListLine(line.text),
        start: line.start,
        end: line.end
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
  if (Math.max(before.length - prefix - suffix, after.length - prefix - suffix) < 2) return false
  // A single list growing by several rows (fill an empty item, then Enter to
  // create the next item) changes just as many rows but is ONE list's
  // structural edit and must stay with the single-list mapper. A blank line
  // between changed rows marks the user-visible boundary of an independent
  // list (CommonMark merges adjacent `-`/`+`/`*` runs into one block, so a
  // canonical block check cannot see that boundary). Check both sides:
  // deleted rows live in the `previous` range, inserted rows in `next`.
  const blankBetweenChangedRows = (rowsArr, markdown, length) => {
    for (let index = prefix + 1; index < length - suffix; index += 1) {
      const gap = markdown.slice(rowsArr[index - 1].end, rowsArr[index].start)
      if (/\n[ \t]*\n/.test(gap)) return true
    }
    return false
  }
  return blankBetweenChangedRows(beforeRows, previous, before.length) ||
    blankBetweenChangedRows(afterRows, next, after.length)
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
  requireMultiple = false,
  allowPartial = false
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
      previousStart: previousList.start,
      previousEnd: previousList.end,
      nextCanonicalList,
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

  const markdown = [...replacements]
      .sort((left, right) => right.start - left.start)
      .reduce(
        (markdown, replacement) =>
          markdown.slice(0, replacement.start) +
          adaptCanonicalRegionToSource(replacement.replacement, source, replacement) +
          markdown.slice(replacement.end),
        source
      )
  const nextBaseline = [...replacements]
    .sort((left, right) => right.previousStart - left.previousStart)
    .reduce(
      (canonical, replacement) =>
        canonical.slice(0, replacement.previousStart) +
        replacement.nextCanonicalList +
        canonical.slice(replacement.previousEnd),
      previous
    )
  const onlyTerminalPaddingRemains =
    nextBaseline.replace(/(?:\r\n|\r|\n)+$/, '') ===
    next.replace(/(?:\r\n|\r|\n)+$/, '')
  const withoutGeneratedEmptyBlocks = (value) => String(value || '')
    .replace(/^\s*(?:[ \t]*>[ \t]*)*<br\s*\/?>\s*$/gim, '')
    .replace(/(?:\r\n|\r|\n){3,}/g, '\n\n')
  const onlyGeneratedEmptyBlockRemains =
    withoutGeneratedEmptyBlocks(nextBaseline) === withoutGeneratedEmptyBlocks(next)
  if (
    !allowPartial &&
    nextBaseline !== next &&
    !onlyTerminalPaddingRemains &&
    !onlyGeneratedEmptyBlockRemains
  ) {
    return stickyBlocked ? blockedBatchedListResult(source) : null
  }
  return {
    markdown,
    preserved: true,
    reason: 'batched-list-block-changes',
    nextBaseline: onlyTerminalPaddingRemains || onlyGeneratedEmptyBlockRemains
      ? next
      : nextBaseline
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

// RS-67: clearing the text of a list item that still owns a nested child is a
// body edit, never an item deletion. In a source/canonical-diverged document
// the generic nested-list mapper can otherwise drop the entire parent marker
// (`1. 啊` -> nothing) and leave only the indented child, changing list depth.
// Claim only the exact raw-canonical transaction where ONE parent marker row
// changes from non-empty body to `<br />`, restoring that row reproduces the
// complete previous canonical byte-for-byte, and the next nonblank row is an
// unchanged deeper marker. Locate the authored parent by the parent+child pair
// and require a unique match before deleting only the parent's body bytes.
export const preserveNestedListParentBodyEmptied = ({ source, previous, next }) => {
  const sourceText = String(source || '')
  const previousText = String(previous || '')
  const nextText = String(next || '')
  if (!sourceText || !previousText || !nextText || previousText === nextText) return null

  const parseRow = (line) => {
    const match = line?.text?.match(/^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    return {
      line,
      indent: match[1].length,
      token: match[2],
      kind: /^\d/.test(match[2]) ? 'ordered' : 'bullet',
      prefixEnd: match[1].length + match[2].length + match[3].length,
      body: match[4]
    }
  }
  const compatibleToken = (sourceToken, canonicalToken) => {
    const sourceOrdered = /^(\d{1,9})[.)]$/.exec(sourceToken || '')
    const canonicalOrdered = /^(\d{1,9})[.)]$/.exec(canonicalToken || '')
    if (sourceOrdered || canonicalOrdered) {
      return Boolean(sourceOrdered && canonicalOrdered && sourceOrdered[1] === canonicalOrdered[1])
    }
    return /^[-+*]$/.test(sourceToken || '') && /^[-+*]$/.test(canonicalToken || '')
  }
  const nextNonblankRow = (lines, fromIndex) => {
    for (let index = fromIndex + 1; index < lines.length; index += 1) {
      if (!lines[index].text.trim()) continue
      return { index, meta: parseRow(lines[index]) }
    }
    return null
  }

  const previousLines = markdownLines(previousText)
  const nextLines = markdownLines(nextText)
  const canonicalCandidates = []
  for (let index = 0; index < nextLines.length; index += 1) {
    const nextParent = parseRow(nextLines[index])
    if (!nextParent || !/^<br\s*\/?>\s*$/i.test(nextParent.body)) continue
    const previousLine = previousLines[index]
    const previousParent = parseRow(previousLine)
    if (
      !previousParent ||
      previousParent.indent !== nextParent.indent ||
      previousParent.token !== nextParent.token ||
      !previousParent.body.trim() ||
      /^<br\s*\/?>\s*$/i.test(previousParent.body)
    ) continue
    const restored = nextText.slice(0, nextParent.line.start) +
      previousParent.line.text +
      nextText.slice(nextParent.line.end)
    if (restored !== previousText) continue
    const child = nextNonblankRow(nextLines, index)
    if (!child?.meta || child.meta.indent <= nextParent.indent) continue
    canonicalCandidates.push({ previousParent, nextParent, child: child.meta })
  }
  if (canonicalCandidates.length !== 1) return null
  const { previousParent, child } = canonicalCandidates[0]

  const authoredParentBody = canonicalTextToSource(previousParent.body)
  const authoredChildBody = canonicalTextToSource(child.body)
  const sourceLines = markdownLines(sourceText)
  const sourceMatches = []
  for (let index = 0; index < sourceLines.length; index += 1) {
    const parent = parseRow(sourceLines[index])
    if (
      !parent ||
      parent.indent !== previousParent.indent ||
      parent.body !== authoredParentBody ||
      !compatibleToken(parent.token, previousParent.token)
    ) continue
    const nested = nextNonblankRow(sourceLines, index)
    if (
      !nested?.meta ||
      nested.meta.indent <= parent.indent ||
      !compatibleToken(nested.meta.token, child.token) ||
      nested.meta.body !== authoredChildBody
    ) continue
    sourceMatches.push(parent)
  }
  if (sourceMatches.length !== 1) return null
  const sourceParent = sourceMatches[0]
  const bodyStart = sourceParent.line.start + sourceParent.prefixEnd
  return {
    markdown: sourceText.slice(0, bodyStart) + sourceText.slice(sourceParent.line.end),
    preserved: true,
    reason: 'nested-list-parent-body-emptied'
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
  // Tail lists are a special zero-visible boundary: the authored source can
  // already contain `- ` while the canonical snapshot has `* <br />`. The
  // document-wide list-block ordinal is unreliable here (earlier authored
  // bullet runs may have been merged by remark), so resolve the empty row from
  // the changed canonical lines and the nearest raw tail slot first.
  const changedRows = (markdown, contentRequired) => markdownLines(markdown)
    .map((line) => ({ ...line, marker: listMarkerRow(line) }))
    .filter((line) => {
      if (!line.marker || line.end < start || line.start > (contentRequired ? nextEnd : previousEnd)) return false
      const content = comparableListLine(line.text)
      return contentRequired ? !!content : !content
    })
    .sort((left, right) => Math.abs(left.start - start) - Math.abs(right.start - start))
  const previousEmptyRow = changedRows(previous, false)[0]
  const nextFilledRow = changedRows(next, true)[0]
  if (previousEmptyRow && nextFilledRow && previousEmptyRow.marker.kind === nextFilledRow.marker.kind) {
    const sourceHint = sourceRawFromVisibleIndex(
      source,
      sourceVisiblePositionAtRaw(previous, previousEmptyRow.start).visibleIndex,
      'forward'
    )
    const sourceRows = markdownLines(source)
      .map((line) => ({ ...line, marker: listMarkerRow(line) }))
      .filter((line) => line.marker &&
        line.marker.kind === previousEmptyRow.marker.kind &&
        !comparableListLine(line.text))
    const sourceRow = sourceRows
      .sort((left, right) => Math.abs(left.start - sourceHint) - Math.abs(right.start - sourceHint))[0]
    if (sourceRow) {
      const sourceSuffix = sourceVisibleIndex(source.slice(sourceRow.end)).text
      const previousSuffix = sourceVisibleIndex(previous.slice(previousEmptyRow.end)).text
      const nextContent = nextFilledRow.text.slice(nextFilledRow.marker.prefixEnd)
        .replace(/<br[^>]*>\\s*$/i, '')
      if (
        sourceSuffix === previousSuffix &&
        nextContent.trim() &&
        sourceRow.marker.kind === 'bullet'
      ) {
        // A newly typed list-item body that is exactly `1.` / `1)` is
        // serialized as `1\\.` / `1\\)` to keep it literal. Dropping that
        // protective escape here changes the item body into list syntax before
        // the user's following input can disambiguate it. Inline punctuation
        // elsewhere still follows the normal canonical→source translation.
        const authoredNextContent = /^\s*\d{1,9}\\[.)]\s*$/.test(nextContent)
          ? nextContent
          : canonicalTextToSource(nextContent)
        const replacement = sourceRow.text.slice(0, sourceRow.marker.prefixEnd) +
          authoredNextContent
        return {
          markdown: source.slice(0, sourceRow.start) + replacement + source.slice(sourceRow.end),
          preserved: true,
          reason: 'tail-empty-list-item-filled'
        }
      }
    }
  }

  const previousList = listBlockNear(previous, start, previousEnd)
  const nextList = listBlockNear(next, start, nextEnd)
  if (!previousList || !nextList) return null
  if (!hasEmptyListItem(previous, previousList) || hasEmptyListItem(next, nextList)) return null

  // RS-54: this mapper owns "empty item gains text", not list deletion or a
  // cross-type boundary collapse. When an isolated empty bullet after an
  // ordered list is removed, `listBlockNear(next, ...)` can resolve the
  // neighbouring ordered list. Treating that as a fill replaces the authored
  // `- ` slot with a copy of the ordered block. Require the list marker kind to
  // remain stable before any ordinal/source replacement is attempted.
  const listKind = (markdown, block) => markdownLines(markdown.slice(block.start, block.end))
    .map((line) => listMarkerRow(line)?.kind || null)
    .find(Boolean)
  if (listKind(previous, previousList) !== listKind(next, nextList)) return null

  // RS-72: this mapper is a text-fill mapper, not an empty-item deletion /
  // structural-compaction mapper. Backspace on an empty ordered item can make
  // ProseMirror lift the empty paragraph and renumber the following sibling in
  // the same transaction (`2. <br /> / 3. C` -> indented `<br /> / 2. C`).
  // The old gate only checked "previous has empty, next has none", so it
  // claimed that structural transaction and formatted the shorter next list
  // over the source, dropping the successor row. Require an unchanged list-row
  // skeleton and exactly one empty marker row gaining text. Any marker token,
  // indentation, row-count, or unrelated body change belongs to a structural
  // list mapper instead.
  const previousRows = flatListItemRows(previous.slice(previousList.start, previousList.end))
  const nextRows = flatListItemRows(next.slice(nextList.start, nextList.end))
  if (previousRows.length !== nextRows.length) return null
  let filledRows = 0
  for (let index = 0; index < previousRows.length; index += 1) {
    const before = previousRows[index]
    const after = nextRows[index]
    if (before.indent !== after.indent || before.token !== after.token) return null
    if (!before.text && after.text) {
      if (!before.token) return null
      filledRows += 1
      continue
    }
    if (before.text !== after.text) return null
  }
  if (filledRows !== 1) return null

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
    row.text.match(/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/)?.[0]?.length || 0
  const authoredCanonicalText = (row) => row.text.slice(nestedMarkerPrefixLength(row))
  // Compare canonical item text in its authored-source spelling. A leading
  // user space is serialized by Crepe as `&#x20;` but persisted as U+200B +
  // space, so raw string equality rejects an otherwise unchanged sibling and
  // prevents a zero-visible nested-list exit from reaching the item diff.
  const canonicalAuthoredText = (item) => canonicalTextToSource(item?.text || '')
  const nextList = outerTopLevelListBlock(next, start)
  if (!nextList) {
    // Backspace can fully lift the first list row into a plain paragraph. The
    // next canonical then starts with no list marker, so a marker-based lookup
    // cannot discover it. Accept only the exact leading-item transform and
    // require every remaining item to stay unchanged.
    const nextLine = lineAt(next, start)
    const liftedText = next.slice(nextLine.start, nextLine.end).replace(/\r$/, '').trim()
    if (!liftedText || previousItems[0]?.text !== liftedText) return null
    if (
      authoredCanonicalText(sourceItems[0] || { text: '' }) !== canonicalAuthoredText(previousItems[0])
    ) return null
    const remainingPrevious = previousItems.slice(1)
    const remainingSource = sourceItems.slice(1)
    if (remainingPrevious.length !== remainingSource.length) return null
    if (remainingPrevious.some((item, index) =>
      authoredCanonicalText(remainingSource[index]) !== canonicalAuthoredText(item)
    )) return null
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

  // Typing a trailing space after a literal ordered marker inside a bullet
  // (`- 1\\.`) produces a brief, real input-rule structure in Crepe. Its
  // canonical spelling is the compact `* 1. ` form: structurally that is an
  // EMPTY outer bullet containing an EMPTY ordered child, not literal text.
  // The next IME/text transaction can immediately turn it back into literal
  // `* 1\\. text`. Keep both frames source-equivalent instead of either
  // dropping the protective escape (`- 1.`) or relaxing the list-slot proof.
  //
  // This bridge is deliberately fail-closed: exactly one flattened item must
  // change, the number+delimiter must match, and the corresponding authored row
  // inside this source list must be unique.
  const preserveInlineOrderedInputRuleTransient = () => {
    const sameFlatItem = (left, right) =>
      left?.token === right?.token && left?.text === right?.text
    let localPrefix = 0
    while (
      localPrefix < previousItems.length &&
      localPrefix < nextItems.length &&
      sameFlatItem(previousItems[localPrefix], nextItems[localPrefix])
    ) localPrefix += 1
    let localSuffix = 0
    while (
      localSuffix < previousItems.length - localPrefix &&
      localSuffix < nextItems.length - localPrefix &&
      sameFlatItem(
        previousItems[previousItems.length - 1 - localSuffix],
        nextItems[nextItems.length - 1 - localSuffix]
      )
    ) localSuffix += 1
    if (
      previousItems.length - localPrefix - localSuffix !== 1 ||
      nextItems.length - localPrefix - localSuffix !== 1
    ) return null

    const previousItem = previousItems[localPrefix]
    const nextItem = nextItems[localPrefix]
    const previousLiteral = previousItem?.text?.match(/^(\d{1,9})\\([.)])$/)
    // A fast human cadence can coalesce the `.` and following Space into the
    // same preservation callback. In that frame the last published source is
    // still `- 1`, while Crepe has already applied the ordered input rule and
    // serializes `* 1. `. Treat this as the same transient bridge as the
    // independently-published `- 1\\.` case, but only when the authored row is
    // the unique bullet row whose complete text is exactly that bare number.
    const previousBareNumber = previousItem?.text?.match(/^(\d{1,9})$/)
    const nextTransient = nextItem?.raw?.match(
      /^(\s*)([-+*])([ \t]+)(\d{1,9})([.)])([ \t]+)$/
    )
    const transientNumber = previousLiteral?.[1] || previousBareNumber?.[1] || null
    const transientDelimiter = previousLiteral?.[2] || nextTransient?.[5] || null
    if (
      (previousLiteral || previousBareNumber) &&
      nextTransient &&
      /^[-+*]$/.test(previousItem.token || '') &&
      previousItem.token === nextItem.token &&
      transientNumber === nextTransient[4] &&
      transientDelimiter === nextTransient[5]
    ) {
      const candidates = sourceItems.filter((row) =>
        /^[-+*]$/.test(row.token || '') &&
        row.text.trim() === previousItem.text
      )
      if (candidates.length !== 1) return null
      const row = candidates[0]
      const rawStart = sourceList.start + row.start
      const rawEnd = sourceList.start + row.end
      const nested = `${' '.repeat(row.indent)}${row.token}   ${transientNumber}${transientDelimiter} `
      return {
        markdown: source.slice(0, rawStart) + nested + source.slice(rawEnd),
        preserved: true,
        reason: 'diverged-inline-ordered-input-rule',
        nextBaseline: previous.slice(0, previousList.start) +
          next.slice(nextList.start, nextList.end) +
          previous.slice(previousList.end)
      }
    }

    const previousTransient = previousItem?.raw?.match(
      /^(\s*)([-+*])([ \t]+)(\d{1,9})([.)])([ \t]+)$/
    )
    const nextLiteral = nextItem?.text?.match(/^(\d{1,9})\\([.)])(?:[ \t]+.*)?$/)
    if (
      previousTransient &&
      nextLiteral &&
      /^[-+*]$/.test(previousItem.token || '') &&
      previousItem.token === nextItem.token &&
      previousTransient[4] === nextLiteral[1] &&
      previousTransient[5] === nextLiteral[2]
    ) {
      const nestedBody = new RegExp(
        `^${previousTransient[4]}${previousTransient[5] === '.' ? '\\.' : '\\)'}[ \\t]+$`
      )
      const candidates = sourceItems.filter((row) =>
        /^[-+*]$/.test(row.token || '') && nestedBody.test(row.text)
      )
      if (candidates.length !== 1) return null
      const row = candidates[0]
      const rawStart = sourceList.start + row.start
      const rawEnd = sourceList.start + row.end
      const literalPrefix = `${nextLiteral[1]}\\${nextLiteral[2]}`
      const literalTail = nextItem.text.slice(literalPrefix.length)
      const literal = `${' '.repeat(row.indent)}${row.token} ${literalPrefix}${canonicalTextToSource(literalTail)}`
      return {
        markdown: source.slice(0, rawStart) + literal + source.slice(rawEnd),
        preserved: true,
        reason: 'diverged-inline-ordered-input-rule',
        nextBaseline: previous.slice(0, previousList.start) +
          next.slice(nextList.start, nextList.end) +
          previous.slice(previousList.end)
      }
    }
    return null
  }
  const inlineOrderedInputRule = preserveInlineOrderedInputRuleTransient()
  if (inlineOrderedInputRule) return inlineOrderedInputRule

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
    if (target === canonicalAuthoredText(item)) {
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
  let nestedOrderedInsertionTemplate = null
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
      nestedOrderedInsertionTemplate = null
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
        let authoredText = canonicalTextToSource(nextItem.text)
        // Filling an EMPTY item whose authored row is a bare marker (`1.` with
        // no trailing space) inserts exactly at the row end. The canonical
        // marker carries the separator space (`1. 色粉`), so the authored row
        // must gain it too; without it `1.色粉` stops being a list item and
        // becomes a paragraph.
        const rowRawEnd = sourceList.start + row.end + applyOffset
        const rowRaw = source.slice(sourceList.start + row.start, sourceList.start + row.end)
        if (
          prevItem.text === '' &&
          rawStart === rowRawEnd &&
          !/[ \t]$/.test(rowRaw) &&
          !/^[ \t]/.test(authoredText)
        ) {
          authoredText = ' ' + authoredText
        }
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
      const sourceBullet = anchorRow && /^[-+*]$/.test(anchorRow.token)
        ? anchorRow.token
        : authoredBullet
      const sourceOrdered = anchorRow && /^\d/.test(anchorRow.token)
      const orderedToken = sourceOrdered
        ? `${nextItem.token.slice(0, -1)}${anchorRow.token.slice(-1)}`
        : nextItem.token

      // `- 1. text` is authored as one bullet row, but remark consumes the
      // inline `1.` as a nested ordered marker. If Enter creates another
      // ordered sibling, writing `- 2. child` would create a NEW outer bullet
      // and fail both semantic and raw-list integrity. Continue the ordered
      // list at the outer bullet's real content column instead. Derive that
      // column from the raw prefix (`- ` -> two spaces, `-   ` -> four) and
      // preserve the author's ordered delimiter (`.` vs `)`). The canonical
      // item must still be deeper than the authored outer bullet, so genuine
      // top-level ordered insertions keep the existing path below.
      const anchorRaw = anchorRow
        ? source.slice(
            sourceList.start + anchorRow.start,
            sourceList.start + anchorRow.end
          )
        : ''
      const sourceOrderedSameDepth = Boolean(
        sourceOrdered &&
        Number(nextItem.indent) === Number(anchorRow?.indent || 0)
      )
      // RS-71: when Enter appends a sibling after an already-authored nested
      // ordered row, the source row itself is the structural anchor. Preserve
      // its exact authored leading whitespace together with its `.` / `)`
      // delimiter. Top-level ordered rows have an empty prefix, while a deeper
      // canonical child (different indent) keeps the pre-existing behavior.
      const sourceOrderedIndent = sourceOrderedSameDepth
        ? (anchorRaw.match(/^([ \t]*)/)?.[1] || '')
        : ''
      const outerBulletPrefix = anchorRaw.match(/^([ \t]*)([-+*])([ \t]+)/)
      const inlineOrderedMarker = anchorRow?.text?.match(/^(\d{1,9})([.)])(?:[ \t]+|$)/)
      const nestedOrderedFromAnchor = Boolean(
        outerBulletPrefix &&
        inlineOrderedMarker &&
        /^[-+*]$/.test(anchorRow?.token || '') &&
        /^\d{1,9}[.)]$/.test(nextItem.token || '') &&
        Number(nextItem.indent) > Number(anchorRow?.indent || 0)
      )
      const inheritedNestedOrdered = Boolean(
        insertionCursor != null &&
        nestedOrderedInsertionTemplate &&
        /^\d{1,9}[.)]$/.test(nextItem.token || '') &&
        Number(nextItem.indent) > Number(anchorRow?.indent || 0)
      )
      const nestedOrderedContinuation = nestedOrderedFromAnchor || inheritedNestedOrdered
      const nestedOrderedIndent = nestedOrderedFromAnchor
        ? `${outerBulletPrefix[1]} ${outerBulletPrefix[3]}`
        : nestedOrderedInsertionTemplate?.indent || ''
      const nestedOrderedDelimiter = nestedOrderedFromAnchor
        ? inlineOrderedMarker[2]
        : nestedOrderedInsertionTemplate?.delimiter || nextItem.token.slice(-1)
      const nestedOrderedToken = nestedOrderedContinuation
        ? `${nextItem.token.slice(0, -1)}${nestedOrderedDelimiter}`
        : ''
      const prefix = !nextItem.token
        ? ' '.repeat(Math.max(1, Number(nextItem.indent) || 2))
        : /^\d/.test(nextItem.token)
          ? nestedOrderedContinuation
            ? `${nestedOrderedIndent}${nestedOrderedToken} `
            : sourceOrdered
              ? `${sourceOrderedIndent}${orderedToken} `
              : `${sourceBullet} ${nextItem.token} `
          : `${' '.repeat(Math.max(0, Number(nextItem.indent) || 0))}${sourceBullet} `
      const inserted = leading + prefix + canonicalTextToSource(nextItem.text) + eol
      output = output.slice(0, insertAt) + inserted + output.slice(insertAt)
      insertionCursor = insertAt + inserted.length
      applyOffset += inserted.length
      nestedOrderedInsertionTemplate = nestedOrderedContinuation
        ? { indent: nestedOrderedIndent, delimiter: nestedOrderedDelimiter }
        : null

      // Two rapid Enters can be published as one zero-visible edit: an empty
      // nested ordered row is created and immediately lifted to a new TOP-LEVEL
      // bullet item. In diverged authored syntax (`-   1. text`), unchanged
      // following top-level canonical items can still be stored as indented
      // source rows. Before the insertion those rows are part of the old
      // authored encoding; after inserting a new top-level empty item the same
      // indentation would make Markdown parse them as CHILDREN of that new
      // item. For this exact one-item insertion, promote only the unchanged
      // canonical top-level suffix rows by removing their marker indentation.
      // Marker token, leading-space sentinel and content stay byte-for-byte.
      if (
        previousChanged === 0 &&
        nextChanged === 1 &&
        !nextItem.text &&
        Number(nextItem.indent) === 0 &&
        /^[-+*]$/.test(nextItem.token || '') &&
        suffix > 0
      ) {
        for (let suffixOffset = 0; suffixOffset < suffix; suffixOffset += 1) {
          const previousSuffixIndex = previousItems.length - suffix + suffixOffset
          const nextSuffixIndex = nextItems.length - suffix + suffixOffset
          const canonicalFollower = nextItems[nextSuffixIndex]
          const followerAlignment = aligned[previousSuffixIndex]
          const followerRow = followerAlignment?.row != null
            ? sourceRows[followerAlignment.row]
            : null
          if (!canonicalFollower || Number(canonicalFollower.indent) !== 0) continue
          if (!followerRow || followerRow.indent <= 0 || !followerRow.token) continue
          const rawStart = sourceList.start + followerRow.start + applyOffset
          const rawEnd = rawStart + followerRow.indent
          output = output.slice(0, rawStart) + output.slice(rawEnd)
          applyOffset -= followerRow.indent
        }
      }
    } else if (prevItem && prevItem.text !== '' && !nextItem) {
      insertionCursor = null
      nestedOrderedInsertionTemplate = null
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

// Backspace on one empty ordered item removes that item, renumbers its
// successor, and leaves one editor-only empty paragraph inside the preceding
// item. Crepe serializes the transient paragraph as an indented standalone
// `<br />`; authored Markdown must persist only the real row deletion and
// renumbering. The left/empty/right rows are proven uniquely on previous,
// next, and source before any bytes are changed.
export const preserveSingleEmptyOrderedBackspaceLift = ({ source, previous, next }) => {
  const rowMeta = (line) => {
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/)
    if (!match) return null
    return {
      line,
      indent: match[1],
      ordinal: Number(match[2]),
      delimiter: match[3],
      token: `${match[2]}${match[3]}`,
      spacing: match[4],
      body: match[5]
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (lines[cursor].text.trim()) return cursor
    }
    return -1
  }
  const visibleBody = (value) => sourceVisibleIndex(String(value || '')).text.trim()
  const change = commonChange(previous, next)

  const previousLines = markdownLines(previous)
  const before = []
  for (let index = 0; index < previousLines.length; index += 1) {
    const empty = rowMeta(previousLines[index])
    if (!empty || empty.body.trim()) continue
    const leftIndex = nearestNonBlank(previousLines, index, -1)
    const rightIndex = nearestNonBlank(previousLines, index, 1)
    if (leftIndex < 0 || rightIndex < 0) continue
    const left = rowMeta(previousLines[leftIndex])
    const right = rowMeta(previousLines[rightIndex])
    if (
      !left || !right || !left.body.trim() || !right.body.trim() ||
      left.indent !== empty.indent || right.indent !== empty.indent ||
      left.delimiter !== empty.delimiter || right.delimiter !== empty.delimiter ||
      empty.ordinal !== left.ordinal + 1 || right.ordinal !== empty.ordinal + 1
    ) continue
    if (empty.line.end < change.start - 2 || empty.line.start > change.previousEnd + 2) continue
    before.push({ left, empty, right })
  }
  if (before.length !== 1) return null
  const target = before[0]

  const nextLines = markdownLines(next)
  const after = []
  for (let index = 0; index < nextLines.length; index += 1) {
    if (!/^[ \t]*<br\s*\/?>[ \t]*$/i.test(nextLines[index].text)) continue
    const leftIndex = nearestNonBlank(nextLines, index, -1)
    const rightIndex = nearestNonBlank(nextLines, index, 1)
    if (leftIndex < 0 || rightIndex < 0) continue
    const left = rowMeta(nextLines[leftIndex])
    const right = rowMeta(nextLines[rightIndex])
    if (
      !left || !right ||
      left.indent !== target.left.indent || right.indent !== target.right.indent ||
      left.delimiter !== target.left.delimiter || right.delimiter !== target.right.delimiter ||
      left.ordinal !== target.left.ordinal || right.ordinal !== target.empty.ordinal ||
      visibleBody(left.body) !== visibleBody(target.left.body) ||
      visibleBody(right.body) !== visibleBody(target.right.body)
    ) continue
    const line = nextLines[index]
    if (line.end < change.start - 2 || line.start > change.nextEnd + 2) continue
    after.push({ left, transient: line, right })
  }
  if (after.length !== 1) return null
  const afterTarget = after[0]

  const sourceLines = markdownLines(source)
  const sourceMatches = []
  for (let index = 0; index < sourceLines.length; index += 1) {
    const empty = rowMeta(sourceLines[index])
    if (!empty || empty.body.trim()) continue
    const leftIndex = nearestNonBlank(sourceLines, index, -1)
    const rightIndex = nearestNonBlank(sourceLines, index, 1)
    if (leftIndex < 0 || rightIndex < 0) continue
    const left = rowMeta(sourceLines[leftIndex])
    const right = rowMeta(sourceLines[rightIndex])
    if (
      !left || !right || !left.body.trim() || !right.body.trim() ||
      left.indent !== empty.indent || right.indent !== empty.indent ||
      left.delimiter !== empty.delimiter || right.delimiter !== empty.delimiter ||
      left.ordinal !== target.left.ordinal || empty.ordinal !== target.empty.ordinal || right.ordinal !== target.right.ordinal ||
      visibleBody(left.body) !== visibleBody(target.left.body) ||
      visibleBody(right.body) !== visibleBody(target.right.body)
    ) continue
    sourceMatches.push({ left, empty, right })
  }
  if (sourceMatches.length !== 1) return null
  const sourceTarget = sourceMatches[0]

  const rightTokenStart = sourceTarget.right.line.start + sourceTarget.right.indent.length
  const rightTokenEnd = rightTokenStart + sourceTarget.right.token.length
  const markdown = source.slice(0, sourceTarget.empty.line.start) +
    source.slice(sourceTarget.right.line.start, rightTokenStart) +
    `${afterTarget.right.ordinal}${sourceTarget.right.delimiter}` +
    source.slice(rightTokenEnd)
  return {
    markdown,
    preserved: true,
    reason: 'diverged-empty-ordered-backspace-lift',
    nextBaseline: next
  }
}

// Multi-successor ordered Backspace is physically a merge followed by one
// relabel Step for every successor. The transaction owner supplies the exact
// removed index/list order/successor count; this raw mapper only proves that the
// bounded authored rows match that PM family, then deletes the empty row and
// rewrites successor ORDINAL DIGITS in place. Delimiters, spacing, bodies and
// every unowned byte remain authored source.
export const preserveOrderedEmptyBackspaceSuccessorChain = ({
  source,
  previous,
  next,
  removedIndex,
  listOrder,
  successorCount
}) => {
  if (
    !Number.isInteger(removedIndex) || removedIndex < 1 ||
    !Number.isInteger(listOrder) || listOrder < 0 ||
    !Number.isInteger(successorCount) || successorCount < 2
  ) return null

  const rowMeta = (line) => {
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/)
    if (!match) return null
    return Object.freeze({
      line,
      indent: match[1],
      ordinal: Number(match[2]),
      ordinalText: match[2],
      delimiter: match[3],
      spacing: match[4],
      body: match[5]
    })
  }
  const topRows = (markdown) => markdownLines(markdown)
    .map(rowMeta)
    .filter((row) => row && row.indent.length === 0)
  const visibleBody = (value) => sourceVisibleIndex(String(value || '')).text.trim()
  const previousRows = topRows(previous)
  const nextRows = topRows(next)
  const sourceRows = topRows(source)
  const oldCount = previousRows.length
  if (
    oldCount < 4 ||
    removedIndex >= oldCount - 1 ||
    successorCount !== oldCount - removedIndex - 1 ||
    nextRows.length !== oldCount - 1 ||
    sourceRows.length !== oldCount
  ) return null

  const sourceDelimiters = new Set(sourceRows.map((row) => row.delimiter))
  if (sourceDelimiters.size !== 1) return null
  for (let index = 0; index < oldCount; index += 1) {
    const previousRow = previousRows[index]
    const sourceRow = sourceRows[index]
    const expectedOrdinal = listOrder + index
    if (
      previousRow.ordinal !== expectedOrdinal ||
      sourceRow.ordinal !== expectedOrdinal ||
      previousRow.delimiter !== previousRows[0].delimiter ||
      sourceRow.indent !== '' ||
      visibleBody(sourceRow.body) !== visibleBody(previousRow.body)
    ) return null
    const previousEmpty = visibleBody(previousRow.body) === ''
    const sourceEmpty = visibleBody(sourceRow.body) === ''
    if (index === removedIndex) {
      if (!previousEmpty || !sourceEmpty) return null
    } else if (previousEmpty || sourceEmpty) {
      return null
    }
  }

  for (let nextIndex = 0; nextIndex < nextRows.length; nextIndex += 1) {
    const sourceOldIndex = nextIndex < removedIndex ? nextIndex : nextIndex + 1
    const previousRow = previousRows[sourceOldIndex]
    const nextRow = nextRows[nextIndex]
    if (
      nextRow.ordinal !== listOrder + nextIndex ||
      nextRow.delimiter !== nextRows[0].delimiter ||
      visibleBody(nextRow.body) !== visibleBody(previousRow.body)
    ) return null
  }

  const patches = []
  for (let offset = 0; offset < successorCount; offset += 1) {
    const oldIndex = removedIndex + 1 + offset
    const row = sourceRows[oldIndex]
    const ordinalStart = row.line.start + row.indent.length
    patches.push(Object.freeze({
      start: ordinalStart,
      end: ordinalStart + row.ordinalText.length,
      replacement: String(row.ordinal - 1)
    }))
  }
  patches.push(Object.freeze({
    start: sourceRows[removedIndex].line.start,
    end: sourceRows[removedIndex + 1].line.start,
    replacement: ''
  }))
  patches.sort((left, right) => right.start - left.start)
  let markdown = source
  for (const patch of patches) {
    markdown = markdown.slice(0, patch.start) + patch.replacement + markdown.slice(patch.end)
  }
  return Object.freeze({
    markdown,
    preserved: true,
    reason: 'diverged-empty-ordered-backspace-successor-chain',
    nextBaseline: next,
    removedIndex,
    successorCount
  })
}

export const preserveTransactionOwnedOrderedEmptySuccessorChain = ({
  source,
  previous,
  next,
  removedIndex,
  listOrder,
  successorCount
}) => {
  const rawSource = String(source || '')
  const rawPrevious = String(previous || '')
  const rawNext = String(next || '')
  if (!rawPrevious || !rawNext || rawPrevious === rawNext) return null
  const sourceEndings = new Set(rawSource.match(/\r\n|\r|\n/g) || [])
  if (sourceEndings.size > 1) return null
  const sourceEol = sourceEndings.values().next().value || '\n'
  const normalize = (value) => String(value || '').replace(/\r\n|\r/g, '\n')
  const restore = (value) => sourceEol === '\n'
    ? String(value || '')
    : String(value || '').replace(/\n/g, sourceEol)
  const normalizedSource = normalize(rawSource)
  const comparablePrevious = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(normalize(rawPrevious))
  )
  const comparableNext = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(normalize(rawNext))
  )
  const result = preserveOrderedEmptyBackspaceSuccessorChain({
    source: normalizedSource,
    previous: comparablePrevious,
    next: comparableNext,
    removedIndex,
    listOrder,
    successorCount
  })
  if (!result || result.preserved === false || typeof result.markdown !== 'string') return null
  const normalizedMapped = normalize(result.markdown)
  const contentLineCount = (value) => {
    const withoutTerminal = String(value || '').replace(/\n+$/, '')
    return withoutTerminal ? withoutTerminal.split('\n').length : 0
  }
  const trailingBoundaryNewlineGrowth = Boolean(
    /\n$/.test(normalizedMapped) &&
    contentLineCount(normalizedMapped) > contentLineCount(normalizedSource)
  ) ? 1 : 0
  return Object.freeze({
    ...result,
    markdown: restore(result.markdown),
    trailingBoundaryNewlineGrowth,
    nextBaseline: rawNext
  })
}

// RS-72 has its own transaction family. Once its two-Step journal is proven,
// only the single-empty ordered Backspace mapper is allowed to interpret the
// bounded source fragment. Do not run the generic list mapper chain here: a
// focused owner rejection must stay a rejection rather than finding another
// list-shaped explanation inside the same callback.
export const preserveTransactionOwnedSingleEmptyOrderedBackspaceLift = ({
  source,
  previous,
  next
}) => {
  const rawSource = String(source || '')
  const rawPrevious = String(previous || '')
  const rawNext = String(next || '')
  if (!rawPrevious || !rawNext || rawPrevious === rawNext) return null

  const sourceEndings = new Set(rawSource.match(/\r\n|\r|\n/g) || [])
  if (sourceEndings.size > 1) return null
  const sourceEol = sourceEndings.values().next().value || '\n'
  const normalize = (value) => String(value || '').replace(/\r\n|\r/g, '\n')
  const restore = (value) => sourceEol === '\n'
    ? String(value || '')
    : String(value || '').replace(/\n/g, sourceEol)
  const normalizedSource = normalize(rawSource)
  const comparablePrevious = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(normalize(rawPrevious))
  )
  const comparableNext = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(normalize(rawNext))
  )
  const result = preserveSingleEmptyOrderedBackspaceLift({
    source: normalizedSource,
    previous: comparablePrevious,
    next: comparableNext
  })
  if (!result || result.preserved === false || typeof result.markdown !== 'string') return null

  const normalizedMapped = normalize(result.markdown)
  const contentLineCount = (value) => {
    const withoutTerminal = String(value || '').replace(/\n+$/, '')
    return withoutTerminal ? withoutTerminal.split('\n').length : 0
  }
  const trailingBoundaryNewlineGrowth = Boolean(
    /\n$/.test(normalizedMapped) &&
    contentLineCount(normalizedMapped) > contentLineCount(normalizedSource)
  ) ? 1 : 0
  return {
    ...result,
    markdown: restore(result.markdown),
    trailingBoundaryNewlineGrowth,
    nextBaseline: rawNext
  }
}

// A transaction owner has already proven the exact old/new top-level list
// subtree and sliced away every neighbouring block. Reuse the established list
// delta implementations on that bounded region instead of asking a
// whole-document visible diff to rediscover the target. This function does not
// grant publication authority; the caller must still splice the result into the
// complete source and pass normal semantic/list-slot validation.
export const preserveTransactionOwnedListSubtreeChange = ({
  source,
  previous,
  next,
  siblingParagraphJoin = null
}) => {
  const rawSource = String(source || '')
  const rawPrevious = String(previous || '')
  const rawNext = String(next || '')
  if (!rawPrevious || !rawNext || rawPrevious === rawNext) return null

  // The list algorithms use logical-line coordinates. A transaction-owned
  // range is already isolated from neighbouring bytes, so normalize its three
  // representations to LF, run the existing mapper once, then replay only the
  // mapped fragment with the authored source's uniform EOL. Mixed-EOL list
  // subtrees remain ambiguous and deliberately defer to the legacy path.
  const sourceEndings = new Set(rawSource.match(/\r\n|\r|\n/g) || [])
  if (sourceEndings.size > 1) return null
  const sourceEol = sourceEndings.values().next().value || '\n'
  const normalize = (value) => String(value || '').replace(/\r\n|\r/g, '\n')
  const restore = (value) => sourceEol === '\n'
    ? String(value || '')
    : String(value || '').replace(/\n/g, sourceEol)
  const normalizedSource = normalize(rawSource)
  const normalizedPrevious = normalize(rawPrevious)
  const normalizedNext = normalize(rawNext)
  // The legacy facade performs these source-safe canonical normalizations
  // before dispatching list mappers. Transaction ownership changes lifecycle,
  // not list syntax semantics: use the same comparable representation so an
  // empty nested item persists as a parse-safe marker, never Crepe's `<br />`.
  const comparablePrevious = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(normalizedPrevious)
  )
  const comparableNext = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(normalizedNext)
  )
  const change = commonChange(comparablePrevious, comparableNext)
  const attempts = [
    () => preserveSingleEmptyOrderedBackspaceLift({
      source: normalizedSource,
      previous: comparablePrevious,
      next: comparableNext
    }),
    () => preserveStableListRowChanges({
      source: normalizedSource,
      previous: comparablePrevious,
      next: comparableNext
    }),
    () => preserveDivergedNestedListChange({
      source: normalizedSource,
      previous: comparablePrevious,
      next: comparableNext,
      ...change
    }),
    () => preserveListBlockChange({
      source: normalizedSource,
      previous: comparablePrevious,
      next: comparableNext,
      ...change
    }),
    () => preserveBatchedListBlockChanges({
      source: normalizedSource,
      previous: comparablePrevious,
      next: comparableNext
    })
  ]
  const repairProvenSiblingParagraphJoin = (mapped) => {
    if (
      siblingParagraphJoin?.kind !== 'transaction-list-sibling-item-paragraph-join-proof' ||
      siblingParagraphJoin?.listType !== 'bullet_list' ||
      mapped?.reason !== 'diverged-nested-list-change'
    ) return null

    const sourceLines = normalizedSource.split('\n')
    const previousLines = comparablePrevious.split('\n')
    const nextLines = comparableNext.split('\n')
    const mappedLines = normalize(mapped.markdown).split('\n')
    if (
      sourceLines.length !== 2 ||
      previousLines.length !== 3 ||
      nextLines.length !== 3 ||
      mappedLines.length !== 2 ||
      previousLines[1].trim() !== '' ||
      nextLines[1].trim() !== ''
    ) return null

    const sourceFirst = sourceLines[0].match(/^([-+*])([ \t]+)(.+)$/)
    const sourceSecond = sourceLines[1].match(/^([-+*])([ \t]+)(.+)$/)
    const previousFirst = previousLines[0].match(/^([-+*])([ \t]+)(.+)$/)
    const previousSecond = previousLines[2].match(/^([-+*])([ \t]+)(.+)$/)
    const nextFirst = nextLines[0].match(/^([-+*])([ \t]+)(.+)$/)
    const nextContinuation = nextLines[2].match(/^([ \t]+)(.+)$/)
    const mappedContinuation = mappedLines[1].match(/^([ \t]+)(.+)$/)
    if (
      !sourceFirst || !sourceSecond || !previousFirst || !previousSecond ||
      !nextFirst || !nextContinuation || !mappedContinuation ||
      /^[-+*](?:[ \t]|$)/.test(nextLines[2]) ||
      mappedLines[0] !== sourceLines[0] ||
      mappedContinuation[2] !== sourceSecond[3] ||
      mappedContinuation[1] !== nextContinuation[1]
    ) return null

    return Object.freeze({
      ...mapped,
      markdown: `${mappedLines[0]}\n\n${mappedLines[1]}`,
      reason: 'diverged-sibling-list-item-paragraph-join'
    })
  }

  const contentLineCount = (value) => {
    const withoutTerminal = String(value || '').replace(/\n+$/, '')
    return withoutTerminal ? withoutTerminal.split('\n').length : 0
  }
  for (const attempt of attempts) {
    const result = attempt()
    if (result && result.preserved !== false && typeof result.markdown === 'string') {
      const repaired = repairProvenSiblingParagraphJoin(result) || result
      const normalizedMapped = normalize(repaired.markdown)
      // The source range ends at the final list-row byte; the untouched source
      // suffix owns the pre-existing separator before the next top-level block.
      // When the mapper appends one or more NEW rows at the subtree tail, its
      // final EOL is the terminator of that new authored row and must precede
      // the old separator. Deletion and same-row edits reuse the suffix's first
      // EOL and therefore declare no growth. This is a structural line-count
      // contract, independent of list text, marker spelling or neighbour type.
      const trailingBoundaryNewlineGrowth = Boolean(
        /\n$/.test(normalizedMapped) &&
        contentLineCount(normalizedMapped) > contentLineCount(normalizedSource)
      ) ? 1 : 0
      return {
        ...repaired,
        markdown: restore(repaired.markdown),
        trailingBoundaryNewlineGrowth,
        // The owner supplied the entire final list subtree, so a successful
        // bounded map consumes that complete local baseline.
        nextBaseline: rawNext
      }
    }
  }
  return null
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
