import {
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from './mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
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
  preserveEmptyListItemTextChange,
  preserveListBlockChange,
  preserveTypedBulletInputRule,
  repairMergedListItems
} from './lib/markdown-preservation/lists.js'
import {
  preserveAppendedParagraph,
  preserveEmptiedParagraph,
  preserveMiddleEmptyBlock,
  preserveTrailingExactLineChange,
  preserveTrailingEmptyBlock,
  withoutStandaloneEmptyBlockLines
} from './lib/markdown-preservation/paragraphs.js'
import {
  hasStructuralPrefixChange,
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

export const generatedScratchMarkdown = (canonical) =>
  compactGeneratedListSpacing(
    withoutStandaloneEmptyBlockLines(normalizeEmptyTableCells(canonical))
  )

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying only the serializer's
// localized delta. Structural edits are bounded to a list, table, or touched
// lines; an ambiguous mapping keeps the authored source instead of normalizing
// the complete document.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical) {
  const sourceMarkdown = String(source || '')
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
        markdown: normalizeEmptyTableCells(compactGeneratedListSpacing(withoutStandaloneEmptyBlockLines(next))),
        preserved: true,
        reason: 'new-document'
      }
    }
    return { markdown: sourceMarkdown, preserved: false, reason: 'missing-baseline' }
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
    const locallyAligned = preserveLocallyAlignedTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (locallyAligned) return locallyAligned
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
      markdown: withoutStandaloneEmptyBlockLines(normalizeEmptyTableCells(next)),
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
