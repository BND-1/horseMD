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
  ignoreTrailingEmptyBlockquoteParagraphPaths = [],
  ignoreSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths = [],
  ignoreTrailingEmptyListItemPaths = [],
  ignoreTableColumnWidthPaths = [],
  ignoreAllTableColumnWidths = false,
  // Source reprint: an empty paragraph inside a quote or list item next to
  // real content has no Markdown spelling, exactly like a top-level one.
  ignoreEmptyContainerParagraphs = false,
  // Transition-channel mode (P7b, trace-62663): flatten inline mark
  // containers (link/strong/emphasis) to their text and drop text marks, so
  // a changed-window comparison on a chronically diverged document asks
  // "same structural edit + same visible text" instead of re-litigating the
  // document's pre-existing inline-form divergence (autolink brackets,
  // serializer mark splits). Applied symmetrically to both sides of the
  // transition; the full-document areSourceDocumentsEquivalent channel and
  // the strict list-slot gate keep their exact semantics.
  inlineTextual = false,
  // Typora parity for emphasis Markdown cannot spell (`**] ok**` after a
  // letter, `**(**`): compare with strong/emphasis marks dropped and `*`/`_`
  // removed from text. Only areSourceDocumentsEquivalentWithLiteralEmphasis
  // uses it, together with a per-block "only delimiters were added" check.
  literalEmphasis = false
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
  const ignoredTrailingEmptyBlockquoteParagraphPaths = new Set(
    (Array.isArray(ignoreTrailingEmptyBlockquoteParagraphPaths)
      ? ignoreTrailingEmptyBlockquoteParagraphPaths
      : [])
      .filter((path) =>
        Array.isArray(path) &&
        path.length >= 1 &&
        path.every((index) => Number.isInteger(index) && index >= 0)
      )
      .map((path) => path.join('.'))
  )
  const ignoredSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths = new Set(
    (Array.isArray(ignoreSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths)
      ? ignoreSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths
      : [])
      .filter((path) =>
        Array.isArray(path) &&
        path.length >= 1 &&
        path.every((index) => Number.isInteger(index) && index >= 0)
      )
      .map((path) => path.join('.'))
  )
  const visit = (value, path = [], inCell = false) => {
    if (!value || typeof value !== 'object') return value
    const next = { ...value }
    if (literalEmphasis && next.type === 'text') {
      next.text = String(next.text || '').replace(/[*_]/g, '')
      if (Array.isArray(next.marks)) {
        next.marks = next.marks.filter((mark) => mark?.type !== 'strong' && mark?.type !== 'emphasis')
        if (!next.marks.length) delete next.marks
      }
    }
    if (next.attrs) {
      next.attrs = { ...next.attrs }
      // An empty title is no title: a pasted image (or a link made in the
      // editor) carries `title: ''`, the parser yields `null`, and Markdown
      // spells both the same way (MacBook Air trace 2026-10-12: an image
      // pasted into a paragraph paused every later edit).
      if (next.attrs.title === '') next.attrs.title = null
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
      // Column widths have no Markdown encoding at all. Callers comparing
      // against the live editor document (source reprint, the validator's
      // canonical-faithfulness check) opt in to ignoring them everywhere;
      // default callers keep the exact-path proof below.
      if (ignoreAllTableColumnWidths && (next.type === 'table_cell' || next.type === 'table_header')) delete next.attrs.colwidth
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
      const childInCell = next.type === 'table_cell' || next.type === 'table_header'
      next.content = next.content.map((child, index) => visit(child, [...path, index], childInCell))
      if (inlineTextual) {
        // Flatten inline mark containers to their text and strip text marks.
        // Atoms (inline code, images, inline math, html) stay strict — they
        // represent authored structure, not serializer form.
        const flattenInline = (children) => children.flatMap((child) => {
          if (
            child?.type === 'link' || child?.type === 'strong' || child?.type === 'emphasis'
          ) {
            return flattenInline(Array.isArray(child.content) ? child.content : [])
          }
          if (child?.type === 'text') return [{ type: 'text', text: String(child.text || '') }]
          return [child]
        })
        next.content = flattenInline(next.content)
      }
      // Merge adjacent text runs with identical marks: ProseMirror splits
      // text at potential mark boundaries (e.g. a lone `~` inside pasted
      // Markdown) while the raw parse keeps them as one run — same visible
      // text, same marks, different node counts. Concatenation is their
      // canonical form, so merge before comparing (0.13.179 paste trace:
      // content[N].content 12 vs 14 nodes with byte-identical text).
      // Whitespace at the edge of a strong/emphasis run renders identically
      // whether or not it carries the mark, and Markdown cannot open/close
      // those delimiters next to whitespace (`** word**` is not bold), so the
      // serializer moves it outside (` **word**`). Compare with edge
      // whitespace moved out of runs whose marks are ONLY strong/emphasis.
      // Code, strike, highlight and links keep their whitespace strict.
      // Links join them: Milkdown's serializer moves edge spaces out of EVERY
      // mark run (`#moveSpaces`), so `[ a ](u)` is always written ` [a](u) `
      // by canonical and reprint alike (fuzz seeds 55/63/66).
      // A GFM autolink literal has no "plain text" spelling: `https://a.com`
      // typed as text and the link it parses back to are the same Markdown
      // (escaping does not help — the autolink transform runs on the decoded
      // text). Compare a link whose text IS its own autolinkable URL unmarked,
      // so typing a URL no longer fails closed; it shows as a link on reopen,
      // like Typora.
      next.content = next.content.map((child) => {
        if (child?.type !== 'text' || !Array.isArray(child.marks)) return child
        const link = child.marks.find((mark) => mark?.type === 'link')
        if (!link || link.attrs?.title) return child
        const text = String(child.text || '')
        const href = String(link.attrs?.href || '')
        const literal =
          (/^https?:\/\/\S+$/i.test(text) && href === text) ||
          (/^www\.\S+$/i.test(text) && href === `http://${text}`) ||
          (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text) && href === `mailto:${text}`)
        if (!literal) return child
        const marks = child.marks.filter((mark) => mark !== link)
        const { marks: _dropped, ...rest } = child
        return marks.length ? { ...rest, marks } : rest
      })
      const invisibleOnWhitespace = new Set(['strong', 'emphasis', 'link'])
      next.content = next.content.flatMap((child) => {
        if (
          child?.type !== 'text' ||
          !Array.isArray(child.marks) ||
          !child.marks.length ||
          !child.marks.every((mark) => invisibleOnWhitespace.has(mark?.type))
        ) return [child]
        const text = String(child.text || '')
        const match = text.match(/^([ \t]*)([\s\S]*?)([ \t]*)$/)
        // A run of ONLY whitespace in bold/italic (the text of `*x*` deleted
        // down to its spaces) cannot be spelled at all: compare it unmarked
        // (fuzz seeds 49/73).
        if (match && !match[2] && text) {
          const { marks, ...rest } = child
          return [rest]
        }
        if (!match || (!match[1] && !match[3]) || !match[2]) return [child]
        const { marks, ...rest } = child
        return [
          ...(match[1] ? [{ ...rest, text: match[1] }] : []),
          { ...child, text: match[2] },
          ...(match[3] ? [{ ...rest, text: match[3] }] : [])
        ]
      })
      // Two adjacent lists of the same kind are one list in Markdown
      // (CommonMark merges them across a blank line; seeds 122/132).
      next.content = next.content.reduce((lists, child) => {
        const previous = lists[lists.length - 1]
        if (
          previous && child && previous.type === child.type &&
          (child.type === 'bullet_list' || child.type === 'ordered_list') &&
          Array.isArray(previous.content) && Array.isArray(child.content)
        ) {
          lists[lists.length - 1] = { ...previous, content: [...previous.content, ...child.content] }
        } else lists.push(child)
        return lists
      }, [])
      const merged = []
      for (const child of next.content) {
        const previous = merged[merged.length - 1]
        if (
          previous &&
          child?.type === 'text' &&
          previous.type === 'text' &&
          JSON.stringify(previous.marks || null) === JSON.stringify(child.marks || null)
        ) {
          previous.text = String(previous.text || '') + String(child.text || '')
          continue
        }
        merged.push(child)
      }
      next.content = merged
    }
    if ((next.type === 'paragraph' || next.type === 'heading') && Array.isArray(next.content)) {
      // A SOFT line break at the very start of a paragraph/heading has no
      // Markdown spelling (a paragraph cannot begin with a newline) — Enter
      // right before a soft break leaves the new paragraph starting with one
      // (fuzz seed 38). A HARD break there has none either: `  \n` at the
      // start of a paragraph is a blank line and at its end is dropped
      // (Shift+Enter at the start of a paragraph/heading, or deleting the line
      // after a hard break — MacBook Air trace 2026-10-12, 12 pauses). Table
      // cells stay strict: `<br>` spells an edge break there.
      const isSoftBreak = (child) =>
        (child?.type === 'hardbreak' || child?.type === 'hard_break') && child.attrs?.isInline === true
      const isEdgeBreak = (child) =>
        (child?.type === 'hardbreak' || child?.type === 'hard_break') && (child.attrs?.isInline === true || !inCell)
      if (next.content.some((child) => !isEdgeBreak(child))) {
        while (isEdgeBreak(next.content[0])) next.content = next.content.slice(1)
        // ...nor end with one (the newline is just the paragraph's end).
        while (isEdgeBreak(next.content.at(-1))) next.content = next.content.slice(0, -1)
      }
      // Spaces right before a line break cannot be stored (CommonMark strips
      // them; two or more turn a soft break into a hard one): compare without
      // them (fuzz seed 55).
      const isAnyBreak = (child) => child?.type === 'hardbreak' || child?.type === 'hard_break'
      next.content = next.content.map((child, index) => (
        child?.type === 'text' && isAnyBreak(next.content[index + 1]) && /[ \t]+$/.test(child.text || '')
          ? { ...child, text: child.text.replace(/[ \t]+$/, '') }
          : child
      )).filter((child) => !(child?.type === 'text' && child.text === ''))
      // ...nor right after a soft break: CommonMark strips the leading
      // whitespace of a paragraph continuation line (fuzz seed 67).
      next.content = next.content.map((child, index) => (
        child?.type === 'text' && isSoftBreak(next.content[index - 1]) && /^[ \t]+/.test(child.text || '')
          ? { ...child, text: child.text.replace(/^[ \t]+/, '') }
          : child
      )).filter((child) => !(child?.type === 'text' && child.text === ''))
    }
    if (next.type === 'paragraph' && Array.isArray(next.content) &&
      next.content.every((child) => child?.type === 'text' && /^[\u200B \t]*$/.test(String(child.text || ''))) &&
      next.content.some((child) => String(child.text || '').includes('\u200B'))) {
      // A paragraph holding only HorseMD's U+200B sentinel is an empty one
      // (`- [ ] ​`: GFM needs body text to keep a task checkbox; seed 87).
      delete next.content
    }
    if ((next.type === 'paragraph' || next.type === 'heading') && Array.isArray(next.content)) {
      // Spaces/tabs at the very END of a paragraph or heading have no Markdown
      // encoding: CommonMark strips them (two or more only mean a hard break
      // when more text follows). A space typed just before Enter / at the end
      // of a line is therefore not authored meaning. Code blocks keep theirs.
      const last = next.content.at(-1)
      if (last?.type === 'text' && /[ \t]+$/.test(String(last.text || ''))) {
        const trimmed = String(last.text).replace(/[ \t]+$/, '')
        if (trimmed) next.content[next.content.length - 1] = { ...last, text: trimmed }
        else next.content = next.content.slice(0, -1)
        if (!next.content.length) delete next.content
      }
    }
    if ((next.type === 'table_cell' || next.type === 'table_header') && Array.isArray(next.content)) {
      // GFM trims leading/trailing spaces and tabs of every cell on parse, so
      // whitespace the user just typed at a cell edge (e.g. the space before
      // the next word) has no Markdown encoding. Compare cell text without it;
      // interior spacing, marks and every other cell stay strict.
      const paragraphs = next.content.filter((child) =>
        child?.type === 'paragraph' && Array.isArray(child.content)
      )
      const first = paragraphs[0]
      const last = paragraphs.at(-1)
      if (first?.content[0]?.type === 'text') {
        first.content[0] = { ...first.content[0], text: String(first.content[0].text || '').replace(/^[ \t]+/, '') }
      }
      if (last?.content.at(-1)?.type === 'text') {
        const index = last.content.length - 1
        last.content[index] = { ...last.content[index], text: String(last.content[index].text || '').replace(/[ \t]+$/, '') }
      }
      for (const paragraph of paragraphs) {
        paragraph.content = paragraph.content.filter((child) => !(child?.type === 'text' && child.text === ''))
        if (!paragraph.content.length) delete paragraph.content
      }
    }
    if (next.type === 'table' && Array.isArray(next.content)) {
      // A row with fewer cells than the widest row is padded with empty cells
      // when the document is built (prosemirror-tables fixTables), so authored
      // `| a | b | extra` under a two-cell header and the canonical's padded
      // rectangle open as the same table (fuzz seed 31: a source edit that
      // appended text after a row made every later table edit pause). Pad both
      // sides the same way; cell content and alignment stay strict.
      const width = Math.max(0, ...next.content.map((row) => Array.isArray(row?.content) ? row.content.length : 0))
      next.content = next.content.map((row) => {
        const cells = Array.isArray(row?.content) ? row.content : []
        if (!row || cells.length >= width || !cells.length) return row
        const padded = [...cells]
        for (let column = cells.length; column < width; column += 1) {
          const model = next.content.find((other) => other?.content?.[column])?.content[column]
          padded.push({
            type: cells[0].type,
            ...(model?.attrs ? { attrs: { ...model.attrs } } : {}),
            content: [{ type: 'paragraph' }]
          })
        }
        return { ...row, content: padded }
      })
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
    if (
      ignoreEmptyContainerParagraphs &&
      (next.type === 'blockquote' || next.type === 'list_item') &&
      Array.isArray(next.content) &&
      next.content.some((child) => !(child?.type === 'paragraph' && !child.content?.length))
    ) {
      next.content = next.content.filter((child) => !(child?.type === 'paragraph' && !child.content?.length))
      // Lists that the removed empty paragraph kept apart are now adjacent:
      // one list in Markdown (seed 122).
      next.content = next.content.reduce((lists, child) => {
        const previous = lists[lists.length - 1]
        if (
          previous && child && previous.type === child.type &&
          (child.type === 'bullet_list' || child.type === 'ordered_list') &&
          Array.isArray(previous.content) && Array.isArray(child.content)
        ) {
          lists[lists.length - 1] = { ...previous, content: [...previous.content, ...child.content] }
        } else lists.push(child)
        return lists
      }, [])
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
    const ignoreTrailingEmptyBlockquoteAtOwnedPath =
      next.type === 'blockquote' &&
      ignoredTrailingEmptyBlockquoteParagraphPaths.has(path.join('.'))
    const ignoreSingleTrailingSpaceAtOwnedPath =
      next.type === 'blockquote' &&
      ignoredSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths.has(path.join('.'))
    if (
      next.type === 'blockquote' &&
      (ignoreTrailingEmptyBlockquoteParagraph || ignoreTrailingEmptyBlockquoteAtOwnedPath) &&
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
      // The child BEFORE the trailing empty run — with several consecutive
      // editor-owned empties (repeated Enter over a published transient,
      // E0 P3d) the previous NONEMPTY sibling is not content.at(-2).
      const previousChild = next.content[next.content.length - 1 - trailingEmptyParagraphs]
      const trailingEmpty = trailing?.type === 'paragraph' && !trailing?.content?.length
      const previousTextParagraph =
        previousChild?.type === 'paragraph' && Array.isArray(previousChild.content) && previousChild.content.length > 0
      const previousList =
        previousChild?.type === 'bullet_list' || previousChild?.type === 'ordered_list'
      // The legacy boolean stays exactly-one; a proof-owned path collapses the
      // WHOLE consecutive run (mirroring the list_item empty-paragraph
      // collapse above) because authored `>` bytes cannot encode any of them.
      const legacySingle = ignoreTrailingEmptyBlockquoteParagraph &&
        trailingEmptyParagraphs === 1 && previousTextParagraph
      const ownedRun = ignoreTrailingEmptyBlockquoteAtOwnedPath &&
        trailingEmptyParagraphs >= 1 && (previousTextParagraph || previousList)
      if (trailingEmpty && (legacySingle || ownedRun)) {
        if (ignoreSingleTrailingSpaceAtOwnedPath && previousTextParagraph) {
          const lastText = previousChild.content.at(-1)
          const text = lastText?.type === 'text' ? String(lastText.text || '') : ''
          if (text.endsWith(' ') && !text.endsWith('  ') && text.length > 1) {
            const previousContent = [...previousChild.content]
            previousContent[previousContent.length - 1] = {
              ...lastText,
              text: text.slice(0, -1)
            }
            next.content[next.content.length - 1 - trailingEmptyParagraphs] = {
              ...previousChild,
              content: previousContent
            }
          }
        }
        next.content = next.content.slice(
          0,
          next.content.length - (ownedRun ? trailingEmptyParagraphs : 1)
        )
      }
    }
    // A line break carries no text, so marks on it (Mod+B then Enter leaves
    // the stored bold mark on the break) are not visible meaning.
    if ((next.type === 'hardbreak' || next.type === 'hard_break') && next.marks) delete next.marks
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
    // A new document's synthetic empty title heading is editor-only too (the
    // canonical strips it), and Crepe's image-block is the parsed form of a
    // paragraph that holds a single image (web paste keeps the inline form).
    result.content = result.content
      .filter((child) => !(
        (child?.type === 'paragraph' || child?.type === 'heading') && !child?.content?.length
      ))
      .map((child) => {
        if (child?.type === 'image-block') return { type: 'image-unit', src: child.attrs?.src ?? null }
        if (
          child?.type === 'paragraph' && child.content?.length === 1 &&
          child.content[0]?.type === 'image'
        ) return { type: 'image-unit', src: child.content[0].attrs?.src ?? null }
        return child
      })

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
      // Compact type/text sketches of both sides so a length mismatch shows
      // what was added or dropped.
      const sketch = (items) => (items || []).map((item) => (
        item?.type === 'text' ? JSON.stringify(item.text).slice(0, 40) : item?.type || String(item)
      ))
      return { path, leftLength: left?.length, rightLength: right?.length, leftItems: sketch(left).slice(0, 12), rightItems: sketch(right).slice(0, 12) }
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
  // P7b (trace-62663): the transition channel compares CHANGED WINDOWS on a
  // document whose authored bytes and serialized bytes already parse
  // differently at inline spots. Inline form must not decide whether the two
  // sides made "the same edit" — block structure and visible text must. Both
  // sides are normalized symmetrically, so a genuine text/structure change on
  // one side still fails the comparison.
  const left = semanticJson(before, { ...options, inlineTextual: true })
  const right = semanticJson(after, { ...options, inlineTextual: true })
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

// Top-level blocks whose only delta is a serializer-internal list attr
// (label / listType / spread) are NOT document changes - the comparator
// already ignores those attrs everywhere. Owners computing changed windows
// use this so an ordered-list relabel run (Enter splitting item 1 of a huge
// list re-labels every successor, trace-9817) cannot balloon the window.
export const areSourceSyncNodesSemanticallyEqual = (left, right) => {
  if (!left || !right) return left === right
  if (left.eq?.(right) === true) return true
  const a = semanticJson(left)
  const b = semanticJson(right)
  return a && b && JSON.stringify(a) === JSON.stringify(b)
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

// Option A (user decision 2026-10-10, Typora parity): bold/italic whose
// delimiters Markdown cannot open or close there (`a**] ok**`, `**(**`) is
// written as-is; reopening shows the asterisks. Accept a candidate ONLY when
// it equals the document with those marks dropped AND every text block of the
// document is the candidate's text with nothing but `*`/`_` removed — no
// authored character may be lost or reordered.
export const areSourceDocumentsEquivalentWithLiteralEmphasis = (parsed, expected, options = {}) => {
  if (!parsed?.descendants || !expected?.descendants) return false
  if (!areSourceDocumentsEquivalent(parsed, expected, { ...options, literalEmphasis: true, recordDifference: false })) return false
  const blocks = (doc) => {
    const texts = []
    doc.descendants((node) => {
      if (!node.isTextblock) return true
      const text = node.textContent.replace(/\u200B/g, '').trim()
      if (text) texts.push(text)
      return false
    })
    return texts
  }
  const left = blocks(parsed)
  const right = blocks(expected)
  if (left.length !== right.length) return false
  let added = 0
  for (let index = 0; index < left.length; index += 1) {
    const candidate = left[index]
    const authored = right[index]
    let at = 0
    for (const character of candidate) {
      if (at < authored.length && character === authored[at]) { at += 1; continue }
      if (character !== '*' && character !== '_') return false
      added += 1
    }
    if (at !== authored.length) return false
  }
  return added > 0
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
