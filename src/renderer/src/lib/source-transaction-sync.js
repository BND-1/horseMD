// Transaction-first source synchronization for edits whose raw ownership can
// be proven without serializing/reformatting the whole Markdown document.
//
// This is deliberately narrower than the canonical preservation fallback:
// only plain-text ReplaceStep edits inside one unmarked textblock are accepted.
// Every transaction batch is atomic. If one step is structural, marked, or
// cannot be mapped byte-for-byte, the caller keeps the authored source intact
// and lets the existing fail-closed preservation path handle the batch.

const unsafeInlineSyntax = /[`*_{}\[\]<>#|\\]/
const unsafeAtBlockStart = /^(?:[-+>]|\d+[.)])/u
const leadingSpaceSentinel = '\u200B'

const plainSliceText = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return ''
  if (slice.openStart || slice.openEnd) return null
  let text = ''
  let valid = true
  slice.content.forEach((node) => {
    if (!node?.isText || node.marks?.length) {
      valid = false
      return
    }
    text += node.text || ''
  })
  if (!valid || /[\r\n]/.test(text)) return null
  return text
}

const isPlainTextblock = (node) => {
  if (!node?.isTextblock) return false
  let valid = true
  node.forEach((child) => {
    if (!child?.isText || child.marks?.length) valid = false
  })
  return valid
}

const isPlainTopLevelSplit = (step, $from, $to) => {
  if (!step?.structure || step.from !== step.to) return false
  if (!$from.sameParent($to) || $from.depth !== 1 || !isPlainTextblock($from.parent)) return false
  const slice = step.slice
  if (!slice || slice.openStart !== 1 || slice.openEnd !== 1 || slice.content?.childCount !== 2) {
    return false
  }
  let valid = true
  slice.content.forEach((node) => {
    if (!node?.isTextblock) valid = false
  })
  return valid
}

const sameDocument = (left, right) => {
  if (!left || !right) return false
  if (typeof left.eq === 'function') return left.eq(right)
  return left === right
}

const documentLineEnding = (source) => {
  const hasCrLf = source.includes('\r\n')
  const withoutCrLf = source.replace(/\r\n/g, '')
  const hasLoneLf = withoutCrLf.includes('\n')
  const hasLoneCr = withoutCrLf.includes('\r')
  const kinds = (hasCrLf ? 1 : 0) + (hasLoneLf ? 1 : 0) + (hasLoneCr ? 1 : 0)
  if (kinds > 1) return null
  if (hasCrLf) return '\r\n'
  if (hasLoneCr) return '\r'
  return '\n'
}

// A whole-document replacement is authoritative only when the pre-transaction
// selection itself covered the complete ProseMirror document. This excludes
// input rules that happen to structurally replace the sole top-level block.
export const isWholeDocumentReplacementBatch = ({
  transactions,
  oldState,
  newState
}) => {
  const oldDoc = oldState?.doc
  const selection = oldState?.selection
  if (
    !oldDoc ||
    !selection ||
    selection.from > 0 ||
    selection.to < oldDoc.content.size
  ) {
    return false
  }
  const changed = (transactions || []).filter((transaction) => transaction?.docChanged)
  if (changed.length !== 1) return false
  const transaction = changed[0]
  if (
    !sameDocument(transaction.before, oldDoc) ||
    !sameDocument(transaction.doc, newState?.doc) ||
    transaction.steps?.length !== 1
  ) {
    return false
  }
  const step = transaction.steps[0]
  return (
    step?.constructor?.name === 'ReplaceStep' &&
    step.from === 0 &&
    step.to === oldDoc.content.size
  )
}

// Once the complete old document was selected, its per-block Markdown spelling
// no longer has surviving ownership. Keep only the file-level format that still
// belongs to the document: BOM and a uniform line-ending convention.
export const formatWholeDocumentReplacementSource = ({
  canonical,
  previousSource
}) => {
  const previous = String(previousSource || '')
  let markdown = String(canonical || '').replace(/^\uFEFF/, '')
  if (!markdown) return ''
  const lineEnding = documentLineEnding(previous.replace(/^\uFEFF/, ''))
  if (lineEnding && lineEnding !== '\n') {
    markdown = markdown.replace(/\r\n|\r|\n/g, lineEnding)
  }
  return `${previous.charCodeAt(0) === 0xFEFF ? '\uFEFF' : ''}${markdown}`
}

const leadingLineEndingCount = (source, lineEnding) => {
  let count = 0
  let offset = 0
  while (source.startsWith(lineEnding, offset)) {
    count += 1
    offset += lineEnding.length
  }
  return count
}

// A mapping view keeps one byte-for-byte normalized copy (BOM stripped, every
// line ending reduced to a single `\n`) plus the original authored bytes.
// remark/Pm coordinates are only exact against the normalized copy; every raw
// proof happens there. Edits are applied to both copies simultaneously so the
// final source keeps the author's BOM/CRLF spelling byte-for-byte.
const createMappingView = (original) => {
  let text = ''
  const toRaw = []
  let index = 0
  if (original.charCodeAt(0) === 0xFEFF) index = 1
  while (index < original.length) {
    const code = original.charCodeAt(index)
    if (code === 13) {
      toRaw.push(index)
      text += '\n'
      index += original.charCodeAt(index + 1) === 10 ? 2 : 1
    } else {
      toRaw.push(index)
      text += original[index]
      index += 1
    }
  }
  toRaw.push(original.length)
  return { text, toRaw, original }
}

// Original raw offset -> normalized position. toRaw is monotonically
// increasing, so this is a binary search for the owning normalized slot.
const normalizedFromRaw = (toRaw, rawOffset) => {
  if (!Number.isFinite(rawOffset) || rawOffset < 0) return null
  const max = toRaw[toRaw.length - 1]
  if (rawOffset > max) return null
  let low = 0
  let high = toRaw.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (toRaw[mid] <= rawOffset) low = mid
    else high = mid - 1
  }
  return low
}

// Apply a normalized-coordinate edit to both copies of the mapping view.
// `lineEnding` converts authored separators only for structural splits;
// plain text insertions never contain a newline.
const applyViewEdit = (view, from, to, text, lineEnding = null) => {
  const origFrom = view.toRaw[from]
  const origTo = view.toRaw[to]
  if (!Number.isFinite(origFrom) || !Number.isFinite(origTo)) {
    return { ok: false }
  }
  const origText = lineEnding && text.includes('\n')
    ? text.replace(/\n/g, lineEnding)
    : text
  view.text = view.text.slice(0, from) + text + view.text.slice(to)
  view.original = view.original.slice(0, origFrom) + origText + view.original.slice(origTo)
  const delta = origText.length - (origTo - origFrom)
  // `toRaw` maps normalized BOUNDARIES, not characters. Preserve the boundary
  // at `from`, append one boundary after every inserted normalized character,
  // then shift untouched boundaries after `to`. The previous implementation
  // dropped the insertion-start boundary, so a second transaction in the same
  // journal mapped one character to the right and could consume the terminal
  // newline. Structural newline insertions use the authored EOL width here.
  const next = view.toRaw.slice(0, from + 1)
  let insertedRawOffset = origFrom
  for (let index = 0; index < text.length; index += 1) {
    insertedRawOffset += lineEnding && text[index] === '\n'
      ? lineEnding.length
      : 1
    next.push(insertedRawOffset)
  }
  for (let i = to + 1; i < view.toRaw.length; i += 1) {
    const value = view.toRaw[i]
    next.push(value == null ? null : value + delta)
  }
  view.toRaw = next
  return { ok: true, origFrom, origTo, origText }
}

const diagnostic = (value) => {
  if (!Array.isArray(globalThis.__hmSourceTransactionLog)) return
  globalThis.__hmSourceTransactionLog.push(value)
  if (globalThis.__hmSourceTransactionLog.length > 200) {
    globalThis.__hmSourceTransactionLog.shift()
  }
}

const semanticJson = (node, {
  ignoreTrailingEmptyListItemParagraph = false,
  ignoreTrailingEmptyListItemParagraphAfterNestedStructure = false,
  ignoreTrailingEmptyBlockquoteParagraph = false,
  ignoreTrailingEmptyListItemPaths = [],
  ignoreTableColumnWidthPaths = []
} = {}) => {
  if (!node?.toJSON) return null
  const ignoredTableColumnWidthPaths = new Set(
    (Array.isArray(ignoreTableColumnWidthPaths) ? ignoreTableColumnWidthPaths : [])
      .filter((path) =>
        Array.isArray(path) &&
        path.length >= 3 &&
        path.every((index) => Number.isInteger(index) && index >= 0)
      )
      .map((path) => path.join('.'))
  )
  const ignoredTrailingEmptyListItemPaths = new Set(
    (Array.isArray(ignoreTrailingEmptyListItemPaths) ? ignoreTrailingEmptyListItemPaths : [])
      .filter((path) =>
        Array.isArray(path) &&
        path.length >= 2 &&
        path.every((index) => Number.isInteger(index) && index >= 0)
      )
      .map((path) => path.join('.'))
  )
  const visit = (value, path = []) => {
    if (!value || typeof value !== 'object') return value
    const next = { ...value }
    if (next.attrs) {
      next.attrs = { ...next.attrs }
      if (next.type === 'heading') {
        // Heading ids are derived by the live editor and regenerated after
        // parse; they are not authored Markdown semantics.
        delete next.attrs.id
      }
      if (next.type === 'bullet_list' || next.type === 'ordered_list') {
        // Milkdown uses both booleans and string values for this internal
        // layout attribute depending on whether the list came from parsing or
        // an input rule. Blank-line layout is already represented by Markdown
        // spacing and must not make a valid source candidate fail integrity.
        delete next.attrs.spread
      }
      if (next.type === 'list_item') {
        // Marker spelling and the derived list type are preserved by the raw
        // source mapper, not by semantic document identity. `checked` remains
        // because task-list state is authored meaning.
        delete next.attrs.label
        delete next.attrs.listType
        delete next.attrs.spread
      }
      if (
        (next.type === 'table_cell' || next.type === 'table_header') &&
        ignoredTableColumnWidthPaths.has(path.join('.'))
      ) {
        // GFM Markdown has no syntax for editor-only column widths. A focused
        // transaction owner may bind the exact affected cell paths and ask the
        // semantic comparator to ignore ONLY `colwidth` at those paths. All
        // content, alignment, span attrs, siblings and table topology remain
        // strict; default callers never receive this relaxation.
        delete next.attrs.colwidth
      }
      if (!Object.keys(next.attrs).length) delete next.attrs
    }
    if (Array.isArray(next.content)) {
      next.content = next.content.map((child, index) => visit(child, [...path, index]))
    }
    if (
      next.type === 'paragraph' &&
      Array.isArray(next.content) &&
      next.content.every((child) =>
        child?.type === 'hardbreak' || child?.type === 'hard_break'
      )
    ) {
      // A standalone hardbreak is Crepe's internal placeholder for an empty
      // paragraph/cell. Milkdown schemas have used both `hardbreak` and
      // `hard_break`; neither spelling carries authored text when it is the
      // paragraph's entire content. Inline breaks surrounded by text remain
      // structurally strict.
      delete next.content
    }
    if (next.type === 'list_item' && Array.isArray(next.content)) {
      const ignoreTrailingEmptyAtOwnedPath =
        ignoredTrailingEmptyListItemPaths.has(path.join('.'))
      // Backspace on an empty list item briefly leaves TWO consecutive empty
      // paragraphs in the preceding item: the real empty item paragraph plus a
      // Crepe-only hardbreak placeholder for the lifted row. Markdown cannot
      // encode the multiplicity of empty paragraphs inside a list item without
      // leaking `<br />`. Collapse only consecutive empty paragraphs to one;
      // every non-empty paragraph/list/quote child remains structurally strict.
      let trailingEmptyParagraphs = 0
      for (let index = next.content.length - 1; index >= 0; index -= 1) {
        const child = next.content[index]
        if (child?.type !== 'paragraph' || child?.content?.length) break
        trailingEmptyParagraphs += 1
      }
      const compact = []
      for (const child of next.content) {
        const emptyParagraph = child?.type === 'paragraph' && !child?.content?.length
        const previousChild = compact.at(-1)
        const previousEmpty = previousChild?.type === 'paragraph' && !previousChild?.content?.length
        if (emptyParagraph && previousEmpty) continue
        compact.push(child)
      }
      // Deleting one EMPTY bullet with Backspace can leave exactly one
      // editor-owned empty paragraph after the preceding non-empty paragraph.
      // Authored Markdown has no distinct source bytes for that transient. The
      // generic RS-51 path accepts it only after a text paragraph. RS-63 adds a
      // separate opt-in for the stricter case where raw preservation proved the
      // removed top-level row merged after a nested list inside the same item.
      if (
        (
          ignoreTrailingEmptyListItemParagraph ||
          ignoreTrailingEmptyListItemParagraphAfterNestedStructure ||
          ignoreTrailingEmptyAtOwnedPath
        ) &&
        trailingEmptyParagraphs === 1 &&
        compact.length >= 2
      ) {
        const trailing = compact.at(-1)
        const previousChild = compact.at(-2)
        const trailingEmpty = trailing?.type === 'paragraph' && !trailing?.content?.length
        const previousTextParagraph =
          previousChild?.type === 'paragraph' && Array.isArray(previousChild.content) && previousChild.content.length > 0
        const previousNestedList = previousChild?.type === 'bullet_list' || previousChild?.type === 'ordered_list'
        const hasEarlierTextParagraph = compact.slice(0, -1).some((child) =>
          child?.type === 'paragraph' && Array.isArray(child.content) && child.content.length > 0
        )
        if (
          trailingEmpty &&
          (
            (
              (ignoreTrailingEmptyListItemParagraph || ignoreTrailingEmptyAtOwnedPath) &&
              previousTextParagraph
            ) ||
            (
              ignoreTrailingEmptyListItemParagraphAfterNestedStructure &&
              previousNestedList &&
              hasEarlierTextParagraph
            )
          )
        ) compact.pop()
      }
      next.content = compact
    }
    if (
      next.type === 'blockquote' &&
      ignoreTrailingEmptyBlockquoteParagraph &&
      Array.isArray(next.content) &&
      next.content.length >= 2
    ) {
      let trailingEmptyParagraphs = 0
      for (let index = next.content.length - 1; index >= 0; index -= 1) {
        const child = next.content[index]
        if (child?.type !== 'paragraph' || child?.content?.length) break
        trailingEmptyParagraphs += 1
      }
      const trailing = next.content.at(-1)
      const previousChild = next.content.at(-2)
      const trailingEmpty = trailing?.type === 'paragraph' && !trailing?.content?.length
      const previousTextParagraph =
        previousChild?.type === 'paragraph' && Array.isArray(previousChild.content) && previousChild.content.length > 0
      if (trailingEmptyParagraphs === 1 && trailingEmpty && previousTextParagraph) {
        next.content = next.content.slice(0, -1)
      }
    }
    if (Array.isArray(next.marks)) next.marks = next.marks.map((mark) => visit(mark, path))
    return next
  }
  const result = visit(node.toJSON())
  if (result?.type === 'doc' && Array.isArray(result.content)) {
    // Blank lines are raw Markdown spacing, not parser-level paragraph nodes.
    // Crepe temporarily represents them as empty top-level paragraphs while a
    // user is typing; the parser drops those nodes on reopen. Their exact byte
    // count is protected by source slots/hints, so semantic comparison ignores
    // only these top-level empty paragraphs (never nested quote/list content).
    result.content = result.content.filter((child) => !(
      child?.type === 'paragraph' && !child?.content?.length
    ))

    // Markdown parsers intentionally merge adjacent same-kind lists even when
    // the authored source has a blank line between them. ProseMirror can keep
    // those as two separate list nodes because the empty paragraph is an
    // editor-owned structural boundary. Compare their item streams as one
    // semantic list; raw marker/spacing preservation remains responsible for
    // retaining the authored boundary and is checked by the localized mapper.
    const merged = []
    for (const child of result.content) {
      const previous = merged.at(-1)
      if (
        previous &&
        (child?.type === 'bullet_list' || child?.type === 'ordered_list') &&
        child.type === previous.type
      ) {
        previous.content = [
          ...(previous.content || []),
          ...(child.content || [])
        ]
      } else {
        merged.push(child)
      }
    }
    result.content = merged
  }
  return result
}

const emptyParagraphBeforeOrderedListCandidates = (root) => {
  const candidates = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'list_item' && Array.isArray(value.content)) {
      for (let index = 1; index < value.content.length - 1; index += 1) {
        const previousChild = value.content[index - 1]
        const emptyChild = value.content[index]
        const followingChild = value.content[index + 1]
        const previousTextParagraph =
          previousChild?.type === 'paragraph' &&
          Array.isArray(previousChild.content) &&
          previousChild.content.length > 0
        const middleEmptyParagraph =
          emptyChild?.type === 'paragraph' && !emptyChild?.content?.length
        const followingOrderedList = followingChild?.type === 'ordered_list'
        if (previousTextParagraph && middleEmptyParagraph && followingOrderedList) {
          candidates.push({ content: value.content, index })
        }
      }
    }
    if (Array.isArray(value.content)) {
      for (const child of value.content) visit(child)
    }
  }
  visit(root)
  return candidates
}

const reconcileSingleEmptyParagraphBeforeOrderedList = (left, right) => {
  const leftCandidates = emptyParagraphBeforeOrderedListCandidates(left)
  const rightCandidates = emptyParagraphBeforeOrderedListCandidates(right)
  // RS-85 is a one-sided, one-transaction transient. Fail closed when both
  // documents contain a candidate, either side contains more than one, or the
  // empty paragraph moved to a different list item. This prevents a dedicated
  // owner from masking unrelated pre-existing middle paragraphs elsewhere.
  if (leftCandidates.length === 1 && rightCandidates.length === 0) {
    leftCandidates[0].content.splice(leftCandidates[0].index, 1)
  } else if (rightCandidates.length === 1 && leftCandidates.length === 0) {
    rightCandidates[0].content.splice(rightCandidates[0].index, 1)
  }
}

const firstSemanticDifference = (left, right, path = '$') => {
  if (Object.is(left, right)) return null
  if (typeof left !== typeof right || left == null || right == null) {
    return { path, left, right }
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return { path, leftLength: left?.length, rightLength: right?.length }
    }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstSemanticDifference(left[index], right[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return null
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      const difference = firstSemanticDifference(left[key], right[key], `${path}.${key}`)
      if (difference) return difference
    }
    return null
  }
  return { path, left, right }
}

const semanticTransition = (before, after, options = {}) => {
  const left = semanticJson(before, options)
  const right = semanticJson(after, options)
  if (!left || !right || left.type !== 'doc' || right.type !== 'doc') return null
  const beforeContent = Array.isArray(left.content) ? left.content : []
  const afterContent = Array.isArray(right.content) ? right.content : []
  let prefix = 0
  while (
    prefix < beforeContent.length &&
    prefix < afterContent.length &&
    JSON.stringify(beforeContent[prefix]) === JSON.stringify(afterContent[prefix])
  ) prefix += 1
  let suffix = 0
  while (
    suffix < beforeContent.length - prefix &&
    suffix < afterContent.length - prefix &&
    JSON.stringify(beforeContent[beforeContent.length - 1 - suffix]) ===
      JSON.stringify(afterContent[afterContent.length - 1 - suffix])
  ) suffix += 1
  return {
    before: beforeContent.slice(prefix, beforeContent.length - suffix),
    after: afterContent.slice(prefix, afterContent.length - suffix)
  }
}

// Existing authored Markdown can legitimately parse to a different whole-doc
// shape than Crepe's serializer while still representing the file HorseMD
// opened. For a later LOCAL edit, prove the delta instead of requiring the two
// already-diverged end states to suddenly become identical. Both sides must
// have the exact same normalized semantic transition; callers still apply raw
// structure/list-slot guards separately.
export const areSourceDocumentTransitionsEquivalent = (
  beforeSource,
  afterSource,
  beforeExpected,
  afterExpected,
  options = {}
) => {
  const sourceTransition = semanticTransition(beforeSource, afterSource, options)
  const expectedTransition = semanticTransition(beforeExpected, afterExpected, options)
  if (!sourceTransition || !expectedTransition) return false
  return JSON.stringify(sourceTransition) === JSON.stringify(expectedTransition)
}

export const areSourceDocumentsEquivalent = (parsed, expected, options = {}) => {
  const left = semanticJson(parsed, options)
  const right = semanticJson(expected, options)
  if (!left || !right) return false
  if (options.ignoreEmptyListItemParagraphBeforeNestedStructure) {
    reconcileSingleEmptyParagraphBeforeOrderedList(left, right)
  }
  const equal = JSON.stringify(left) === JSON.stringify(right)
  if (
    !equal &&
    options.recordDifference !== false &&
    Array.isArray(globalThis.__hmSourceIntegrityDiffTrace)
  ) {
    globalThis.__hmSourceIntegrityDiffTrace.push(firstSemanticDifference(left, right))
    if (globalThis.__hmSourceIntegrityDiffTrace.length > 20) globalThis.__hmSourceIntegrityDiffTrace.shift()
  }
  return equal
}

export function mapPlainTextTransactionsToSource({
  source,
  transactions,
  oldState,
  newState,
  mapPosition,
  blockHints = [],
  validateMarkdown,
  allowEmptyTextblock = false
}) {
  const original = String(source || '')
  if (!Array.isArray(transactions) || !transactions.length) {
    return { ok: false, markdown: original, reason: 'no-transactions' }
  }
  if (typeof mapPosition !== 'function') {
    return { ok: false, markdown: original, reason: 'missing-position-mapper' }
  }

  const view = createMappingView(original)
  let markdown = view.text
  let doc = oldState?.doc
  let changed = false
  let hints = Array.isArray(blockHints)
    ? blockHints.map((hint) => ({ ...hint }))
    : []

  const fail = (reason, details = null) => {
    const result = { ok: false, markdown: original, reason }
    diagnostic({ ok: false, reason, ...(details || {}) })
    return result
  }

  if (!doc) return fail('missing-old-document')

  for (const transaction of transactions) {
    if (!transaction?.docChanged) continue
    if (!sameDocument(transaction.before, doc)) return fail('transaction-chain-mismatch')
    if (!transaction.steps?.length) return fail('changed-transaction-without-steps')

    for (let index = 0; index < transaction.steps.length; index += 1) {
      const step = transaction.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') {
        return fail(`unsupported-step-${step?.constructor?.name || 'unknown'}`)
      }
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) {
        return fail('invalid-step-range')
      }

      const stepDoc = transaction.docs?.[index] || doc
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return fail('unresolvable-step-range')
      }
      if (!$from.sameParent($to) || !isPlainTextblock($from.parent)) {
        return fail('non-plain-textblock-edit')
      }

      const blockSplit = isPlainTopLevelSplit(step, $from, $to)
      const inserted = plainSliceText(step.slice)
      if (inserted == null && !blockSplit) return fail('non-plain-inserted-slice')
      if (!blockSplit && unsafeInlineSyntax.test(inserted)) return fail('syntax-sensitive-insert')
      if (!blockSplit && $from.parentOffset === 0 && unsafeAtBlockStart.test(inserted)) {
        return fail('block-prefix-sensitive-insert')
      }
      let rawFrom
      let rawTo
      let blockHint = null
      try {
        const topBlockStart = $from.depth >= 1 ? $from.before(1) : null
        blockHint = hints.find((candidate) => candidate.pmBlockStart === topBlockStart) || null
        if (blockHint) {
          const slotStart = normalizedFromRaw(view.toRaw, blockHint.rawStart)
          if (slotStart == null) return fail('hint-raw-position-unmapped')
          rawFrom = slotStart + $from.parentOffset
          rawTo = slotStart + $to.parentOffset
        } else {
          rawFrom = mapPosition(markdown, step.from, stepDoc)
          rawTo = mapPosition(markdown, step.to, stepDoc)
        }
      } catch {
        return fail('position-mapper-threw')
      }
      if (
        !Number.isFinite(rawFrom) ||
        !Number.isFinite(rawTo)
      ) {
        return fail('unmapped-step-range')
      }
      if (rawFrom > rawTo || rawFrom < 0 || rawTo > markdown.length) {
        return fail('invalid-raw-range')
      }

      // Empty textblocks have no visible character that can prove which raw
      // Markdown blank-line slot owns them. Only a preceding structural edit
      // can establish that ownership. A generic position-map result is
      // ambiguous and previously inserted text into an adjacent paragraph.
      if ($from.parent.content.size === 0) {
        if (!blockHint) return fail('empty-block-without-source-slot')
        // An empty textblock nested inside a list item or blockquote has its
        // container marker immediately before the slot. Mapping the caret to
        // the slot would write text before the marker. List/quote structure is
        // owned by the specialized preservation paths, which keep the marker
        // position exact; the transaction mapper stays out.
        if ($from.depth > 1) return fail('nested-empty-textblock-edit')
      }

      const removed = $from.parent.textBetween(
        $from.parentOffset,
        $to.parentOffset,
        '',
        '\uFFFC'
      )
      const blockText = $from.parent.textBetween(0, $from.parent.content.size, '', '\uFFFC')
      const rawBlockStart = rawFrom - $from.parentOffset
      const rawBlockEnd = rawBlockStart + blockText.length
      if (rawTo !== rawBlockStart + $to.parentOffset) {
        return fail('non-linear-raw-range')
      }
      if (markdown.slice(rawBlockStart, rawBlockEnd) !== blockText) {
        return fail('raw-block-text-mismatch', {
          rawFrom,
          rawTo,
          rawBlockStart,
          rawBlockEnd,
          parentOffset: $from.parentOffset,
          blockText,
          rawBlockText: markdown.slice(rawBlockStart, rawBlockEnd)
        })
      }
      if (blockSplit) {
        // Enter in a top-level heading/paragraph creates two PM textblocks.
        // Markdown needs one blank line between them. Reuse any authored line
        // ending already adjacent to the caret and add only the missing bytes.
        // Splitting at block start is safe only for an empty paragraph whose
        // raw slot was created by this mapper. Non-empty block-at-start splits
        // may interact with heading/list/quote prefixes and stay quarantined.
        if ($from.parentOffset === 0 && ($from.parent.content.size !== 0 || !blockHint)) {
          return fail('split-at-unowned-block-start')
        }
        const lineEnding = documentLineEnding(view.original)
        if (!lineEnding) return fail('mixed-line-ending-split')
        const origFrom = view.toRaw[rawFrom]
        const rightBreaks = leadingLineEndingCount(view.original.slice(origFrom), lineEnding)
        const splitAtBlockEnd = $from.parentOffset === $from.parent.content.size
        // If another authored block already follows, its existing `\n\n`
        // belongs to that boundary. The new empty PM paragraph needs its own
        // preceding boundary as well; inserting another pair creates a stable
        // raw slot between the two boundaries for the first typed character.
        // The separator is authored in the normalized view (plain LF); the
        // view edit converts it to the document's own line ending once.
        const separator = splitAtBlockEnd && rightBreaks >= 2
          ? '\n\n'
          : '\n'.repeat(Math.max(0, 2 - rightBreaks))
        const edited = applyViewEdit(view, rawFrom, rawFrom, separator, lineEnding)
        if (!edited.ok) return fail('view-edit-failed')
        markdown = view.text
        const applied = step.apply(stepDoc)
        if (applied?.failed || !applied?.doc) return fail('step-apply-failed')
        const oldTopStart = $from.before(1)
        const firstSplitBlock = applied.doc.nodeAt(oldTopStart)
        if (!firstSplitBlock) return fail('split-block-missing')
        const newBlockStart = oldTopStart + firstSplitBlock.nodeSize
        hints = hints
          .map((hint) => hint.pmBlockStart > oldTopStart
            ? {
                ...hint,
                pmBlockStart: hint.pmBlockStart + 2,
                rawStart: hint.rawStart + edited.origText.length
              }
            : hint)
          .filter((hint) => hint.pmBlockStart !== newBlockStart)
        hints.push({
          pmBlockStart: newBlockStart,
          // The new block's content starts after a complete paragraph
          // boundary (two line endings). When authored bytes already covered
          // part of that boundary, the separator was shorter; the slot still
          // points past the full two-line-ending boundary.
          rawStart: edited.origFrom + (lineEnding.length * Math.max(2, separator.length))
        })
        doc = applied.doc
        changed = true
        continue
      }
      // This equality is the byte-ownership proof. It rejects escaped syntax,
      // entities, atoms and any mapper drift instead of guessing where a PM
      // character belongs in the authored source.
      if (markdown.slice(rawFrom, rawTo) !== removed) {
        return fail('raw-range-text-mismatch')
      }

      const applied = step.apply(stepDoc)
      if (applied?.failed || !applied?.doc) return fail('step-apply-failed')
      const currentTopStart = $from.before(1)
      const nextTopBlock = applied.doc.nodeAt(currentTopStart)
      let nextTextblock = nextTopBlock?.isTextblock ? nextTopBlock : null
      try {
        const nextResolved = applied.doc.resolve(Math.min(step.from, applied.doc.content.size))
        if (nextResolved.parent?.isTextblock) nextTextblock = nextResolved.parent
      } catch {
        return fail('post-step-position-unresolvable')
      }
      if (
        !allowEmptyTextblock &&
        $from.parent.content.size > 0 &&
        nextTextblock?.content.size === 0
      ) {
        // Emptying a textblock is commonly followed by a structural command:
        // backticks/fences in paragraphs or Enter-to-exit in list items. Until
        // each family is owned as one transaction sequence, mixing a mapped
        // empty source line with its legacy structural callback corrupts the
        // baseline. Keep the whole transition on the proven fallback path.
        return fail('textblock-emptied')
      }
      const nextBlockText = nextTextblock?.isTextblock
        ? nextTextblock.textBetween(0, nextTextblock.content.size, '', '\uFFFC')
        : null
      const hasLeadingSpaceSentinel = markdown.charAt(rawBlockStart - 1) === leadingSpaceSentinel
      const needsLeadingSpaceSentinel = typeof nextBlockText === 'string' && /^\s/u.test(nextBlockText)
      let patchFrom = rawFrom
      let patchTo = rawTo
      let replacement = inserted
      let currentHintRawStart = blockHint?.rawStart ?? null
      if (hasLeadingSpaceSentinel || needsLeadingSpaceSentinel) {
        patchFrom = rawBlockStart - (hasLeadingSpaceSentinel ? 1 : 0)
        patchTo = rawBlockEnd
        replacement = `${needsLeadingSpaceSentinel ? leadingSpaceSentinel : ''}${nextBlockText || ''}`
        currentHintRawStart = view.toRaw[patchFrom] + (needsLeadingSpaceSentinel ? leadingSpaceSentinel.length : 0)
      }
      const edited = applyViewEdit(view, patchFrom, patchTo, replacement, null)
      if (!edited.ok) return fail('view-edit-failed')
      markdown = view.text
      const pmDelta = inserted.length - (step.to - step.from)
      const rawDelta = edited.origText.length - (edited.origTo - edited.origFrom)
      if (pmDelta || rawDelta) {
        hints = hints.map((hint) => {
          if (hint.pmBlockStart === currentTopStart && currentHintRawStart != null) {
            return { ...hint, rawStart: currentHintRawStart }
          }
          if (hint.pmBlockStart > currentTopStart) {
            return {
              ...hint,
              pmBlockStart: hint.pmBlockStart + pmDelta,
              rawStart: hint.rawStart + rawDelta
            }
          }
          return hint
        })
      }
      doc = applied.doc
      changed = true
    }
  }

  if (!changed) return fail('no-document-change')
  if (!sameDocument(doc, newState?.doc)) return fail('final-document-mismatch')
  if (typeof validateMarkdown !== 'function') return fail('missing-semantic-validator')
  try {
    if (validateMarkdown(markdown, newState.doc) !== true) {
      return fail('semantic-document-mismatch')
    }
  } catch {
    return fail('semantic-validator-threw')
  }

  // The caller stores this snapshot as the authored source, so it must carry
  // the author's exact BOM/CRLF spelling. All proofs happened on the
  // normalized copy; `view.original` was edited in lockstep.
  const result = { ok: true, markdown: view.original, blockHints: hints, reason: 'plain-text-transactions' }
  diagnostic({ ok: true, reason: result.reason })
  return result
}
