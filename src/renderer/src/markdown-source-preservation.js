import {
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from './mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  canonicalTextToSource,
  commonChange,
  rawInsertionAtCanonicalLineEnd,
  rawOffsetAtVisible
} from './lib/markdown-preservation/core.js'
import {
  hasEmptyListItem,
  hasListStructureChange,
  listBlockAt,
  compactGeneratedListSpacing,
  normalizeEmptyListItems,
  preserveBatchedListBlockChanges,
  preserveDivergedNestedListChange,
  preserveEmptyListItemTextChange,
  preserveListBlockChange,
  preserveStableListRowChanges,
  preserveTypedBulletInputRule,
  repairMergedListItems
} from './lib/markdown-preservation/lists.js'
import {
  capOutputTrailingNewlines,
  preserveAppendedParagraph,
  preserveEmptiedParagraph,
  preserveMiddleEmptyBlock,
  preserveTrailingExactLineChange,
  preserveTrailingEmptyBlock,
  withoutStandaloneEmptyBlockLines
} from './lib/markdown-preservation/paragraphs.js'
import {
  hasStructuralPrefixChange,
  preserveDivergedBlockTextChange,
  preserveDivergedVisibleDelete,
  preserveChangedLineRegion,
  preserveLocallyAlignedTextChange
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
  preserveTypedBulletInputRule,
  preserveGeneratedBulletMarkers,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from './lib/markdown-preservation/lists.js'

export const generatedScratchMarkdown = (canonical) => {
  // A brand-new document is authored entirely by rich typing; its canonical is
  // the only structural source. Milkdown may terminate the serialization with
  // an extra blank line (or the skeleton's empty-paragraph `<br />`). Neither
  // is authored content, so the generated source ends with exactly one final
  // newline — never a phantom trailing blank line.
  return canonicalTextToSource(
    compactGeneratedListSpacing(
      withoutStandaloneEmptyBlockLines(
        normalizeEmptyListItems(normalizeEmptyTableCells(canonical))
      )
    )
  ).replace(/\r?\n+$/, '\n')
}

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying only the serializer's
// localized delta. Structural edits are bounded to a list, table, or touched
// lines; an ambiguous mapping keeps the authored source instead of normalizing
// the complete document.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical) {
  const sourceMarkdown = String(source || '')
  const result = preserveRichMarkdownSourceCore(sourceMarkdown, previousCanonical, nextCanonical)
  // Hard boundary invariant: an internal empty-paragraph `<br />` placeholder
  // must NEVER reach authored source, no matter which heuristic path produced
  // the result. Enforce it here as a post-condition on every output, so a
  // future path with a too-strict guard cannot leak the serializer's internal
  // representation again (this is what the empty-paragraph/visible-stream
  // bugs kept tripping over). Table-cell and inline `text<br>text` breaks are
  // not standalone lines and stay untouched.
  if (result && result.markdown != null) {
    const withoutPlaceholders = withoutStandaloneEmptyBlockLines(result.markdown)
    // Crepe may append a serializer blank line after the last edited block; the
    // file's terminal line-ending run is authored formatting and must not grow.
    result.markdown = capOutputTrailingNewlines(withoutPlaceholders, sourceMarkdown)
  }
  return result
}

const preserveAllDivergedListChanges = ({ source, previous, next }) => {
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
  // Empty list items have a Crepe-only `<br />` placeholder. Normalize it on
  // both sides of the delta before source mapping so a normal rich-text flow
  // (paragraph → Enter → `- ` → text) never persists that implementation
  // detail or loses the new list item's structural boundary on its next edit.
  const previous = normalizeEmptyListItems(String(previousCanonical || ''))
  const next = normalizeEmptyListItems(String(nextCanonical || ''))
  if (previous === next) return { markdown: sourceMarkdown, preserved: true, reason: 'unchanged' }
  if (!previous) {
    if (!sourceMarkdown) {
      return {
        markdown: canonicalTextToSource(
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

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  const { start, previousEnd, nextEnd } = commonChange(previous, next)
  const emptiedParagraphPreserved = preserveEmptiedParagraph({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptiedParagraphPreserved) return emptiedParagraphPreserved
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
  const middleEmptyPreserved = preserveMiddleEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (middleEmptyPreserved) return middleEmptyPreserved
  // A deferred callback can fill an empty item in one list while also changing
  // another independently-authored list. The single empty-item helper below
  // sees only the first list and can merge neighbouring `-`, `+`, and `*`
  // blocks into one canonical style. Reconcile proven multi-list batches before
  // any one-list shortcut is allowed to return.
  const earlyMultiListPreserved = preserveBatchedListBlockChanges({
    source: sourceMarkdown,
    previous,
    next,
    requireMultiple: true
  })
  if (earlyMultiListPreserved) return earlyMultiListPreserved
  const stableListRowsPreserved = preserveStableListRowChanges({
    source: sourceMarkdown,
    previous,
    next
  })
  if (stableListRowsPreserved) return stableListRowsPreserved
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
  if (sourceVisible.text !== previousVisible.text) {
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
    return {
      markdown: canonicalTextToSource(
        withoutStandaloneEmptyBlockLines(normalizeEmptyTableCells(next))
      ),
      preserved: true,
      reason: 'exact-canonical-baseline'
    }
  }

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
