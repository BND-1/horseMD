import {
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from './mode-visible-map.js'
import { LEADING_SPACE_SENTINEL } from './lib/markdown-leading-space.js'
import {
  adaptCanonicalRegionToSource,
  canonicalFreshTextToSource,
  canonicalTextToSource,
  commonChange,
  lineAt,
  markdownLines,
  rawInsertionAtCanonicalLineEnd,
  rawOffsetAtVisible
} from './lib/markdown-preservation/core.js'
import {
  hasEmptyListItem,
  hasListStructureChange,
  listBlockAt,
  compactGeneratedListSpacing,
  normalizeEmptyListItems,
  normalizeOrderedListDelimiters,
  preserveBatchedListBlockChanges,
  preserveDivergedNestedListChange,
  preserveDivergedListContinuation,
  preserveEmptyListItemTextChange,
  preserveNestedListParentBodyEmptied,
  preserveListBlockChange,
  preserveStableListRowChanges,
  repairMergedListItems
} from './lib/markdown-preservation/lists.js'
import {
  capOutputTrailingNewlines,
  preserveAppendedParagraph,
  preserveCreatedTrailingEmptyBlockquoteParagraph,
  preserveEscapedStandaloneThematicBreakInputRule,
  preserveEmptiedEscapedLiteralLine,
  preserveEmptiedParagraph,
  preserveMiddleEmptyBlock,
  preserveParagraphSplit,
  preserveRemovedEmptyBlockquote,
  preserveRemovedEmptyParagraphBeforeFence,
  preserveTrailingExactLineChange,
  preserveTrailingEmptyBlock,
  withoutStandaloneEmptyBlockLines
} from './lib/markdown-preservation/paragraphs.js'
import {
  hasStructuralPrefixChange,
  preserveDivergedBlockTextChange,
  preserveDivergedVisibleDelete,
  preserveDivergedTailBlockAppend,
  preserveDivergedTailImageDelete,
  preserveDivergedLeadingSpaceListWhitespaceTail,
  preserveDivergedTailBulletBodyEmptied,
  preserveDisplayMathBlockTextChange,
  preserveFencedCodeBlockTextChange,
  preserveChangedLineRegion,
  preserveLocallyAlignedTextChange,
  preserveOrdinalLineTextChange,
  preserveUniquelyAnchoredTextChange,
  reconcileLeadingSpaceSentinelTransition
} from './lib/markdown-preservation/regions.js'
import {
  hasTableStructureChange,
  normalizeEmptyTableCells,
  preserveTableTextChange,
  replaceChangedTableBlock
} from './lib/markdown-preservation/tables.js'

export {
  replaceMarkdownFrontmatterBlock
} from './lib/markdown-preservation/frontmatter.js'
export {
  preserveOwnedTypedBulletInputRule,
  preserveTypedBulletInputRule,
  preserveGeneratedBulletMarkers,
  preserveTransactionOwnedListSubtreeChange,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from './lib/markdown-preservation/lists.js'

// RS-58: once a continuation paragraph inside a list/task item is reduced to
// empty, Crepe keeps one editor-owned `<br />` paragraph while authored
// Markdown has no bytes that can preserve that empty child without leaking an
// implementation placeholder. Reclassify only an already-proven paragraph
// deletion when the changed line is the terminal indented continuation directly
// under the same unchanged list marker. Ordinary top-level escaped/empty lines
// keep their original reasons and remain semantically strict.
const reclassifyTrailingListItemParagraphEmptied = ({ result, previous, next }) => {
  if (
    !result ||
    (result.reason !== 'escaped-literal-line-emptied' && result.reason !== 'paragraph-emptied')
  ) return result

  const previousLines = markdownLines(String(previous || ''))
  const nextLines = markdownLines(String(next || ''))
  const lastNonBlankIndex = (lines) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].text.trim()) return index
    }
    return -1
  }
  const previousIndex = lastNonBlankIndex(previousLines)
  const nextIndex = lastNonBlankIndex(nextLines)
  if (previousIndex < 1 || nextIndex < 1) return result

  const previousLine = previousLines[previousIndex]
  const nextLine = nextLines[nextIndex]
  const previousContinuation = previousLine.text.match(/^([ \t]{2,})(\S(?:.*\S)?)\s*$/)
  const nextEmptyContinuation = nextLine.text.match(/^([ \t]{2,})<br\s*\/?>\s*$/i)
  if (
    !previousContinuation ||
    !nextEmptyContinuation ||
    previousContinuation[1] !== nextEmptyContinuation[1] ||
    /<br\s*\/?>/i.test(previousContinuation[2])
  ) return result

  // The whole document outside this one continuation row must be unchanged.
  // This keeps the transient ownership tied to the exact paragraph deletion,
  // not to an unrelated list edit batched elsewhere in the document.
  if (
    String(previous).slice(0, previousLine.start) !== String(next).slice(0, nextLine.start) ||
    String(previous).slice(previousLine.end) !== String(next).slice(nextLine.end)
  ) return result

  let markerIndex = nextIndex - 1
  while (markerIndex >= 0 && !nextLines[markerIndex].text.trim()) markerIndex -= 1
  if (markerIndex < 0) return result
  const marker = nextLines[markerIndex].text.match(
    /^([ \t]*)(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\](?:\s+|$))?\S/
  )
  if (!marker || marker[1].length >= nextEmptyContinuation[1].length) return result

  return {
    ...result,
    reason: 'trailing-list-item-paragraph-emptied'
  }
}

const generatedListContentStart = (line) => {
  let offset = 0
  for (;;) {
    const rest = String(line || '').slice(offset)
    const leading = rest.match(/^[ \t]*/)?.[0] || ''
    offset += leading.length
    const afterLeading = String(line || '').slice(offset)
    const quote = afterLeading.match(/^>[ \t]*/)?.[0]
    if (quote) {
      offset += quote.length
      continue
    }
    const list = afterLeading.match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+/)?.[0]
    if (list) {
      offset += list.length
      continue
    }
    return offset
  }
}

// In a complete generated document, `1\\.` / `1\\)` at the beginning of a
// top-level block or list/quote item body is not cosmetic serializer spelling:
// removing that backslash creates a real ordered-list marker. Inline occurrences
// later in the same paragraph remain safe to restore. Compare canonical and
// translated lines after their structural quote/list prefixes and put the escape
// back only for the exact same number+delimiter pair.
const preserveGeneratedOrderedLiteralEscapes = (canonical, translated) => {
  const canonicalLines = String(canonical || '').split('\n')
  const translatedLines = String(translated || '').split('\n')
  if (canonicalLines.length !== translatedLines.length) return translated
  return translatedLines.map((line, index) => {
    const canonicalLine = canonicalLines[index]
    const canonicalStart = generatedListContentStart(canonicalLine)
    const protectedMarker = canonicalLine.slice(canonicalStart)
      .match(/^(\d{1,9})\\([.)])(?=[ \t]|$)/)
    if (!protectedMarker) return line
    const translatedPrefix = canonicalFreshTextToSource(
      canonicalLine.slice(0, canonicalStart)
    )
    if (!line.startsWith(translatedPrefix)) return line
    const translatedStart = translatedPrefix.length
    const rawMarker = line.slice(translatedStart)
      .match(/^(\d{1,9})([.)])(?=[ \t]|$)/)
    if (
      !rawMarker ||
      rawMarker[1] !== protectedMarker[1] ||
      rawMarker[2] !== protectedMarker[2]
    ) return line
    const markerEnd = translatedStart + rawMarker[1].length
    return line.slice(0, markerEnd) + '\\' + line.slice(markerEnd)
  }).join('\n')
}

const preserveGeneratedEmptyTaskPlaceholder = (canonical) => String(canonical || '').replace(
  /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+)[ \t]*<br\s*\/?>[ \t]*$/gim,
  `$1${LEADING_SPACE_SENTINEL}`
)

// RS-66: Slash may create an otherwise-unrepresentable empty unchecked task
// in the middle of an existing authored document. RS-50 already established
// U+200B as HorseMD's source-owned spelling for that empty task body, but the
// normal preservation path used to normalize `<br />` away and publish bare
// `- [ ] `, which GFM reparses as ordinary bracket text. Claim only the exact
// Slash-command transaction: replacing one top-level standalone `/` row with
// one top-level unchecked empty task row must reproduce the complete previous
// canonical byte-for-byte. Map repeated slash rows by ordinal into source and
// replace only that row; any batched or non-empty task edit stays fail-closed.
const preserveCreatedEmptyTaskFromSlash = ({ source, previous, next }) => {
  const previousText = String(previous || '')
  const nextText = String(next || '')
  const sourceText = String(source || '')
  const previousLines = markdownLines(previousText)
  const nextLines = markdownLines(nextText)
  const previousSlashRows = previousLines.filter((line) => line.text === '/')
  const sourceSlashRows = markdownLines(sourceText).filter((line) => line.text === '/')
  if (!previousSlashRows.length || sourceSlashRows.length !== previousSlashRows.length) return null

  for (const taskLine of nextLines) {
    const match = taskLine.text.match(/^([-+*])([ \t]+)\[ \]([ \t]+)<br\s*\/?>[ \t]*$/i)
    if (!match) continue
    const collapsedNext = nextText.slice(0, taskLine.start) + '/' + nextText.slice(taskLine.end)
    if (collapsedNext !== previousText) continue

    const previousSlashIndex = previousSlashRows.findIndex((line) => line.start === taskLine.start)
    if (previousSlashIndex < 0) continue
    const previousSlash = previousSlashRows[previousSlashIndex]
    if (previousSlash.end !== previousSlash.start + 1) continue

    const sourceSlash = sourceSlashRows[previousSlashIndex]
    if (!sourceSlash) continue
    const replacement = `${match[1]}${match[2]}[ ]${match[3]}${LEADING_SPACE_SENTINEL}`
    return {
      markdown: sourceText.slice(0, sourceSlash.start) + replacement + sourceText.slice(sourceSlash.end),
      preserved: true,
      reason: 'empty-task-slash-created'
    }
  }
  return null
}

export const generatedScratchMarkdown = (canonical) => {
  // A brand-new document is authored entirely by rich typing; its canonical is
  // the only structural source. Serializer punctuation escapes outside proven
  // code/HTML literals therefore have no author-owned spelling to preserve:
  // restore the physical characters the user typed (for example
  // `\`\`\`你好\`\`\`` -> ```你好```) instead of leaking canonical escapes into
  // source mode. Milkdown may terminate the serialization with an extra blank
  // line (or the skeleton's empty-paragraph `<br />`). Neither is authored
  // content, so the generated source ends with exactly one final newline —
  // never a phantom trailing blank line.
  // A bare `- [ ] ` is not a GFM task item: remark reparses it as ordinary
  // bracket text and loses checked:false. Keep one invisible, source-owned
  // sentinel while the task paragraph is truly empty. The remark parser plugin
  // removes that exact sentinel before ProseMirror is built on reopen.
  const generatedCanonical = preserveGeneratedEmptyTaskPlaceholder(canonical)
  const normalized = compactGeneratedListSpacing(
    withoutStandaloneEmptyBlockLines(
      normalizeEmptyListItems(normalizeEmptyTableCells(generatedCanonical))
    )
  )
  return preserveGeneratedOrderedLiteralEscapes(
    normalized,
    canonicalFreshTextToSource(normalized)
  ).replace(/\r?\n+$/, '\n')
}

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying only the serializer's
// localized delta. Structural edits are bounded to a list, table, or touched
// lines; an ambiguous mapping keeps the authored source instead of normalizing
// the complete document.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical) {
  const sourceMarkdown = String(source || '')
  let result = preserveRichMarkdownSourceCore(sourceMarkdown, previousCanonical, nextCanonical)
  if (result?.preserved !== false && result?.markdown != null) {
    const leadingSpaceSentinel = reconcileLeadingSpaceSentinelTransition({
      source: sourceMarkdown,
      previous: String(previousCanonical || ''),
      next: String(nextCanonical || ''),
      markdown: result.markdown
    })
    if (leadingSpaceSentinel) result = { ...result, ...leadingSpaceSentinel }
  }
  // Hard boundary invariant: an internal empty-paragraph `<br />` placeholder
  // must NEVER reach authored source, no matter which heuristic path produced
  // the result. Enforce it here as a post-condition on every output, so a
  // future path with a too-strict guard cannot leak the serializer's internal
  // representation again (this is what the empty-paragraph/visible-stream
  // bugs kept tripping over). Normalize table cells separately: only a cell
  // whose sole content is `<br />` is empty; inline `text<br>text` stays intact.
  if (result && result.markdown != null) {
    const withoutPlaceholders = withoutStandaloneEmptyBlockLines(
      normalizeEmptyTableCells(result.markdown)
    )
    // Crepe may append a serializer blank line after the last edited block; the
    // file's terminal line-ending run is authored formatting and must not grow.
    result.markdown = capOutputTrailingNewlines(
      withoutPlaceholders,
      sourceMarkdown,
      result.trailingNewlineGrowth
    )
  }
  // Test-only opt-in diagnostics. Production never creates this array; CDP
  // regressions can enable it before typing to capture the first fail-closed
  // transaction without logging document content during normal use.
  if (Array.isArray(globalThis.__hmPreserveLog)) {
    globalThis.__hmPreserveLog.push({
      source: sourceMarkdown,
      previous: String(previousCanonical || ''),
      next: String(nextCanonical || ''),
      markdown: String(result?.markdown || ''),
      preserved: result?.preserved !== false,
      reason: result?.reason || 'unknown',
      integrityProof: result?.integrityProof || null
    })
    if (globalThis.__hmPreserveLog.length > 200) globalThis.__hmPreserveLog.shift()
  }
  return result
}

const preserveSingleEmptyOrderedBackspaceLift = ({ source, previous, next }) => {
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

  // Keep the authored gap before the empty row as the surviving loose/compact
  // separator, remove the empty row plus the gap after it, then rewrite only
  // the successor's ordinal while retaining its authored delimiter/spacing.
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

const preserveTransientEmptyOrderedBackspaceLift = ({ source, previous, next }) => {
  const singleEmptyLift = preserveSingleEmptyOrderedBackspaceLift({ source, previous, next })
  if (singleEmptyLift) return singleEmptyLift
  // Backspace on an EMPTY ordered item has a one-keystroke ProseMirror
  // intermediate state that Markdown cannot author faithfully: the item marker
  // disappears, while Crepe keeps a second empty paragraph inside the preceding
  // list item and serializes it as an indented standalone `<br />`. Persist the
  // real structural edit (remove the empty item + renumber the surviving suffix)
  // without ever writing that editor placeholder into source. Integrity treats
  // the duplicate empty paragraph as the same non-authored transient below.
  const originalChange = commonChange(previous, next)
  const intersectsChange = (candidate, endKey) => {
    const candidateStart = candidate.index ?? -1
    const candidateEnd = candidateStart + candidate[0].length
    return candidateStart <= originalChange[endKey] && candidateEnd >= originalChange.start
  }

  // The original 0.13.78 failure had TWO consecutive empty ordered rows. Keep
  // that proven regex fallback unchanged; RS-72's single-empty shape is owned
  // above by the stricter line-level left/empty/right proof.
  const nextPattern = /(^[ \t]*\d{1,9}[.)][ \t]*(?:\r\n|\n|\r))(?:(?:\r\n|\n|\r))*<br\s*\/?>[ \t]*(?:\r\n|\n|\r)(?=[ \t]*\d{1,9}[.)][ \t]+\S)/gm
  const matches = [...String(next || '').matchAll(nextPattern)]
    .filter((candidate) => intersectsChange(candidate, 'nextEnd'))
  if (matches.length !== 1) return null

  const previousPattern = /(^[ \t]*\d{1,9}[.)][ \t]*(?:\r\n|\n|\r))[ \t]*\d{1,9}[.)][ \t]*(?:\r\n|\n|\r)(?=[ \t]*\d{1,9}[.)][ \t]+\S)/gm
  const previousProofs = [...String(previous || '').matchAll(previousPattern)]
    .filter((candidate) => intersectsChange(candidate, 'previousEnd'))
  if (previousProofs.length !== 1) return null

  const match = matches[0]
  const collapsedNext = next.slice(0, match.index) + match[1] + next.slice(match.index + match[0].length)
  const change = commonChange(previous, collapsedNext)
  const result = preserveDivergedNestedListChange({
    source,
    previous,
    next: collapsedNext,
    ...change
  })
  if (!result?.preserved || result.nextBaseline !== collapsedNext) return null
  return {
    ...result,
    reason: 'diverged-empty-ordered-backspace-lift',
    nextBaseline: next
  }
}

// RS-68: rapid human Backspace cadence can coalesce two logically separate
// edits into one markdownUpdated callback: a non-empty ordered parent is first
// emptied, then the now-empty parent is lifted into the preceding bullet list,
// while its nested ordered child remains unchanged. The raw canonical jumps
// directly from
//
//   * left              * left
//
//   1. parent      ->   * <br />
//
//      1. child           1. child
//
// A generic line mapper removes `<br />` but preserves the serializer blank
// line after the empty bullet, yielding `- \n\n   1. child`; remark parses that
// child as a separate top-level list instead of a child of the empty bullet.
// Prove the whole coalesced transaction against raw canonical bytes, then patch
// only the authored parent marker/body and collapse only the parent→child gap to
// one line ending. The nested child bytes themselves stay untouched.
const preserveRapidNestedOrderedParentBackspaceLift = ({ source, previous, next }) => {
  const sourceText = String(source || '')
  const previousText = String(previous || '')
  const nextText = String(next || '')
  if (!sourceText || !previousText || !nextText || previousText === nextText) return null

  const rowMeta = (line) => {
    const match = line?.text?.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    const ordered = /^(\d{1,9})([.)])$/.exec(match[2])
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body: match[4],
      kind: ordered ? 'ordered' : 'bullet',
      number: ordered ? ordered[1] : null
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (lines[cursor].text.trim()) return cursor
    }
    return -1
  }
  const previousLines = markdownLines(previousText)
  const nextLines = markdownLines(nextText)
  if (previousLines.length !== nextLines.length) return null

  const canonicalCandidates = []
  for (let index = 0; index < previousLines.length; index += 1) {
    const beforeParent = rowMeta(previousLines[index])
    const afterParent = rowMeta(nextLines[index])
    if (
      !beforeParent || !afterParent ||
      beforeParent.kind !== 'ordered' ||
      afterParent.kind !== 'bullet' ||
      beforeParent.indent !== afterParent.indent ||
      !beforeParent.body.trim() ||
      !/^<br\s*\/?>\s*$/i.test(afterParent.body)
    ) continue

    const leftIndex = nearestNonBlank(previousLines, index, -1)
    const childIndex = nearestNonBlank(previousLines, index, 1)
    if (leftIndex < 0 || childIndex < 0) continue
    if (leftIndex !== nearestNonBlank(nextLines, index, -1) || childIndex !== nearestNonBlank(nextLines, index, 1)) continue
    const beforeLeft = rowMeta(previousLines[leftIndex])
    const afterLeft = rowMeta(nextLines[leftIndex])
    const beforeChild = rowMeta(previousLines[childIndex])
    const afterChild = rowMeta(nextLines[childIndex])
    if (
      !beforeLeft || !afterLeft || !beforeChild || !afterChild ||
      beforeLeft.kind !== 'bullet' || afterLeft.kind !== 'bullet' ||
      beforeLeft.indent !== beforeParent.indent || afterLeft.indent !== afterParent.indent ||
      beforeLeft.body.trim() === '' || beforeLeft.line.text !== afterLeft.line.text ||
      afterParent.token !== afterLeft.token ||
      beforeChild.indent.length <= beforeParent.indent.length ||
      afterChild.indent.length <= afterParent.indent.length ||
      beforeChild.kind !== afterChild.kind ||
      beforeChild.token !== afterChild.token ||
      beforeChild.body !== afterChild.body ||
      !beforeChild.body.trim()
    ) continue
    // The same deferred callback may make Crepe re-spell an unrelated,
    // already-diverged bullet marker (`*` <-> `-` / `+`) while leaving that
    // row's indentation, spacing and body byte-identical. That serializer-only
    // marker drift is not a second user edit and must not prevent this local
    // proof. Keep every other difference strict: ordered tokens, indentation,
    // spacing or body changes all reject the claim.
    const unchangedOrBulletMarkerDrift = previousLines.every((line, lineIndex) => {
      if (lineIndex === index || lineIndex === childIndex) return true
      const nextLine = nextLines[lineIndex]
      if (line.text === nextLine.text) return true
      const before = rowMeta(line)
      const after = rowMeta(nextLine)
      return Boolean(
        before && after &&
        before.kind === 'bullet' && after.kind === 'bullet' &&
        before.indent === after.indent &&
        before.spacing === after.spacing &&
        before.body === after.body
      )
    })
    if (!unchangedOrBulletMarkerDrift) continue
    canonicalCandidates.push({ beforeParent, afterParent, beforeLeft, beforeChild, afterChild })
  }
  if (canonicalCandidates.length !== 1) return null
  const target = canonicalCandidates[0]

  const authoredParentBody = canonicalTextToSource(target.beforeParent.body)
  const authoredLeftBody = canonicalTextToSource(target.beforeLeft.body)
  const authoredChildBody = canonicalTextToSource(target.beforeChild.body)
  const sourceLines = markdownLines(sourceText)
  const sourceMatches = []
  for (let index = 0; index < sourceLines.length; index += 1) {
    const parent = rowMeta(sourceLines[index])
    if (
      !parent ||
      parent.kind !== 'ordered' ||
      parent.indent !== target.beforeParent.indent ||
      parent.number !== target.beforeParent.number ||
      parent.body !== authoredParentBody
    ) continue
    const leftIndex = nearestNonBlank(sourceLines, index, -1)
    const childIndex = nearestNonBlank(sourceLines, index, 1)
    if (leftIndex < 0 || childIndex < 0) continue
    const left = rowMeta(sourceLines[leftIndex])
    const child = rowMeta(sourceLines[childIndex])
    if (
      !left || !child ||
      left.kind !== 'bullet' || left.indent !== parent.indent || left.body !== authoredLeftBody ||
      child.indent.length <= parent.indent.length ||
      child.kind !== target.beforeChild.kind ||
      child.token !== target.beforeChild.token ||
      child.body !== authoredChildBody
    ) continue
    sourceMatches.push({ parent, left, child })
  }
  if (sourceMatches.length !== 1) return null
  const { parent, left, child } = sourceMatches[0]
  const gap = sourceText.slice(parent.line.end, child.line.start)
  const lineEnding = gap.match(/\r\n|\n|\r/)?.[0]
  if (!lineEnding) return null
  const replacement = `${parent.indent}${left.token}${parent.spacing}`
  const afterLocal = replacement + lineEnding + sourceText.slice(child.line.start, child.line.end)
  const markdown = sourceText.slice(0, parent.line.start) +
    replacement +
    lineEnding +
    sourceText.slice(child.line.start)
  return {
    markdown,
    preserved: true,
    reason: 'rapid-nested-ordered-parent-backspace-lift',
    integrityProof: {
      kind: 'localized-list-slots',
      beforeSource: { start: parent.line.start, end: child.line.end },
      afterSource: { start: parent.line.start, end: parent.line.start + afterLocal.length },
      beforeCanonical: { start: target.beforeParent.line.start, end: target.beforeChild.line.end },
      afterCanonical: { start: target.afterParent.line.start, end: target.afterChild.line.end }
    }
  }
}

const preserveIsolatedEmptyOrderedBackspaceLift = ({ source, previous, next }) => {
  // Backspace on a single empty ordered list between two same-level bullet
  // regions converts that ordered item into an empty bullet before a second
  // Backspace removes it. In a diverged document this also merges list blocks,
  // so the normal one-block conversion mapper cannot pair the before/after
  // trees and the broad diverged-list batch fails closed. Prove the exact local
  // shape with the unchanged neighbouring item bodies and patch only the empty
  // source row's marker; all authored spacing and unrelated list syntax stays
  // byte-stable.
  const rowMeta = (line) => {
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body: match[4],
      kind: /^\d/.test(match[2]) ? 'ordered' : 'bullet'
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (lines[cursor].text.trim()) return cursor
    }
    return -1
  }
  const candidates = ({ markdown, emptyKind, changeEnd, requireSeparated }) => {
    const lines = markdownLines(markdown)
    const found = []
    for (let index = 0; index < lines.length; index += 1) {
      const empty = rowMeta(lines[index])
      if (
        !empty ||
        empty.kind !== emptyKind ||
        empty.indent.length !== 0 ||
        empty.body.trim()
      ) continue
      const leftIndex = nearestNonBlank(lines, index, -1)
      const rightIndex = nearestNonBlank(lines, index, 1)
      if (leftIndex < 0 || rightIndex < 0) continue
      const left = rowMeta(lines[leftIndex])
      const right = rowMeta(lines[rightIndex])
      if (
        !left || !right ||
        left.kind !== 'bullet' || right.kind !== 'bullet' ||
        left.indent !== empty.indent || right.indent !== empty.indent ||
        !left.body.trim() || !right.body.trim()
      ) continue
      const leftGap = markdown.slice(left.line.end, empty.line.start)
      const rightGap = markdown.slice(empty.line.end, right.line.start)
      const hasLeftBlank = /\r?\n[ \t]*\r?\n/.test(leftGap)
      const hasRightBlank = /\r?\n[ \t]*\r?\n/.test(rightGap)
      if (requireSeparated && (!hasLeftBlank || !hasRightBlank)) continue
      // After the Backspace conversion Crepe may serialize the newly merged
      // bullet level either compact (`* a\n* `) or loose (`* a\n\n* `).
      // Both represent the same list transition; uniqueness comes from the
      // unchanged neighbouring item bodies, not serializer blank-line style.
      found.push({ empty, left, right })
    }
    return found.filter(({ empty }) =>
      empty.line.end >= changeEnd.start - 2 &&
      empty.line.start <= changeEnd.end + 2
    )
  }

  const change = commonChange(previous, next)
  const before = candidates({
    markdown: previous,
    emptyKind: 'ordered',
    changeEnd: { start: change.start, end: change.previousEnd },
    requireSeparated: true
  })
  if (before.length !== 1) return null
  const target = before[0]

  const after = candidates({
    markdown: next,
    emptyKind: 'bullet',
    changeEnd: { start: change.start, end: change.nextEnd },
    requireSeparated: false
  }).filter(({ left, right }) =>
    left.body === target.left.body && right.body === target.right.body
  )
  if (after.length !== 1) return null

  const sourceMatches = candidates({
    markdown: source,
    emptyKind: 'ordered',
    changeEnd: { start: 0, end: source.length },
    requireSeparated: true
  }).filter(({ left, right }) =>
    left.body === target.left.body &&
    right.body === target.right.body &&
    left.token === right.token
  )
  if (sourceMatches.length !== 1) return null
  const sourceTarget = sourceMatches[0]
  const tokenStart = sourceTarget.empty.line.start + sourceTarget.empty.indent.length
  const tokenEnd = tokenStart + sourceTarget.empty.token.length
  return {
    markdown: source.slice(0, tokenStart) + sourceTarget.left.token + source.slice(tokenEnd),
    preserved: true,
    reason: 'diverged-isolated-empty-ordered-backspace-lift',
    nextBaseline: next
  }
}

// RS-86: two rapid Enters at the end of a non-empty bullet item can be
// coalesced into one markdownUpdated callback. The first Enter creates an empty
// bullet before an existing sibling; the second immediately lifts that empty
// item into a top-level editor paragraph. In a long-lived PM tree the original
// list can retain authored `-` labels while the newly split successor list is
// serialized with `*`, so commonChange sees both the inserted `<br />` and the
// successor marker flip. The generic empty-list-row remover then mistakes the
// non-empty successor for the row that exited and deletes it from source.
//
// Own only the exact raw shape before marker/empty normalization: two unchanged
// top-level plain bullet rows with one real block gap become the same rows with
// one standalone top-level `<br />` between them; the right row may change only
// its one-character bullet token, while its indent, spacing, body and the whole
// suffix remain byte-identical. The authored source must contain one unique
// matching row pair outside fences. Markdown already owns the inter-item block
// gap, so the lifted editor-only empty paragraph adds no source bytes.
export const preserveCoalescedEmptyBulletExitBeforeSibling = ({ source, previous, next }) => {
  const sourceText = String(source || '')
  const previousText = String(previous || '')
  const nextText = String(next || '')
  const stripCr = (value) => String(value || '').endsWith('\r')
    ? String(value).slice(0, -1)
    : String(value || '')
  const rowMeta = (line) => {
    if (!line) return null
    const text = stripCr(line.text)
    const match = text.match(/^([ \t]*)([-+*])([ \t]+)(.*)$/)
    if (!match) return null
    const task = match[4].match(/^\[([ xX])\](?:[ \t]+|$)/)
    const body = match[4]
    const authoredBody = body.replaceAll(LEADING_SPACE_SENTINEL, '')
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body,
      bodyVisible: sourceVisibleIndex(authoredBody).text.trim(),
      task: task ? task[1].toLowerCase() : null,
      empty: !authoredBody.trim() || /^<br\s*\/?>$/i.test(authoredBody.trim())
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (stripCr(lines[cursor].text).trim()) return cursor
    }
    return -1
  }
  const hasBlockGap = (markdown, left, right) =>
    /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/.test(markdown.slice(left.end, right.start))
  const fencedIndexes = (markdown, lines) => {
    const fenced = new Set()
    let open = null
    for (let index = 0; index < lines.length; index += 1) {
      const text = stripCr(lines[index].text)
      if (open) {
        fenced.add(index)
        const close = text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
        if (close && close[1][0] === open.char && close[1].length >= open.length) open = null
        continue
      }
      const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!match) continue
      if (match[1][0] === '`' && match[2].includes('`')) continue
      open = { char: match[1][0], length: match[1].length }
      fenced.add(index)
    }
    return fenced
  }
  // commonChange starts on the successor marker itself in this family. Use an
  // exact line/range overlap: a ±2 tolerance also intersects the preceding
  // item's line end in compact coordinates and destroys the uniqueness proof.
  const intersects = (line, range) =>
    line.end >= range.start && line.start <= range.end

  const change = commonChange(previousText, nextText)
  const previousLines = markdownLines(previousText)
  const previousFenced = fencedIndexes(previousText, previousLines)
  const before = []
  for (let rightIndex = 0; rightIndex < previousLines.length; rightIndex += 1) {
    const right = rowMeta(previousLines[rightIndex])
    if (
      !right || right.indent.length !== 0 || right.task != null || right.empty ||
      previousFenced.has(rightIndex) ||
      !intersects(right.line, { start: change.start, end: change.previousEnd })
    ) continue
    const middleIndex = nearestNonBlank(previousLines, rightIndex, -1)
    if (middleIndex < 0) continue
    const middle = rowMeta(previousLines[middleIndex])
    if (
      !middle || middle.indent.length !== 0 || middle.task != null || middle.empty ||
      previousFenced.has(middleIndex) ||
      !hasBlockGap(previousText, middle.line, right.line)
    ) continue
    before.push({ middle, right })
  }
  if (before.length !== 1) return null
  const target = before[0]
  const beforeGap = previousText.slice(target.middle.line.end, target.right.line.start)

  const nextLines = markdownLines(nextText)
  const nextFenced = fencedIndexes(nextText, nextLines)
  const after = []
  for (let emptyIndex = 0; emptyIndex < nextLines.length; emptyIndex += 1) {
    const emptyLine = nextLines[emptyIndex]
    if (
      !/^<br\s*\/?>[ \t]*$/i.test(stripCr(emptyLine.text)) ||
      nextFenced.has(emptyIndex) ||
      !intersects(emptyLine, { start: change.start, end: change.nextEnd })
    ) continue
    const middleIndex = nearestNonBlank(nextLines, emptyIndex, -1)
    const rightIndex = nearestNonBlank(nextLines, emptyIndex, 1)
    if (middleIndex < 0 || rightIndex < 0) continue
    const middle = rowMeta(nextLines[middleIndex])
    const right = rowMeta(nextLines[rightIndex])
    if (
      !middle || middle.indent.length !== 0 || middle.task != null || middle.empty ||
      !right || right.indent.length !== 0 || right.task != null || right.empty ||
      middle.body !== target.middle.body ||
      middle.token !== target.middle.token ||
      middle.spacing !== target.middle.spacing ||
      right.body !== target.right.body ||
      right.spacing !== target.right.spacing ||
      right.token === target.right.token ||
      nextFenced.has(middleIndex) || nextFenced.has(rightIndex) ||
      !hasBlockGap(nextText, middle.line, emptyLine) ||
      !hasBlockGap(nextText, emptyLine, right.line)
    ) continue
    const leftGap = nextText.slice(middle.line.end, emptyLine.start)
    const rightGap = nextText.slice(emptyLine.end, right.line.start)
    if (leftGap !== beforeGap || rightGap !== beforeGap) continue
    if (
      previousText.slice(0, target.middle.line.end) !== nextText.slice(0, middle.line.end) ||
      previousText.slice(target.right.line.end) !== nextText.slice(right.line.end)
    ) continue
    after.push({ middle, emptyLine, right })
  }
  if (after.length !== 1) return null

  const sourceLines = markdownLines(sourceText)
  const sourceFenced = fencedIndexes(sourceText, sourceLines)
  const sourceMatches = []
  for (let rightIndex = 0; rightIndex < sourceLines.length; rightIndex += 1) {
    const right = rowMeta(sourceLines[rightIndex])
    if (
      !right || right.indent.length !== 0 || right.task != null || right.empty ||
      right.bodyVisible !== target.right.bodyVisible || sourceFenced.has(rightIndex)
    ) continue
    const middleIndex = nearestNonBlank(sourceLines, rightIndex, -1)
    if (middleIndex < 0) continue
    const middle = rowMeta(sourceLines[middleIndex])
    if (
      !middle || middle.indent.length !== 0 || middle.task != null || middle.empty ||
      middle.bodyVisible !== target.middle.bodyVisible || sourceFenced.has(middleIndex)
    ) continue
    sourceMatches.push({ middle, right })
  }
  if (sourceMatches.length !== 1) return null

  return {
    markdown: sourceText,
    preserved: true,
    reason: 'coalesced-empty-bullet-exit-before-sibling',
    nextBaseline: nextText
  }
}

// RS-85: Backspace on an EMPTY top-level ordered item that still owns a
// nested ordered child removes the item boundary, but ProseMirror keeps the
// empty paragraph between the preceding sibling's text and the moved child:
//
//   1. left            1. left
//   2. <br />    ->       <br />
//      1. child           1. child
//
// Markdown cannot encode that one editor-owned middle empty paragraph without
// leaking `<br />`. The generic `empty-list-item-removed` mapper already
// deletes the correct authored row, but its trailing-empty semantic allowance
// cannot prove a paragraph BEFORE a nested list. Own only this exact raw shape:
// the empty item is the consecutive top-level ordered sibling, the replacement
// indent exactly matches an unchanged nested ordered child, and the raw left
// prefix plus child suffix are byte-identical even when previous used compact
// spacing and next becomes loose. The authored parent/empty/child triple must be
// unique, compact and outside fences. Patch only the authored empty item row;
// the dedicated integrity reason
// may then ignore precisely the unencodable middle paragraph.
export const preserveEmptyOrderedItemBackspaceMergeBeforeNestedList = ({ source, previous, next }) => {
  const stripCr = (value) => String(value || '').endsWith('\r')
    ? String(value).slice(0, -1)
    : String(value || '')
  const rowMeta = (line) => {
    if (!line) return null
    const text = stripCr(line.text)
    const match = text.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    const ordered = match[2].match(/^(\d{1,9})([.)])$/)
    const task = match[4].match(/^\[([ xX])\](?:[ \t]+|$)/)
    const body = match[4]
    const authoredBody = body.replaceAll(LEADING_SPACE_SENTINEL, '')
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body,
      bodyVisible: sourceVisibleIndex(authoredBody).text.trim(),
      empty: !authoredBody.trim() || /^<br\s*\/?>$/i.test(authoredBody.trim()),
      task: task ? task[1].toLowerCase() : null,
      kind: ordered ? 'ordered' : 'bullet',
      ordinal: ordered ? Number(ordered[1]) : null,
      delimiter: ordered ? ordered[2] : null
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (stripCr(lines[cursor].text).trim()) return cursor
    }
    return -1
  }
  const hasBlockGap = (markdown, left, right) =>
    /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/.test(markdown.slice(left.end, right.start))
  const fencedIndexes = (markdown, lines) => {
    const fenced = new Set()
    let open = null
    for (let index = 0; index < lines.length; index += 1) {
      const text = stripCr(lines[index].text)
      if (open) {
        fenced.add(index)
        const close = text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
        if (close && close[1][0] === open.char && close[1].length >= open.length) open = null
        continue
      }
      const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!match) continue
      if (match[1][0] === '`' && match[2].includes('`')) continue
      open = { char: match[1][0], length: match[1].length }
      fenced.add(index)
    }
    return fenced
  }
  const intersects = (line, range) => !range || (
    line.end >= range.start - 2 && line.start <= range.end + 2
  )

  const beforeCandidates = ({ markdown, range }) => {
    const lines = markdownLines(markdown)
    const fenced = fencedIndexes(markdown, lines)
    const found = []
    for (let index = 0; index < lines.length; index += 1) {
      const empty = rowMeta(lines[index])
      if (
        !empty || empty.kind !== 'ordered' || empty.indent.length !== 0 ||
        empty.task != null || !empty.empty ||
        !/^<br\s*\/?>$/i.test(empty.body.trim()) ||
        fenced.has(index) || !intersects(empty.line, range)
      ) continue
      const leftIndex = nearestNonBlank(lines, index, -1)
      const childIndex = nearestNonBlank(lines, index, 1)
      if (leftIndex < 0 || childIndex < 0) continue
      const left = rowMeta(lines[leftIndex])
      const child = rowMeta(lines[childIndex])
      if (
        !left || left.kind !== 'ordered' || left.indent.length !== 0 ||
        left.task != null || left.empty ||
        empty.ordinal !== left.ordinal + 1 ||
        empty.delimiter !== left.delimiter ||
        !child || child.kind !== 'ordered' || child.indent.length === 0 ||
        child.task != null || child.empty ||
        fenced.has(leftIndex) || fenced.has(childIndex) ||
        !hasBlockGap(markdown, empty.line, child.line)
      ) continue
      found.push({ lines, left, empty, child })
    }
    return found
  }

  const afterCandidates = ({ markdown, target, range }) => {
    const lines = markdownLines(markdown)
    const fenced = fencedIndexes(markdown, lines)
    const found = []
    for (let index = 0; index < lines.length; index += 1) {
      const text = stripCr(lines[index].text)
      const emptyMatch = text.match(/^([ \t]+)<br\s*\/?>[ \t]*$/i)
      if (!emptyMatch || fenced.has(index) || !intersects(lines[index], range)) continue
      const leftIndex = nearestNonBlank(lines, index, -1)
      const childIndex = nearestNonBlank(lines, index, 1)
      if (leftIndex < 0 || childIndex < 0) continue
      const left = rowMeta(lines[leftIndex])
      const child = rowMeta(lines[childIndex])
      if (
        !left || left.kind !== 'ordered' || left.indent.length !== 0 ||
        left.task != null || left.empty ||
        left.bodyVisible !== target.left.bodyVisible ||
        left.ordinal !== target.left.ordinal ||
        left.delimiter !== target.left.delimiter ||
        left.spacing !== target.left.spacing ||
        !child || child.kind !== 'ordered' || child.indent.length === 0 ||
        child.task != null || child.empty ||
        child.bodyVisible !== target.child.bodyVisible ||
        child.indent !== target.child.indent ||
        child.ordinal !== target.child.ordinal ||
        child.delimiter !== target.child.delimiter ||
        child.spacing !== target.child.spacing ||
        emptyMatch[1] !== child.indent ||
        fenced.has(leftIndex) || fenced.has(childIndex) ||
        !hasBlockGap(markdown, left.line, lines[index]) ||
        !hasBlockGap(markdown, lines[index], child.line)
      ) continue
      found.push({ lines, left, empty: lines[index], child })
    }
    return found
  }

  const change = commonChange(previous, next)
  const before = beforeCandidates({
    markdown: previous,
    range: { start: change.start, end: change.previousEnd }
  })
  if (before.length !== 1) return null
  const target = before[0]
  const after = afterCandidates({
    markdown: next,
    target,
    range: { start: change.start, end: change.nextEnd }
  }).filter((candidate) =>
    previous.slice(0, target.left.line.end) === next.slice(0, candidate.left.line.end) &&
    previous.slice(target.child.line.start) === next.slice(candidate.child.line.start)
  )
  if (after.length !== 1) return null

  const sourceLines = markdownLines(String(source || ''))
  const sourceFenced = fencedIndexes(source, sourceLines)
  const sourceMatches = []
  for (let index = 0; index < sourceLines.length; index += 1) {
    const empty = rowMeta(sourceLines[index])
    if (
      !empty || empty.kind !== 'ordered' || empty.indent.length !== 0 ||
      empty.task != null || !empty.empty || /<br\s*\/?>/i.test(empty.body) ||
      sourceFenced.has(index)
    ) continue
    const leftIndex = nearestNonBlank(sourceLines, index, -1)
    const childIndex = nearestNonBlank(sourceLines, index, 1)
    if (leftIndex < 0 || childIndex < 0) continue
    const left = rowMeta(sourceLines[leftIndex])
    const child = rowMeta(sourceLines[childIndex])
    if (
      !left || left.kind !== 'ordered' || left.indent.length !== 0 ||
      left.task != null || left.empty ||
      left.bodyVisible !== target.left.bodyVisible ||
      left.ordinal !== target.left.ordinal ||
      empty.ordinal !== left.ordinal + 1 ||
      empty.delimiter !== left.delimiter ||
      !child || child.kind !== 'ordered' || child.indent.length === 0 ||
      child.task != null || child.empty ||
      child.bodyVisible !== target.child.bodyVisible ||
      child.ordinal !== target.child.ordinal ||
      sourceFenced.has(leftIndex) || sourceFenced.has(childIndex) ||
      hasBlockGap(source, left.line, empty.line) ||
      hasBlockGap(source, empty.line, child.line)
    ) continue
    sourceMatches.push({ empty, left, child })
  }
  if (sourceMatches.length !== 1) return null
  const sourceTarget = sourceMatches[0]
  const rowEnd = sourceTarget.empty.line.end < source.length && source[sourceTarget.empty.line.end] === '\n'
    ? sourceTarget.empty.line.end + 1
    : sourceTarget.empty.line.end
  return {
    markdown: source.slice(0, sourceTarget.empty.line.start) + source.slice(rowEnd),
    preserved: true,
    reason: 'empty-ordered-item-merged-before-nested-list',
    nextBaseline: next
  }
}

// RS-84: deleting one selection that starts in a bullet body, crosses a
// standalone ordered item, and ends in the first item of the following bullet
// list is one atomic ProseMirror replace. The live document keeps exactly one
// empty bullet item before the untouched second bullet item:
//
//   * first          * <br />
//
//   2. middle   ->   * surviving
//
//   * last
//   * surviving
//
// On a globally diverged document the broad multi-list mapper tries to
// reconcile the three old list blocks independently and fails with
// `unmapped-diverged-list-batch`. Own only the exact real trace family before
// `<br />` normalization: canonical outside the replacement must be byte
// identical, all three removed rows must be top-level non-task rows with the
// exact bullet/ordered/bullet shape, the authored source target plus unchanged
// visible neighbours must be unique, and no target row may be inside a fence.
// The source patch replaces the complete three-row range with the first
// authored bullet prefix (`- ` / `+ ` / `* `), preserving its EOL, compactness,
// the surviving sibling and every unrelated byte. Any ambiguity or batched edit
// returns null and keeps the existing fail-closed behavior.
export const preserveCrossListSelectionDeleteToEmptyBullet = ({ source, previous, next }) => {
  const stripCr = (value) => String(value || '').endsWith('\r')
    ? String(value).slice(0, -1)
    : String(value || '')
  const rowMeta = (line) => {
    if (!line) return null
    const text = stripCr(line.text)
    const match = text.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    const ordered = match[2].match(/^(\d{1,9})([.)])$/)
    const task = match[4].match(/^\[([ xX])\](?:[ \t]+|$)/)
    const body = match[4]
    const authoredBody = body.replaceAll(LEADING_SPACE_SENTINEL, '')
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      prefixEnd: match[1].length + match[2].length + match[3].length,
      body,
      bodyVisible: sourceVisibleIndex(authoredBody).text.trim(),
      empty: !authoredBody.trim() || /^<br\s*\/?>$/i.test(authoredBody.trim()),
      task: task ? task[1].toLowerCase() : null,
      kind: ordered ? 'ordered' : 'bullet',
      ordinal: ordered ? Number(ordered[1]) : null,
      delimiter: ordered ? ordered[2] : null
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (stripCr(lines[cursor].text).trim()) return cursor
    }
    return -1
  }
  const hasBlockGap = (markdown, left, right) =>
    /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/.test(markdown.slice(left.end, right.start))
  const visibleLine = (line) => sourceVisibleIndex(stripCr(line?.text)).text.trim()
  const fencedIndexes = (markdown, lines) => {
    const fenced = new Set()
    let open = null
    for (let index = 0; index < lines.length; index += 1) {
      const text = stripCr(lines[index].text)
      if (open) {
        fenced.add(index)
        const close = text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
        if (close && close[1][0] === open.char && close[1].length >= open.length) open = null
        continue
      }
      const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!match) continue
      // A backtick info string containing another backtick is not a valid
      // CommonMark fence opener (for example the literal line ```text```).
      if (match[1][0] === '`' && match[2].includes('`')) continue
      open = { char: match[1][0], length: match[1].length }
      fenced.add(index)
    }
    return fenced
  }
  const triples = ({ markdown, targetBodies = null, targetAnchors = null, changeRange = null }) => {
    const lines = markdownLines(markdown)
    const fenced = fencedIndexes(markdown, lines)
    const found = []
    for (let firstIndex = 0; firstIndex < lines.length; firstIndex += 1) {
      const first = rowMeta(lines[firstIndex])
      if (
        !first || first.kind !== 'bullet' || first.indent.length !== 0 ||
        first.task != null || first.empty || fenced.has(firstIndex)
      ) continue
      const middleIndex = nearestNonBlank(lines, firstIndex, 1)
      const lastIndex = middleIndex >= 0 ? nearestNonBlank(lines, middleIndex, 1) : -1
      const rightIndex = lastIndex >= 0 ? nearestNonBlank(lines, lastIndex, 1) : -1
      const leftIndex = nearestNonBlank(lines, firstIndex, -1)
      if (middleIndex < 0 || lastIndex < 0 || rightIndex < 0 || leftIndex < 0) continue
      const middle = rowMeta(lines[middleIndex])
      const last = rowMeta(lines[lastIndex])
      const right = rowMeta(lines[rightIndex])
      if (
        !middle || middle.kind !== 'ordered' || middle.indent.length !== 0 ||
        middle.task != null || middle.empty ||
        !last || last.kind !== 'bullet' || last.indent.length !== 0 ||
        last.task != null || last.empty ||
        !right || right.kind !== 'bullet' || right.indent.length !== 0 ||
        right.task != null || right.empty ||
        first.token !== last.token || last.token !== right.token ||
        fenced.has(middleIndex) || fenced.has(lastIndex) ||
        fenced.has(leftIndex) || fenced.has(rightIndex) ||
        !hasBlockGap(markdown, first.line, middle.line) ||
        !hasBlockGap(markdown, middle.line, last.line)
      ) continue
      if (
        changeRange &&
        !(
          changeRange.start >= first.line.start && changeRange.start <= first.line.end &&
          changeRange.end >= last.line.start && changeRange.end <= last.line.end + 1
        )
      ) continue
      const bodies = [first.bodyVisible, middle.bodyVisible, last.bodyVisible]
      const anchors = {
        left: visibleLine(lines[leftIndex]),
        right: right.bodyVisible
      }
      if (targetBodies && bodies.some((body, index) => body !== targetBodies[index])) continue
      if (
        targetAnchors &&
        (anchors.left !== targetAnchors.left || anchors.right !== targetAnchors.right)
      ) continue
      found.push({
        lines,
        left: lines[leftIndex],
        first,
        middle,
        last,
        right,
        bodies,
        anchors
      })
    }
    return found
  }

  const change = commonChange(previous, next)
  const before = triples({
    markdown: previous,
    changeRange: { start: change.start, end: change.previousEnd }
  })
  if (before.length !== 1) return null
  const target = before[0]

  const nextLines = markdownLines(next)
  const nextFenced = fencedIndexes(next, nextLines)
  const after = []
  for (let index = 0; index < nextLines.length; index += 1) {
    const empty = rowMeta(nextLines[index])
    if (
      !empty || empty.kind !== 'bullet' || empty.indent.length !== 0 ||
      empty.task != null || !empty.empty ||
      !/^<br\s*\/?>$/i.test(empty.body.trim()) ||
      empty.token !== target.first.token || nextFenced.has(index)
    ) continue
    const leftIndex = nearestNonBlank(nextLines, index, -1)
    const rightIndex = nearestNonBlank(nextLines, index, 1)
    if (leftIndex < 0 || rightIndex < 0 || nextFenced.has(leftIndex) || nextFenced.has(rightIndex)) continue
    const right = rowMeta(nextLines[rightIndex])
    if (
      !right || right.kind !== 'bullet' || right.indent.length !== 0 ||
      right.task != null || right.empty ||
      right.token !== target.right.token ||
      right.bodyVisible !== target.anchors.right ||
      visibleLine(nextLines[leftIndex]) !== target.anchors.left ||
      !hasBlockGap(next, nextLines[leftIndex], empty.line) ||
      !hasBlockGap(next, empty.line, right.line) ||
      change.nextEnd < empty.line.start || change.nextEnd > empty.line.end + 1
    ) continue
    if (
      previous.slice(0, target.first.line.start) !== next.slice(0, empty.line.start) ||
      previous.slice(target.right.line.start) !== next.slice(right.line.start)
    ) continue
    after.push({ empty, right })
  }
  if (after.length !== 1) return null

  const sourceMatches = triples({
    markdown: source,
    targetBodies: target.bodies,
    targetAnchors: target.anchors
  })
  if (sourceMatches.length !== 1) return null
  const sourceTarget = sourceMatches[0]
  const markerPrefix = sourceTarget.first.line.text.slice(0, sourceTarget.first.prefixEnd)
  const sourceContentEnd = sourceTarget.last.line.text.endsWith('\r')
    ? sourceTarget.last.line.end - 1
    : sourceTarget.last.line.end
  return {
    markdown: source.slice(0, sourceTarget.first.line.start) +
      markerPrefix +
      source.slice(sourceContentEnd),
    preserved: true,
    reason: 'diverged-cross-list-selection-delete-to-empty-bullet',
    nextBaseline: next
  }
}

const preserveNonEmptyBulletListBackspaceMergeIntoOrdered = ({ source, previous, next }) => {
  // Backspace at the beginning of the first NON-EMPTY bullet item immediately
  // after an ordered list can join the complete flat bullet segment into that
  // ordered list in one structural transaction:
  //
  //   2. left        ->  2. left
  //
  //   - first           3. first
  //   - second          4. second
  //
  // If another ordered list immediately follows, preserving the same delimiter
  // would make CommonMark merge it into the newly extended list on reopen.
  // Crepe therefore changes that following first marker (`1.` -> `1)`) as a
  // parse-required separator. Prove the whole family in one pass: the left item
  // and all moved bodies are unchanged, ordinals are consecutive, the authored
  // target segment is unique, and the following separator changes only when
  // required. Patch the moved markers plus that one proven separator marker;
  // every other byte remains author-owned apart from same-kind serializer
  // marker spelling outside the transaction.
  const rowMeta = (line) => {
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    const ordered = match[2].match(/^(\d{1,9})([.)])$/)
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body: match[4],
      kind: ordered ? 'ordered' : 'bullet',
      ordinal: ordered ? Number(ordered[1]) : null,
      delimiter: ordered ? ordered[2] : null
    }
  }
  const nextNonBlankIndex = (lines, index) => {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].text.trim()) return cursor
    }
    return -1
  }
  const outsideListSpellingEquivalent = (leftMarkdown, rightMarkdown) => {
    const leftLines = markdownLines(leftMarkdown)
    const rightLines = markdownLines(rightMarkdown)
    if (leftLines.length !== rightLines.length) return false
    for (let index = 0; index < leftLines.length; index += 1) {
      if (leftLines[index].text === rightLines[index].text) continue
      const left = rowMeta(leftLines[index])
      const right = rowMeta(rightLines[index])
      if (
        !left || !right ||
        left.kind !== right.kind ||
        left.indent !== right.indent ||
        left.spacing !== right.spacing ||
        left.body !== right.body
      ) return false
      if (left.kind === 'ordered' && left.ordinal !== right.ordinal) return false
      // For ordered rows only `.` / `)` may drift; for bullet rows only the
      // single marker character may drift. All other bytes were checked above.
    }
    return true
  }
  const flatBulletSegmentsAfterOrdered = ({ markdown, changeRange }) => {
    const lines = markdownLines(markdown)
    const found = []
    for (let index = 0; index < lines.length; index += 1) {
      const left = rowMeta(lines[index])
      if (
        !left || left.kind !== 'ordered' || left.indent.length !== 0 ||
        !Number.isFinite(left.ordinal) || !left.body.trim()
      ) continue
      let cursor = nextNonBlankIndex(lines, index)
      if (cursor < 0) continue
      const first = rowMeta(lines[cursor])
      if (
        !first || first.kind !== 'bullet' || first.indent.length !== 0 ||
        !first.body.trim()
      ) continue
      const bulletToken = first.token
      const rows = []
      while (cursor >= 0) {
        const row = rowMeta(lines[cursor])
        if (
          !row || row.kind !== 'bullet' || row.indent.length !== 0 ||
          !row.body.trim() || row.token !== bulletToken
        ) break
        rows.push(row)
        cursor = nextNonBlankIndex(lines, cursor)
      }
      const firstStart = rows[0].line.start
      const lastEnd = rows.at(-1).line.end
      if (
        lastEnd < changeRange.start - 2 ||
        firstStart > changeRange.end + 2
      ) continue
      const following = cursor >= 0 ? rowMeta(lines[cursor]) : null
      found.push({ left, rows, following })
    }
    return found
  }
  const orderedMergeCandidates = ({ markdown, target, changeRange }) => {
    const lines = markdownLines(markdown)
    const found = []
    for (let index = 0; index < lines.length; index += 1) {
      const left = rowMeta(lines[index])
      if (
        !left || left.kind !== 'ordered' || left.indent.length !== 0 ||
        left.body !== target.left.body ||
        left.ordinal !== target.left.ordinal ||
        left.delimiter !== target.left.delimiter ||
        left.spacing !== target.left.spacing
      ) continue
      let cursor = index
      const rows = []
      let valid = true
      for (let offset = 0; offset < target.rows.length; offset += 1) {
        cursor = nextNonBlankIndex(lines, cursor)
        const row = cursor >= 0 ? rowMeta(lines[cursor]) : null
        const beforeRow = target.rows[offset]
        if (
          !row || row.kind !== 'ordered' || row.indent.length !== 0 ||
          row.body !== beforeRow.body ||
          row.spacing !== beforeRow.spacing ||
          row.ordinal !== left.ordinal + offset + 1 ||
          row.delimiter !== left.delimiter
        ) {
          valid = false
          break
        }
        rows.push(row)
      }
      if (!valid) continue
      const firstStart = rows[0].line.start
      const lastEnd = rows.at(-1).line.end
      if (
        lastEnd < changeRange.start - 2 ||
        firstStart > changeRange.end + 2
      ) continue
      const followingIndex = nextNonBlankIndex(lines, cursor)
      const following = followingIndex >= 0 ? rowMeta(lines[followingIndex]) : null
      found.push({ left, rows, following })
    }
    return found
  }

  const sameFollowingOrderedRow = (left, right) => Boolean(
    left && right &&
    left.kind === 'ordered' && right.kind === 'ordered' &&
    left.indent.length === 0 && right.indent.length === 0 &&
    left.indent === right.indent &&
    left.spacing === right.spacing &&
    left.body === right.body &&
    left.ordinal === right.ordinal
  )

  const change = commonChange(previous, next)
  const before = flatBulletSegmentsAfterOrdered({
    markdown: previous,
    changeRange: { start: change.start, end: change.previousEnd }
  })
  if (before.length !== 1) return null
  const target = before[0]

  const after = orderedMergeCandidates({
    markdown: next,
    target,
    changeRange: { start: change.start, end: change.nextEnd }
  })
  if (after.length !== 1) return null
  const afterTarget = after[0]

  if (!outsideListSpellingEquivalent(
    previous.slice(0, target.left.line.start),
    next.slice(0, afterTarget.left.line.start)
  )) return null
  const targetLast = target.rows.at(-1)
  const afterLast = afterTarget.rows.at(-1)
  let separatorChange = null
  let previousSuffixStart = targetLast.line.end
  let nextSuffixStart = afterLast.line.end
  if (target.following || afterTarget.following) {
    if (!sameFollowingOrderedRow(target.following, afterTarget.following)) return null
    const previousGap = previous.slice(targetLast.line.end, target.following.line.start)
    const nextGap = next.slice(afterLast.line.end, afterTarget.following.line.start)
    if (previousGap !== nextGap) return null

    const alreadySeparated = target.following.delimiter !== target.left.delimiter
    if (alreadySeparated) {
      if (afterTarget.following.delimiter !== target.following.delimiter) return null
    } else {
      if (afterTarget.following.delimiter === afterTarget.left.delimiter) return null
      separatorChange = {
        before: target.following,
        after: afterTarget.following
      }
    }
    previousSuffixStart = target.following.line.end
    nextSuffixStart = afterTarget.following.line.end
  }
  if (!outsideListSpellingEquivalent(
    previous.slice(previousSuffixStart),
    next.slice(nextSuffixStart)
  )) return null

  const sourceMatches = flatBulletSegmentsAfterOrdered({
    markdown: source,
    changeRange: { start: 0, end: source.length }
  }).filter(({ left, rows, following }) =>
    left.body === target.left.body &&
    left.ordinal === target.left.ordinal &&
    rows.length === target.rows.length &&
    rows.every((row, index) => row.body === target.rows[index].body) &&
    (!target.following || (
      sameFollowingOrderedRow(following, target.following) &&
      following.delimiter === target.following.delimiter
    ))
  )
  if (sourceMatches.length !== 1) return null
  const sourceTarget = sourceMatches[0]
  const delimiter = sourceTarget.left.delimiter
  if (!delimiter) return null

  const replacements = sourceTarget.rows.map((row, index) => ({
    start: row.line.start + row.indent.length,
    end: row.line.start + row.indent.length + row.token.length,
    token: `${afterTarget.rows[index].ordinal}${delimiter}`
  }))
  if (separatorChange) {
    const following = sourceTarget.following
    if (!following) return null
    replacements.push({
      start: following.line.start + following.indent.length,
      end: following.line.start + following.indent.length + following.token.length,
      token: `${separatorChange.after.ordinal}${separatorChange.after.delimiter}`
    })
  }
  replacements.sort((left, right) => right.start - left.start)
  let markdown = source
  for (const replacement of replacements) {
    markdown = markdown.slice(0, replacement.start) + replacement.token + markdown.slice(replacement.end)
  }
  return {
    markdown,
    preserved: true,
    reason: 'diverged-nonempty-bullet-list-backspace-merge-ordered',
    nextBaseline: next
  }
}

const preserveIsolatedEmptyBulletBackspaceMergeIntoOrdered = ({ source, previous, next }) => {
  // The mirror image of `preserveIsolatedEmptyOrderedBackspaceLift` happens
  // when an empty bullet sits immediately to the right of an ordered list.
  // Backspace can absorb that empty bullet AND the following same-level bullet
  // row into the ordered list in one ProseMirror transaction:
  //
  //   2. left        ->  2. left
  //   -                 3.
  //   - right           4. right
  //
  // In a globally diverged document the generic list-batch mapper cannot pair
  // the three before/after blocks and fails closed. Prove the exact local
  // shape from the unchanged neighbour bodies and consecutive ordinals, then
  // change only the two authored bullet marker tokens. Blank-line style,
  // spacing, bodies, fences, and every unrelated list stay byte-stable.
  const rowMeta = (line) => {
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    const match = text.match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return null
    const ordered = match[2].match(/^(\d{1,9})([.)])$/)
    return {
      line,
      indent: match[1],
      token: match[2],
      spacing: match[3],
      body: match[4],
      kind: ordered ? 'ordered' : 'bullet',
      ordinal: ordered ? Number(ordered[1]) : null,
      delimiter: ordered ? ordered[2] : null
    }
  }
  const nearestNonBlank = (lines, index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) {
      if (lines[cursor].text.trim()) return cursor
    }
    return -1
  }
  const candidates = ({ markdown, middleKind, rightKind, changeRange }) => {
    const lines = markdownLines(markdown)
    const found = []
    for (let index = 0; index < lines.length; index += 1) {
      const middle = rowMeta(lines[index])
      if (
        !middle || middle.kind !== middleKind || middle.indent.length !== 0 ||
        middle.body.trim()
      ) continue
      const leftIndex = nearestNonBlank(lines, index, -1)
      const rightIndex = nearestNonBlank(lines, index, 1)
      if (leftIndex < 0 || rightIndex < 0) continue
      const left = rowMeta(lines[leftIndex])
      const right = rowMeta(lines[rightIndex])
      if (
        !left || !right || left.kind !== 'ordered' || right.kind !== rightKind ||
        left.indent !== middle.indent || right.indent !== middle.indent ||
        !left.body.trim() || !right.body.trim()
      ) continue
      found.push({ left, middle, right })
    }
    return found.filter(({ middle }) =>
      middle.line.end >= changeRange.start - 2 &&
      middle.line.start <= changeRange.end + 2
    )
  }

  const change = commonChange(previous, next)
  const before = candidates({
    markdown: previous,
    middleKind: 'bullet',
    rightKind: 'bullet',
    changeRange: { start: change.start, end: change.previousEnd }
  })
  if (before.length !== 1) return null
  const target = before[0]
  if (target.middle.token !== target.right.token) return null

  const after = candidates({
    markdown: next,
    middleKind: 'ordered',
    rightKind: 'ordered',
    changeRange: { start: change.start, end: change.nextEnd }
  }).filter(({ left, middle, right }) =>
    left.body === target.left.body &&
    right.body === target.right.body &&
    Number.isFinite(left.ordinal) &&
    middle.ordinal === left.ordinal + 1 &&
    right.ordinal === left.ordinal + 2 &&
    middle.delimiter === left.delimiter &&
    right.delimiter === left.delimiter
  )
  if (after.length !== 1) return null
  const afterTarget = after[0]

  const sourceMatches = candidates({
    markdown: source,
    middleKind: 'bullet',
    rightKind: 'bullet',
    changeRange: { start: 0, end: source.length }
  }).filter(({ left, middle, right }) =>
    left.body === target.left.body &&
    right.body === target.right.body &&
    Number.isFinite(left.ordinal) &&
    left.ordinal === afterTarget.left.ordinal &&
    middle.token === right.token
  )
  if (sourceMatches.length !== 1) return null
  const sourceTarget = sourceMatches[0]
  const delimiter = sourceTarget.left.delimiter
  if (!delimiter) return null
  const replacements = [
    {
      start: sourceTarget.middle.line.start + sourceTarget.middle.indent.length,
      end: sourceTarget.middle.line.start + sourceTarget.middle.indent.length + sourceTarget.middle.token.length,
      token: `${afterTarget.middle.ordinal}${delimiter}`
    },
    {
      start: sourceTarget.right.line.start + sourceTarget.right.indent.length,
      end: sourceTarget.right.line.start + sourceTarget.right.indent.length + sourceTarget.right.token.length,
      token: `${afterTarget.right.ordinal}${delimiter}`
    }
  ].sort((left, right) => right.start - left.start)
  let markdown = source
  for (const replacement of replacements) {
    markdown = markdown.slice(0, replacement.start) + replacement.token + markdown.slice(replacement.end)
  }
  return {
    markdown,
    preserved: true,
    reason: 'diverged-isolated-empty-bullet-backspace-merge-ordered',
    nextBaseline: next
  }
}

const preserveAllDivergedListChanges = ({ source, previous, next }) => {
  const nonEmptyBulletMerge = preserveNonEmptyBulletListBackspaceMergeIntoOrdered({ source, previous, next })
  if (nonEmptyBulletMerge) return nonEmptyBulletMerge

  const isolatedBulletMerge = preserveIsolatedEmptyBulletBackspaceMergeIntoOrdered({ source, previous, next })
  if (isolatedBulletMerge) return isolatedBulletMerge

  const isolatedEmptyLift = preserveIsolatedEmptyOrderedBackspaceLift({ source, previous, next })
  if (isolatedEmptyLift) return isolatedEmptyLift

  const transientEmptyLift = preserveTransientEmptyOrderedBackspaceLift({ source, previous, next })
  if (transientEmptyLift) return transientEmptyLift

  let currentSource = source
  let currentPrevious = previous
  let applied = false
  const limit = Math.max(2, String(previous || '').split('\n').length)
  for (let attempt = 0; attempt < limit && currentPrevious !== next; attempt += 1) {
    const change = commonChange(currentPrevious, next)
    const result = preserveDivergedNestedListChange({
      source: currentSource,
      previous: currentPrevious,
      next,
      ...change
    })
    if (!result?.nextBaseline || result.nextBaseline === currentPrevious) {
      // A list transaction may be followed only by Crepe changing the number
      // of terminal serializer newlines. The structural delta was already
      // consumed above; terminal canonical padding has no authored-source
      // ownership and must not turn a successful Enter split into a blocked
      // transaction. Keep this exception byte-strict apart from trailing EOLs
      // so heading/list/task changes can never pass on visible-text equality.
      const withoutTrailingBreaks = (value) => String(value || '').replace(/(?:\r?\n)+$/, '')
      if (
        applied &&
        withoutTrailingBreaks(currentPrevious) === withoutTrailingBreaks(next)
      ) {
        currentPrevious = next
        continue
      }
      if (!applied) return null
      return {
        markdown: source,
        preserved: false,
        reason: 'unmapped-diverged-list-batch',
        blocked: true
      }
    }
    currentSource = result.markdown
    currentPrevious = result.nextBaseline
    applied = true
  }
  if (!applied) return null
  if (currentPrevious !== next) {
    return {
      markdown: source,
      preserved: false,
      reason: 'unmapped-diverged-list-batch',
      blocked: true
    }
  }
  return {
    markdown: currentSource,
    preserved: true,
    reason: 'diverged-nested-list-change'
  }
}

function preserveRichMarkdownSourceCore(sourceMarkdown, previousCanonical, nextCanonical) {
  // RS-56: preserve the raw indentation of a nested editor-owned `<br />`
  // before normalizeEmptyListItems strips it. A rapid Backspace can remove the
  // deepest list row and lift its empty paragraph into the parent list item;
  // the raw canonical's indented placeholder is the proof that this is the
  // existing narrow list-item-removal transient. Only that dedicated reason is
  // allowed to bypass normalization here. Every other tail result is ignored
  // and continues through the established mapper ordering below.
  const rawPrevious = String(previousCanonical || '')
  const rawNext = String(nextCanonical || '')
  if (rawPrevious && rawNext && rawPrevious !== rawNext) {
    // RS-66: preserve GFM task semantics before normalizeEmptyListItems()
    // erases the `<br />` evidence and lets a generic mapper publish bare
    // `[ ]` syntax. The dedicated proof itself verifies the whole transaction.
    const rawEmptyTaskSlashCreated = preserveCreatedEmptyTaskFromSlash({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawEmptyTaskSlashCreated) return rawEmptyTaskSlashCreated

    // RS-68: rapid Backspace can coalesce "empty ordered parent body" and
    // "lift that empty parent into the preceding bullet list" into one raw
    // callback. Claim this before RS-67's single-step body-empty proof and
    // before `<br />` normalization loses the parse-critical parent/child gap.
    const rawRapidNestedParentLift = preserveRapidNestedOrderedParentBackspaceLift({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawRapidNestedParentLift) return rawRapidNestedParentLift

    // RS-67: preserve a list parent's marker before `<br />` normalization can
    // erase the distinction between "parent body emptied" and "parent item
    // removed". The proof itself requires an unchanged deeper child and a
    // unique authored parent/child pair, so it stays independent of any earlier
    // source/canonical divergence in the document.
    const rawNestedParentBodyEmptied = preserveNestedListParentBodyEmptied({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawNestedParentBodyEmptied) return rawNestedParentBodyEmptied

    // RS-86: a rapid two-Enter exit can insert one top-level editor-only empty
    // paragraph before an unchanged sibling while the newly split sibling list
    // changes only its bullet token spelling. Claim this before generic empty
    // list-row removal can misidentify that non-empty sibling as the exited row.
    const rawCoalescedBulletExit = preserveCoalescedEmptyBulletExitBeforeSibling({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawCoalescedBulletExit) return rawCoalescedBulletExit

    // RS-85: an empty top-level ordered item with an unchanged nested ordered
    // child can merge into its previous sibling. Raw canonical preserves the
    // only proof that the resulting empty paragraph sits BEFORE that child, so
    // claim it before `<br />` normalization and generic empty-row removal.
    const rawEmptyOrderedBeforeNested = preserveEmptyOrderedItemBackspaceMergeBeforeNestedList({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawEmptyOrderedBeforeNested) return rawEmptyOrderedBeforeNested

    // RS-84: a cross-block selection deletion can replace one bullet row, one
    // ordered row and the first row of the next bullet list with a single empty
    // bullet item. Prove and publish that complete raw replacement before
    // `<br />` normalization or the broad diverged-list loop can only apply a
    // partial list deletion and block the callback.
    const rawCrossListSelectionDelete = preserveCrossListSelectionDeleteToEmptyBullet({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawCrossListSelectionDelete) return rawCrossListSelectionDelete

    // RS-82: a non-empty bullet segment can be absorbed into the ordered list
    // on its left. If another ordered list follows, Crepe switches that first
    // marker from `1.` to `1)` to keep the two lists separate on reparse.
    // normalizeOrderedListDelimiters() intentionally erases that delimiter
    // spelling, so the parse-safe separator must be proven and patched from the
    // raw callback before normalization. The family proof also verifies all
    // moved bodies, consecutive ordinals, token identity and untouched suffix.
    const rawNonEmptyBulletMerge = preserveNonEmptyBulletListBackspaceMergeIntoOrdered({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext
    })
    if (rawNonEmptyBulletMerge) return rawNonEmptyBulletMerge

    const rawChange = commonChange(rawPrevious, rawNext)
    // RS-60: an empty task row can be removed into an indented trailing
    // paragraph inside the preceding task item. normalizeEmptyListItems() drops
    // precisely that indentation, so prove the task-owned transition against
    // raw canonical first. Only the dedicated task reason may short-circuit;
    // every other raw paragraph result continues through normal normalization.
    const rawOwnedContinuationRemoval = preserveEmptiedParagraph({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext,
      start: rawChange.start,
      previousEnd: rawChange.previousEnd,
      nextEnd: rawChange.nextEnd
    })
    if (
      rawOwnedContinuationRemoval?.reason === 'empty-task-item-merged-to-continuation' ||
      rawOwnedContinuationRemoval?.reason === 'empty-list-item-merged-after-nested-list'
    ) {
      return rawOwnedContinuationRemoval
    }
    const rawNestedRemoval = preserveDivergedTailBlockAppend({
      source: sourceMarkdown,
      previous: rawPrevious,
      next: rawNext,
      start: rawChange.start,
      nextEnd: rawChange.nextEnd
    })
    if (rawNestedRemoval?.reason === 'nested-empty-list-item-removed') {
      return rawNestedRemoval
    }
  }

  // Empty list items have a Crepe-only `<br />` placeholder. Normalize it on
  // both sides of the delta before source mapping so a normal rich-text flow
  // (paragraph → Enter → `- ` → text) never persists that implementation
  // detail or loses the new list item's structural boundary on its next edit.
  const previous = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(String(previousCanonical || ''))
  )
  const next = normalizeOrderedListDelimiters(
    normalizeEmptyListItems(String(nextCanonical || ''))
  )
  if (previous === next) return { markdown: sourceMarkdown, preserved: true, reason: 'unchanged' }
  if (!previous) {
    if (!sourceMarkdown) {
      return {
        // An empty source has no pre-existing escape spelling to protect. This
        // is the same all-new authoring boundary as generatedScratchMarkdown.
        markdown: canonicalFreshTextToSource(
          normalizeEmptyTableCells(compactGeneratedListSpacing(withoutStandaloneEmptyBlockLines(next)))
        ),
        preserved: true,
        reason: 'new-document'
      }
    }
    return { markdown: sourceMarkdown, preserved: false, reason: 'missing-baseline' }
  }
  // Full-document deletion in the rich editor: the canonical became empty.
  // This is unambiguous — everything the user saw was removed — so no
  // localized mapping is needed. Without this branch a diverged source
  // (authored `-` vs canonical `*`, mid-line `* `, HTML entities, ...) fails
  // every mapping closed and resurrects the old content in source mode, in
  // saves, and after a reopen. An emptied document must serialize as empty.
  if (!next) {
    return { markdown: '', preserved: true, reason: 'document-emptied' }
  }

  const trailingEmptyBlockquoteParagraphCreated = preserveCreatedTrailingEmptyBlockquoteParagraph({
    source: sourceMarkdown,
    previous,
    next
  })
  if (trailingEmptyBlockquoteParagraphCreated) return trailingEmptyBlockquoteParagraphCreated

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  const { start, previousEnd, nextEnd } = commonChange(previous, next)
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  const removedEmptyParagraphBeforeFence = preserveRemovedEmptyParagraphBeforeFence({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (removedEmptyParagraphBeforeFence) return removedEmptyParagraphBeforeFence
  const removedEmptyBlockquote = preserveRemovedEmptyBlockquote({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (removedEmptyBlockquote) return removedEmptyBlockquote
  const escapedStandaloneThematicBreak = preserveEscapedStandaloneThematicBreakInputRule({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (escapedStandaloneThematicBreak) return escapedStandaloneThematicBreak

  const emptiedEscapedLiteralLine = preserveEmptiedEscapedLiteralLine({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptiedEscapedLiteralLine) {
    return reclassifyTrailingListItemParagraphEmptied({
      result: emptiedEscapedLiteralLine,
      previous: rawPrevious,
      next: rawNext
    })
  }
  const emptiedParagraphPreserved = preserveEmptiedParagraph({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptiedParagraphPreserved) {
    return reclassifyTrailingListItemParagraphEmptied({
      result: emptiedParagraphPreserved,
      previous: rawPrevious,
      next: rawNext
    })
  }
  // Crepe's cached Markdown and direct ProseMirror serialization can disagree
  // about *only* the number of terminal newlines. That is not a user edit.
  // In particular, treating it as a structural deletion on a list rewrites a
  // no-op rich→source switch and drops the author's final blank line.
  const withoutTrailingLineEndings = (value) => value.replace(/(?:\r\n|\r|\n)+$/, '')
  if (withoutTrailingLineEndings(previous) === withoutTrailingLineEndings(next)) {
    return { markdown: sourceMarkdown, preserved: true, reason: 'canonical-trailing-newline-drift' }
  }
  // When the canonical differs only in blank-line placement between list items
  // (loose vs compact), no visible content changed: Crepe re-serialized the
  // same authored document. The source's authored spacing must win, not the
  // serializer's latest formatting choice.
  if (compactGeneratedListSpacing(previous) === compactGeneratedListSpacing(next)) {
    return { markdown: sourceMarkdown, preserved: true, reason: 'formatting-only-drift' }
  }
  const trailingEmptyPreserved = preserveTrailingEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (trailingEmptyPreserved) return trailingEmptyPreserved
  // Display math and fenced code content each have a dedicated source boundary.
  // Resolve them before the generic middle-block mapper, which otherwise treats
  // their first content row as a paragraph insertion and can move/add bytes
  // around the closing delimiter.
  const displayMathPreserved = preserveDisplayMathBlockTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start
  })
  if (displayMathPreserved) return displayMathPreserved
  const fencedCodePreserved = preserveFencedCodeBlockTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start
  })
  if (fencedCodePreserved) return fencedCodePreserved
  const middleEmptyPreserved = preserveMiddleEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (middleEmptyPreserved) return middleEmptyPreserved
  // A trailing empty ProseMirror paragraph can serialize as canonical terminal
  // padding rather than `<br />`. Typing into it is therefore a pure append at
  // `previous.length`, even when an earlier `- - text` or escaped literal has
  // already made source/canonical visible streams diverge. Prove and append it
  // before ordinal visible-offset fallbacks can mistake a repeated empty quote
  // row for the insertion point.
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
  // Enter can split an existing paragraph even when an earlier part of the
  // document has a permanent source/canonical visible-stream divergence. Own
  // this zero-visible structural transaction before the divergent list/text
  // fallbacks; the helper inserts only the proven separator at the unique raw
  // text boundary and never rewrites surrounding Markdown.
  const paragraphSplit = preserveParagraphSplit({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (paragraphSplit) return paragraphSplit
  // A real block appended at the document tail must keep its raw paragraph
  // boundary before generic list reconciliation. This is equally true when
  // source/canonical visible streams still match: a trailing empty paragraph
  // (`<br />`) can otherwise make the list batch mapper collapse
  // `ordered-list + blank line + bullet-list` into adjacent rows.
  const tailBlockAppend = preserveDivergedTailBlockAppend({
    source: sourceMarkdown,
    previous,
    next,
    start,
    nextEnd
  })
  if (tailBlockAppend) return tailBlockAppend
  // Exact same-count row/gap skeletons are the strongest list proof: apply
  // their item-text delta before broad multi-list reconciliation. This keeps
  // serializer-only escapes (`1\.`) and untouched marker/spacing differences
  // local instead of replacing canonical list blocks wholesale.
  const stableListRowsPreserved = preserveStableListRowChanges({
    source: sourceMarkdown,
    previous,
    next
  })
  if (stableListRowsPreserved) return stableListRowsPreserved
  // RS-72: only the new single-empty ordered Backspace proof must run before
  // broad multi-list reconciliation. Keep the older double-empty transient
  // helper at its original later dispatcher position so its established
  // authored blank-line behavior is unchanged.
  const singleEmptyOrderedBackspaceLift = preserveSingleEmptyOrderedBackspaceLift({
    source: sourceMarkdown,
    previous,
    next
  })
  if (singleEmptyOrderedBackspaceLift) return singleEmptyOrderedBackspaceLift
  // A deferred callback can structurally change more than one independently-
  // authored list. Reconcile those proven multi-list batches before any
  // one-list shortcut is allowed to return.
  const earlyMultiListPreserved = preserveBatchedListBlockChanges({
    source: sourceMarkdown,
    previous,
    next,
    requireMultiple: true
  })
  if (earlyMultiListPreserved) return earlyMultiListPreserved
  const emptyListItemTextPreserved = preserveEmptyListItemTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptyListItemTextPreserved) return emptyListItemTextPreserved
  const tableTextPreserved = preserveTableTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (tableTextPreserved) return tableTextPreserved
  // A table row/column operation is structurally local even when an earlier
  // list, quote, or table has different authored spacing from the canonical
  // serializer. Handle it before the document-wide visible-stream divergence
  // gate; otherwise a perfectly identifiable column deletion is rejected by a
  // mismatch elsewhere in the document and the old authored column survives
  // save/source switching.
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
  if (sourceVisible.text !== previousVisible.text) {
    // RS-76: source-owned U+200B leading-space syntax is invisible while the
    // row has text, but becomes real parsed content if left behind after the
    // body is deleted to spaces-only. Prove and patch this exact tail-row edit
    // before global visible divergence is allowed to block it.
    const leadingSpaceListWhitespaceTail = preserveDivergedLeadingSpaceListWhitespaceTail({
      source: sourceMarkdown,
      previous,
      next
    })
    if (leadingSpaceListWhitespaceTail) return leadingSpaceListWhitespaceTail

    // RS-78: the source/canonical document may already be globally diverged,
    // while the user only empties the body of the existing final bullet item.
    // Prove the entire final-row transition before any broad visible mapper can
    // guess, and preserve the authored bullet token/spacing byte-for-byte.
    const divergedTailBulletBodyEmptied = preserveDivergedTailBulletBodyEmptied({
      source: sourceMarkdown,
      previous,
      next
    })
    if (divergedTailBulletBodyEmptied) return divergedTailBulletBodyEmptied

    // RS-73: the rich editor can delete a final image atom that canonical has
    // attached to a nested list even though the authored image row remains
    // top-level. The image has no visible characters, so own this exact row
    // deletion before any visible-stream mapper is allowed to guess.
    const divergedTailImageDelete = preserveDivergedTailImageDelete({
      source: sourceMarkdown,
      previous,
      next
    })
    if (divergedTailImageDelete) return divergedTailImageDelete

    // RS-50 is a deliberately source-owned empty-task sentinel lifecycle. It
    // must run before the broader diverged-list fallbacks, which can otherwise
    // accept the task row first and leave U+200B after newly typed body text.
    // Do NOT move the generic diverged-block mapper here: only the dedicated
    // sentinel-fill proof may bypass the established list fallback ordering.
    const emptyTaskSentinelFill = preserveDivergedBlockTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (emptyTaskSentinelFill?.reason === 'empty-task-sentinel-filled') {
      return emptyTaskSentinelFill
    }

    // remark parses `- 1. 甲乙` as a nested ordered list, so the canonical
    // visible stream drops the `1. ` item text while the authored source
    // keeps it — the whole document's visible stream diverges and any
    // list-internal text edit fails every localized mapper below, falling
    // back to the OLD source (the user's typing silently vanishes). Anchor
    // the canonical list tree's visible text in the source and map the
    // tree-local diff back to the authored raw range. This must run BEFORE
    // the generic locally-aligned/line-region mappers: on a diverged document
    // those can map a zero-width insertion onto the wrong visible position and
    // persist corrupted rows (`- 1.  3. 戊\n 甲乙`) into the authored list.
    // The strict preconditions here (list tree + unique visible anchor) make
    // this a no-op for every non-list divergence (e.g. mid-line `* `).
    // One deferred callback may contain both a list edit and a second edit in
    // the adjacent paragraph (continue a persisted list, exit it, then type
    // prose). Map the proven list tree first, then recursively map the
    // remaining canonical delta against that updated baseline. Publication is
    // atomic: if the remainder is not independently proven, discard the
    // partial result and keep the original authored source.
    const divergedContinuation = preserveDivergedListContinuation({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (divergedContinuation) return divergedContinuation
    const firstListChange = preserveDivergedNestedListChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    }) || preserveBatchedListBlockChanges({
      source: sourceMarkdown,
      previous,
      next,
      allowPartial: true
    })
    if (firstListChange?.nextBaseline === next) return firstListChange
    if (
      firstListChange?.nextBaseline &&
      firstListChange.nextBaseline !== previous &&
      firstListChange.nextBaseline !== next
    ) {
      const remainderChange = commonChange(firstListChange.nextBaseline, next)
      const remainderReplacement = next.slice(remainderChange.start, remainderChange.nextEnd)
      const remainderArgs = {
        source: firstListChange.markdown,
        previous: firstListChange.nextBaseline,
        next,
        ...remainderChange
      }
      // Deliberately compose only an adjacent empty-paragraph fill/append.
      // Broader recursion would also accept an unrelated heading/list
      // structure change after mapping only the first list, violating the
      // atomic fail-closed contract.
      const remainder = preserveMiddleEmptyBlock(remainderArgs) ||
        preserveTrailingEmptyBlock(remainderArgs) ||
        preserveAppendedParagraph({
          ...remainderArgs,
          replacementVisible: sourceVisibleIndex(remainderReplacement).text
        })
      if (remainder && remainder.preserved !== false) {
        return {
          ...remainder,
          reason: `composite-${firstListChange.reason}+${remainder.reason}`
        }
      }
    }
    const divergedList = preserveAllDivergedListChanges({
      source: sourceMarkdown,
      previous,
      next
    })
    if (divergedList) return divergedList
    const locallyAligned = preserveLocallyAlignedTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (locallyAligned) return locallyAligned
    const uniquelyAnchored = preserveUniquelyAnchoredTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (uniquelyAnchored) return uniquelyAnchored
    const linesPreserved = preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'visible-mismatch-line-change'
    })
    if (linesPreserved) return linesPreserved
    // A diverged visible stream defeats both mappings above. If the edit is a
    // single-canonical-block text change whose block occurs exactly once in
    // the authored source, apply the block delta so deletions are not
    // silently rolled back. Anything ambiguous keeps the fail-closed source.
    const divergedBlock = preserveDivergedBlockTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (divergedBlock) return divergedBlock
    // A deletion spanning several canonical blocks (whole tail, rows from
    // several list trees) still fails every mapper above. Anchor the
    // canonical's pre-deletion visible context in the authored source and
    // delete the mapped raw range; the deleted raw text is verified to match
    // the canonical deletion after marker stripping.
    const visibleDelete = preserveDivergedVisibleDelete({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (visibleDelete) return visibleDelete
    return { markdown: sourceMarkdown, preserved: false, reason: 'visible-stream-mismatch' }
  }
  const listStructureChanged = hasListStructureChange({
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (listStructureChanged) {
    // A deferred markdownUpdated can batch edits across several independently
    // authored lists (fill the previous empty item, create an empty item in the
    // next list, delete from a third). A single-list mapper can validly update
    // only one of those blocks and return early, silently dropping the others.
    // Reconcile all changed top-level list blocks first only when at least two
    // replacements are proven; ordinary one-list edits keep their specialized
    // path below.
    const multiListPreserved = preserveBatchedListBlockChanges({
      source: sourceMarkdown,
      previous,
      next,
      requireMultiple: true
    })
    if (multiListPreserved) return multiListPreserved
    const listPreserved = preserveListBlockChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (listPreserved) {
      const repaired = repairMergedListItems(listPreserved.markdown, next)
      return repaired !== listPreserved.markdown
        ? { ...listPreserved, markdown: repaired, reason: 'list-merge-repaired' }
        : listPreserved
    }
    const batchedListPreserved = preserveBatchedListBlockChanges({
      source: sourceMarkdown,
      previous,
      next
    })
    if (batchedListPreserved) return batchedListPreserved
    const linesPreserved = preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'list-line-change'
    })
    if (linesPreserved) {
      const repaired = repairMergedListItems(linesPreserved.markdown, next)
      return repaired !== linesPreserved.markdown
        ? { ...linesPreserved, markdown: repaired, reason: 'list-merge-repaired' }
        : linesPreserved
    }
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
  const trailingExactLine = preserveTrailingExactLineChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (trailingExactLine) return trailingExactLine
  if (sourceMarkdown === previous) {
    const translatedReplacement = canonicalFreshTextToSource(next.slice(start, nextEnd))
    return {
      markdown: withoutStandaloneEmptyBlockLines(normalizeEmptyTableCells(
        sourceMarkdown.slice(0, start) +
          translatedReplacement +
          sourceMarkdown.slice(previousEnd)
      )),
      preserved: true,
      reason: 'exact-canonical-baseline'
    }
  }

  const ordinalLinePreserved = preserveOrdinalLineTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (ordinalLinePreserved) return ordinalLinePreserved

  // Enter in a list is emitted as an empty-item transaction followed by text.
  // Reapply the bounded list tree instead of mapping that zero-width span past
  // the list into the following paragraph.
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

  if (startVisible.visibleIndex === endVisible.visibleIndex && !replacementVisible) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'structural-line-change',
      transformReplacement: withoutStandaloneEmptyBlockLines
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-structural-change' }
  }

  let rawStart = rawOffsetAtVisible(sourceMarkdown, startVisible)
  let rawEnd = rawOffsetAtVisible(sourceMarkdown, endVisible)
  if (
    start === previousEnd &&
    startVisible.visibleIndex === endVisible.visibleIndex &&
    replacementVisible
  ) {
    const lineEndInsertion = rawInsertionAtCanonicalLineEnd({
      source: sourceMarkdown,
      previous,
      canonicalOffset: start,
      mappedSourceOffset: rawStart,
      sourceVisibleMap: sourceVisible.map
    })
    if (Number.isFinite(lineEndInsertion)) {
      rawStart = lineEndInsertion
      rawEnd = lineEndInsertion
    }
  }
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

  // RS-59: Markdown block separators have zero width in the visible stream.
  // When a standalone escaped punctuation paragraph (`\\-`) is extended into
  // ordinary text (`-【】`) while source/canonical already differ elsewhere,
  // backward affinity can map the changed line's visible boundary to the end of
  // the previous source paragraph. Patching that raw range glues sibling blocks
  // together (`哈哈；-【】`). This fallback claims to edit one existing source
  // line, so require the mapped source line to have the same visible identity as
  // the canonical line being edited. If not, let the established line-region
  // mapper use row/block context instead of trusting the ambiguous zero-width
  // boundary. Empty canonical lines keep their dedicated placeholder handlers.
  const previousMappedLine = lineAt(previous, start)
  const sourceMappedLine = lineAt(sourceMarkdown, rawStart)
  // Reuse the full-document visible indexes above instead of re-indexing an
  // isolated line. Reference links are the critical example: `[shortcut]` is
  // visible text only because a definition elsewhere in the document proves
  // that syntax. Slicing the line first loses that definition and makes a
  // legitimate source line appear different from canonical's inline-link form.
  const visibleTextInRawLine = (visibleIndex, line) => {
    let text = ''
    for (let index = 0; index < visibleIndex.map.length; index += 1) {
      const rawOffset = visibleIndex.map[index]
      if (rawOffset < line.start) continue
      if (rawOffset >= line.end) break
      text += visibleIndex.text[index]
    }
    return text
  }
  const previousMappedLineVisible = visibleTextInRawLine(previousVisible, previousMappedLine)
  const sourceMappedLineVisible = visibleTextInRawLine(sourceVisible, sourceMappedLine)
  if (previousMappedLineVisible && sourceMappedLineVisible !== previousMappedLineVisible) {
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
    markdown: withoutStandaloneEmptyBlockLines(
      sourceMarkdown.slice(0, rawStart) +
        adaptCanonicalRegionToSource(replacement, sourceMarkdown, { start: rawStart, end: rawEnd }) +
        sourceMarkdown.slice(rawEnd)
    ),
    preserved: true,
    reason: 'localized-change'
  }
}
