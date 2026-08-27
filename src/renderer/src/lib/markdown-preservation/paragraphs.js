import {
  sourceRawFromVisibleIndex,
  sourceVisiblePositionAtRaw,
  sourceVisibleIndex
} from '../../mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  canonicalFreshTextToSource,
  canonicalTextToSource,
  isTableLine,
  lineAt,
  lineEndingNear,
  listMarker,
  markdownLines
} from './core.js'
import {
  preserveChangedLineRegion,
  sameVisibleLines,
  visibleLineEntries
} from './regions.js'
import { LEADING_SPACE_SENTINEL } from '../markdown-leading-space.js'

const emptyCanonicalQuoteLine = /^\s*(?:>\s*)+(?:<br\s*\/?>\s*)?$/i
const emptyAuthoredQuoteLine = /^\s*(?:>\s*)+$/

const paragraphFenceBlocks = (markdown) => {
  const lines = markdownLines(String(markdown || ''))
  const blocks = []
  let open = null
  for (const line of lines) {
    if (!open) {
      const match = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (match) {
        open = {
          openStart: line.start,
          openEnd: line.end,
          contentStart: line.end + (markdown[line.end] === '\n' ? 1 : 0),
          openLine: line.text,
          char: match[1][0],
          length: match[1].length
        }
      }
      continue
    }
    const close = line.text.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    if (!close || close[1][0] !== open.char || close[1].length < open.length) continue
    blocks.push({
      ...open,
      closeStart: line.start,
      closeEnd: line.end,
      closeLine: line.text
    })
    open = null
  }
  return blocks
}

// Backspace can remove an editor-only empty paragraph immediately before an
// authored fenced code block. The canonical delta is only `  <br />\n\n` ->
// empty, but the generic line-region mapper treats its exclusive end as a
// touched line and pulls the UNCHANGED opening fence into the replacement.
// On a diverged document that can turn one authored fence into ` ```\n\n``` `.
// Prove the adjacent paired fence and the preceding visible anchor by ordinal;
// if source already represents the boundary as ordinary blank separation,
// there are no authored bytes to delete, so keep source exactly unchanged.
export const preserveRemovedEmptyParagraphBeforeFence = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousChanged = previous.slice(start, previousEnd)
  const nextChanged = next.slice(start, nextEnd)
  if (
    !/<br\s*\/?>/i.test(previousChanged) ||
    withoutStandaloneEmptyBlockLines(previousChanged).trim() ||
    nextChanged ||
    previous.slice(previousEnd) !== next.slice(nextEnd)
  ) return null

  const previousBlocks = paragraphFenceBlocks(previous)
  const nextBlocks = paragraphFenceBlocks(next)
  const previousFenceIndex = previousBlocks.findIndex((block) => block.openStart === previousEnd)
  const nextFenceIndex = nextBlocks.findIndex((block) => block.openStart === nextEnd)
  if (previousFenceIndex < 0 || previousFenceIndex !== nextFenceIndex) return null
  const previousFence = previousBlocks[previousFenceIndex]
  const nextFence = nextBlocks[nextFenceIndex]
  if (
    previousFence.openLine !== nextFence.openLine ||
    previousFence.closeLine !== nextFence.closeLine ||
    sourceVisibleIndex(previous.slice(previousFence.contentStart, previousFence.closeStart)).text !==
      sourceVisibleIndex(next.slice(nextFence.contentStart, nextFence.closeStart)).text
  ) return null

  const sourceBlocks = paragraphFenceBlocks(source)
  const sourceFence = sourceBlocks[nextFenceIndex]
  if (
    !sourceFence ||
    sourceFence.openLine !== nextFence.openLine ||
    sourceFence.closeLine !== nextFence.closeLine ||
    sourceVisibleIndex(source.slice(sourceFence.contentStart, sourceFence.closeStart)).text !==
      sourceVisibleIndex(next.slice(nextFence.contentStart, nextFence.closeStart)).text
  ) return null

  const previousAnchor = visibleLineEntries(previous)
    .filter((line) => line.end <= start)
    .at(-1)
  const sourceAnchor = visibleLineEntries(source)
    .filter((line) => line.end <= sourceFence.openStart)
    .at(-1)
  if (!previousAnchor || !sourceAnchor || previousAnchor.visible !== sourceAnchor.visible) return null
  const sourceGap = source.slice(sourceAnchor.end, sourceFence.openStart)
  if (/\S/.test(sourceGap)) return null

  return {
    markdown: source,
    preserved: true,
    reason: 'empty-paragraph-before-fence-removed'
  }
}

// RS-57 / RS-65: pressing Enter at the end of a non-empty blockquote creates
// a second EMPTY paragraph inside that same quote. Crepe serializes the
// unrepresentable transient as two syntax rows (`>` + `> <br />`). Plain
// Markdown cannot persist an empty paragraph inside a blockquote without an
// implementation placeholder, so the authored source must stay unchanged until
// that paragraph receives real text. "Trailing" here means trailing INSIDE the
// quote; RS-65 proves the same lifecycle when a real block follows the quote.
// The proof is deliberately stronger than a local visible diff: removing only
// the two newly generated quote rows from `next` must reproduce `previous`
// byte-for-byte, so no simultaneous edit elsewhere can receive this transient.
export const preserveCreatedTrailingEmptyBlockquoteParagraph = ({ source, previous, next }) => {
  const quotePrefix = (line) => String(line || '').match(/^\s*((?:>\s*)+)/)?.[1] || ''
  const quoteDepth = (line) => (quotePrefix(line).match(/>/g) || []).length
  const visible = (line) => sourceVisibleIndex(String(line || '')).text
  const visibleQuoteRows = (value) => markdownLines(String(value || ''))
    .filter((line) => quoteDepth(line.text) > 0 && visible(line.text))

  const previousLines = markdownLines(String(previous || ''))
  const nextLines = markdownLines(String(next || ''))
  const previousVisibleQuotes = visibleQuoteRows(previous)
  const sourceVisibleQuotes = visibleQuoteRows(source)
  const oneLineBreak = /^(?:\r\n|\r|\n)$/

  for (let index = 0; index <= nextLines.length - 3; index += 1) {
    const nextTextQuote = nextLines[index]
    const nextSeparatorQuote = nextLines[index + 1]
    const nextEmptyQuote = nextLines[index + 2]
    if (
      quoteDepth(nextTextQuote.text) < 1 ||
      !visible(nextTextQuote.text) ||
      !emptyAuthoredQuoteLine.test(nextSeparatorQuote.text) ||
      !/^\s*(?:>\s*)+<br\s*\/?>\s*$/i.test(nextEmptyQuote.text) ||
      !oneLineBreak.test(String(next).slice(nextTextQuote.end, nextSeparatorQuote.start)) ||
      !oneLineBreak.test(String(next).slice(nextSeparatorQuote.end, nextEmptyQuote.start))
    ) continue

    const depth = quoteDepth(nextTextQuote.text)
    if (
      quoteDepth(nextSeparatorQuote.text) !== depth ||
      quoteDepth(nextEmptyQuote.text) !== depth
    ) continue

    // This is the whole transaction proof. It works at document tail and in
    // the middle: every byte before the quote text and after the generated
    // empty row must be exactly the previous canonical snapshot.
    const collapsedNext = String(next).slice(0, nextTextQuote.end) +
      String(next).slice(nextEmptyQuote.end)
    if (collapsedNext !== String(previous)) continue

    const previousQuote = previousLines.find((line) =>
      line.start === nextTextQuote.start && line.end === nextTextQuote.end
    )
    if (
      !previousQuote ||
      quoteDepth(previousQuote.text) !== depth ||
      visible(previousQuote.text) !== visible(nextTextQuote.text)
    ) continue

    // Source/canonical spelling may already differ elsewhere in a long
    // document. Match this quote by the ordinal of VISIBLE quote rows rather
    // than raw offset, while still requiring identical depth and visible text.
    // Empty quote syntax / <br /> rows are deliberately excluded from ordinal
    // counting because authored source does not persist those transients.
    const quoteIndex = previousVisibleQuotes.findIndex((line) =>
      line.start === previousQuote.start && line.end === previousQuote.end
    )
    const sourceQuote = quoteIndex >= 0 ? sourceVisibleQuotes[quoteIndex] : null
    if (
      !sourceQuote ||
      quoteDepth(sourceQuote.text) !== depth ||
      visible(sourceQuote.text) !== visible(previousQuote.text)
    ) continue

    return {
      markdown: source,
      preserved: true,
      reason: 'trailing-empty-blockquote-paragraph-created'
    }
  }

  return null
}

// After the user clears a blockquote's text, Crepe keeps an empty blockquote
// (`> <br />`) and the authored source keeps a syntax-only `>` row. Pressing
// Backspace once more removes the blockquote node. Because `>` and `<br />`
// contribute no visible characters, the generic visible-stream mapper sees a
// zero-width structural change and cannot find the raw source row; it used to
// report success while leaving `>` behind, so save/reopen resurrected the
// quote. Map the complete zero-visible gap between the same neighbouring text
// anchors and replace it with the gap from the next canonical document.
export const preserveRemovedEmptyBlockquote = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousChanged = previous.slice(start, previousEnd)
  const nextChanged = next.slice(start, nextEnd)
  const previousRows = previousChanged.split(/\r\n|\n|\r/).filter((line) => line.trim())
  if (
    !previousRows.length ||
    !previousRows.every((line) => emptyCanonicalQuoteLine.test(line)) ||
    sourceVisibleIndex(previousChanged).text ||
    sourceVisibleIndex(nextChanged).text
  ) {
    return null
  }

  const previousVisible = sourceVisibleIndex(previous)
  const sourceVisible = sourceVisibleIndex(source)
  const nextVisible = sourceVisibleIndex(next)
  if (nextVisible.text !== previousVisible.text) return null

  const startVisible = sourceVisiblePositionAtRaw(previous, start).visibleIndex
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd).visibleIndex
  if (startVisible !== endVisible) return null

  // The authored source may already diverge from canonical elsewhere (for
  // example a mid-line literal `*`). Do not repeat the old whole-document
  // equality mistake: uniquely anchor up to 24 visible characters on both
  // sides of this zero-width boundary and map only that local source gap.
  const contextBefore = previousVisible.text.slice(Math.max(0, startVisible - 24), startVisible)
  const contextAfter = previousVisible.text.slice(startVisible, startVisible + 24)
  const context = contextBefore + contextAfter
  if (!context) return null
  const contextAt = sourceVisible.text.indexOf(context)
  if (contextAt < 0 || sourceVisible.text.indexOf(context, contextAt + 1) >= 0) return null
  const sourceBoundary = contextAt + contextBefore.length

  const sourceStart = sourceRawFromVisibleIndex(source, sourceBoundary, 'backward')
  const sourceEnd = sourceRawFromVisibleIndex(source, sourceBoundary, 'forward')
  const previousStart = sourceRawFromVisibleIndex(previous, startVisible, 'backward')
  const previousEndRaw = sourceRawFromVisibleIndex(previous, endVisible, 'forward')
  const nextStart = sourceRawFromVisibleIndex(next, startVisible, 'backward')
  const nextEndRaw = sourceRawFromVisibleIndex(next, endVisible, 'forward')
  if (
    !Number.isFinite(sourceStart) ||
    !Number.isFinite(sourceEnd) ||
    !Number.isFinite(previousStart) ||
    !Number.isFinite(previousEndRaw) ||
    !Number.isFinite(nextStart) ||
    !Number.isFinite(nextEndRaw) ||
    sourceStart > sourceEnd ||
    previousStart > previousEndRaw ||
    nextStart > nextEndRaw
  ) {
    return null
  }

  const sourceGap = source.slice(sourceStart, sourceEnd)
  const sourceRows = sourceGap.split(/\r\n|\n|\r/).filter((line) => line.trim())
  const previousGap = previous.slice(previousStart, previousEndRaw)
  const previousGapRows = previousGap.split(/\r\n|\n|\r/).filter((line) => line.trim())
  const nextGap = next.slice(nextStart, nextEndRaw)
  const nextRows = nextGap.split(/\r\n|\n|\r/).filter((line) => line.trim())
  const sourceQuoteRows = sourceRows.filter((line) => emptyAuthoredQuoteLine.test(line))
  const previousQuoteRows = previousGapRows.filter((line) => emptyCanonicalQuoteLine.test(line))
  const nextQuoteRows = nextRows.filter((line) => emptyCanonicalQuoteLine.test(line))
  const otherRows = (rows, isQuote) => rows
    .filter((line) => !isQuote.test(line))
    .map((line) => line.trim())
  if (
    !sourceQuoteRows.length ||
    sourceQuoteRows.length !== previousQuoteRows.length ||
    nextQuoteRows.length >= previousQuoteRows.length ||
    JSON.stringify(otherRows(sourceRows, emptyAuthoredQuoteLine)) !==
      JSON.stringify(otherRows(previousGapRows, emptyCanonicalQuoteLine)) ||
    JSON.stringify(otherRows(nextRows, emptyCanonicalQuoteLine)) !==
      JSON.stringify(otherRows(previousGapRows, emptyCanonicalQuoteLine))
  ) {
    return null
  }

  return {
    markdown: source.slice(0, sourceStart) +
      adaptCanonicalRegionToSource(
        withoutStandaloneEmptyBlockLines(nextGap),
        source,
        { start: sourceStart, end: sourceEnd }
      ) +
      source.slice(sourceEnd),
    preserved: true,
    reason: 'empty-blockquote-removed'
  }
}

// A rich-text edit that removes every character of a paragraph replaces its
// text with Crepe's internal standalone `<br />` placeholder. That placeholder
// is not authored Markdown and must never enter the raw source: the emptied
// paragraph maps to deleting its authored lines while the surrounding
// blank-line separators (and every untouched byte) stay exactly as written.
export const preserveEmptiedParagraph = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const nextEmptyLines = standaloneEmptyBlockLines(next)
  if (!nextEmptyLines.length) return null
  const nextChangedText = withoutStandaloneEmptyBlockLines(next.slice(start, nextEnd)).trim()
  const previousChangedText = withoutStandaloneEmptyBlockLines(previous.slice(start, previousEnd)).trim()
  // Inside a blockquote the emptied paragraph strips down to its `>` markers;
  // that is an empty paragraph, not authored text. An emptied list item
  // likewise strips to its bare marker (`3.`, `-`, `*`); the dedicated
  // empty-list-item-removed branch below owns removing that row, so a bare
  // marker in `previous` must NOT be rejected by the empty-residue guard.
  const isListMarkerResidue = (value) =>
    /^(?:[-+*]|\d{1,9}[.)])(?:\s+\[[ xX]\])?$/.test(value.trim())
  const isEmptyParagraphResidue = (value) =>
    !/[^\s>]/.test(value) && !isListMarkerResidue(value)
  // The delta must be exactly "real text (or a bare list marker) became empty
  // paragraph(s)". Inserting a fresh empty block, or editing text, belongs to
  // the other handlers. Exiting an empty item next to a surviving sibling list
  // leaks that sibling's marker prefix (`* ` of the following row) into the
  // change span: the sibling's text is common, only its canonical marker
  // differs (`- ` vs `* `). That bare-marker residue is the exit case too and
  // must not be rejected as "real text".
  if (
    (!isEmptyParagraphResidue(nextChangedText) && !isListMarkerResidue(nextChangedText)) ||
    isEmptyParagraphResidue(previousChangedText)
  ) return null
  // Backspace can empty a list item and Enter can immediately lift that empty
  // item into a standalone ProseMirror paragraph. Canonical then replaces the
  // list row with a bare `<br />`. This runs BEFORE the whole-document
  // tail-equality guards below: commonChange treats the shared `<br />` token
  // as common content, so the change span can stop at the marker and the
  // canonical `<br />` line sits outside `nextEnd` — the tail guard would
  // otherwise veto this transaction and fall into paragraph-emptied.
  //
  // The branch deletes the uniquely matching authored row including its own
  // EOL and collapses any surplus blank lines it created back to the
  // canonical empty-block count, preserving the separator before the
  // following block byte-for-byte.
  const previousLine = lineAt(previous, start)
  const previousLineText = previous.slice(previousLine.start, previousLine.end)
  const bareEmptyParagraph = nextEmptyLines.some((range) =>
    range.end >= start &&
    range.start <= nextEnd &&
    /^\s*<br\s*\/?>\s*$/i.test(next.slice(range.start, range.end))
  )
  if (bareEmptyParagraph && listMarker(previousLineText)) {
    // `sourceVisibleIndex` treats an ordered marker's own ordinal (`3.`) as
    // visible text, so it cannot tell an empty `3. ` row apart from content.
    // Task rows add one more syntax layer: `[ ]` / `[x]` is list-item metadata,
    // while generated empty tasks can persist U+200B as their zero-width source
    // body. Parse both layers before deciding whether the row is genuinely empty.
    const emptyListItemShape = (lineText) => {
      const marker = String(lineText || '').match(/^(\s*)([-+*]|\d{1,9}[.)])(\s+)(.*)$/)
      if (!marker) return null
      let body = marker[4]
      let taskState = null
      const task = body.match(/^\[([ xX])\](?:\s+|$)(.*)$/)
      if (task) {
        taskState = task[1].toLowerCase()
        body = task[2]
      }
      const authoredBody = body.replaceAll(LEADING_SPACE_SENTINEL, '').trim()
      return {
        indent: marker[1].length,
        token: marker[2],
        taskState,
        empty: !authoredBody || /^<br\s*\/?>$/i.test(authoredBody)
      }
    }
    const previousItemShape = emptyListItemShape(previousLineText)
    const previousVisible = previousItemShape?.empty
      ? ''
      : sourceVisibleIndex(previousLineText).text.trim()
    // An empty list item carries no visible text, so the visible-text anchor
    // below cannot tell `3. ` apart from any other empty row. Anchor by the
    // exact authored spelling (indent width + marker kind + task state) instead;
    // the row must still be unique in the source before we delete it. Crepe
    // normalizes every authored bullet token to `*` in canonical, so compare
    // bullet tokens by kind while keeping task-vs-plain and checked state exact.
    const bulletKindKey = (token) => /^[-+*]$/.test(token) ? 'bullet' : token
    const emptyItemKey = !previousVisible && previousItemShape?.empty
      ? `${previousItemShape.indent}\u0000${bulletKindKey(previousItemShape.token)}\u0000${previousItemShape.taskState ?? 'plain'}`
      : null
    const sourceRows = markdownLines(source).filter((line) => {
      if (!listMarker(line.text)) return false
      if (emptyItemKey) {
        const shape = emptyListItemShape(line.text)
        return Boolean(shape?.empty) &&
          `${shape.indent}\u0000${bulletKindKey(shape.token)}\u0000${shape.taskState ?? 'plain'}` === emptyItemKey
      }
      const visible = sourceVisibleIndex(line.text).text.trim()
      return Boolean(previousVisible) && visible === previousVisible
    })
    if ((previousVisible || emptyItemKey) && sourceRows.length === 1) {
      const [row] = sourceRows
      const rowEnd = row.end < source.length && source[row.end] === '\n'
        ? row.end + 1
        : row.end
      const removedTrailingRow = rowEnd === source.length
      const eol = lineEndingNear(source, row.start)
      const breakPattern = /\r\n|[\r\n]/g
      // The canonical empty item becomes a standalone `<br />` segment. Every
      // authored blank line that the exit created on top of that segment is
      // surplus and must be dropped; keeping it shifts the following block's
      // blank-line count and the list-slot fingerprint fails closed.
      const expectedBlankSegments = nextEmptyLines.filter((range) =>
        range.end >= start && range.start <= nextEnd
      ).length
      // `rowEnd` already swallowed the removed row's own line ending, so each
      // canonical empty segment contributes exactly one additional break (one
      // blank line = one break on top of the surviving row's EOL).
      const expectedBreakCount = Math.max(1, expectedBlankSegments)
      let keptTail = source.slice(rowEnd)
      const leadingBreaks = (keptTail.match(/^(?:\r\n|[\r\n])*/) || [''])[0]
      const leadingBreakCount = (leadingBreaks.match(breakPattern) || []).length
      if (leadingBreakCount > expectedBreakCount) {
        keptTail = eol.repeat(expectedBreakCount) + keptTail.slice(leadingBreaks.length)
      }
      const prefixEnd = source.slice(0, row.start)
      const prefixTrailingBreaks = (prefixEnd.match(/(?:\r\n|[\r\n])*$/) || [''])[0]
      const prefixBreakCount = (prefixTrailingBreaks.match(breakPattern) || []).length
      // A loose first-Enter insert can write a blank line before an empty row
      // INSIDE an existing list (`- 是v的；发布\n\n- \n\n- 露娜了`).
      // That blank is an editor-owned exit placeholder, so list-internal
      // removal collapses it. RS-84 exposes the opposite boundary: a
      // cross-list selection leaves the empty row as the FIRST item of a new
      // bullet list after an ordinary paragraph (`正文\n\n- \n- surviving`).
      // In that shape the preceding blank is the authored separator between
      // the left block and the surviving list. Removing it produces
      // `正文\n- surviving`, a silent byte-level formatting drift even though
      // the parser still accepts both forms. Preserve the block gap only when
      // the deleted row is top-level, the immediately surviving source row is
      // another top-level bullet, and the nearest source content on the left is
      // not a list row. Every list-internal empty-item path keeps the existing
      // collapse behavior.
      const previousSourceNonBlank = source
        .slice(0, row.start)
        .split(/\r\n|\r|\n/)
        .reverse()
        .find((line) => line.trim()) || ''
      const nextSourceLine = markdownLines(source.slice(rowEnd))
        .find((line) => line.text.trim())?.text || ''
      const removedMarker = row.text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
      const survivingMarker = nextSourceLine.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
      const preserveLeadingBlockGap = Boolean(
        removedMarker?.[1]?.length === 0 &&
        /^[-+*]$/.test(removedMarker?.[2] || '') &&
        survivingMarker?.[1]?.length === 0 &&
        /^[-+*]$/.test(survivingMarker?.[2] || '') &&
        !listMarker(previousSourceNonBlank)
      )
      // The row's own EOL was already swallowed by `rowEnd`, so ordinary
      // list-internal removal keeps at most one trailing break when content
      // follows. A proven block-leading empty item retains its authored gap.
      const prefix = prefixBreakCount > 1 && keptTail.trim() && !preserveLeadingBlockGap
        ? prefixEnd.slice(0, prefixEnd.length - prefixTrailingBreaks.length) + eol
        : prefixEnd
      const kept = prefix + keptTail
      const sourceTrailingBreakCount = (
        source.match(/(?:\r\n|\r|\n)*$/)?.[0]?.match(/\r\n|\r|\n/g) || []
      ).length
      const trailingNewlineGrowth = removedTrailingRow
        ? sourceTrailingBreakCount === 0 ? 2 : 1
        : 0
      const removedSourceMarker = row.text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
      const nestedEmptyListItemRemoved = Boolean(removedSourceMarker?.[1]?.length)
      const ownedEmptyParagraph = nextEmptyLines.find((range) =>
        range.end >= start && range.start <= nextEnd
      )
      const ownedEmptyIndent = ownedEmptyParagraph
        ? (next.slice(ownedEmptyParagraph.start, ownedEmptyParagraph.end).match(/^([ \t]*)<br\s*\/?>/i)?.[1]?.length || 0)
        : 0
      // RS-60: Backspace on a second empty task item can remove that task row
      // and move the resulting empty paragraph INSIDE the preceding task item.
      // Its canonical `<br />` is therefore more indented than the removed
      // top-level task marker. Keep this distinct from RS-51's post-list empty
      // paragraph so generated scratch never arms the RS-52 top-level token.
      const taskItemMergedToContinuation = Boolean(
        previousItemShape?.taskState != null &&
        ownedEmptyIndent > previousItemShape.indent
      )
      // RS-63: the same PM merge can happen for a plain top-level bullet when
      // the preceding list item ends in a nested list. Generic RS-51 only
      // ignores an editor-owned trailing empty paragraph after a TEXT paragraph;
      // keep nested structure strict unless raw canonical proves this exact
      // transition. The nearest non-empty line before the removed row must be a
      // deeper list row, and the new `<br />` must move to a deeper indent.
      const previousNonBlankLine = previous
        .slice(0, previousLine.start)
        .split(/\r\n|\r|\n/)
        .reverse()
        .find((line) => line.trim()) || ''
      const previousNonBlankIndent = previousNonBlankLine.match(/^([ \t]*)/)?.[1]?.length || 0
      const plainItemMergedAfterNestedList = Boolean(
        previousItemShape?.taskState == null &&
        previousItemShape?.indent === 0 &&
        ownedEmptyIndent > previousItemShape.indent &&
        listMarker(previousNonBlankLine) &&
        previousNonBlankIndent > previousItemShape.indent
      )
      return {
        // Enter twice exits the list into a real trailing paragraph. Keep one
        // raw blank-line slot for the next typed block; otherwise a later list
        // input rule has nowhere to attach and its marker is glued to the
        // previous list item. This is user-authored Enter state, not Crepe's
        // serializer padding.
        markdown: removedTrailingRow
          ? kept + eol
          : kept,
        preserved: true,
        // Nested removal leaves its transient empty paragraph INSIDE the parent
        // list item. Keep that distinct from RS-51's top-level/post-list
        // transient so generated scratch does not arm the RS-52 post-list token.
        reason: taskItemMergedToContinuation
          ? 'empty-task-item-merged-to-continuation'
          : plainItemMergedAfterNestedList
            ? 'empty-list-item-merged-after-nested-list'
            : nestedEmptyListItemRemoved
              ? 'nested-empty-list-item-removed'
              : 'empty-list-item-removed',
        // A no-final-newline file needs two physical line endings after the
        // final empty row is removed: one terminates the surviving row and one
        // owns the blank block boundary. A source that already ended in EOL
        // needs only one additional break.
        trailingNewlineGrowth
      }
    }
  }
  // The emptied paragraphs are the entire delta between otherwise identical
  // documents. The source may legitimately disagree with the canonical's
  // visible stream ELSEWHERE (for example a mid-line `* ` that remark parses
  // as a list item while the authored line keeps it as paragraph text). Only
  // the mapped region must align; preserveChangedLineRegion verifies that
  // locally and fails closed, so a whole-document equality check here would
  // veto valid empty-paragraph mappings and let <br /> leak.
  if (previous.slice(0, start) !== next.slice(0, start)) return null
  if (previous.slice(previousEnd) !== next.slice(nextEnd)) return null
  return preserveChangedLineRegion({
    source,
    previous,
    next,
    start,
    previousEnd,
    nextEnd,
    reason: 'paragraph-emptied',
    transformReplacement: withoutStandaloneEmptyBlockLines
  })
}

const appendBlockAtDocumentEnd = (source, canonicalBlock) => {
  const eol = lineEndingNear(source, source.length)
  const sourceTrailingBreaks = source.match(/(?:(?:\r\n)|\n|\r)*$/)?.[0] || ''
  const sourceTrailingNewlines = sourceTrailingBreaks.match(/\r\n|\n|\r/g)?.length || 0
  const canonical = withoutStandaloneEmptyBlockLines(canonicalBlock)
    .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
    .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
  // Dedicated-syntax rows (list markers, tables, headings, quotes, fences)
  // must not be spell-checked by the fresh-punctuation restore (that would
  // unescape an authored `\*`), but canonical entity spelling (`&#x20;` for a
  // leading content space) still has to be translated back to authored text.
  // canonicalTextToSource without the fresh flag does exactly that.
  // RS-55: while a user is typing a new paragraph, the whole block can be the
  // literal text `3.` before the following Space fires the ordered-list input
  // rule. Crepe serializes that paragraph as `3\\.` specifically so Markdown
  // does NOT parse it as a list yet. Fresh-punctuation restoration is correct
  // for inline text, but removing this block-level escape changes structure one
  // keystroke too early and trips integrity. Keep only this exact protective
  // whole-block marker; the real list transaction on Space uses the list path.
  const protectedWholeBlockOrderedMarker = /^\s*\d{1,9}\\[.)]\s*$/.test(canonical)
  const block = hasDedicatedBlockSyntax(canonical)
    ? canonicalTextToSource(canonical)
    : protectedWholeBlockOrderedMarker
      ? canonical
      : canonicalFreshTextToSource(canonical)
  if (!block) return null
  const separator = eol.repeat(Math.max(0, 2 - sourceTrailingNewlines))
  const finalNewline = sourceTrailingNewlines > 0 ? eol : ''
  return source + separator +
    adaptCanonicalRegionToSource(block, source, { start: source.length, end: source.length }) +
    finalNewline
}

const trailingSingleLineBlock = (markdown) => {
  const value = String(markdown || '')
  const trailingBreaks = value.match(/(?:(?:\r\n)|\n|\r)*$/)?.[0] || ''
  const end = value.length - trailingBreaks.length
  if (end <= 0) return null
  const before = value.slice(0, end)
  const previousBreak = Math.max(
    before.lastIndexOf('\n'),
    before.lastIndexOf('\r')
  )
  const start = previousBreak + 1
  const prefixBreaks = value.slice(0, start).match(/(?:(?:\r\n)|\n|\r)+$/)?.[0] || ''
  const breakCount = prefixBreaks.match(/\r\n|\n|\r/g)?.length || 0
  if (start > 0 && breakCount < 2) return null
  const text = value.slice(start, end)
  if (!text.trim() || /\r|\n/.test(text)) return null
  return { start, end, text, trailingBreaks }
}

// A syntax-only trailing paragraph (for example the temporary escaped
// backtick before inline code gets its first character) has no stable visible
// offset. If that exact final line still exists in the authored source, replace
// the line directly and preserve every non-canonical byte before it.
export const preserveTrailingExactLineChange = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceBlock = trailingSingleLineBlock(source)
  const previousBlock = trailingSingleLineBlock(previous)
  const nextBlock = trailingSingleLineBlock(next)
  if (!sourceBlock || !previousBlock || !nextBlock) return null
  if (
    start < previousBlock.start ||
    start < nextBlock.start ||
    previousEnd > previousBlock.end ||
    nextEnd > nextBlock.end ||
    sourceBlock.text !== previousBlock.text
  ) {
    return null
  }

  const replacement = adaptCanonicalRegionToSource(
    nextBlock.text,
    source,
    sourceBlock
  )
  return {
    markdown: source.slice(0, sourceBlock.start) +
      replacement +
      source.slice(sourceBlock.end),
    preserved: true,
    reason: 'trailing-exact-line-change'
  }
}

const trailingEmptyBlock = (markdown) => {
  const match = markdown.match(/(?:^|\n{2})(?:[ \t]*>[ \t]*)*<br\s*\/?>\n*$/i)
  if (!match) return null
  const prefixLength = match[0].startsWith('\n\n') ? 2 : 0
  return {
    start: match.index + prefixLength,
    end: markdown.length
  }
}

// While a user holds Space in a new rich paragraph, Crepe serializes a
// sequence of whitespace-only paragraphs before the first visible character
// arrives (`  `, `   `, `    `, then `&#x20; ...text`). Those intermediate
// snapshots are still empty from the authored-source perspective. Treat them
// like the normal `<br />` placeholder so they cannot enter generic structural
// line mapping and collapse the paragraph boundary onto the previous line.
const trailingCanonicalEmptyBlock = (markdown) => {
  const placeholder = trailingEmptyBlock(markdown)
  if (placeholder) return placeholder
  const match = String(markdown || '').match(
    /(?:^|\n{2})(?:[ \t]*>[ \t]*)*[ \t]+\n*$/
  )
  if (!match) return null
  const prefixLength = match[0].startsWith('\n\n') ? 2 : 0
  return {
    start: match.index + prefixLength,
    end: String(markdown || '').length
  }
}

// Crepe represents an empty paragraph as a standalone `<br />` line. Inside a
// blockquote that line is prefixed by the quote marker (`> <br />`); both
// spellings are editor placeholders, never authored content.
const standaloneEmptyBlockLines = (markdown) => markdownLines(markdown)
  .filter((line) => /^\s*(?:[ \t]*>[ \t]*)*<br\s*\/?>\s*$/i.test(line.text))

export const withoutStandaloneEmptyBlockLines = (markdown) => String(markdown || '')
  .replace(
    /^((?:[ \t]*>[ \t]*)*)[ \t]*<br\s*\/?>[ \t]*$/gim,
    (match, prefix) => prefix.replace(/[ \t]+$/, '')
  )

// The file's terminal line-ending run (0, 1, or more trailing newlines) is
// authored formatting. Crepe can append a serializer blank line after the last
// block (`item\n\n`); only the block bytes belong to the edit, so the output's
// trailing run must never GROW beyond the source's. The source's authored
// trailing blank lines may legitimately become mid-document separators when a
// paragraph is appended, so the output is clamped rather than force-equalized.
export const capOutputTrailingNewlines = (markdown, source, allowedGrowth = 0) => {
  const output = String(markdown || '')
  // A brand-new document generated from an empty source has no authored
  // terminal convention yet; its own serializer newline is the structure.
  if (!String(source || '').trim()) return output
  const outputTrail = output.match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const sourceTrail = String(source || '').match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const countBreaks = (run) => (run.match(/\r\n|\n|\r/g) || []).length
  const sourceCount = countBreaks(sourceTrail)
  const outputCount = countBreaks(outputTrail)
  const limit = sourceCount + Math.max(0, Number(allowedGrowth) || 0)
  if (outputCount <= limit) return output
  const eol = lineEndingNear(source, source.length)
  return output.slice(0, output.length - outputTrail.length) + sourceTrail + eol.repeat(limit - sourceCount)
}

const rangeTouches = (range, start, end) =>
  range.start <= Math.max(start, end) && range.end >= Math.min(start, end)

const hasDedicatedBlockSyntax = (markdown) => markdownLines(markdown).some(({ text }) => {
  const trimmed = text.trim()
  if (!trimmed) return false
  return !!listMarker(text) ||
    isTableLine(text) ||
    /^(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(trimmed)
})

// A list created by typing into an already-proven empty paragraph owns that
// whole zero-width block slot. A deferred markdownUpdated may publish the list
// rows and the paragraph typed after exiting the list together, so the changed
// region can contain both list markers and ordinary continuation/prose rows.
// Keep headings, quotes, tables, fences, and thematic breaks on their dedicated
// mappers; accepting those here would bypass their source-specific contracts.
const isMiddleListSlotFill = (markdown) => {
  const lines = markdownLines(withoutStandaloneEmptyBlockLines(markdown))
  let hasList = false
  for (const { text } of lines) {
    const trimmed = text.trim()
    if (!trimmed) continue
    if (listMarker(text)) {
      hasList = true
      continue
    }
    if (
      isTableLine(text) ||
      /^(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(trimmed)
    ) return false
  }
  return hasList
}

// A real Enter inside a paragraph is a structural split, not a visible-text
// edit. This deserves its own transaction proof because an existing document
// may already have a source/canonical visible-stream divergence elsewhere (for
// example authored `-` versus Crepe's `*`, or nested marker spelling). In that
// situation ordinary visible-offset mappers intentionally fail closed, but
// the split itself is still unambiguous when its canonical before/after text
// surrounds one newly inserted paragraph separator.
export const preserveParagraphSplit = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousVisible = sourceVisibleIndex(previous)
  const nextVisible = sourceVisibleIndex(next)
  if (previousVisible.text !== nextVisible.text) return null

  const previousChanged = previous.slice(start, previousEnd)
  const nextChanged = next.slice(start, nextEnd)
  if (Array.isArray(globalThis.__hmParagraphTrace)) {
    globalThis.__hmParagraphTrace.push({
      phase: 'paragraph-split-candidate',
      start,
      previousEnd,
      nextEnd,
      previousChanged: previousChanged.slice(0, 120),
      nextChanged: nextChanged.slice(0, 120),
      canonicalVisibleEqual: previousVisible.text === nextVisible.text
    })
    if (globalThis.__hmParagraphTrace.length > 40) globalThis.__hmParagraphTrace.shift()
  }
  const splitLineRange = lineAt(previous, start)
  const splitLine = previous.slice(splitLineRange.start, splitLineRange.end)
  const splitLineSyntax = splitLine.trim()
  if (
    previousChanged.includes('\n') ||
    !/(?:\r\n|\n|\r){2,}/.test(nextChanged) ||
    hasDedicatedBlockSyntax(nextChanged.replace(/(?:\r\n|\n|\r)+/g, '')) ||
    listMarker(splitLine) ||
    isTableLine(splitLine) ||
    /^(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(splitLineSyntax)
  ) return null

  const splitVisible = sourceVisiblePositionAtRaw(previous, start).visibleIndex
  const before = previousVisible.text.slice(Math.max(0, splitVisible - 48), splitVisible)
  const after = previousVisible.text.slice(splitVisible, splitVisible + 48)
  if (Array.isArray(globalThis.__hmParagraphTrace)) {
    globalThis.__hmParagraphTrace.push({
      phase: 'paragraph-split-context',
      splitVisible,
      before,
      after,
      previousVisibleLength: previousVisible.text.length
    })
    if (globalThis.__hmParagraphTrace.length > 40) globalThis.__hmParagraphTrace.shift()
  }
  if (!before || !after) return null

  const sourceVisibleText = sourceVisibleIndex(source).text
  const boundary = `${before}${after}`
  const first = sourceVisibleText.indexOf(boundary)
  const boundaryCount = first < 0 ? 0 : sourceVisibleText.split(boundary).length - 1
  if (Array.isArray(globalThis.__hmParagraphTrace)) {
    globalThis.__hmParagraphTrace.push({
      phase: 'paragraph-split-boundary',
      splitVisible,
      before,
      after,
      boundary,
      boundaryCount,
      sourceVisibleLength: sourceVisibleText.length
    })
    if (globalThis.__hmParagraphTrace.length > 40) globalThis.__hmParagraphTrace.shift()
  }
  if (first < 0 || sourceVisibleText.indexOf(boundary, first + 1) >= 0) return null
  const sourceSplitVisible = first + before.length
  const rawSplit = sourceRawFromVisibleIndex(source, sourceSplitVisible, 'forward')
  if (!Number.isFinite(rawSplit) || rawSplit <= 0 || rawSplit >= source.length) return null

  const eol = lineEndingNear(source, rawSplit)
  const authoredAroundSplit = source.slice(Math.max(0, rawSplit - 1), rawSplit + 1)
  if (authoredAroundSplit.includes('\n') || authoredAroundSplit.includes('\r')) {
    // The source already owns a line boundary at this exact visible split.
    // Do not add another one merely because the canonical serializer changed
    // its empty-paragraph representation.
    return {
      markdown: source,
      preserved: true,
      reason: 'paragraph-split-already-authored'
    }
  }

  const markdown = source.slice(0, rawSplit) + eol + eol + source.slice(rawSplit)
  return {
    markdown,
    preserved: true,
    reason: 'paragraph-split'
  }
}

// Preserve an empty paragraph inserted between two existing blocks without
// leaking Crepe's transient standalone `<br />` into authored Markdown.
export const preserveMiddleEmptyBlock = ({
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

  const previousChangeLine = lineAt(previous, start)
  const directBlockInsertion =
    previousEnd === start &&
    !previousChangedText &&
    !!nextChangedText &&
    (start === previousChangeLine.start || start === previousChangeLine.end)
  if ((!previousChangedEmpty && !directBlockInsertion) || !nextChangedText) return null
  const changedRegion = next.slice(start, nextEnd)
  // The empty paragraph may have already been committed by the preceding
  // plain-text callback, so `previousChangedEmpty` is not a reliable ownership
  // signal for the following list input-rule transaction. The dedicated-list
  // shape itself, together with the two neighbouring visible anchors below,
  // proves this is a middle list-slot fill.
  const middleListSlotFill = isMiddleListSlotFill(changedRegion)
  if (hasDedicatedBlockSyntax(changedRegion) && !middleListSlotFill) return null

  const previousLines = visibleLineEntries(previous)
  const sourceLines = visibleLineEntries(source)

  let beforeIndex = -1
  for (let index = 0; index < previousLines.length; index += 1) {
    if (previousLines[index].end <= start) beforeIndex = index
  }
  const afterIndex = previousLines.findIndex((line) => line.start >= previousEnd)
  if (beforeIndex < 0 || afterIndex < 0 || afterIndex <= beforeIndex) return null

  const previousBefore = previousLines[beforeIndex]
  const previousAfter = previousLines[afterIndex]
  let sourceBefore
  let sourceAfter
  if (sameVisibleLines(sourceLines, previousLines)) {
    sourceBefore = sourceLines[beforeIndex]
    sourceAfter = sourceLines[afterIndex]
  } else {
    // A divergence near the document start (`- - text`, escaped punctuation,
    // etc.) shifts every later visible-line index. Using beforeIndex directly
    // then inserts a newly filled paragraph into an unrelated earlier quote —
    // especially when many quote rows contain the same “测试” text. Identify
    // the neighbouring visible-line pair by its own ordinal among equivalent
    // pairs instead of borrowing the document-global index.
    const lineKind = (line) => {
      const text = line?.text || ''
      if (/^\s*>/.test(text)) return 'quote'
      if (/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(text)) return 'list'
      if (/^\s*#{1,6}\s+/.test(text)) return 'heading'
      if (/^\s*\|/.test(text)) return 'table'
      return 'plain'
    }
    const pairMatches = (lines, before, after) => {
      const matches = []
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (
          lines[index].visible === before.visible &&
          lines[index + 1].visible === after.visible &&
          lineKind(lines[index]) === lineKind(before) &&
          lineKind(lines[index + 1]) === lineKind(after)
        ) matches.push(index)
      }
      return matches
    }
    const previousPairs = pairMatches(previousLines, previousBefore, previousAfter)
    const pairOrdinal = previousPairs.indexOf(beforeIndex)
    const sourcePairs = pairMatches(sourceLines, previousBefore, previousAfter)
    let sourcePairIndex = Number.isInteger(sourcePairs[pairOrdinal])
      ? sourcePairs[pairOrdinal]
      : null
    // Repeated paragraphs make the pair ordinal unstable after the first
    // insertion: the current canonical edit position is a better owner than
    // the original pair ordinal whenever it resolves near a source pair.
    const sourceHint = sourceRawFromVisibleIndex(
      source,
      sourceVisiblePositionAtRaw(previous, start).visibleIndex,
      'forward'
    )
    if (Number.isFinite(sourceHint) && sourcePairs.length) {
      const nearest = sourcePairs.reduce((best, candidate) => {
        if (!Number.isInteger(best)) return candidate
        const bestDistance = Math.abs(sourceLines[best].start - sourceHint)
        const candidateDistance = Math.abs(sourceLines[candidate].start - sourceHint)
        return candidateDistance < bestDistance ? candidate : best
      }, null)
      if (Number.isInteger(nearest)) sourcePairIndex = nearest
    }
    if (!Number.isInteger(sourcePairIndex)) return null
    sourceBefore = sourceLines[sourcePairIndex]
    sourceAfter = sourceLines[sourcePairIndex + 1]
  }
  if (
    !sourceBefore ||
    !sourceAfter ||
    sourceBefore.visible !== previousBefore.visible ||
    sourceAfter.visible !== previousAfter.visible
  ) {
    return null
  }
  const delta = nextEnd - previousEnd
  // `next` may insert one or more `<br />` lines before the old right
  // neighbour, so its raw offset is no longer `previousAfter.start + delta`.
  // Resolve both anchors by visible text and block kind around the changed
  // range. This is especially important for repeated paragraphs: the nearest
  // matching pair is the structural slot, not the first equal sentence in the
  // document.
  const lineKind = (line) => {
    const text = line?.text || ''
    if (/^\s*>/.test(text)) return 'quote'
    if (/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(text)) return 'list'
    if (/^\s*#{1,6}\s+/.test(text)) return 'heading'
    if (/^\s*\|/.test(text)) return 'table'
    return 'plain'
  }
  const nextLines = visibleLineEntries(next)
  const beforeCandidates = nextLines.filter((line) =>
    line.end <= start &&
    line.visible === previousBefore.visible &&
    lineKind(line) === lineKind(previousBefore)
  )
  const afterCandidates = nextLines.filter((line) =>
    line.start >= nextEnd &&
    line.visible === previousAfter.visible &&
    lineKind(line) === lineKind(previousAfter)
  )
  const nextBefore = beforeCandidates.at(-1) || lineAt(next, previousBefore.start)
  const nextAfter = afterCandidates[0] || lineAt(next, previousAfter.start + delta)
  const nextBeforeVisible = sourceVisibleIndex(next.slice(nextBefore.start, nextBefore.end)).text.trim()
  const nextAfterVisible = sourceVisibleIndex(next.slice(nextAfter.start, nextAfter.end)).text.trim()
  if (
    nextBeforeVisible !== previousBefore.visible ||
    nextAfterVisible !== previousAfter.visible
  ) {
    return null
  }

  // markdownLines() includes the `\r` byte in a CRLF row's text range. The
  // middle-slot edit owns the complete line ending after the left anchor; a
  // splice at sourceBefore.end would retain that `\r` and then emit a fresh
  // `\r\n`, producing `\r\r\n`. Start before the complete CRLF pair.
  const sourceBeforeContentEnd = sourceBefore.text.endsWith('\r')
    ? sourceBefore.end - 1
    : sourceBefore.end
  const sourceGap = source.slice(sourceBeforeContentEnd, sourceAfter.start)
  if (standaloneEmptyBlockLines(sourceGap).length) return null
  const nextGap = next.slice(nextBefore.end, nextAfter.start)
  // If the authored gap already owns an empty list-marker row, a canonical
  // filled row is an edit *inside that item*, not a new block inserted before
  // later authored syntax. This must be decided before the fence-special case
  // below or the fence branch will steal the fill and can turn literal `1\\.`
  // item text into structural `1.` Markdown.
  const sourceGapEmptyListRow = sourceGap.match(
    /(?:^|\r?\n)[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]*(?=\r?\n|$)/
  )
  const nextGapFilledListRow = nextGap.match(
    /(?:^|\r?\n)[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\S/
  )
  const fillingAuthoredEmptyListItem =
    !!sourceGapEmptyListRow && !!nextGapFilledListRow
  // A visible-line mapper can omit syntax-only rows such as a fenced code
  // block's opening line. If that authored gap contains real Markdown syntax,
  // do not replace the gap with a plain canonical slice: that would drop an
  // info string (` ```js `) while inserting an unrelated paragraph before the
  // fence. Keep the authored gap byte-for-byte and insert only the proven new
  // plain block before it.
  const sourceGapHasAuthoredSyntax = /\S/.test(sourceGap)
  // A fenced block's opening row is syntax-only from the visible-line mapper's
  // perspective, so a batched edit can choose the first code-content row as
  // `sourceAfter`. Inserting a new list/prose block through the generic gap
  // replacement then drops the opening fence and leaves the closing fence at
  // the wrong place. Keep the authored fence segment intact and insert the
  // newly-created visible block immediately before it.
  const sourceGapFence = sourceGap.match(/(?:^|\r?\n)[ \t]*(?:`{3,}|~{3,})[^\r\n]*/)
  const nextGapFence = nextGap.match(/(?:^|\r?\n)[ \t]*(?:`{3,}|~{3,})[^\r\n]*/)
  const fenceStartInGap = (gap, match) => match
    ? gap.indexOf(match[0]) + match[0].lastIndexOf('\n') + 1
    : -1
  const sourceFenceStart = fenceStartInGap(sourceGap, sourceGapFence)
  const nextFenceStart = fenceStartInGap(nextGap, nextGapFence)
  const sourceFenceAndAfter = sourceFenceStart >= 0 ? sourceGap.slice(sourceFenceStart) : ''
  const nextFenceAndAfter = nextFenceStart >= 0 ? nextGap.slice(nextFenceStart) : ''
  if (
    sourceGapFence &&
    nextGapFence &&
    sourceFenceAndAfter === nextFenceAndAfter &&
    nextChangedText &&
    !fillingAuthoredEmptyListItem &&
    !/(?:^|\r?\n)[ \t]*(?:`{3,}|~{3,})/.test(nextChangedText)
  ) {
    // The visible-line delta ends before the fence because the fence itself
    // has no visible text. Use the next gap's prefix, not commonChange's
    // shorter changed slice: that prefix is the complete set of new blocks
    // (list rows and/or prose) that must be inserted before the unchanged,
    // authored fence.
    const insertedLines = withoutStandaloneEmptyBlockLines(
      nextGap.slice(0, nextFenceStart)
    )
      .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
      .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
    if (insertedLines.trim()) {
      const eol = lineEndingNear(source, sourceBeforeContentEnd)
      const sourceMarker = sourceBefore.text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
      const localizeMarker = (value) => {
        if (!sourceMarker) return value
        return value.replace(
          /^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/,
          (match, indent, marker) => {
            const sourceOrdered = /^\d/.test(sourceMarker[2])
            const insertedOrdered = /^\d/.test(marker)
            if (sourceOrdered !== insertedOrdered) return match
            if (sourceOrdered) {
              // Keep the canonical ordinal for a newly-created ordered item,
              // while retaining the authored delimiter style (`.` versus `)`).
              // Reusing the entire previous marker turns canonical `2.` into
              // authored `1.` and fails the strict list-slot integrity proof.
              const sourceDelimiter = sourceMarker[2].slice(-1)
              const insertedNumber = marker.slice(0, -1)
              return `${indent}${insertedNumber}${sourceDelimiter}`
            }
            return `${indent}${sourceMarker[2]}`
          }
        )
      }
      const localizedInsertedLines = localizeMarker(insertedLines)
      // The complete inserted block can temporarily be the literal text `1.`
      // before the user types the trailing space that turns it into a real
      // ordered list. Crepe serializes that paragraph as `1\\.`. Restoring the
      // escape here would change its Markdown meaning before the input rule has
      // fired, so keep the block-level protective escape exactly as the generic
      // middle-empty-block path below already does.
      const insertedSource = /^\s*\d{1,9}\\[.)]\s*$/.test(localizedInsertedLines)
        ? localizedInsertedLines
        : canonicalFreshTextToSource(localizedInsertedLines)
      const insertedMarker = localizedInsertedLines.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=\s)/)
      const sameListContinuation = sourceMarker && insertedMarker &&
        /^\d/.test(sourceMarker[2]) === /^\d/.test(insertedMarker[2])
      const beforeInsertedSeparator = sameListContinuation ? eol : eol.repeat(2)
      return {
        markdown: source.slice(0, sourceBeforeContentEnd) +
          beforeInsertedSeparator +
          adaptCanonicalRegionToSource(insertedSource, source, {
            start: sourceBeforeContentEnd,
            end: sourceBeforeContentEnd
          }) +
          eol.repeat(2) +
          sourceFenceAndAfter +
          source.slice(sourceAfter.start),
        preserved: true,
        reason: 'middle-block-before-authored-fence'
      }
    }
  }
  if (
    directBlockInsertion &&
    sourceGapHasAuthoredSyntax &&
    nextChangedText &&
    !hasDedicatedBlockSyntax(nextChangedText) &&
    !fillingAuthoredEmptyListItem
  ) {
    const eol = lineEndingNear(source, sourceBeforeContentEnd)
    const insertedText = adaptCanonicalRegionToSource(
      canonicalFreshTextToSource(nextChangedText),
      source,
      { start: sourceBeforeContentEnd, end: sourceBeforeContentEnd }
    )
    return {
      markdown: source.slice(0, sourceBeforeContentEnd) +
        eol.repeat(2) +
        insertedText +
        source.slice(sourceBeforeContentEnd),
      preserved: true,
      reason: 'middle-block-inserted'
    }
  }
  if (Array.isArray(globalThis.__hmParagraphTrace)) {
    globalThis.__hmParagraphTrace.push({
      phase: 'mapped-middle-slot',
      sourceBefore: sourceBefore.text,
      sourceAfter: sourceAfter.text,
      sourceGap,
      previousGap: previous.slice(previousBefore.end, previousAfter.start),
      nextGap,
      directBlockInsertion
    })
    if (globalThis.__hmParagraphTrace.length > 30) globalThis.__hmParagraphTrace.shift()
  }
  // A list follows this source gap in the affected family. Crepe may publish
  // one or more empty `<br />` rows around a newly typed plain paragraph; the
  // source owns only the blank-line separator. Extract the visible inserted
  // rows and add one normal Markdown block before the list. This handles both
  // insertion into a fresh slot and filling the last of several empty slots.
  if (
    listMarker(sourceAfter.text) &&
    nextChangedText &&
    standaloneEmptyBlockLines(nextGap).length
  ) {
    const placeholderStarts = new Set(
      standaloneEmptyBlockLines(nextGap).map((range) => range.start)
    )
    const eol = lineEndingNear(source, sourceAfter.start)
    const withoutPlaceholders = markdownLines(nextGap)
      .filter((line) => !placeholderStarts.has(line.start))
      .map((line) => line.text)
      .join(eol)
      .replace(/^(?:[ \\t]*\n)+/, '')
      .replace(/(?:\n[ \\t]*)+$/, '')
    const insertedText = canonicalFreshTextToSource(withoutPlaceholders)
    if (insertedText.trim() && !hasDedicatedBlockSyntax(insertedText)) {
      return {
        markdown: source.slice(0, sourceAfter.start) +
          adaptCanonicalRegionToSource(
            insertedText + eol.repeat(2),
            source,
            { start: sourceAfter.start, end: sourceAfter.start }
          ) +
          source.slice(sourceAfter.start),
        preserved: true,
        reason: 'middle-empty-block-inserted'
      }
    }
  }

  // Several Enter transactions can move an already-authored paragraph between
  // placeholder rows without adding any visible text. In that shape the
  // changed canonical gap contains the neighbouring paragraph itself, so the
  // generic sequence branch below used to insert that same paragraph a second
  // time and emit an extra blank-line pair. Treat it as a structural
  // placeholder-only change: keep the authored gap and let the next callback
  // that contains genuinely new text own the slot.
  const previousChangedRegion = withoutStandaloneEmptyBlockLines(
    previous.slice(start, previousEnd)
  )
  const nextChangedRegion = withoutStandaloneEmptyBlockLines(
    next.slice(start, nextEnd)
  )
  const boundaryOnly = !hasDedicatedBlockSyntax(next.slice(start, nextEnd)) &&
    sourceVisibleIndex(previousChangedRegion).text === sourceVisibleIndex(nextChangedRegion).text &&
    sourceVisibleIndex(withoutStandaloneEmptyBlockLines(previous)).text ===
      sourceVisibleIndex(withoutStandaloneEmptyBlockLines(next)).text
  if (Array.isArray(globalThis.__hmParagraphTrace)) {
    globalThis.__hmParagraphTrace.push({
      start,
      previousEnd,
      nextEnd,
      boundaryOnly,
      previousChanged: previousChangedRegion.slice(0, 160),
      nextChanged: nextChangedRegion.slice(0, 160),
      previousChangedVisible: sourceVisibleIndex(previousChangedRegion).text,
      nextChangedVisible: sourceVisibleIndex(nextChangedRegion).text,
      previousVisibleLength: sourceVisibleIndex(withoutStandaloneEmptyBlockLines(previous)).text.length,
      nextVisibleLength: sourceVisibleIndex(withoutStandaloneEmptyBlockLines(next)).text.length,
      dedicated: hasDedicatedBlockSyntax(next.slice(start, nextEnd))
    })
    if (globalThis.__hmParagraphTrace.length > 30) globalThis.__hmParagraphTrace.shift()
  }
  if (boundaryOnly) {
    return {
      markdown: source,
      preserved: true,
      reason: 'middle-empty-block-boundary-only'
    }
  }

  // A middle empty slot can be filled by a dedicated list after the plain
  // paragraph callback has already committed the left side of the same
  // transaction family. The source then has the correct neighbouring text
  // anchors but no authored list row yet, so the old `sourceAfter is a list`
  // branch cannot own it. Treat the whole newly-created list as one bounded
  // block insertion between those anchors. The input-rule layer may refine
  // marker spelling afterwards; it must not be responsible for inventing the
  // structural slot.
  if (
    middleListSlotFill &&
    !sourceGap.trim() &&
    /(?:^|\n)[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/m.test(nextChangedText) &&
    /(?:^|\n)[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/m.test(nextGap)
  ) {
    const eol = lineEndingNear(source, sourceAfter.start)
    const insertedList = canonicalFreshTextToSource(nextChangedText)
      // `nextChangedText` is trimmed above, so an empty item arrives as a bare
      // marker (`1.`, `-`). The author-visible marker space is part of the
      // item: a bare row is invisible to the list row parsers downstream and
      // makes the next text fill fail closed or map onto the wrong block.
      .replace(/^(?:[ \t]*)(?:[-+*]|\d{1,9}[.)])$/, '$& ')
    const sourceBeforeMarker = sourceBefore.text.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=[ \t]+)/)
    const insertedMarker = insertedList.match(/^(\s*)([-+*]|\d{1,9}[.)])(?=[ \t]+|$)/)
    const canonicalGapHasPlaceholder = standaloneEmptyBlockLines(
      previous.slice(previousBefore.end, previousAfter.start)
    ).length > 0
    // If the left anchor is already a list item, this is an append to that
    // same list rather than a new block before the following paragraph. Keep
    // the authored marker token and the existing post-list gap together. An
    // empty ordered item needs its author-visible marker space restored because
    // canonicalFreshTextToSource trims the internal `<br />` placeholder.
    const sameListKind = sourceBeforeMarker && insertedMarker &&
      /^\d/.test(sourceBeforeMarker[2]) === /^\d/.test(insertedMarker[2])
    if (sameListKind && !canonicalGapHasPlaceholder && insertedList.trim()) {
      const ordered = /^\d/.test(sourceBeforeMarker[2])
      const emptyTaskPlaceholder = /^(?:[ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\](?:[ \t]+<br\s*\/?>)?[ \t]*$/i.test(nextChangedText)
      const itemText = emptyTaskPlaceholder
        ? insertedList.replace(
          /([ \t]+\[[ xX]\])(?:[ \t]*(?:<br\s*\/?>)?)?[ \t]*$/i,
          `$1 ${LEADING_SPACE_SENTINEL}`
        )
        : /^(?:[ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(nextChangedText)
          ? `${insertedList.replace(/[ \t]*$/, '')} `
          : insertedList
      const authoredMarker = ordered
        ? `${insertedMarker[2].slice(0, -1)}${sourceBeforeMarker[2].slice(-1)}`
        : sourceBeforeMarker[2]
      // `nextChangedText` is trimmed before this branch, so a newly-created
      // empty nested sibling can arrive as a bare `*`/`1.` with no leading
      // indentation. `sourceBefore` is the already-authored sibling selected by
      // the same bounded middle slot; keep that authored list depth together
      // with its marker spelling/delimiter.
      const localizedList = sourceBeforeMarker[1] +
        authoredMarker +
        itemText.slice(insertedMarker[1].length + insertedMarker[2].length)
      return {
        markdown: source.slice(0, sourceBeforeContentEnd) +
          eol +
          localizedList +
          sourceGap +
          (ordered ? eol : '') +
          source.slice(sourceAfter.start),
        preserved: true,
        reason: 'middle-empty-block-list-filled'
      }
    }
    if (insertedList.trim()) {
      return {
        markdown: source.slice(0, sourceAfter.start) +
          adaptCanonicalRegionToSource(
            insertedList + eol.repeat(2),
            source,
            { start: sourceAfter.start, end: sourceAfter.start }
          ) +
          source.slice(sourceAfter.start),
        preserved: true,
        reason: 'middle-empty-block-list-filled'
      }
    }
  }

  // When a new list item is inserted into an existing list, the authored blank
  // gap belongs after the list, not before the new item. Treat the list as one
  // structural block: keep the left member's line ending as the item separator
  // and retain the original gap unchanged before the following block. This
  // avoids turning `1. first\\n\\nafter` into `1. first\\n\\n2. \\n\\nafter`, which is a different list layout even though the parser accepts it.
  if (
    directBlockInsertion &&
    !sourceGap.trim() &&
    /^(?:[ \t]*)\d{1,9}[.)](?:[ \t]+|$)/m.test(nextChangedText) &&
    /(?:^|\n)[ \t]*\d{1,9}[.)](?:[ \t]+|$)/m.test(nextGap)
  ) {
    const canonicalInsertedList = canonicalFreshTextToSource(
      withoutStandaloneEmptyBlockLines(nextChangedText)
    )
    const insertedList = /^(?:[ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(nextChangedText)
      ? `${canonicalInsertedList.replace(/[ \t]*$/, '')} `
      : canonicalInsertedList
      .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
      .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
    if (insertedList.trim()) {
      const eol = lineEndingNear(source, sourceBeforeContentEnd)
      return {
        markdown: source.slice(0, sourceBeforeContentEnd) +
          eol +
          adaptCanonicalRegionToSource(insertedList, source, {
            start: sourceBeforeContentEnd,
            end: sourceBeforeContentEnd
          }) +
          sourceGap +
          eol +
          source.slice(sourceAfter.start),
        preserved: true,
        reason: 'middle-list-item-inserted'
      }
    }
  }

  if (directBlockInsertion) {
    const previousGap = previous.slice(previousBefore.end, previousAfter.start)
    const insertionAfterGap = nextGap.startsWith(previousGap)
    const insertionBeforeGap = nextGap.endsWith(previousGap)
    if (!insertionAfterGap && !insertionBeforeGap) {
      // Several consecutive Enter transactions can leave a `<br />` on both
      // sides of the newly typed block. In that shape the old gap is not a
      // prefix or suffix of `nextGap`, even though the only non-placeholder
      // bytes are exactly the user's new list/paragraph. Remove only the
      // standalone placeholders, collapse their serializer padding, and put
      // the inserted block into the authored gap between the same anchors.
      const withoutPlaceholders = withoutStandaloneEmptyBlockLines(nextGap)
        .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
        .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
      const previousGapContent = withoutStandaloneEmptyBlockLines(previousGap).trim()
      if (!previousGapContent && withoutPlaceholders.trim()) {
        const eol = lineEndingNear(source, sourceBeforeContentEnd)
        const insertedGap = canonicalFreshTextToSource(withoutPlaceholders)
        const markdown = source.slice(0, sourceBeforeContentEnd) +
          eol.repeat(2) +
          adaptCanonicalRegionToSource(insertedGap, source, {
            start: sourceBeforeContentEnd,
            end: sourceAfter.start
          }) +
          eol.repeat(2) +
          source.slice(sourceAfter.start)
        if (Array.isArray(globalThis.__hmParagraphTrace)) {
          globalThis.__hmParagraphTrace.push({
            phase: 'middle-result',
            reason: 'middle-empty-block-sequence-inserted',
            region: markdown.slice(Math.max(0, sourceBeforeContentEnd - 40), sourceBeforeContentEnd + 100)
          })
        }
        return {
          markdown,
          preserved: true,
          reason: 'middle-empty-block-sequence-inserted'
        }
      }
      return null
    }

    // Enter at the start of the following paragraph leaves the canonical
    // `<br />` placeholder in the shared gap, while the next typed block is
    // inserted *after* that placeholder and immediately before the following
    // authored paragraph. The old branch only accepted the opposite ordering
    // (new block before the existing gap), so the first character after a
    // middle Enter fell back to `visible-stream-mismatch`; every later
    // character then accumulated against the stale authored source.
    const insertedBlock = withoutStandaloneEmptyBlockLines(
      insertionAfterGap
        ? nextGap.slice(previousGap.length)
        : nextGap.slice(0, nextGap.length - previousGap.length)
    )
      .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
      .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
    const insertedGap = canonicalFreshTextToSource(insertedBlock)
    if (!insertedGap) return null
    const eol = lineEndingNear(source, sourceAfter.start)
    const insertion = adaptCanonicalRegionToSource(
      insertedGap,
      source,
      { start: insertionAfterGap ? sourceAfter.start : sourceBeforeContentEnd, end: insertionAfterGap ? sourceAfter.start : sourceBeforeContentEnd }
    )
    const markdown = insertionAfterGap
      ? source.slice(0, sourceAfter.start) +
        insertion +
        eol.repeat(2) +
        source.slice(sourceAfter.start)
      : source.slice(0, sourceBeforeContentEnd) +
        eol.repeat(2) +
        insertion +
        eol.repeat(2) +
        source.slice(sourceAfter.start)
    if (Array.isArray(globalThis.__hmParagraphTrace)) {
      globalThis.__hmParagraphTrace.push({
        phase: 'middle-result',
        reason: 'middle-block-inserted',
        region: markdown.slice(Math.max(0, sourceBeforeContentEnd - 40), sourceBeforeContentEnd + 100)
      })
    }
    return {
      markdown,
      preserved: true,
      reason: 'middle-block-inserted'
    }
  }

  const sourceGapRegion = { start: sourceBeforeContentEnd, end: sourceAfter.start }
  const canonicalGapForSource = withoutStandaloneEmptyBlockLines(nextGap)
  // `canonicalFreshTextToSource` normally restores serializer escapes after
  // visible text, so `1\\.` becomes `1.`. That is correct for inline text but
  // not when the *entire newly filled block* is the literal text `1.`: the raw
  // spelling would become an ordered-list marker and change document semantics.
  // Keep only this block-level protective escape; all other fresh punctuation
  // still follows the normal restoration path.
  const authoredGap = /^\s*\d{1,9}\\[.)]\s*$/.test(canonicalGapForSource)
    ? canonicalGapForSource
    : canonicalFreshTextToSource(canonicalGapForSource)
  return {
    markdown: source.slice(0, sourceBeforeContentEnd) +
      adaptCanonicalRegionToSource(
        authoredGap,
        source,
        sourceGapRegion
      ) +
      source.slice(sourceAfter.start),
    preserved: true,
    reason: previousChangedEmpty
      ? middleListSlotFill
        ? 'middle-empty-block-list-filled'
        : 'middle-empty-block-filled'
      : 'middle-block-inserted'
  }
}

// RS-83: the first `-` typed into a proven middle empty paragraph is safely
// published as an independent `\\-` source row. If the next two hyphens arrive
// before another source callback, ProseMirror's input rule replaces that whole
// paragraph with a thematic-break node and Crepe serializes it as `***`.
// Thematic breaks contribute no visible characters, so the generic visible
// mapper can give the zero-width change backward affinity and glue `***` to the
// preceding list item. Own only this exact block transition: canonical outside
// the one row must be byte-identical, the row must have blank block separation,
// and its authored `\\-` row must be uniquely identified by unchanged visible
// neighbours. Restore the user's typed marker spelling as `---`, preserving the
// source EOL and every unrelated byte. Ambiguity or any batched edit fails closed.
export const preserveEscapedStandaloneThematicBreakInputRule = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const stripCr = (text) => String(text || '').endsWith('\r')
    ? String(text).slice(0, -1)
    : String(text || '')
  const previousLine = lineAt(previous, start)
  const nextLine = lineAt(next, Math.min(start, next.length))
  if (previousEnd > previousLine.end || nextEnd > nextLine.end) return null

  const previousText = stripCr(previous.slice(previousLine.start, previousLine.end))
  const nextText = stripCr(next.slice(nextLine.start, nextLine.end))
  const escapedDash = previousText.match(/^([ \t]{0,3})\\-$/)
  if (!escapedDash || !/^[ \t]{0,3}(?:\*{3,}|-{3,}|_{3,})[ \t]*$/.test(nextText)) {
    return null
  }
  if (
    previous.slice(0, previousLine.start) !== next.slice(0, nextLine.start) ||
    previous.slice(previousLine.end) !== next.slice(nextLine.end)
  ) return null

  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (stripCr(lines[cursor].text).trim()) return lines[cursor]
    }
    return null
  }
  const hasBlockGap = (markdown, left, right) =>
    /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/.test(markdown.slice(left.end, right.start))
  const visibleLine = (line) => sourceVisibleIndex(stripCr(line?.text)).text

  const previousLines = markdownLines(previous)
  const previousIndex = previousLines.findIndex((line) =>
    line.start === previousLine.start && line.end === previousLine.end
  )
  if (previousIndex < 0) return null
  const previousBefore = nearestNonBlank(previousLines, previousIndex, -1)
  const previousAfter = nearestNonBlank(previousLines, previousIndex, 1)
  if (
    !previousBefore || !previousAfter ||
    !hasBlockGap(previous, previousBefore, previousLine) ||
    !hasBlockGap(previous, previousLine, previousAfter)
  ) return null
  const beforeVisible = visibleLine(previousBefore)
  const afterVisible = visibleLine(previousAfter)
  if (!beforeVisible || !afterVisible) return null

  const sourceLines = markdownLines(source)
  const sourceFences = paragraphFenceBlocks(source)
  const candidates = sourceLines.filter((line, index) => {
    if (stripCr(line.text) !== previousText) return false
    if (sourceFences.some((block) => line.start > block.openStart && line.end < block.closeEnd)) {
      return false
    }
    const before = nearestNonBlank(sourceLines, index, -1)
    const after = nearestNonBlank(sourceLines, index, 1)
    return Boolean(
      before && after &&
      hasBlockGap(source, before, line) &&
      hasBlockGap(source, line, after) &&
      visibleLine(before) === beforeVisible &&
      visibleLine(after) === afterVisible
    )
  })
  if (candidates.length !== 1) return null
  const sourceLine = candidates[0]
  const replacement = `${escapedDash[1]}---${sourceLine.text.endsWith('\r') ? '\r' : ''}`
  return {
    markdown: source.slice(0, sourceLine.start) + replacement + source.slice(sourceLine.end),
    preserved: true,
    reason: 'escaped-standalone-thematic-break-input-rule'
  }
}

// An unmatched backtick or another punctuation-only line is serialized with
// a protective backslash (`\\``) even though the user typed the raw character.
// Once that authored spelling is committed, changing/deleting it leaves the
// source/canonical visible streams temporarily different and generic mapping
// fails closed. Replace only the unique matching authored line with the next
// spelling of that same line. This matters for multi-key deletion: ProseMirror
// may publish `\`\`\`` -> `\`` in one transaction; deleting the whole source
// row there would make the following keystroke permanently unmappable.
export const preserveEmptiedEscapedLiteralLine = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const previousLine = lineAt(previous, start)
  if (previousEnd > previousLine.end) return null
  const canonicalLine = previous.slice(previousLine.start, previousLine.end)
  const authoredLine = canonicalFreshTextToSource(canonicalLine)
  const punctuationOnly = /^[\\`*{}\[\]()#+\-.!_>~|]+$/
  if (
    authoredLine === canonicalLine ||
    !authoredLine.trim() ||
    !punctuationOnly.test(authoredLine.trim())
  ) {
    return null
  }

  const nextLine = lineAt(next, Math.min(start, next.length))
  if (nextEnd > nextLine.end) return null
  const nextCanonicalLine = next.slice(nextLine.start, nextLine.end)
  const nextAuthoredLine = withoutStandaloneEmptyBlockLines(
    canonicalFreshTextToSource(nextCanonicalLine)
  )
  const nextHasDedicatedBlockSyntax = /^\s{0,3}(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}|~{3,}|\|)/.test(
    nextAuthoredLine
  )
  // This branch owns only serializer-escaped punctuation lines and their
  // empty/plain-text transition, never a new block structure. Replacing the
  // punctuation placeholder with ordinary text is a common final step after
  // deleting a fence experiment; rejecting it would leave the canonical
  // baseline on `` ` `` and make all later edits fail closed.
  if (
    nextAuthoredLine.trim() &&
    (
      nextHasDedicatedBlockSyntax ||
      (
        canonicalFreshTextToSource(nextCanonicalLine) === nextCanonicalLine &&
        punctuationOnly.test(nextAuthoredLine.trim())
      )
    )
  ) {
    return null
  }

  const sourceLines = markdownLines(source)
  const previousLines = markdownLines(previous)
  const previousLineIndex = previousLines.findIndex((line) => (
    line.start === previousLine.start && line.end === previousLine.end
  ))
  // Source and canonical normally retain the same row skeleton even when the
  // serializer escapes punctuation. Prefer that structural identity so two
  // separate raw `` ` `` rows can be edited independently. If earlier edits
  // changed row counts, retain the stricter unique-content fallback.
  const ordinalSourceLine = sourceLines.length === previousLines.length && previousLineIndex >= 0
    ? sourceLines[previousLineIndex]
    : null
  const candidates = sourceLines.filter((line) => line.text === authoredLine)
  const sourceLine = ordinalSourceLine?.text === authoredLine
    ? ordinalSourceLine
    : candidates.length === 1
      ? candidates[0]
      : null
  if (!sourceLine) return null
  return {
    markdown: source.slice(0, sourceLine.start) + nextAuthoredLine + source.slice(sourceLine.end),
    preserved: true,
    reason: nextAuthoredLine.trim()
      ? punctuationOnly.test(nextAuthoredLine.trim())
        ? 'escaped-literal-line-changed'
        : 'escaped-literal-line-replaced'
      : 'escaped-literal-line-emptied'
  }
}

export const preserveTrailingEmptyBlock = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd
}) => {
  const sourceEmpty = trailingEmptyBlock(source)
  const previousEmpty = trailingCanonicalEmptyBlock(previous)
  const nextEmpty = trailingCanonicalEmptyBlock(next)

  const previousTrailingBreaks = previous.match(/(?:\r\n|\r|\n)*$/)?.[0] || ''
  const changeTouchesTrailingSlot = previousEmpty
    ? previousEnd >= previousEmpty.start || start >= previousEmpty.start
    : start >= previous.length - previousTrailingBreaks.length

  if (!sourceEmpty && !previousEmpty && nextEmpty && changeTouchesTrailingSlot) {
    // A newly typed list/heading can be published together with Crepe's
    // trailing empty-paragraph placeholder. The placeholder itself has no
    // authored source row, but the block before it is real user content and
    // must be appended now. If we keep the source unchanged here, the next
    // list callback sees only the later sibling and silently drops this first
    // tail block (for example ordered list -> unordered list).
    const createdBlock = withoutStandaloneEmptyBlockLines(next.slice(start, nextEnd))
      .replace(/^(?:(?:\r\n)|\n|\r)+/, '')
      .replace(/(?:(?:\r\n)|\n|\r)+$/, '')
    if (createdBlock.trim() && hasDedicatedBlockSyntax(createdBlock)) {
      const markdown = appendBlockAtDocumentEnd(source, next.slice(start, nextEnd))
      if (markdown !== null) {
        return {
          markdown,
          preserved: true,
          reason: 'trailing-block-created'
        }
      }
    }

    // A leading-space segment (`&#x20;   文本`, U+200B-sentineled in source)
    // deleted down to a blank canonical row makes `nextEmpty` true — this is
    // a deletion, not a newly created empty block. When the canonical tail
    // segment is a leading-space segment and the authored tail segment shows
    // the same visible text, drop the authored segment instead of keeping it
    // (which resurrected deleted content in source mode and after reopen).
    const trailingVisibleLine = (value) => {
      const body = String(value || '').replace(/\r?\n$/, '')
      const lines = body.split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].trim()) {
          let start = 0
          for (let before = 0; before < index; before += 1) start += lines[before].length + 1
          return { text: lines[index], start, end: start + lines[index].length }
        }
      }
      return null
    }
    const sourceTailLine = trailingVisibleLine(source)
    const previousTailLine = trailingVisibleLine(previous)
    const stripSentinel = (line) => String(line || '')
      .replace(/\u200B/g, '')
      .replace(/&#x20;/g, ' ')
      .replace(/^\s+/, '')
    if (
      sourceTailLine &&
      previousTailLine &&
      /^\s*(?:\u200B|&#x20;)/.test(previousTailLine.text) &&
      stripSentinel(sourceTailLine.text) === stripSentinel(previousTailLine.text) &&
      // Only a change that actually touches the segment is a deletion. Pressing
      // Enter after the segment (canonical grows a `<br />` empty block, which
      // makes `nextEmpty` true) must NOT drop the authored leading-space row.
      start <= previousTailLine.end
    ) {
      return {
        markdown: source.slice(0, sourceTailLine.start) + source.slice(sourceTailLine.end),
        preserved: true,
        reason: 'trailing-leading-space-deleted'
      }
    }
    return {
      markdown: source,
      preserved: true,
      reason: 'trailing-empty-block-created'
    }
  }

  if (previousEmpty && nextEmpty) {
    const previousChanged = withoutStandaloneEmptyBlockLines(
      previous.slice(start, previousEnd)
    )
    const nextChanged = withoutStandaloneEmptyBlockLines(
      next.slice(start, nextEnd)
    )
    if (!previousChanged.trim() && !nextChanged.trim()) {
      return {
        markdown: source,
        preserved: true,
        reason: 'trailing-empty-block-whitespace'
      }
    }
  }

  if (
    !sourceEmpty &&
    previousEmpty &&
    !nextEmpty &&
    start <= previousEmpty.end &&
    previousEnd >= previousEmpty.start
  ) {
    // RS-48: a syntax-only authored blockquote (`>`, `> >`, ...) is the raw
    // representation of Crepe's trailing `> <br />` placeholder. Filling that
    // slot must stay INSIDE the quote. Treating it as an ordinary empty
    // paragraph and calling appendBlockAtDocumentEnd() produces `>\n\ntext`,
    // which changes the document structure even though the live PM node is
    // still a blockquote.
    const lastNonBlankLine = (value) => {
      const lines = markdownLines(String(value || ''))
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].text.trim()) return lines[index]
      }
      return null
    }
    const sourceQuote = lastNonBlankLine(source)
    const previousQuote = lastNonBlankLine(previous)
    const nextQuote = lastNonBlankLine(next)
    const quotePrefix = (line) => String(line || '').match(/^\s*((?:>\s*)+)/)?.[1] || ''
    const quoteDepth = (line) => (quotePrefix(line).match(/>/g) || []).length
    if (
      sourceQuote &&
      previousQuote &&
      nextQuote &&
      sourceQuote.end === String(source || '').replace(/(?:\r\n|\r|\n)*$/, '').length &&
      emptyAuthoredQuoteLine.test(sourceQuote.text) &&
      emptyCanonicalQuoteLine.test(previousQuote.text) &&
      /^\s*(?:>\s*)+\S/.test(nextQuote.text) &&
      quoteDepth(sourceQuote.text) === quoteDepth(previousQuote.text) &&
      quoteDepth(sourceQuote.text) === quoteDepth(nextQuote.text)
    ) {
      const nextText = nextQuote.text.replace(/^\s*(?:>\s*)+/, '')
      const authoredPrefix = sourceQuote.text.replace(/\s+$/, '')
      const spacing = /\s$/.test(sourceQuote.text) ? sourceQuote.text.slice(authoredPrefix.length) : ' '
      return {
        markdown: source.slice(0, sourceQuote.start) +
          authoredPrefix + spacing + nextText +
          source.slice(sourceQuote.end),
        preserved: true,
        reason: 'trailing-empty-blockquote-filled'
      }
    }

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

export const preserveAppendedParagraph = ({
  source,
  previous,
  next,
  start,
  previousEnd,
  nextEnd,
  replacementVisible
}) => {
  const replacement = next.slice(start, nextEnd)
  // This shortcut owns only a new plain paragraph at the physical document
  // end. Headings, lists, quotes, fences, tables, and other block syntax must
  // continue through their structural handlers; otherwise moving this proof
  // ahead of the diverged-visible branch could flatten a real structure.
  if (hasDedicatedBlockSyntax(replacement)) return null
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

  const markdown = appendBlockAtDocumentEnd(source, replacement)
  if (markdown === null) return null

  return {
    markdown,
    preserved: true,
    reason: 'appended-paragraph'
  }
}
