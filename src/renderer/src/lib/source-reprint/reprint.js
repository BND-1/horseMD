// Source reprint engine (R1, docs/source-reprint-architecture.md).
//
//   reprintSource({ source, editorDoc, parse, remark, serialize })
//     → { ok, markdown, edits, notes }
//
// srcDoc = parse(source) is what the source MEANS now; editorDoc is what the
// editor shows. Their difference is exactly what must be written back.
// Unchanged subtrees keep their authored bytes; a changed container keeps its
// frame (markers, prefixes, fences, pipes) and recurses; a changed text block
// is patched at character or inline-segment level; anything else is printed
// by the (author-styled) serializer. The caller verifies parse(result) against
// editorDoc — this module never decides correctness on its own.

import { isAllBlank, isBlankChar, splitBlanks } from '../markdown-blanks.js'
import { withLiteralBlocksProtected } from '../literal-blocks.js'
import { Fragment } from '@milkdown/prose/model'
import { buildInlineMap, pmInlineUnits } from './inline-map.js'
import { cachedParse, parseMarkdownCached, rememberParse } from './incremental-parse.js'
import { textblockMeaning } from '../source-sync/projection.js'

const SENTINEL = '​'
// The leading-space sentinel reads back only at the start of a text node
// (markdown-leading-space.js): a block's first line or the line after a
// hard break. A continuation line after a soft break is inside one text
// node, where U+200B would stay as text: there the serializer's `&#x20;`
// stays.
const BLOCK_PREFIX = '(?:[ \\t]*(?:>|[-*+]|\\d{1,9}[.)]|#{1,6})[ \\t]+(?:\\[[ xX]\\][ \\t]+)?)'
const LINE_START_ENTITY = new RegExp(`(^|\\n)(${BLOCK_PREFIX}*)&#x20;`, 'g')
const LINE_START_ENTITY_AFTER_PREFIX = new RegExp(`(^|\\n)(${BLOCK_PREFIX}+)&#x20;`, 'g')
const sentinelWhereItReadsBack = (match, lead, prefix, offset, whole) => {
  // Only before text: a line of only blanks loses them at its end and the
  // U+200B stays as text (it reads back as the sentinel only when a blank
  // follows it in the value).
  const lineEnd = whole.indexOf('\n', offset + match.length)
  if (!/[^ \t\r]/.test(whole.slice(offset + match.length, lineEnd < 0 ? whole.length : lineEnd))) return match
  const opensBlock = /(?:[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+(?:\[[ xX]\][ \t]+)?$/.test(prefix)
  if (!lead || opensBlock) return `${lead}${prefix}${SENTINEL} `
  const previousStart = whole.lastIndexOf('\n', offset - 1) + 1
  const previous = whole.slice(previousStart, offset).replace(/^(?:[ \t]*>)*[ \t]*/, '')
  const hardBreak = /(?:^|[^\\])(?:\\\\)*\\$/.test(previous) || / {2,}$/.test(previous)
  return !previous.trim() || hardBreak ? `${lead}${prefix}${SENTINEL} ` : match
}

const startOf = (node) => node?.position?.start?.offset
const endOf = (node) => node?.position?.end?.offset

const MD_SKIP_IN_DOC = new Set(['definition', 'footnoteDefinition'])
const CONTAINERS = new Set(['doc', 'blockquote', 'bullet_list', 'ordered_list', 'list_item', 'table', 'table_header_row', 'table_row'])

const ignoredAttrs = {
  heading: ['id'],
  bullet_list: ['spread'],
  ordered_list: ['spread'],
  list_item: ['spread', 'label', 'listType'],
  table_cell: ['colwidth'],
  table_header: ['colwidth']
}

// An empty title is no title (the editor writes `''`, the parser `null`).
const attrValue = (attrs, key) => {
  const value = attrs?.[key] ?? null
  return key === 'title' && value === '' ? null : value
}

// Attribute-level equality minus editor-only attrs.
const attrsEqual = (left, right, except = []) => {
  if (left.type !== right.type) return false
  const ignored = new Set([...(ignoredAttrs[left.type.name] || []), ...except])
  const keys = new Set([...Object.keys(left.attrs || {}), ...Object.keys(right.attrs || {})])
  for (const key of keys) {
    if (ignored.has(key)) continue
    if (JSON.stringify(attrValue(left.attrs, key)) !== JSON.stringify(attrValue(right.attrs, key))) return false
  }
  return true
}

// Marks compare by meaning: `marker` (`*` vs `_`) is spelling, which the
// reprint keeps from the source anyway.
const markEq = (left, right) => {
  if (left.type !== right.type) return false
  const keys = new Set([...Object.keys(left.attrs || {}), ...Object.keys(right.attrs || {})])
  for (const key of keys) {
    if (key === 'marker') continue
    if (JSON.stringify(attrValue(left.attrs, key)) !== JSON.stringify(attrValue(right.attrs, key))) return false
  }
  return true
}
const sameMarkSet = (left, right) => left.length === right.length && left.every((mark, index) => markEq(mark, right[index]))

// Units p..end of a text block differ only in their link mark's href / title
// (same characters, leaves and other marks), and that link is one inline
// `[…](…)` in the source covering exactly those units: the new `](…)` bytes.
// Anything else (reference links, a link wider than the window, a URL that
// needs escaping) returns null and the other patch levels run; the result is
// verified against the editor document like every reprint.
const linkMarkOf = (unit) => (unit.marks || []).find((mark) => mark.type.name === 'link') || null
function patchLinkDestination(body, map, mdBlock, oldUnits, newUnits, p, end) {
  let oldLink = null
  let newLink = null
  for (let i = p; i < end; i += 1) {
    const a = oldUnits[i]
    const b = newUnits[i]
    if (!a || !b || a.kind !== b.kind) return null
    if (a.kind === 'char' ? a.char !== b.char : (a.node.type !== b.node.type || !attrsEqual(a.node, b.node))) return null
    const la = linkMarkOf(a)
    const lb = linkMarkOf(b)
    if (!la || !lb) return null
    if (!oldLink) { oldLink = la; newLink = lb }
    if (!markEq(oldLink, la) || !markEq(newLink, lb)) return null
    if (!sameMarkSet(a.marks.filter((mark) => mark !== la), b.marks.filter((mark) => mark !== lb))) return null
  }
  if (!oldLink || markEq(oldLink, newLink)) return null
  // The link must not continue past the window (blank edge units compare
  // equal without their link mark).
  if ((p > 0 && linkMarkOf(oldUnits[p - 1]) && markEq(linkMarkOf(oldUnits[p - 1]), oldLink)) ||
    (end < oldUnits.length && linkMarkOf(oldUnits[end]) && markEq(linkMarkOf(oldUnits[end]), oldLink))) return null
  const first = map.units[p]
  const last = map.units[end - 1]
  if (!first || !last) return null
  let link = null
  const walk = (node) => {
    if (node.type === 'link' && Number.isInteger(node.position?.start?.offset) && Number.isInteger(node.position?.end?.offset)) {
      const from = node.position.start.offset
      const to = node.position.end.offset
      if (from <= first.from && to >= last.to && (!link || to - from < link.position.end.offset - link.position.start.offset)) link = node
    }
    for (const child of node.children || []) walk(child)
  }
  walk(mdBlock)
  if (!link) return null
  const linkFrom = link.position.start.offset
  const linkTo = link.position.end.offset
  if ((p > 0 && map.units[p - 1].to > linkFrom) || (end < map.units.length && map.units[end].from < linkTo)) return null
  if ((link.url || '') !== (oldLink.attrs.href || '') || (link.title ?? null) !== (oldLink.attrs.title ?? null)) return null
  const childEnd = link.children?.length ? link.children[link.children.length - 1].position?.end?.offset : null
  if (!Number.isInteger(childEnd)) return null
  const tail = /^\]\(([\s\S]*)\)$/.exec(body.slice(childEnd, linkTo))
  if (!tail) return null
  const inner = tail[1]
  const dest = /^([ \t]*)(<(?:[^<>\n\\]|\\.)*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)/.exec(inner)
  if (!dest) return null
  const rest = inner.slice(dest[0].length)
  const href = String(newLink.attrs.href || '')
  if (/[\\\n\r]/.test(href)) return null
  const balanced = (() => { let depth = 0; for (const ch of href) { if (ch === '(') depth += 1; else if (ch === ')' && --depth < 0) return false } return depth === 0 })()
  const angle = dest[2].startsWith('<') || !href || /[\s<>]/.test(href) || !balanced
  if (angle && /[<>]/.test(href)) return null
  const spelledHref = angle ? `<${href}>` : href
  const oldTitle = oldLink.attrs.title ?? null
  const newTitle = newLink.attrs.title ?? null
  let spelledRest = rest
  if (newTitle !== oldTitle) {
    if (newTitle == null || newTitle === '') spelledRest = rest.replace(/^[\s\S]*?([ \t]*)$/, '$1')
    else spelledRest = ` "${String(newTitle).replace(/(["\\])/g, '\\$1')}"`
  }
  return { from: childEnd, to: linkTo, text: `](${dest[1]}${spelledHref}${spelledRest})` }
}

// A GFM autolink literal (`https://a.com`, `www.a.com`, `a@b.com`) has no
// plain-text spelling: the same bytes are a link after parsing and plain text
// while typed (design doc §5). Inline content compares with such links
// unmarked, so a typed URL keeps its source bytes instead of being reprinted.
const isAutolinkLiteral = (node, mark) => {
  if (mark.type.name !== 'link' || mark.attrs?.title) return false
  const text = node.text
  const href = String(mark.attrs?.href || '')
  return (/^https?:\/\/\S+$/i.test(text) && href === text) ||
    (/^www\.\S+$/i.test(text) && href === `http://${text}`) ||
    (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text) && href === `mailto:${text}`)
}
// Marks a blank looks the same with or without (the validator compares them
// off whitespace; the serializer moves edge blanks out of every mark run but
// inline code — lib/inline-serializer.js).
const INVISIBLE_ON_BLANK = new Set(['strong', 'emphasis', 'link', 'html_span', 'strike_through', 'highlight', 'subscript', 'superscript'])
const inlineRunsModuloAutolinks = (block) => {
  const runs = []
  const push = (text, marks) => {
    if (!text) return
    const previous = runs[runs.length - 1]
    if (previous && previous.marks && sameMarkSet(previous.marks, marks)) previous.text += text
    else runs.push({ text, marks })
  }
  let afterHardBreak = false
  block.forEach((child, _offset, index) => {
    if (!child.isText) {
      // A break opening a paragraph has no spelling: the text after it
      // starts the block and its blanks are spelled (the validator agrees;
      // fuzz UI seed 185).
      runs.push({ node: child })
      afterHardBreak = /^hard_?break$/.test(child.type.name) && !(index === 0 && /^(paragraph|heading)$/.test(block.type.name))
      return
    }
    const marks = child.marks.filter((mark) => !isAutolinkLiteral(child, mark))
    const isCode = marks.some((mark) => mark.type.name === 'inlineCode')
    // Blanks at the start of the line after a line break have no Markdown
    // spelling outside an HTML tag: compare that line start without them.
    // Inline code keeps them (they are its content; spec 334).
    let text = afterHardBreak && !isCode ? child.text.replace(/^[ \t]+/, '') : child.text
    afterHardBreak = afterHardBreak && !isCode && !text
    const blankMarks = marks.filter((mark) => !INVISIBLE_ON_BLANK.has(mark.type.name))
    for (const piece of isCode ? [text] : splitBlanks(text)) {
      push(piece, !isCode && isAllBlank(piece) ? blankMarks : marks)
    }
  })
  return runs
}
const sameInlineModuloAutolinks = (left, right) => {
  const a = inlineRunsModuloAutolinks(left)
  const b = inlineRunsModuloAutolinks(right)
  return a.length === b.length && a.every((run, index) => {
    const other = b[index]
    if (run.node || other.node) {
      if (!run.node || !other.node || !sameNode(run.node, other.node)) return false
      // Marks on an image / formula are part of it (`**![i](a.png)**`,
      // `[![i](a.png)](u)`); sameNode ignores leaf marks. A line break's
      // marks show nothing and have no spelling of their own.
      return /^hard_?break$/.test(run.node.type.name) || sameMarkSet(run.node.marks, other.node.marks)
    }
    return run.text === other.text && sameMarkSet(run.marks, other.marks)
  })
}

// Structural equality minus editor-only attrs (recursive).
export function sameNode(left, right) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.eq(right)) return true
  if (left.isTextblock && right.isTextblock && left.type === right.type && !left.type.spec.code && attrsEqual(left, right)) {
    // The same Markdown meaning (lib/source-sync/projection.js): blanks,
    // marks and links compare the way they read back, by one definition.
    const meaning = sameTextblockMeaning(left, right)
    if (meaning != null) return meaning
    if (sameInlineModuloAutolinks(left, right)) return true
  }
  if (!attrsEqual(left, right) || left.childCount !== right.childCount) return false
  // A cell's paragraph reads as a cell (GFM trims its edges; a `<br>` at an
  // edge is an empty line in it).
  if (/^table_(cell|header)$/.test(left.type.name) && left.childCount === 1 && left.firstChild.isTextblock && right.firstChild.isTextblock) {
    const meaning = sameTextblockMeaning(left.firstChild, right.firstChild, { cell: left.type.name })
    if (meaning != null) return meaning
  }
  if (left.isText) return left.text === right.text && sameMarkSet(left.marks, right.marks)
  // An image / formula's marks are part of it (`[==![i](a.png)==](u)`); a
  // line break's show nothing.
  if (left.isLeaf) return /^hard_?break$/.test(left.type.name) || sameMarkSet(left.marks, right.marks)
  for (let index = 0; index < left.childCount; index += 1) {
    if (!sameNode(left.child(index), right.child(index))) return false
  }
  return true
}

// GFM trims a cell's spaces and tabs only: a no-break space (Excel's empty
// merged cell) or U+3000 is the cell's content (`.trim()` dropped them).
const trimCell = (text) => text.replace(/^[ \t]+|[ \t]+$/g, '')

// Whether two text blocks read back the same (null: no projector, e.g. a
// test without an editor). In a table cell GFM trims the edges.
function sameTextblockMeaning(left, right, { cell = false } = {}) {
  const a = textblockMeaning(left, { cell })
  const b = a == null ? null : textblockMeaning(right, { cell })
  return a == null || b == null ? null : a === b
}

// GFM column alignment: each delimiter-row segment `:?-+:?`; the editor keeps
// it on every cell of the column (header row first).
const tableAlignments = (table) => {
  const aligns = []
  table.firstChild?.forEach((cell) => aligns.push(cell.attrs.alignment ?? null))
  return aligns
}
const alignmentOf = (segment) => {
  const left = segment.startsWith(':')
  const right = segment.endsWith(':')
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null
}
const spellAlignment = (segment, align) => {
  const dashes = segment.replace(/:/g, '') || '---'
  return align === 'left' ? `:${dashes}` : align === 'center' ? `:${dashes}:` : align === 'right' ? `${dashes}:` : dashes
}
// The authored delimiter row with every segment whose alignment differs from
// `aligns` respelled, the rest byte for byte; null when it is not a plain
// delimiter row of that many columns.
const realignDelimiterRow = (row, aligns) => {
  if (!/^[ \t|:-]+$/.test(row)) return null
  const segments = row.match(/:?-+:?/g) || []
  if (segments.length !== aligns.length) return null
  let index = 0
  return row.replace(/:?-+:?/g, (segment) => {
    const align = aligns[index++]
    return alignmentOf(segment) === align ? segment : spellAlignment(segment, align)
  })
}
// The same table with each column's alignment taken from `aligns`.
const withAlignments = (table, aligns) => {
  const rows = []
  table.forEach((row) => {
    const cells = []
    row.forEach((cell, _offset, index) => {
      cells.push(index < aligns.length && (cell.attrs.alignment ?? null) !== aligns[index]
        ? cell.type.create({ ...cell.attrs, alignment: aligns[index] }, cell.content, cell.marks)
        : cell)
    })
    rows.push(row.type.create(row.attrs, cells, row.marks))
  })
  return table.type.create(table.attrs, rows, table.marks)
}

// A paragraph of only the U+200B sentinel (and blanks): HorseMD's spelling of
// an empty task body (`- [ ] ​`).
const isSentinelParagraph = (node) => {
  if (node?.type?.name !== 'paragraph' || !node.childCount) return false
  let only = true
  node.forEach((child) => { if (!child.isText || child.marks.length || !/^[​ \t]*$/.test(child.text)) only = false })
  return only && node.textContent.includes('​')
}

const isEmptyTextblock = (node) => node?.isTextblock && node.content.size === 0
// A paragraph holding only spaces/tabs has no encoding either: trailing
// whitespace is stripped, so it parses as nothing (fuzz seed 49).
const isBlankParagraph = (node) => {
  if (node?.type?.name !== 'paragraph') return false
  let blank = true
  // Spaces in inline code are content (`` ` ` `` is a code span of one space).
  // Soft breaks between blanks show nothing either: a paragraph of a soft
  // break + spaces was written as U+200B + spaces and reopened as a paragraph
  // holding U+200B (fuzz seed 1057).
  // Hard breaks alone too: a break at the end of a paragraph is no break,
  // so a paragraph of only line breaks reads back as nothing. Treated as
  // content, it was inserted again on every print — blank lines grew without
  // end (fuzz seed 3815: a 1 KB document saved as 5 MB of `>` lines).
  // Blanks next to a hard break are spelled (`&#x20;  ` + `&#x20;`): content.
  const softBreak = (child) => /^hard_?break$/.test(child.type.name) && child.attrs?.isInline === true
  let hardBreak = false
  let other = false
  node.forEach((child) => {
    if (softBreak(child)) return
    if (/^hard_?break$/.test(child.type.name)) { hardBreak = true; return }
    other = true
    if (!child.isText || /[^ \t]/.test(child.text) || child.marks.some((mark) => mark.type.name === 'inlineCode')) blank = false
  })
  return blank && !(hardBreak && other)
}

// A text block without the blanks Markdown cannot hold: at the end, around
// a soft break (CommonMark strips them), and in a table cell at the start
// too (GFM trims cells). Plain text only: in inline code a blank is content.
// A leading blank of a paragraph is content (the U+200B sentinel spells it).
const withoutUnencodedBlanks = (block, { cell = false } = {}) => {
  if (!block?.isTextblock || block.type.spec.code || !block.childCount) return block
  const children = []
  block.forEach((child) => children.push(child))
  const isCode = (child) => child.marks.some((mark) => mark.type.spec.code)
  const isSoftBreak = (child) => /^hard_?break$/.test(child?.type?.name || '') && child.attrs?.isInline === true
  const trimmed = children.map((child, index) => {
    if (!child.isText || isCode(child)) return child
    let text = child.text
    if (index === children.length - 1 || isSoftBreak(children[index + 1])) text = text.replace(/[ \t]+$/, '')
    if ((cell && index === 0) || isSoftBreak(children[index - 1])) text = text.replace(/^[ \t]+/, '')
    return text === child.text ? child : text ? child.withText(text) : null
  }).filter(Boolean)
  if (trimmed.length === children.length && trimmed.every((child, index) => child === children[index])) return block
  return block.copy(Fragment.fromArray(trimmed))
}

// Equal once the empty paragraphs that have no Markdown are left out — not
// a container's first child (an item's marker line). Backspace in an empty
// last item joins it to the item above as such a paragraph (RS-63): the item
// reads back the same, so it keeps its authored bytes (it was reprinted, and
// its nested `* x ` became `- x`).
const sameModuloEditorOnly = (left, right) => {
  if (sameNode(left, right)) return true
  // Blanks with no Markdown (a cell's edges, around soft breaks; the
  // validator ignores them too) are no change: the block keeps its bytes.
  // Before, its patch failed on them, it was printed whole (degraded) and
  // the fallback writers took the edit (fuzz seed 3716).
  if (left?.isTextblock && right?.isTextblock && left.type === right.type && attrsEqual(left, right)) {
    const meaning = left.type.spec.code ? null : sameTextblockMeaning(left, right)
    return meaning ?? sameNode(withoutUnencodedBlanks(left), withoutUnencodedBlanks(right))
  }
  if (!left || !right || left.type !== right.type || left.isTextblock || left.isLeaf || !left.childCount || !right.childCount) return false
  if (!attrsEqual(left, right)) return false
  if (/^table_(cell|header)$/.test(left.type.name)) {
    if (left.childCount !== 1 || right.childCount !== 1) return false
    const meaning = sameTextblockMeaning(left.child(0), right.child(0), { cell: left.type.name })
    return meaning ?? sameNode(withoutUnencodedBlanks(left.child(0), { cell: true }), withoutUnencodedBlanks(right.child(0), { cell: true }))
  }
  const kept = (node) => {
    const children = []
    node.forEach((child, _offset, index) => { if (index === 0 || !isBlankParagraph(child)) children.push(child) })
    return children
  }
  const before = kept(left)
  const after = kept(right)
  return before.length === after.length && before.every((child, index) => sameModuloEditorOnly(child, after[index]))
}

// LCS over two node arrays with sameNode (modulo editor-only paragraphs);
// returns aligned pairs.
const diffSequences = (oldNodes, newNodes) => {
  const sameNode = sameModuloEditorOnly
  let prefix = 0
  while (prefix < oldNodes.length && prefix < newNodes.length && sameNode(oldNodes[prefix], newNodes[prefix])) prefix += 1
  let suffix = 0
  while (
    suffix < oldNodes.length - prefix && suffix < newNodes.length - prefix &&
    sameNode(oldNodes[oldNodes.length - 1 - suffix], newNodes[newNodes.length - 1 - suffix])
  ) suffix += 1
  const oldMid = oldNodes.slice(prefix, oldNodes.length - suffix)
  const newMid = newNodes.slice(prefix, newNodes.length - suffix)
  const pairs = []
  for (let index = 0; index < prefix; index += 1) pairs.push([index, index])
  // Middle: LCS table (middles are small for local edits).
  const n = oldMid.length
  const m = newMid.length
  if (n && m && n * m <= 250000) {
    const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] = sameNode(oldMid[i], newMid[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (sameNode(oldMid[i], newMid[j])) { pairs.push([prefix + i, prefix + j]); i += 1; j += 1 }
      else if (table[i + 1][j] >= table[i][j + 1]) i += 1
      else j += 1
    }
  } else if (n && m) {
    // Too big for the table (two changes far apart in a large document):
    // walk both, and after a mismatch resynchronise on the nearest pair of
    // equal nodes within a window. Leaving the whole middle unaligned would
    // reprint every block between the two changes.
    const WINDOW = 48
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (sameNode(oldMid[i], newMid[j])) { pairs.push([prefix + i, prefix + j]); i += 1; j += 1; continue }
      let skip = null
      for (let distance = 1; distance <= WINDOW && !skip; distance += 1) {
        for (let a = 0; a <= distance; a += 1) {
          const b = distance - a
          if (i + a < n && j + b < m && sameNode(oldMid[i + a], newMid[j + b])) { skip = [a, b]; break }
        }
      }
      if (!skip) { i += 1; j += 1; continue }
      i += skip[0]
      j += skip[1]
    }
  }
  for (let index = 0; index < suffix; index += 1) {
    pairs.push([oldNodes.length - suffix + index, newNodes.length - suffix + index])
  }
  return pairs
}

const lineStartOf = (source, offset) => {
  let at = offset
  while (at > 0 && source[at - 1] !== '\n' && source[at - 1] !== '\r') at -= 1
  return at
}

// The marker may end its line (`4.` + newline: the item starts with a blank
// line); `$` alone only matches at the end of the sliced text.
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|(?=\r?\n)|$)/

// The source being reprinted is the committed baseline: the same string for
// every keystroke until the next publish, and for each escape level of one
// reprint. Parsing a 250 KB file twice per attempt cost seconds per pause
// (Yuque export, 2800 inline HTML spans), so recent parses per editor
// (`remark` is per editor) are reused, and a new text is parsed
// incrementally from a cached neighbour (incremental-parse.js). Results are
// only read.
const legacyParsed = new WeakMap()
// A unified processor is callable (typeof 'function'), so test for both.
const cacheKey = (remark) => (remark && (typeof remark === 'object' || typeof remark === 'function') ? remark : null)
// `parseTree` (optional) builds the editor document from the mdast already
// made here, so the source is parsed once instead of twice.
function parseSource(body, parse, remark, parseTree, schema) {
  const key = cacheKey(remark)
  if (key && schema && typeof remark.parse === 'function' && typeof remark.runSync === 'function') {
    return parseMarkdownCached(remark, schema, body)
  }
  const cached = key ? legacyParsed.get(key) : null
  if (cached?.body === body) return cached
  const mdRoot = remark.runSync(remark.parse(body), body)
  const entry = { body, srcDoc: parseTree ? parseTree(mdRoot) : parse(body), mdRoot }
  if (key) legacyParsed.set(key, entry)
  return entry
}

// The candidate a sync verified becomes the committed source of the next
// sync: callers that already parsed it hand the result over, so the next
// keystroke does not parse the whole file again.
export function rememberParsedSource(remark, body, srcDoc, mdRoot) {
  const key = cacheKey(remark)
  if (!key || typeof body !== 'string' || !srcDoc || !mdRoot) return
  if (cachedParse(remark, body)) return
  rememberParse(remark, { body, srcDoc, mdRoot, counts: null, noDefs: false })
  legacyParsed.set(key, { body, srcDoc, mdRoot })
}

// `newListMarkers` ({ bullet, delimiter }): how a list with no authored
// marker is spelled — the marker the user just typed (`+ `, `1) `), from the
// editor's list input intent; else the serializer's default.
export function reprintSource({ source, editorDoc, previousDoc = null, parse, parseTree = null, remark, serialize, escape = 'minimal', newListMarkers = null }) {
  // `escape: 'segment'` skips character patches: every changed text block
  // reprints whole top-level inline segments, which re-escapes literal
  // delimiters around the edit (`**` + typed text → `\*你好\*`; seed 50).
  const segmentOnly = escape === 'segment'
  // `escape: 'block'` (the verifier's last step): every changed text block
  // is printed whole in the editor's spelling, inside its unchanged frame.
  // The character and segment patches are exact but intricate; when one of
  // them prints a wrong line (fuzz 2026-10-31: inline code edited and a
  // blank after a soft break in one paragraph lost the line break), the
  // verifier used to have nothing left and the sync paused.
  const blockOnly = escape === 'block'
  // `escape: 'top'`: every changed top-level block is printed whole by the
  // serializer, unchanged ones keep their bytes; `'document'`: the whole
  // document is the serializer's (docs/reprint-root-cause-plan.md P3: widen
  // until it verifies). Both are degraded — the last steps, so a sync never
  // has to pause for a document the serializer can write (an empty item
  // opening a quote right after a paragraph line reads as text: Windows
  // fuzz seed 286).
  const topOnly = escape === 'top'
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const body = bom ? source.slice(1) : source
  const eol = /\r\n/.test(body) ? '\r\n' : '\n'
  // An UNCLOSED fence / `$$` block ends at the start of the next line (its
  // last line ending included); every other block ends on its own last
  // line. Replacing it ate that line ending — the next list item landed on
  // the printed closing fence (`$$$- 第三项`, fuzz seed 181).
  const endOf = (node) => {
    const end = node?.position?.end?.offset
    if ((node?.type === 'code' || node?.type === 'math') && Number.isInteger(end) && end > 0 && body[end - 1] === '\n') {
      return end - (body[end - 2] === '\r' ? 2 : 1)
    }
    return end
  }
  const notes = []
  const edits = []
  // Set when a changed text block could not be character-mapped and is
  // therefore printed whole (canonical inline spelling): still correct, but
  // less faithful than an exact patch.
  let degraded = false
  let srcDoc
  let mdRoot
  try {
    ;({ srcDoc, mdRoot } = parseSource(body, parse, remark, parseTree, editorDoc?.type?.schema))
  } catch (error) {
    return { ok: false, reason: 'parse-failed', notes: [String(error?.message || error)] }
  }
  // Nothing changed: the source is the spelling. (A source whose content the
  // editor cannot hold — `[](u)`, a document of only `[foo]: /url` — must
  // not be reprinted from the editor's copy: that drops it.) Not when the
  // editor changed an editor-only state since the last publication: removing
  // the kept empty paragraph equals the source's parse but collapses its
  // blank lines (Typora).
  if (srcDoc.eq(editorDoc) && (!previousDoc || previousDoc.eq(editorDoc))) {
    return { ok: true, markdown: source, edits: [], notes: [{ level: 'unchanged' }] }
  }
  const schema = editorDoc.type.schema
  const docWith = (nodes) => schema.topNodeType.create(null, nodes)

  // A line break's marks before printing (below).
  const SPAN_MARKS = new Set(['strong', 'emphasis', 'strike_through', 'highlight'])
  // Empty text blocks print as Crepe's `<br />` placeholder; in source an
  // empty paragraph/item body is simply empty.
  const withoutPlaceholders = (text) => text.replace(
    /^([ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*)*)<br\s*\/?>[ \t]*$/gm,
    // GFM needs body content after `[ ]` to keep a task: an empty task body
    // is the U+200B sentinel (RS-50 convention).
    (match, prefix) => (/\[[ xX]\][ \t]*$/.test(prefix) ? prefix.replace(/[ \t]*$/, ' ') + SENTINEL : prefix.replace(/[ \t]+$/, ''))
  )
  // (A `&#x20;` the serializer writes at a line end is a line of only
  // blanks: removing it made an empty line, which split the paragraph —
  // fuzz seed 34. Blanks with no Markdown are not written at all.)
  // The passes below read Markdown syntax: fenced code / `$$` content is
  // kept as printed (fuzz seed 562: `## &#x20;` inside a code block).
  const serializeNodes = (nodes, options) => withLiteralBlocksProtected(
    // Edge lines, blanks before a break, marks on a line break: the
    // serializer writes them as they read back (inline-serializer.js,
    // remark-text-handler.js) — one definition, nothing re-shaped here.
    // (Taking the marks off a break split the mark run around it and moved
    // the blank after it out of the mark: fuzz seed 1142.)
    serialize(docWith(nodes)).replace(/\n+$/, ''),
    (printed) => withoutPlaceholders(printed)
    // Only the serializer's own entities: `\&#x20;` is the text `&#x20;`
    // (an even run of backslashes before it escapes only themselves) —
    // rewriting it printed `\ ` (fuzz seed 3735: code text with `&#x20;`
    // dropped into a heading).
    // A leading space right after a block prefix (`## `, `- `, `> `) keeps
    // the sentinel spelling (fuzz seed 66: Enter before the space of a
    // heading); every other mid-line `&#x20;` is a plain space.
    .replace(LINE_START_ENTITY_AFTER_PREFIX, sentinelWhereItReadsBack)
    .replace(/(?<=[^\n\\](?:\\\\)*)&#x20;/g, ' ')
  )

  // The whole document in the serializer's spelling (the last step) —
  // exactly as written, only the empty-block placeholders taken out: the
  // `&#x20;` → space respelling above can move an emphasis delimiter's
  // flanking (`*a&#x20;*` is not `*a *`), and the last step must be the
  // projection itself (fuzz seed 410).
  if (escape === 'document') {
    const children = []
    editorDoc.forEach((child) => children.push(child))
    const printed = `${withLiteralBlocksProtected(serialize(docWith(children)).replace(/\n+$/, ''), (text) => withoutPlaceholders(text))}\n`
    return { ok: true, markdown: bom + (eol === '\r\n' ? printed.replace(/\r?\n/g, '\r\n') : printed), edits: [], notes: [{ level: 'document' }], degraded: true }
  }

  // Prefix every line after the first; blank lines get the trimmed prefix.
  const indentContinuation = (text, prefix) => text
    .split('\n')
    .map((line, index) => (index === 0 ? line : line ? prefix + line : prefix.replace(/[ \t]+$/, '')))
    .join('\n')

  // A block printed whole over several lines indents its continuation lines
  // for a block starting at the frame's column. Authored blanks between the
  // frame prefix and the old block (` src1`: up to 3 columns, ignored by
  // CommonMark) would shift the new first line: ` 1. s` + `   ```js` puts
  // the fence outside the item (fuzz seed 722). Those blanks go with it.
  const wholeBlockFrom = (at, printed, prefix) => {
    if (!printed.includes('\n')) return at
    const lineStart = body.lastIndexOf('\n', at - 1) + 1
    const lead = body.slice(lineStart, at)
    if (!lead.startsWith(prefix)) return at
    return /^[ \t]+$/.test(lead.slice(prefix.length)) ? lineStart + prefix.length : at
  }

  // A file with mixed line endings (a CRLF file appended to on a Mac) keeps
  // each region's own: printed text takes the line ending of the bytes it
  // replaces (the majority), else of the line it lands on — not the file's
  // first CRLF, which rewrote every LF line of a reprinted list.
  const eolAt = (from, to) => {
    if (eol === '\n') return '\n'
    const replaced = body.slice(from, to)
    const crlf = (replaced.match(/\r\n/g) || []).length
    const lf = (replaced.match(/\n/g) || []).length - crlf
    if (crlf !== lf) return crlf > lf ? '\r\n' : '\n'
    const next = body.indexOf('\n', to)
    if (next >= 0) return body[next - 1] === '\r' ? '\r\n' : '\n'
    const previous = body.lastIndexOf('\n', from - 1)
    if (previous >= 0) return body[previous - 1] === '\r' ? '\r\n' : '\n'
    return eol
  }
  const replace = (from, to, text, note) => {
    const local = eolAt(from, to)
    edits.push({ from, to, text: local === '\n' ? text.replace(/\r\n/g, '\n') : text.replace(/\r?\n/g, local) })
    if (note) notes.push(note)
  }

  // ---- children alignment -------------------------------------------------
  const mdChildren = (pmNode, mdNode) => {
    let kids = mdNode.children || []
    if (pmNode.type.name === 'doc') kids = kids.filter((child) => !MD_SKIP_IN_DOC.has(child.type))
    if (kids.length === pmNode.childCount) return kids
    // A blank source parses to a document of one empty paragraph (the schema
    // needs a block) with no mdast children: placeholders, no source bytes.
    if (pmNode.type.name === 'doc' && !kids.length) {
      const blanks = []
      pmNode.forEach((child) => blanks.push(isEmptyTextblock(child) ? null : child))
      if (blanks.every((child) => child === null)) return blanks
    }
    // `- - nested` (an item whose content starts with a list): the schema
    // makes Milkdown insert a synthetic empty first paragraph that has no
    // source bytes. Align it with a null placeholder.
    if (
      pmNode.type.name === 'list_item' &&
      kids.length === pmNode.childCount - 1 &&
      isEmptyTextblock(pmNode.firstChild) &&
      kids[0]?.type !== 'paragraph'
    ) return [null, ...kids]
    return null
  }

  const childFrame = (pmNode, mdNode, frame) => {
    const name = pmNode.type.name
    if (name === 'blockquote') {
      const start = startOf(mdNode)
      const marker = /^[ \t]{0,3}>[ \t]?/.exec(body.slice(start, start + 8))?.[0]?.trimStart() || '> '
      return { prefix: frame.prefix + marker, quoteDepth: frame.quoteDepth + 1 }
    }
    if (name === 'list_item') {
      const start = startOf(mdNode)
      const match = LIST_MARKER.exec(body.slice(start, start + 16))
      const spaces = match?.[3]?.length ?? 1
      const width = (match?.[2]?.length ?? 1) + (spaces > 4 ? 1 : Math.max(1, spaces))
      // The item's content column also counts the blanks before its marker
      // (`>   - x`: a list indented inside its frame). Without them a block
      // added to the item printed at the marker's column and became the
      // list's sibling (fuzz seed 1299).
      const lineStart = body.lastIndexOf('\n', start - 1) + 1
      const lead = body.slice(lineStart, start)
      const indent = lead.startsWith(frame.prefix) && /^ *$/.test(lead.slice(frame.prefix.length))
        ? lead.length - frame.prefix.length
        : 0
      return { prefix: frame.prefix + ' '.repeat(indent + width), quoteDepth: frame.quoteDepth }
    }
    return frame
  }

  // ---- printing new nodes -------------------------------------------------
  const markerFor = (listMd, itemIndexInNew, ordered) => {
    const items = listMd.children || []
    const sample = items[Math.min(itemIndexInNew, items.length - 1)] || items[0]
    const raw = sample ? LIST_MARKER.exec(body.slice(startOf(sample), startOf(sample) + 16)) : null
    if (!raw) return null
    if (!ordered) return raw[2]
    const delimiter = raw[2].slice(-1)
    const numbers = items.map((item) => Number(LIST_MARKER.exec(body.slice(startOf(item), startOf(item) + 16))?.[2]?.slice(0, -1)))
    // `1. 1. 1.` numbering is kept; one authored item says nothing about it.
    const allSame = numbers.length > 1 && numbers.every((value) => value === numbers[0])
    const number = allSame ? numbers[0] : (numbers[0] || 1) + itemIndexInNew
    return `${number}${delimiter}`
  }

  // Leading spaces are spelled with the U+200B sentinel (Typora), not the
  // serializer's `&#x20;`, at the start of any printed line or item body.
  const withSentinels = (text) => withLiteralBlocksProtected(text, (printed) => printed.replace(LINE_START_ENTITY, sentinelWhereItReadsBack))
  // A cell is printed where it lives, in a one-cell table: the serializer
  // knows the cell's rules (`<br>` breaks, `&#10;`, `\|`, marks running over
  // a break). Printed run by run, between its breaks, marks crossing a
  // break were closed and reopened around it and the blank after it left
  // the mark (fuzz seed 1142: `*test<br> ok*` printed `*test*<br> *ok*`).
  const printCellFragment = (fragment) => {
    const { table, table_header_row: headerRow, table_header: header, paragraph } = schema.nodes
    if (table && headerRow && header) {
      const cell = table.create(null, headerRow.create(null, header.create(null, paragraph.create(null, fragment))))
      const line = serializeNodes([cell], { trimBreaks: false }).split('\n')[0]
      if (/^\|.*\|$/.test(line)) return trimCell(line.slice(1, -1))
    }
    return printCellSegment(fragment)
  }
  // Part of a cell (a segment patch inside it): its edge blanks are inside
  // the cell, so it is printed run by run between its breaks, joined with
  // `<br>`, pipes escaped.
  const printCellSegment = (fragment) => {
    const runs = [[]]
    fragment.forEach((child) => {
      if (/^hard_?break$/.test(child.type.name)) runs.push([])
      else runs[runs.length - 1].push(child)
    })
    return runs
      .map((run) => (run.length ? serializeNodes([schema.nodes.paragraph.create(null, run)], { trimBreaks: false }).replace(/^&#x20;/, ' ') : ''))
      // A run ending in an unescaped backslash would escape the `<` of the
      // following `<br>` (fuzz seed 73): double it.
      .map((text, index, all) => (index < all.length - 1 && /(?:^|[^\\])(?:\\\\)*\\$/.test(text) ? text + '\\' : text))
      .join('<br>')
      .replace(/(?<!\\)\|/g, '\\|')
  }
  // Whole table printed by HorseMD itself (the canonical table printer drops
  // a trailing in-cell `<br>`). The authored delimiter row is kept when the
  // column count is unchanged.
  const printTable = (table, mdTable) => {
    const rows = []
    // A body row without cells is what a header-only table parses to
    // (`| a |` + delimiter): it has no spelling of its own — leaving it out
    // is that spelling (`|  |` would read back as a row of empty cells).
    table.forEach((row, _offset, index) => { if (index === 0 || row.childCount) rows.push(row) })
    if (!rows.length) return null
    const width = Math.max(...rows.map((row) => row.childCount))
    const cellsOf = (row) => {
      const cells = []
      row.forEach((cell) => cells.push(cell.childCount === 1 ? trimCell(printCellFragment(cell.child(0).content)) : ''))
      while (cells.length < width) cells.push('')
      return cells
    }
    const line = (cells) => `| ${cells.join(' | ')} |`
    const aligns = tableAlignments(table)
    while (aligns.length < width) aligns.push(null)
    let delimiter = null
    if (mdTable?.position) {
      const lines = body.slice(startOf(mdTable), endOf(mdTable)).split(/\r?\n/)
      // The authored row, with only the columns whose alignment changed
      // respelled (a table handle's align button).
      delimiter = realignDelimiterRow(lines[1]?.trim() || '', aligns)
    }
    if (!delimiter) {
      delimiter = `| ${aligns.map((align) => spellAlignment('---', align)).join(' | ')} |`
    }
    return [line(cellsOf(rows[0])), delimiter, ...rows.slice(1).map((row) => line(cellsOf(row)))].join('\n')
  }
  // ---- container printer -------------------------------------------------
  // Lists, list items and blockquotes are printed by HorseMD itself so every
  // separator follows one rule set (pairSeparator/tightAllowed): Milkdown's
  // serializer could emit an empty sub-item right under a paragraph line (a
  // setext underline) or a blank line after an empty item marker, both of
  // which re-read as different structures (fuzz seeds 16/34/59). Leaf blocks
  // still go through the author-styled serializer; tables use printTable.
  let defaultMarkers = null
  const learnDefaultMarkers = () => {
    if (defaultMarkers) return defaultMarkers
    defaultMarkers = { bullet: '-', delimiter: '.' }
    try {
      const item = schema.nodes.list_item.createAndFill(null, [schema.nodes.paragraph.create(null, schema.text('x'))])
      defaultMarkers.bullet = /^\s*([-*+])/.exec(serializeNodes([schema.nodes.bullet_list.create(null, [item])]))?.[1] || '-'
      defaultMarkers.delimiter = /^\s*\d+([.)])/.exec(serializeNodes([schema.nodes.ordered_list.create(null, [item])]))?.[1] || '.'
    } catch {
      // keep the defaults
    }
    if (/^[-*+]$/.test(newListMarkers?.bullet || '')) defaultMarkers.bullet = newListMarkers.bullet
    if (/^[.)]$/.test(newListMarkers?.delimiter || '')) defaultMarkers.delimiter = newListMarkers.delimiter
    return defaultMarkers
  }
  // Spaces-only counts too (seed 77: an item holding only spaces is `1.`).
  const isEditorOnlyParagraph = (node) => isBlankParagraph(node)
  const indentLines = (text, indent) => text
    .split('\n')
    .map((line, index) => (index === 0 || !line ? line : indent + line))
    .join('\n')
  const joinPrinted = (parts, preferTight) => parts.reduce((out, part, index) => {
    if (index === 0) return part.text
    const separator = preferTight && tightAllowed(parts[index - 1].node, part.node) ? '\n' : '\n\n'
    return out + separator + part.text
  }, '')
  const leafText = (node) => withSentinels(serializeNodes([node]))
  const printNode = (node, oldMd = null) => {
    const name = node.type.name
    if (name === 'table') return printTable(node, oldMd?.type === 'table' ? oldMd : null) ?? leafText(node)
    if (name === 'blockquote') {
      const parts = []
      node.forEach((child) => { if (!isEditorOnlyParagraph(child)) parts.push({ node: child, text: printNode(child) }) })
      return joinPrinted(parts, false).split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')
    }
    // Authored markers are reused only while the list keeps its kind.
    if (isList(node)) {
      const sameKind = oldMd?.type === 'list' && Boolean(oldMd.ordered) === (name === 'ordered_list')
      return printList(node, sameKind ? oldMd : null)
    }
    return leafText(node)
  }
  let newListNoted = false
  const listMarker = (list, listMd, index) => {
    const ordered = list.type.name === 'ordered_list'
    const authored = listMd ? markerFor(listMd, index, ordered) : null
    if (authored) return authored
    // The caller's list input intent (the typed marker) is spent once a list
    // without authored markers is printed: the marker is source now.
    if (!newListNoted) {
      newListNoted = true
      notes.push({ level: 'new-list-marker' })
    }
    const defaults = learnDefaultMarkers()
    return ordered ? `${(list.attrs.order ?? 1) + index}${defaults.delimiter}` : defaults.bullet
  }
  const printList = (list, listMd) => {
    const items = []
    list.forEach((item) => items.push(item))
    let loose
    if (listMd?.children?.length >= 2) {
      loose = /\n[ \t>]*\r?\n/.test(body.slice(endOf(listMd.children[0]), startOf(listMd.children[1])))
    } else {
      loose = items.some((item) => {
        let blocks = 0
        item.forEach((child) => { if (!isList(child) && !isEditorOnlyParagraph(child)) blocks += 1 })
        return blocks >= 2
      })
    }
    return items.map((item, index) => printItem(item, listMarker(list, listMd, index))).join(loose ? '\n\n' : '\n')
  }
  const printItem = (item, marker) => {
    const children = []
    item.forEach((child) => children.push(child))
    const task = item.attrs.checked === true || item.attrs.checked === false
    const head = marker + (task ? (item.attrs.checked ? ' [x]' : ' [ ]') : '')
    const indent = ' '.repeat(marker.length + 1)
    const first = children[0]
    // A task whose content starts with a nested block has no body text on the
    // checkbox line: GFM needs the sentinel there, the block goes below
    // (`- [ ] - [ ] x` is not a nested task; seed 87).
    const taskLedByBlock = task && first && !first.isTextblock
    const firstEmpty = !first || isEditorOnlyParagraph(first) || taskLedByBlock
    // An item whose content starts with a list (Milkdown's synthetic empty
    // paragraph in front of it) writes that list on the marker line, the way
    // it reads back and is authored: `- 1. a`, not `-` + `  1. a`. Not when
    // the line would read as a thematic break (`- - -`).
    let leadList = null
    if (!task && first && isEditorOnlyParagraph(first)) {
      const next = children.slice(1).find((child) => !isEditorOnlyParagraph(child))
      if (next && isList(next)) {
        const line = `${head} ${indentLines(printNode(next), indent)}`
        if (!/^(?:[ \t]*[-*_]){3,}[ \t]*$/.test(line.split('\n')[0])) leadList = { node: next, line }
      }
    }
    let text
    if (leadList) {
      text = leadList.line
    } else if (firstEmpty) {
      // GFM needs body content after `[ ]` (RS-50: U+200B); a plain empty
      // item is just its marker.
      text = task ? `${head} ${SENTINEL}` : head
    } else {
      let firstText = printNode(first)
      // Spaces after the marker are swallowed as marker padding.
      if (first.isTextblock && /^[ \t]/.test(firstText)) firstText = SENTINEL + firstText
      text = `${head} ${indentLines(firstText, indent)}`
    }
    // A task's marker line always carries text (`[ ]` + U+200B): what follows
    // is spaced as after a paragraph — a paragraph right below would be its
    // lazy continuation (`2. [ ] ​` + `​ x g`; fuzz UI seed 311).
    let previous = leadList ? leadList.node : firstEmpty ? (task ? schema.nodes.paragraph.create() : null) : first
    for (const child of taskLedByBlock ? children : children.slice(1)) {
      if (isEditorOnlyParagraph(child) || child === leadList?.node) continue
      // An item that starts empty cannot have a blank line before its content.
      const separator = !previous || tightAllowed(previous, child) ? '\n' : '\n\n'
      text += separator + indent + indentLines(printNode(child), indent)
      previous = child
    }
    return text
  }
  // A thematic break typed over a paragraph (`---`: Milkdown's input rule
  // fires on the third `-`) keeps the typed character (Typora; the
  // serializer writes `***`). Minimal level only: a `---` that would read as
  // a setext underline fails the check and the next level writes `***`.
  // `mds`: the removed source blocks.
  const typedThematicBreak = (node, mds) => {
    if (node?.type.name !== 'hr' || escape !== 'minimal') return null
    for (const md of mds) {
      if (md?.type !== 'paragraph') continue
      const match = /^([-*_])\1{0,2}$/.exec(body.slice(startOf(md), endOf(md)).replace(/\\/g, '').trim())
      if (match) return match[1].repeat(3)
    }
    return null
  }
  const printBlock = (node, parentNode, parentMd, indexInNew, oldMd = null) => {
    if (node.type.name === 'list_item') {
      const sameKind = parentMd?.type === 'list' && Boolean(parentMd.ordered) === (parentNode.type.name === 'ordered_list')
      return printItem(node, listMarker(parentNode, sameKind ? parentMd : null, indexInNew))
    }
    // A body row inserted by the row handle: printed on its own line so the
    // authored rows around it keep their bytes (column padding). Before, the
    // whole table was printed again.
    if (node.type.name === 'table_row' && parentNode?.type.name === 'table' && parentNode.firstChild !== node) {
      const cells = []
      node.forEach((cell) => cells.push(cell.childCount === 1 ? trimCell(printCellFragment(cell.child(0).content)) : ''))
      if (!cells.length) return null
      return `| ${cells.join(' | ')} |`
    }
    if (/^table_(header_)?row$/.test(node.type.name)) return null
    return printNode(node, oldMd)
  }


  // ---- separators between siblings ----------------------------------------
  const separatorFor = (parentNode, parentMd, frame) => {
    const kids = mdChildren(parentNode, parentMd) || []
    if (kids.length >= 2) {
      const gap = body.slice(endOf(kids[0]), startOf(kids[1]))
      if (/^[ \t]*(\r?\n[ \t>]*)+$/.test(gap)) return gap.replace(/\r\n/g, '\n')
    }
    const name = parentNode.type.name
    if (name === 'bullet_list' || name === 'ordered_list') return '\n' + frame.prefix
    if (name === 'table' || /^table_/.test(name)) return '\n' + frame.prefix
    return '\n' + frame.prefix.replace(/[ \t]+$/, '') + '\n' + frame.prefix
  }

  // ---- text blocks ----------------------------------------------------------
  // 'minimal' writes exactly what was typed (plus the unavoidable cases);
  // 'full' escapes every inline-syntax character. The verifier tries minimal
  // first, so a typed `a = b` stays `a = b` in source.
  const escapeInline = (text, { cell = false, lineStart = false, sentinel = true } = {}) => {
    let output = escape === 'full'
      ? text.replace(/[\\`*_[\]<>~=$]/g, (character) => `\\${character}`)
      : text.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    if (cell) output = output.replace(/\|/g, '\\|')
    if (lineStart) {
      // After a line break the serializer's spelling: the first blank as an
      // entity (`&#x20; b`); CommonMark strips raw blanks there.
      output = sentinel ? output.replace(/^([ \t]+)/, `${SENTINEL}$1`) : output.replace(/^[ \t]/, (blank) => `&#x${blank.charCodeAt(0).toString(16).toUpperCase()};`)
      output = output.replace(/^(#{1,6}(?=[ \t]|$)|[-+*](?=[ \t]|$)|>|`{3,}|~{3,}|\d{1,9}(?=[.)](?:[ \t]|$)))/, (match) =>
        /^\d/.test(match) ? match.replace(/(\d+)$/, '$1\\') : `\\${match}`)
      output = output.replace(/^(\d+)\\$/, '$1')
    }
    return output
  }

  // A blank looks the same with or without bold/italic/link/<font> on it, and
  // the validator compares those marks off whitespace (Milkdown moves edge
  // blanks out of every mark run): a blank whose only difference is such a
  // mark is unchanged, or the next edit reprints spans the previous publish
  // already proved equivalent. Likewise marks on a line break.
  const INVISIBLE_ON_BLANK = new Set(['strong', 'emphasis', 'link', 'html_span', 'strike_through', 'highlight', 'subscript', 'superscript'])
  const visibleMarks = (marks) => (marks || []).filter((mark) => !INVISIBLE_ON_BLANK.has(mark.type.name))
  const sameUnit = (left, right) => {
    if (!left || !right || left.kind !== right.kind) return false
    if (left.kind === 'char') {
      if (left.char !== right.char) return false
      if (isBlankChar(left.char)) return sameMarkSet(visibleMarks(left.marks), visibleMarks(right.marks))
      return sameMarkSet(left.marks, right.marks)
    }
    if (/^hard_?break$/.test(left.node?.type?.name || '') && left.node.type === right.node?.type) {
      return (left.node.attrs?.isInline === true) === (right.node.attrs?.isInline === true)
    }
    return sameMarkSet(left.marks, right.marks) && sameNode(left.node, right.node)
  }

  // Patch one text block. `mdBlock` is the mdast paragraph/heading/tableCell.
  const patchTextblock = (srcBlock, mdBlock, newBlock, frame, { cell = false } = {}) => {
    if (blockOnly) {
      degraded = true
      return false
    }
    // Text typed into an EMPTY cell (`|   |`: no inline node to patch). It
    // goes between the pipes, before the last blank — `|  否 |` emptied and
    // refilled reads `|  是 |` again — and the other cells keep their bytes.
    // Before, the whole table was printed again and every authored column
    // padding was lost (a refilled cell in an aligned table).
    if (cell && srcBlock.childCount === 0 && newBlock.childCount > 0 && mdBlock?.type === 'tableCell' && !(mdBlock.children || []).length) {
      const from = startOf(mdBlock)
      const to = endOf(mdBlock)
      if (!Number.isInteger(from) || !Number.isInteger(to) || body[from] !== '|') {
        degraded = true
        return false
      }
      const innerEnd = body[to - 1] === '|' && to - 1 > from ? to - 1 : to
      const inner = body.slice(from + 1, innerEnd)
      if (/[^ \t]/.test(inner)) {
        degraded = true
        return false
      }
      const text = trimCell(printCellFragment(newBlock.content))
      if (!text) return true
      if (inner.length >= 2) replace(innerEnd - 1, innerEnd - 1, text)
      else replace(from + 1, innerEnd, ` ${text} `)
      notes.push({ level: 'cell', at: from })
      return true
    }
    const map = buildInlineMap({ source: body, block: mdBlock, quoteDepth: frame.quoteDepth })
    const oldUnits = pmInlineUnits(srcBlock)
    if (!map || map.units.length !== oldUnits.length) {
      degraded = true
      return false
    }
    // Whitespace at the end of a text block (and at both edges of a cell) has
    // no encoding — the parsed source never has it, the editor may. Leave it
    // out of the diff, or every reprint would append it again (design §5).
    // Inline code keeps its spaces (`` ` a` `` is " a"; fuzz UI seed 118).
    const isBlank = (unit) => unit?.kind === 'char' && (unit.char === ' ' || unit.char === '\t') &&
      !unit.marks?.some((mark) => mark.type.name === 'inlineCode')
    const newUnits = pmInlineUnits(newBlock)
    let tailBlanks = 0
    while (newUnits.length && isBlank(newUnits[newUnits.length - 1]) && !isBlank(oldUnits[oldUnits.length - 1])) { newUnits.pop(); tailBlanks += 1 }
    let leadTrim = 0
    if (cell) while (newUnits.length && isBlank(newUnits[0]) && !isBlank(oldUnits[0])) { newUnits.shift(); leadTrim += 1 }
    // A line break at the very start or end of a paragraph/heading has no
    // encoding either (cells spell it `<br>`): leave it out of the diff too,
    // or it is written as a blank line / a dangling `  ` + newline.
    if (!cell) {
      const isEdgeBreak = (unit) => unit?.kind === 'leaf' && /^hard_?break$/.test(unit.node?.type?.name || '')
      while (newUnits.length > 1 && isEdgeBreak(newUnits[newUnits.length - 1]) && !isEdgeBreak(oldUnits[oldUnits.length - 1])) newUnits.pop()
      while (newUnits.length > 1 && isEdgeBreak(newUnits[0]) && !isEdgeBreak(oldUnits[0])) { newUnits.shift(); leadTrim += 1 }
    }
    let p = 0
    while (p < oldUnits.length && p < newUnits.length && sameUnit(oldUnits[p], newUnits[p])) p += 1
    let q = 0
    while (
      q < oldUnits.length - p && q < newUnits.length - p &&
      sameUnit(oldUnits[oldUnits.length - 1 - q], newUnits[newUnits.length - 1 - q])
    ) q += 1
    const oldEnd = oldUnits.length - q
    const newEnd = newUnits.length - q
    if (p === oldEnd && p === newEnd) return true
    const oldWindow = oldUnits.slice(p, oldEnd)
    const newWindow = newUnits.slice(p, newEnd)

    // 0. Link destination: same text and formatting, only a link's href /
    // title changed (the link card's 编辑). Rewrite `(url "title")` and keep
    // every other byte — the segment printer would respell the link
    // (`[**粗**体](u)` → `**[粗](u)**[体](u)`).
    if (!segmentOnly && oldWindow.length && oldWindow.length === newWindow.length) {
      const patched = patchLinkDestination(body, map, mdBlock, oldUnits, newUnits, p, oldEnd)
      if (patched) {
        replace(patched.from, patched.to, patched.text, null)
        notes.push({ level: 'link-destination', at: patched.from })
        return true
      }
    }

    // 0b. Deletion across formatting: a selection over plain text and whole
    // bold/italic/link runs deleted (`前段。* **输入设备：** 内容` → `前段。* `).
    // The raw bytes of the deleted runs, delimiters included, are removed and
    // everything around them stays as authored; the segment printer respelled
    // the block (`前段。\*`). Partly deleted runs at either end must be plain
    // text. The verifier still checks the result.
    if (!segmentOnly && oldWindow.length && !newWindow.length &&
        !oldWindow.every((unit) => unit.kind === 'char' && sameMarkSet(unit.marks, oldWindow[0].marks))) {
      // Blanks the editor still has at the block end (left out of the diff
      // above) are authored bytes here: kept (`前段。* ` stays `* `).
      let start = p
      if (oldEnd === oldUnits.length) {
        while (start < oldEnd && start - p < tailBlanks && isBlank(oldUnits[start]) && !(oldUnits[start].marks || []).length) start += 1
      }
      const firstTop = start < oldEnd ? map.units[start].top : -1
      const lastTop = map.units[oldEnd - 1].top
      const unitsOf = (top) => map.units.reduce((list, unit, index) => (unit.top === top ? [...list, index] : list), [])
      const plain = (indexes) => indexes.every((index) => oldUnits[index].kind === 'char' && !(oldUnits[index].marks || []).length)
      const headUnits = unitsOf(firstTop)
      const tailUnits = unitsOf(lastTop)
      const from = headUnits[0] === start ? map.tops[firstTop].from : plain(headUnits) ? map.units[start].from : null
      const to = tailUnits[tailUnits.length - 1] === oldEnd - 1 ? map.tops[lastTop].to : plain(tailUnits) ? map.units[oldEnd - 1].to : null
      if (start < oldEnd && from != null && to != null && from < to && firstTop !== lastTop) {
        replace(from, to, '', null)
        notes.push({ level: 'run-deletion', at: from })
        return true
      }
    }

    // 1. Character patch: plain characters with one mark set, one text run.
    const marks = (newWindow[0] || oldWindow[0]).marks
    const allChars = (units) => units.every((unit) => unit.kind === 'char' && sameMarkSet(unit.marks, marks))
    if (!segmentOnly && allChars(newWindow) && allChars(oldWindow) && !newWindow.some((unit) => unit.char === '\n')) {
      let from = null
      let to = null
      if (oldWindow.length) {
        const tops = new Set(map.units.slice(p, oldEnd).map((unit) => unit.top))
        if (tops.size === 1) {
          from = map.units[p].from
          to = map.units[oldEnd - 1].to
        }
      } else {
        const left = p > 0 ? oldUnits[p - 1] : null
        const right = p < oldUnits.length ? oldUnits[p] : null
        if (left?.kind === 'char' && sameMarkSet(left.marks, marks)) from = to = map.units[p - 1].to
        else if (right?.kind === 'char' && sameMarkSet(right.marks, marks)) from = to = map.units[p].from
        else if (!marks.length && left) from = to = map.tops[map.units[p - 1].top].to
        else if (!marks.length && right) from = to = map.tops[map.units[p].top].from
      }
      let text = newWindow.map((unit) => unit.char).join('')
      const code = marks.some((mark) => mark.type.name === 'inlineCode')
      // Typed at the block end after blanks the source line already ends
      // with (`- 1\. ` + ` 测`: CommonMark trims them, so they are not text):
      // those blanks spell the typed ones; inserting before them left a
      // trailing space (`1\. 测 `).
      if (!code && !oldWindow.length && from != null && p === oldUnits.length) {
        const trailing = /^[ \t]+(?=\r?\n|$)/.exec(body.slice(to))?.[0] || ''
        if (trailing && text.startsWith(trailing) && text.length > trailing.length) {
          from += trailing.length
          to = from
          text = text.slice(trailing.length)
        }
      }
      const isBreakUnit = (unit) => unit?.kind === 'leaf' && /^hard_?break$/.test(unit.node.type.name)
      const isSoftUnit = (unit) => isBreakUnit(unit) && unit.node.attrs?.isInline === true
      // Blanks typed right after a soft break have no encoding (CommonMark
      // strips a continuation line's indentation; fuzz seed 67).
      if (!code && !cell && isSoftUnit(oldUnits[p - 1])) text = text.replace(/^[ \t]+/, '')
      // A deletion that leaves only blanks before a line break would make
      // them trailing spaces (2+ = a hard break; fuzz seed 68): drop them too.
      if (!code && from != null && isBreakUnit(oldUnits[oldEnd]) && !text.replace(/[ \t]/g, '')) {
        while (from > 0 && (body[from - 1] === ' ' || body[from - 1] === '\t') && p > 0 && isBlank(oldUnits[p - 1])) { from -= 1; p -= 1 }
        text = ''
      }
      // A deletion at the start of the block that exposes a leading blank or a
      // block marker (`a b` → ` b`, `x- y` → `- y`): the line needs the
      // sentinel/escape spelling, which the segment printer provides.
      // A bold/italic run left blank or empty by the edit (`*x*` → `*  *`)
      // cannot keep its delimiters: the segment printer drops the mark
      // (seed 92).
      let blankRun = false
      if (marks.some((mark) => SPAN_MARKS.has(mark.type.name))) {
        let runFrom = p
        let runTo = newEnd
        while (runFrom > 0 && newUnits[runFrom - 1].kind === 'char' && sameMarkSet(newUnits[runFrom - 1].marks, marks)) runFrom -= 1
        while (runTo < newUnits.length && newUnits[runTo].kind === 'char' && sameMarkSet(newUnits[runTo].marks, marks)) runTo += 1
        blankRun = newUnits.slice(runFrom, runTo).every(isBlank)
      }
      const exposesLineStart = !cell && !code && p === 0 && from != null && !text &&
        /^(?:[ \t]|#{1,6}(?=[ \t]|$)|[-+*](?=[ \t]|$)|>|`{3,}|~{3,}|\d{1,9}[.)](?:[ \t]|$))/.test(body.slice(to, to + 12))
      // Blanks typed right before a soft break have no encoding.
      const afterWindow = oldUnits[oldEnd]
      if (!code && afterWindow?.kind === 'leaf' && /^hard_?break$/.test(afterWindow.node.type.name)) text = text.replace(/[ \t]+$/, '')
      // Inside a code span nothing is escaped; a backtick would change the
      // span's fence, so that goes to segment reprint.
      // Text at the start of a sentinel-led line goes in front of the
      // sentinel, so the sentinel keeps pairing with its space.
      if (from != null && p === 0 && body[from - 1] === SENTINEL) from -= 1
      // Unmarked text right against a bold/italic delimiter (`**foo.**` + `a`)
      // can stop the delimiter from closing; the segment printer sees the
      // neighbour and encodes it (`**foo.**&#x61;`).
      const leavesSpan = (unit) => (unit?.marks || []).some((mark) => SPAN_MARKS.has(mark.type.name) && !marks.some((own) => own.eq(mark)))
      const againstDelimiter = from != null && !code && (
        (leavesSpan(oldUnits[p - 1]) && /[*_~=]$/.test(body.slice(0, from))) ||
        (leavesSpan(oldUnits[oldEnd]) && /^[*_~=]/.test(body.slice(to)))
      )
      if (from != null && !exposesLineStart && !blankRun && !againstDelimiter && !(code && text.includes('`'))) {
        const lineStart = !cell && !code && (p === 0 || isBreakUnit(oldUnits[p - 1]))
        let spelled = code ? text : escapeInline(text, { cell, lineStart, sentinel: p === 0 })
        // A trailing backslash would escape the authored punctuation right
        // after the edit (`\` + `<br>`, `\` + `*`): double it.
        // (Also when a deletion leaves an authored backslash next to it.)
        if (!code && /(?:^|[^\\])(?:\\\\)*\\$/.test(body.slice(Math.max(0, from - 32), from) + spelled) && /^[!-/:-@[-`{-~]/.test(body.slice(to, to + 1))) spelled += '\\'
        replace(from, to, spelled, null)
        notes.push({ level: 'char', at: from })
        return true
      }
    }

    // 2. Segment reprint: whole top-level inline children covering the window.
    if (map.tops.length) {
      const topOfOld = (index) => map.units[Math.min(Math.max(index, 0), map.units.length - 1)]?.top
      let firstTop = oldWindow.length ? topOfOld(p) : topOfOld(p > 0 ? p - 1 : p)
      let lastTop = oldWindow.length ? topOfOld(oldEnd - 1) : firstTop
      // New text that continues a neighbour's mark (typing at the end of a
      // link's text) belongs to the neighbour's top: print them together, or
      // the mark is spelled twice (`[a](u) [b](u)` for one link; seed 63).
      const sharesMark = (left, right) => Boolean(left && right) &&
        (left.marks || []).some((mark) => (right.marks || []).some((other) => other.eq(mark)))
      if (Number.isInteger(firstTop) && p > 0 && newWindow.length && sharesMark(oldUnits[p - 1], newWindow[0])) {
        firstTop = Math.min(firstTop, topOfOld(p - 1))
      }
      if (Number.isInteger(lastTop) && oldEnd < oldUnits.length && newWindow.length && sharesMark(oldUnits[oldEnd], newWindow[newWindow.length - 1])) {
        lastTop = Math.max(lastTop, topOfOld(oldEnd))
      }
      // A neighbour that ends (or starts) with a bold/italic delimiter is
      // printed together with the segment: alone, new text right against
      // `**` is spelled literally and can stop the delimiter from closing
      // (Yuque: `**<font>…</font>**` + typed text).
      if (Number.isInteger(firstTop) && firstTop > 0 && /[*_~=]$/.test(body.slice(map.tops[firstTop - 1].from, map.tops[firstTop - 1].to))) firstTop -= 1
      if (Number.isInteger(lastTop) && lastTop < map.tops.length - 1 && /^[*_~=]/.test(body.slice(map.tops[lastTop + 1].from, map.tops[lastTop + 1].to))) lastTop += 1
      if (Number.isInteger(firstTop) && Number.isInteger(lastTop)) {
        let unitFrom = map.units.findIndex((unit) => unit.top === firstTop)
        let unitTo = map.units.length - [...map.units].reverse().findIndex((unit) => unit.top === lastTop)
        unitFrom = Math.min(unitFrom, p)
        unitTo = Math.max(unitTo, oldEnd)
        const delta = newUnits.length - oldUnits.length
        const fragment = newBlock.content.cut(unitFrom + leadTrim, unitTo + delta + leadTrim)
        let printed
        if (cell) {
          printed = printCellSegment(fragment)
        } else {
          const paragraph = schema.nodes.paragraph.create(null, fragment)
          printed = fragment.size ? serializeNodes([paragraph], { trimBreaks: false }) : ''
          printed = indentContinuation(printed, frame.prefix)
        }
        // A segment starting mid-line keeps a plain leading space.
        if (firstTop > 0) printed = printed.replace(/^&#x20;/, ' ')
        // Blanks right before the line break that follows the segment have no
        // encoding (2+ would make it a hard break; fuzz seed 68).
        if (!cell && /^\r?\n/.test(body.slice(map.tops[lastTop].to, map.tops[lastTop].to + 2))) printed = printed.replace(/[ \t]+$/, '')
        // ...and inside it (seed 119: a deleted link left `bet    ` + newline),
        // unless the segment holds a hard break: `  ` + newline is then its
        // spelling (Yuque two-space breaks inside <font>), and blanks before
        // soft breaks were already dropped from the fragment.
        let hardBreakInside = false
        fragment.descendants((child) => { if (/^hard_?break$/.test(child.type.name) && child.attrs?.isInline !== true) hardBreakInside = true })
        if (!cell && !hardBreakInside) printed = printed.replace(/(?<!\\)[ \t]+(?=\r?\n)/g, '')
        let segmentFrom = map.tops[firstTop].from
        const segmentTo = map.tops[lastTop].to
        // Nothing left before a line break: the blanks just before the segment
        // (an unchanged neighbour's) would now end the line (seed 119).
        if (!cell && printed === '' && /^\r?\n/.test(body.slice(segmentTo, segmentTo + 2))) {
          while (segmentFrom > 0 && (body[segmentFrom - 1] === ' ' || body[segmentFrom - 1] === '\t')) segmentFrom -= 1
        }
        replace(segmentFrom, segmentTo, cell ? printed : withSentinels(printed))
        notes.push({ level: 'segment', at: map.tops[firstTop].from })
        return true
      }
    }
    return false
  }

  // ---- node-level recursion -------------------------------------------------
  // Returns true when the change was expressed inside the node's frame. A
  // failed attempt rolls back every edit it queued, so the caller's whole-node
  // replacement never overlaps half a patch.
  const patchNode = (srcNode, mdNode, newNode, frame) => {
    const editMark = edits.length
    const noteMark = notes.length
    const done = patchNodeInner(srcNode, mdNode, newNode, frame)
    if (!done) {
      edits.length = editMark
      notes.length = noteMark
      notes.push({ level: 'patch-failed', type: srcNode.type.name, md: mdNode?.type || null })
    }
    return done
  }
  // A list whose type alone changed (right-click conversion, ordered ↔
  // bullet) with every item as it was: only the markers are rewritten — the
  // items, their nested lists and blank lines keep their bytes. Printed
  // whole, the nested lists took the serializer's spacing and markers
  // (test:list-conversion-source-fidelity-ui). A wider marker moves the
  // item's later lines (as renumbering does); a narrower one leaves them.
  const patchListType = (srcNode, mdNode, newNode, frame) => {
    if (mdNode?.type !== 'list' || srcNode.childCount !== newNode.childCount) return false
    const kids = mdChildren(srcNode, mdNode)
    if (!kids || kids.length !== srcNode.childCount) return false
    for (let index = 0; index < srcNode.childCount; index += 1) {
      const before = srcNode.child(index)
      const after = newNode.child(index)
      if (before.attrs.checked !== after.attrs.checked || before.childCount !== after.childCount) return false
      for (let child = 0; child < before.childCount; child += 1) {
        if (!sameNode(before.child(child), after.child(child))) return false
      }
    }
    const ordered = newNode.type.name === 'ordered_list'
    const start = Number(newNode.attrs.order ?? 1)
    const itemFrame = childFrame(srcNode, mdNode, frame)
    for (let index = 0; index < kids.length; index += 1) {
      const item = kids[index]
      const at = startOf(item)
      const marker = Number.isInteger(at) ? LIST_MARKER.exec(body.slice(at, at + 16)) : null
      if (!marker) return false
      const next = ordered ? `${start + index}.` : '-'
      const delta = next.length - marker[2].length
      if (delta > 0 && !shiftItemLines(item, delta, itemFrame)) return false
      replace(at + marker[1].length, at + marker[1].length + marker[2].length, next)
    }
    notes.push({ level: 'list-type' })
    return true
  }
  const patchNodeInner = (srcNode, mdNode, newNode, frame) => {
    const name = srcNode.type.name
    if (srcNode.type !== newNode.type && /^(bullet|ordered)_list$/.test(name) && /^(bullet|ordered)_list$/.test(newNode.type.name)) {
      return patchListType(srcNode, mdNode, newNode, frame)
    }
    if (srcNode.type !== newNode.type) return false
    if (name === 'paragraph' || name === 'heading') {
      if (!attrsEqual(srcNode, newNode)) return false
      return patchTextblock(srcNode, mdNode, newNode, frame)
    }
    if (name === 'table_cell' || name === 'table_header') {
      if (!attrsEqual(srcNode, newNode) || srcNode.childCount !== 1 || newNode.childCount !== 1) return false
      return patchTextblock(srcNode.child(0), mdNode, newNode.child(0), frame, { cell: true })
    }
    if (name === 'list_item' && srcNode.attrs.checked !== newNode.attrs.checked) {
      const start = startOf(mdNode)
      const head = body.slice(start, startOf(mdNode.children?.[0]) ?? start)
      const box = /\[([ xX])\]/.exec(head)
      if (!box || srcNode.attrs.checked == null || newNode.attrs.checked == null) return false
      replace(start + box.index + 1, start + box.index + 2, newNode.attrs.checked ? 'x' : ' ')
      const resolved = srcNode.type.create({ ...srcNode.attrs, checked: newNode.attrs.checked }, srcNode.content)
      return patchContainer(resolved, mdNode, newNode, frame)
    }
    if (name === 'code_block') return patchCodeBlock(srcNode, mdNode, newNode, frame)
    // A column's alignment changed (table handle): only that delimiter-row
    // segment is respelled; the cells keep their bytes.
    if (name === 'table') {
      const before = tableAlignments(srcNode)
      const after = tableAlignments(newNode)
      if (after.length === before.length && after.some((align, index) => align !== before[index])) {
        const rows = mdNode?.children || []
        const headerEnd = endOf(rows[0])
        if (!Number.isInteger(headerEnd)) return false
        const lineStart = body.indexOf('\n', headerEnd) + 1
        if (lineStart <= 0) return false
        let lineEnd = body.indexOf('\n', lineStart)
        if (lineEnd < 0) lineEnd = body.length
        if (body[lineEnd - 1] === '\r') lineEnd -= 1
        const authored = body.slice(lineStart, lineEnd)
        // A table inside a quote / list item: its prefix comes first.
        const prefix = /^[ \t>]*?(?=[ \t]*\|?[ \t]*:?-)/.exec(authored)?.[0] ?? ''
        const realigned = realignDelimiterRow(authored.slice(prefix.length), after)
        if (realigned == null) return false
        replace(lineStart + prefix.length, lineEnd, realigned)
        return patchContainer(withAlignments(srcNode, after), mdNode, newNode, frame)
      }
      // One column inserted / deleted (table handle): only that cell of every
      // row and that delimiter segment change; the other cells keep their
      // bytes (authored column padding). Before, the whole table was printed
      // again.
      if (Math.abs(after.length - before.length) === 1) {
        const edits = planColumnChange(srcNode, mdNode, newNode, before, after)
        if (!edits) return false
        for (const [from, to, text] of edits) replace(from, to, text)
        notes.push({ level: 'table-column' })
        return true
      }
    }
    if (CONTAINERS.has(name)) {
      if (!attrsEqual(srcNode, newNode)) return false
      return patchContainer(srcNode, mdNode, newNode, frame)
    }
    return false
  }

  // [from, to, text] edits for one inserted / deleted column, or null when
  // the table cannot be patched that way (cells changed elsewhere, rows
  // without outer pipes, a delimiter row of another shape).
  const planColumnChange = (srcNode, mdNode, newNode, before, after) => {
    const inserted = after.length > before.length
    const rowsOf = (table) => { const rows = []; table.forEach((row) => rows.push(row)); return rows }
    const oldRows = rowsOf(srcNode)
    const newRows = rowsOf(newNode)
    const mdRows = mdNode?.children || []
    if (oldRows.length !== newRows.length || mdRows.length !== oldRows.length) return null
    const contents = (row) => { const cells = []; row.forEach((cell) => cells.push(JSON.stringify(cell.content.toJSON()))); return cells }
    const without = (cells, k) => cells.filter((_cell, index) => index !== k)
    const width = Math.max(before.length, after.length)
    let column = -1
    for (let k = 0; k < width && column < 0; k += 1) {
      const fits = oldRows.every((row, index) => {
        const oldCells = contents(row)
        const newCells = contents(newRows[index])
        return inserted ? JSON.stringify(without(newCells, k)) === JSON.stringify(oldCells) : JSON.stringify(without(oldCells, k)) === JSON.stringify(newCells)
      })
      if (fits) column = k
    }
    if (column < 0) return null
    const edits = []
    for (let index = 0; index < mdRows.length; index += 1) {
      const row = mdRows[index]
      const cells = row?.children || []
      const rowEnd = endOf(row)
      if (!Number.isInteger(rowEnd) || body[rowEnd - 1] !== '|' || !cells.length) return null
      const starts = cells.map((cell) => startOf(cell))
      if (starts.some((at) => !Number.isInteger(at) || body[at] !== '|')) return null
      if (inserted) {
        const cell = newRows[index].child(column)
        const text = cell.childCount === 1 ? trimCell(printCellFragment(cell.child(0).content)) : ''
        if (column < cells.length) edits.push([starts[column], starts[column], `| ${text} `])
        else if (column === cells.length) edits.push([rowEnd - 1, rowEnd - 1, `| ${text} `])
        else if (text) return null
      } else if (column < cells.length) {
        edits.push(column < cells.length - 1 ? [starts[column], starts[column + 1], ''] : [starts[column], rowEnd - 1, ''])
      }
    }
    // The delimiter row: the line after the header row.
    const lineStart = body.indexOf('\n', endOf(mdRows[0])) + 1
    if (lineStart <= 0) return null
    let lineEnd = body.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = body.length
    if (body[lineEnd - 1] === '\r') lineEnd -= 1
    const line = body.slice(lineStart, lineEnd)
    const prefix = /^[ \t>]*?(?=[ \t]*\|?[ \t]*:?-)/.exec(line)?.[0] ?? ''
    const row = line.slice(prefix.length)
    if (!/^[ \t]*\|[ \t|:-]+\|[ \t]*$/.test(row)) return null
    const pipes = []
    for (let at = 0; at < row.length; at += 1) if (row[at] === '|') pipes.push(lineStart + prefix.length + at)
    if (pipes.length !== before.length + 1) return null
    if (inserted) edits.push([pipes[column], pipes[column], `| ${spellAlignment('---', after[column])} `])
    else edits.push([pipes[column], pipes[column + 1], ''])
    return edits
  }
  // A fenced code / `$$` block whose closing fence is missing (it ends with
  // its container).
  const fenceLeftOpen = (mdNode, node) => {
    if (node?.type.name !== 'code_block' || !mdNode) return false
    const lines = body.slice(startOf(mdNode), endOf(mdNode)).split(/\r?\n/)
    const open = /^[ \t]*(`{3,}|~{3,}|\${2,})/.exec(lines[0])
    if (!open) return false
    if (lines.length < 2) return true
    const close = /^[ \t>]*(`{3,}|~{3,}|\${2,})[ \t]*$/.exec(lines[lines.length - 1])
    return !close || close[1][0] !== open[1][0] || close[1].length < open[1].length
  }
  const patchCodeBlock = (srcNode, mdNode, newNode, frame) => {
    const languageChanged = !attrsEqual(srcNode, newNode) && attrsEqual(srcNode, newNode, ['language'])
    if (!attrsEqual(srcNode, newNode) && !languageChanged) return false
    const start = startOf(mdNode)
    const end = endOf(mdNode)
    const raw = body.slice(start, end)
    const lines = raw.split(/\r?\n/)
    // `$$` math blocks (lang LaTeX, remark-math) are fenced like code: the
    // content lines sit between the `$$` lines, which stay authored.
    const open = mdNode?.lang === 'LaTeX'
      ? /^([ \t]*)(`{3,}|~{3,}|\${2,})/.exec(lines[0])
      : /^([ \t]*)(`{3,}|~{3,})/.exec(lines[0])
    // Only the language changed (the code block's language picker): the
    // info string's first word is rewritten in the authored opening fence —
    // the fence characters, its indentation and the blanks around the word
    // stay (`~~~   ts  ` → `~~~   go  `). Before, the whole block was
    // written again as a ``` fence.
    // Applied only once the patch is sure to succeed.
    let infoPatch = null
    if (languageChanged) {
      const before = String(srcNode.attrs.language || '')
      const after = String(newNode.attrs.language || '')
      if (!open || open[2][0] === '$' || before === 'LaTeX' || after === 'LaTeX' || mdNode?.lang === 'LaTeX') return false
      if (/\s/.test(after) || (open[2][0] === '`' && after.includes('`')) || /[\\&]/.test(after)) return false
      const rest = lines[0].slice(open[0].length)
      const word = /^([ \t]*)(\S*)/.exec(rest)
      if (word[2] !== before) return false
      // Removing the word would make the rest of the info string the language.
      if (!after && rest.slice(word[0].length).trim()) return false
      const at = start + open[0].length + word[1].length
      infoPatch = [at, at + word[2].length, after]
      if (srcNode.textContent === newNode.textContent) {
        replace(...infoPatch)
        notes.push({ level: 'code', at: start })
        return true
      }
    }
    // Indented code (Yuque writes nested lists as blank line + 4 spaces):
    // patch it in place, keeping the indentation. Reprinting it as a fence
    // would change what follows (`2. x` right after indented code is
    // paragraph text; after a fence it starts a list).
    if (!open) {
      const lineStart = lineStartOf(body, start)
      const indent = /^[ \t]*/.exec(body.slice(start, end))[0]
      const before = body.slice(lineStart, start)
      const width = (text) => text.replace(/\t/g, '    ').length
      if (width(before.replace(/^[ \t>]*/, '') + indent) < 4 && width(before + indent) - width(frame.prefix) < 4) return false
      const content = newNode.textContent
      const contentLines = content.split('\n')
      if (!content || !contentLines[0].trim() || !contentLines[contentLines.length - 1].trim()) return false
      // Same number of lines: patch inside the changed lines only, aligned
      // at each line's first non-blank character — every authored byte of
      // the indentation stays (tabs half used as indentation, content
      // that starts with blanks: `        foo` is `    foo`; CommonMark
      // spec 5–7, 116, 257, 274).
      const oldLines = srcNode.textContent.split('\n')
      const sourceLines = []
      // The first line from the block's own start (it may share its line
      // with a list marker: `-\t\tfoo`).
      for (let at = start; ;) {
        const stop = body.indexOf('\n', at)
        const lineEnd = stop < 0 || stop >= end ? end : stop
        sourceLines.push({ from: at, to: lineEnd > at && body[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd })
        if (stop < 0 || stop >= end) break
        at = stop + 1
      }
      if (oldLines.length === contentLines.length && sourceLines.length === oldLines.length) {
        const patches = []
        let exact = true
        oldLines.forEach((oldLine, index) => {
          const newLine = contentLines[index]
          if (!exact || oldLine === newLine) return
          const sourceLine = body.slice(sourceLines[index].from, sourceLines[index].to)
          const oldLead = /^[ \t]*/.exec(oldLine)[0].length
          const sourceLead = /^[ \t>]*/.exec(sourceLine)[0].length
          if (!oldLine.slice(oldLead) || sourceLine.slice(sourceLead) !== oldLine.slice(oldLead)) { exact = false; return }
          let prefix = 0
          while (prefix < oldLine.length && prefix < newLine.length && oldLine[prefix] === newLine[prefix]) prefix += 1
          let suffix = 0
          while (suffix < oldLine.length - prefix && suffix < newLine.length - prefix && oldLine[oldLine.length - 1 - suffix] === newLine[newLine.length - 1 - suffix]) suffix += 1
          if (prefix < oldLead) { exact = false; return }
          const from = sourceLines[index].from + sourceLead + (prefix - oldLead)
          const to = sourceLines[index].from + sourceLead + (oldLine.length - suffix - oldLead)
          patches.push([from, to, newLine.slice(prefix, newLine.length - suffix)])
        })
        if (exact && patches.length) {
          for (const [from, to, text] of patches) replace(from, to, text)
          notes.push({ level: 'code', at: start })
          return true
        }
      }
      // Otherwise the block is written again: only the code indentation
      // (4 columns) is indentation — the first line's own leading blanks are
      // content. A tab that holds both cannot be split: print it whole.
      const contentLead = /^[ \t]*/.exec(oldLines[0])[0]
      if (contentLead && (!/^ *$/.test(contentLead) || !indent.endsWith(contentLead) || /\t/.test(indent))) return false
      const codeIndent = indent.slice(0, indent.length - contentLead.length)
      const lead = frame.prefix + before.slice(frame.prefix.length) + codeIndent
      const text = contentLines
        .map((line, index) => (index === 0 ? codeIndent + line : line ? lead + line : frame.prefix.replace(/[ \t]+$/, '')))
        .join('\n')
      replace(start, end, text)
      notes.push({ level: 'code', at: start })
      return true
    }
    if (lines.length < 2) return false
    const fence = open[2]
    const last = lines[lines.length - 1].replace(/^[ \t>]*/, '')
    if (!last.startsWith(fence[0].repeat(fence.length))) return false
    if (newNode.textContent.split('\n').some((line) => line.trimStart().startsWith(fence))) return false
    // Content lines sit between the opening and closing fence lines; each
    // carries the container prefix. Fences and info string stay authored.
    // A fence indented by N spaces (` ```js`, `   ``` ` under `- `) has up
    // to N spaces removed from every content line (CommonMark): print them
    // back, or a line typed as `  a list` reads as ` a list` (fuzz
    // 2026-10-31, seed 48).
    const firstLineEnd = body.indexOf('\n', start) + 1
    const lastLineStart = lineStartOf(body, end)
    const fenceLead = (body.slice(lineStartOf(body, start), start) + open[1]).replace(/\t/g, '    ')
    const fenceIndent = ' '.repeat(Math.max(0, Math.min(3, fenceLead.length - frame.prefix.replace(/\t/g, '    ').length)))
    const content = newNode.textContent
    const text = content
      ? content.split('\n').map((line) => (line ? frame.prefix + fenceIndent + line : frame.prefix.replace(/[ \t]+$/, ''))).join('\n') + '\n'
      : ''
    if (infoPatch) replace(...infoPatch)
    replace(firstLineEnd, lastLineStart, text)
    notes.push({ level: 'code', at: start })
    return true
  }

  const patchContainer = (srcNode, mdNode, newNode, frame) => {
    // Extra empty cells are prosemirror-tables padding only up to the widest
    // authored row; a table wider than every authored row gained a real
    // column (column insert, seed 80): reprint the whole table.
    if (srcNode.type.name === 'table') {
      const widest = (table) => { let width = 0; table.forEach((row) => { width = Math.max(width, row.childCount) }); return width }
      if (widest(newNode) > widest(srcNode)) return false
    }
    const alignedKids = mdChildren(srcNode, mdNode)
    if (!alignedKids) return false
    const name = srcNode.type.name
    const innerFrame = childFrame(srcNode, mdNode, frame)
    const alignedOld = []
    srcNode.forEach((child) => alignedOld.push(child))
    // Children with no source bytes (the synthetic empty first paragraph)
    // take no part in the diff.
    const keep = alignedOld.map((_child, index) => alignedKids[index] !== null)
    const oldNodes = alignedOld.filter((_child, index) => keep[index])
    const kids = alignedKids.filter((_kid, index) => keep[index])
    const newNodes = []
    newNode.forEach((child) => newNodes.push(child))
    // Rows of a table are frames for cells; cells are matched positionally.
    // Elsewhere, editor-only empty paragraphs (Milkdown's trailing paragraph,
    // a just-emptied block) have no encoding and take no part in the diff.
    const isEditorOnly = (node) => isBlankParagraph(node)
    // Top level, a paragraph whose text was deleted keeps its line (Typora:
    // `A\n\nX\n\nB` with X emptied saves `A\n\n\n\nB`): the empty paragraph
    // standing in the authored paragraph's slot stays in the diff so only the
    // text bytes are removed.
    const emptiedSlots = new Set()
    if (name === 'doc') {
      let lastO = -1
      let lastN = -1
      for (const [oldIndex, newIndex] of [...diffSequences(oldNodes, newNodes), [oldNodes.length, newNodes.length]]) {
        if (oldIndex - lastO === newIndex - lastN) {
          for (let offset = 1; lastO + offset < oldIndex; offset += 1) {
            const before = oldNodes[lastO + offset]
            const after = newNodes[lastN + offset]
            if (isEditorOnly(after) && before.type.name === 'paragraph' && !isBlankParagraph(before)) emptiedSlots.add(after)
          }
        }
        lastO = oldIndex
        lastN = newIndex
      }
    }
    // An item's empty first paragraph that is authored too (`- [x] ​` + a
    // block below: the task's sentinel line, which parses as a paragraph of
    // just U+200B) is that same paragraph: taken for editor-only, it looked
    // deleted and the sentinel went with it, the block landing on the
    // checkbox line (fuzz seed 154).
    let keptFirst = null
    if (name === 'list_item' && keep[0] && isEditorOnly(newNodes[0]) &&
        (isEditorOnly(alignedOld[0]) || isSentinelParagraph(alignedOld[0]))) {
      keptFirst = newNodes[0] = alignedOld[0]
    }
    const encodedNew = name === 'table_row' || name === 'table_header_row'
      ? newNodes
      : newNodes.filter((node) => node === keptFirst || !isEditorOnly(node) || emptiedSlots.has(node))
    // Top level, empty paragraphs between two blocks (Enter on an empty line)
    // are spelled like an emptied one (Typora): each adds a blank line to the
    // gap of a block printed next to it. Counted per encoded block.
    if (name === 'doc') {
      const counts = []
      let run = 0
      for (const node of newNodes) {
        if (isEditorOnly(node) && !emptiedSlots.has(node)) { run += 1; continue }
        counts.push(counts.length ? run : 0)
        run = 0
      }
      blankRunsBefore.set(encodedNew, counts)
    }
    if (name === 'table_row' || name === 'table_header_row') {
      // Extra trailing EMPTY cells are prosemirror-tables padding for a short
      // authored row (design §5): no encoding, the authored row stays short.
      if (newNodes.length < oldNodes.length) return false
      for (let index = oldNodes.length; index < newNodes.length; index += 1) {
        let text = false
        newNodes[index].descendants((child) => { if (child.isText && child.text) text = true })
        if (text || newNodes[index].childCount !== 1) return false
      }
      for (let index = 0; index < oldNodes.length; index += 1) {
        if (sameNode(oldNodes[index], newNodes[index])) continue
        if (!patchNode(oldNodes[index], kids[index], newNodes[index], innerFrame)) return false
      }
      // An authored row without a closing pipe whose LAST cell became empty
      // would lose that cell (`| a | b` → `| a |`): close the row (seeds
      // 80/84).
      const lastIndex = oldNodes.length - 1
      const lastNew = newNodes[lastIndex]
      let lastText = false
      lastNew?.descendants((child) => { if (child.isText && child.text.trim() || /^hard_?break$/.test(child.type.name) || child.isAtom && !child.isText) lastText = true })
      if (lastIndex > 0 && !lastText && !sameNode(oldNodes[lastIndex], lastNew)) {
        const rowEnd = endOf(mdNode)
        if (!/\|[ \t]*$/.test(body.slice(startOf(mdNode), rowEnd))) replace(rowEnd, rowEnd, ' |')
      }
      return true
    }
    // A plain item's marker-line text deleted, everything after it unchanged
    // (`1. 父` + `   1. 微风`, 父 deleted): only the text goes, the nested
    // list keeps its own line (`1. ` + `   1. 微风`). Reprinted whole below,
    // the list moved onto the marker line (`1. 1. 微风`; RS-67).
    if (name === 'list_item' && newNode.attrs.checked == null && keep[0] && oldNodes.length >= 2 &&
        oldNodes[0].type.name === 'paragraph' && !isEditorOnly(oldNodes[0]) &&
        isEditorOnly(newNodes[0]) && newNodes[0] !== keptFirst &&
        encodedNew.length === oldNodes.length - 1 &&
        encodedNew.every((node, index) => sameNode(node, oldNodes[index + 1])) &&
        // Only a nested list right below (no blank line): an item starting
        // with an empty line ends at a blank one (`- ` + blank + `  c` puts
        // c outside the item; spec example 316).
        isList(oldNodes[1]) && !/\n[ \t>]*\r?\n/.test(body.slice(endOf(kids[0]), startOf(kids[1])))) {
      replace(startOf(kids[0]), endOf(kids[0]), '')
      notes.push({ level: 'emptied-lead', at: startOf(kids[0]) })
      return true
    }
    // What sits on an item's marker line went from text to a block (its
    // first paragraph emptied, a nested list now first) or back: the item's
    // shape changed — reprint it whole, printItem spells the marker line
    // (`- [x] ​` + the block below; fuzz seed 165 wrote `- [x] - [x] ​`).
    if (name === 'list_item' && oldNodes.length && encodedNew.length &&
        Boolean(oldNodes[0].isTextblock) !== Boolean(encodedNew[0].isTextblock)) return false
    // Same when the marker line's text was emptied and a block follows (a
    // heading pasted at the start of `5. [x] k` left an empty first
    // paragraph: dropped as editor-only, the heading landed on the checkbox
    // line as paragraph text; fuzz UI seed 398), and when a task's first
    // block is not a paragraph (`[x] ## h` is text, not a heading).
    // Also when nothing encodable is left: a task emptied of its only text
    // kept `- [ ] ` without the U+200B body and reopened as a plain item
    // (fuzz seed 619); the item printer writes the sentinel.
    if (name === 'list_item' && oldNodes.length) {
      const task = newNode.attrs.checked === true || newNode.attrs.checked === false
      const onLine = (node) => (task ? node.type.name === 'paragraph' : node.isTextblock)
      const emptied = isEditorOnly(newNodes[0]) && newNodes[0] !== keptFirst &&
        oldNodes[0].type.name === 'paragraph' && !isEditorOnly(oldNodes[0])
      // (A plain item emptied keeps its authored `- ` through the region.)
      if (emptied && (encodedNew.length || task)) return false
      if (encodedNew.length && onLine(oldNodes[0]) !== onLine(encodedNew[0])) return false
    }
    // A fence left open runs to the end of its container, so the block was
    // its container's last child. Followed by a block now (a paste or a
    // line typed below it; fuzz seed 3737: a file ending in an open
    // ```` ``` ````), its authored bytes would swallow that block: it is
    // printed again, closed.
    const lastEncoded = encodedNew.length - 1
    const pairs = diffSequences(oldNodes, encodedNew)
      .filter(([oldIndex, newIndex]) => newIndex >= lastEncoded || !fenceLeftOpen(kids[oldIndex], oldNodes[oldIndex]))
    // Items that keep their authored bytes (unchanged or patched in place):
    // their marker numbers may need renumbering below.
    const survivors = [...pairs]
    const separator = separatorFor(srcNode, mdNode, innerFrame)
    let lastOld = -1
    let lastNew = -1
    const gaps = []
    for (const [oldIndex, newIndex] of [...pairs, [oldNodes.length, encodedNew.length]]) {
      if (oldIndex > lastOld + 1 || newIndex > lastNew + 1) {
        gaps.push({ oldFrom: lastOld + 1, oldTo: oldIndex, newFrom: lastNew + 1, newTo: newIndex })
      }
      lastOld = oldIndex
      lastNew = newIndex
    }
    for (const gap of gaps) {
      const oldCount = gap.oldTo - gap.oldFrom
      const newCount = gap.newTo - gap.newFrom
      // Same-shaped region: patch pairwise inside each node's frame first.
      if (oldCount === newCount) {
        // Neighbouring children that both take the region path are ONE
        // region: two regions each claimed the separator between them and
        // the edits overlapped (`reprint-overlapping-edits`; a list and the
        // paragraph after it in a quote, fuzz FORMAT seed 33).
        let regionRun = null
        const flushRegion = () => {
          const run = regionRun
          regionRun = null
          return !run || replaceRegion(srcNode, mdNode, kids, newNode, run, innerFrame, separator, encodedNew, oldNodes)
        }
        const queueRegion = (oldIndex, newIndex) => {
          if (regionRun && regionRun.oldTo === oldIndex && regionRun.newTo === newIndex) {
            regionRun.oldTo += 1
            regionRun.newTo += 1
            return true
          }
          if (!flushRegion()) return false
          regionRun = { oldFrom: oldIndex, oldTo: oldIndex + 1, newFrom: newIndex, newTo: newIndex + 1 }
          return true
        }
        for (let offset = 0; offset < oldCount; offset += 1) {
          const before = oldNodes[gap.oldFrom + offset]
          const after = encodedNew[gap.newFrom + offset]
          const md = kids[gap.oldFrom + offset]
          // The first child of an item sits on the marker line: swapping a
          // text block for a nested block there (or back) changes the item's
          // shape — reprint the whole item (seed 87: `- [ ] - [ ] x`).
          if (name === 'list_item' && gap.oldFrom + offset === 0 && before.isTextblock !== after.isTextblock) return false
          // Emptied paragraph: no encoding — remove it with its separator.
          if (isBlankParagraph(after) && !isBlankParagraph(before)) {
            if (emptiedSlots.has(after)) {
              if (!flushRegion()) return false
              // Keep the line and its blank-line separators; drop the text.
              replace(startOf(md), endOf(md), '')
              notes.push({ level: 'emptied', at: startOf(md) })
              continue
            }
            if (!queueRegion(gap.oldFrom + offset, gap.newFrom + offset)) return false
            continue
          }
          // The gap before this child was valid for the OLD pair; a changed
          // child (e.g. a list whose first item became empty, right after a
          // paragraph) may now merge with its predecessor. Reprint it through
          // the region path, which picks a separator for the new pair.
          const newIndex = gap.newFrom + offset
          const oldIndex = gap.oldFrom + offset
          const predecessor = newIndex > 0 ? encodedNew[newIndex - 1] : null
          const gapBefore = oldIndex > 0 ? body.slice(endOf(kids[oldIndex - 1]), startOf(md)) : null
          const containerName = srcNode.type.name
          const blockContainer = containerName === 'doc' || containerName === 'blockquote' || containerName === 'list_item'
          // Likewise the gap AFTER it: a heading turned paragraph merges with a
          // paragraph that followed it on the next line (seed 111).
          const successor = newIndex + 1 < encodedNew.length ? encodedNew[newIndex + 1] : null
          const gapAfter = oldIndex + 1 < kids.length ? body.slice(endOf(md), startOf(kids[oldIndex + 1])) : null
          // A list next to another list keeps the authored gap while the
          // edge did not change: still a list of that kind, and the item at
          // that edge still starts with text (`1) foo` + `- bar` on the next
          // line are two lists and stay two — CommonMark spec 297). Other
          // pairs depend on how the edge LINE is spelled (an unclosed fence
          // in a quote read as text: editing it made the next line a lazy
          // continuation — spec 237), so they keep the region path.
          const edgeKept = (side) => {
            const neighbour = side === 'start' ? predecessor : successor
            if (before.type !== after.type || !isList(after) || !isList(neighbour)) return false
            const item = (list) => (side === 'start' ? list.firstChild : list.lastChild)
            const starts = (list) => Boolean(item(list)?.firstChild?.isTextblock && item(list).firstChild.content.size)
            return starts(before) && starts(after)
          }
          if (
            blockContainer && (
              (predecessor && gapBefore != null && !/\n[ \t>]*\r?\n/.test(gapBefore) && !tightAllowed(predecessor, after) && !edgeKept('start')) ||
              (successor && gapAfter != null && !/\n[ \t>]*\r?\n/.test(gapAfter) && !tightAllowed(after, successor) && !edgeKept('end'))
            )
          ) {
            if (!queueRegion(oldIndex, newIndex)) return false
            continue
          }
          if (!flushRegion()) return false
          if (!(topOnly && containerName === 'doc') && patchNode(before, md, after, innerFrame)) {
            survivors.push([oldIndex, newIndex])
          } else {
            const printed = typedThematicBreak(after, [md]) ?? printBlock(after, newNode, mdNode, gap.newFrom + offset, md)
            if (printed == null) return false
            replace(wholeBlockFrom(startOf(md), printed, innerFrame.prefix), endOf(md), indentContinuation(printed, innerFrame.prefix))
            notes.push({ level: topOnly && containerName === 'doc' ? 'top' : 'block', type: after.type.name })
            if (topOnly && containerName === 'doc') degraded = true
          }
        }
        if (!flushRegion()) return false
        continue
      }
      if (!replaceRegion(srcNode, mdNode, kids, newNode, gap, innerFrame, separator, encodedNew, oldNodes)) return false
    }
    if (name === 'ordered_list') {
      renumberSurvivors(kids, survivors, innerFrame)
      // The first item's number IS the list's start (`order`): when an
      // authored item becomes first, it carries the editor's start number
      // even in irregular numbering (`1. 2. 3.` + `1.`; seed 96).
      const lead = survivors.find(([, newIndex]) => newIndex === 0)
      if (lead && lead[0] > 0) {
        const item = kids[lead[0]]
        const match = LIST_MARKER.exec(body.slice(startOf(item), startOf(item) + 16))
        const expected = String(newNode.attrs.order ?? 1)
        if (match && /^\d+[.)]$/.test(match[2]) && match[2].slice(0, -1) !== expected) {
          const from = startOf(item) + match[1].length
          if (!edits.some((edit) => edit.from <= from && edit.to > from)) replace(from, from + match[2].length - 1, expected)
        }
      }
    }
    if (name === 'doc' && previousDoc) {
      collapseRemovedEmptyLines(kids, newNodes, survivors, (node) => !isEditorOnly(node) || emptiedSlots.has(node))
    }
    return true
  }

  // The counterpart of keeping an emptied paragraph's line: when the editor
  // removes an empty top-level paragraph (Backspace on the blank line), the
  // extra blank lines it stood for go too (Typora collapses them to one).
  // `previousDoc` is the editor document paired with `source`; only gaps
  // between two surviving neighbours that hold more than one blank line are
  // touched.
  const collapseRemovedEmptyLines = (kids, newNodes, survivors, isEncoded) => {
    const prevNodes = []
    previousDoc.forEach((child) => prevNodes.push(child))
    const oldOf = new Map(survivors.map(([oldIndex, newIndex]) => [newIndex, oldIndex]))
    const encodedIndex = new Map()
    {
      let encoded = 0
      newNodes.forEach((node, index) => {
        if (isEncoded(node)) encodedIndex.set(index, encoded++)
      })
    }
    let lastP = -1
    let lastN = -1
    for (const [prevIndex, newIndex] of [...diffSequences(prevNodes, newNodes), [prevNodes.length, newNodes.length]]) {
      const removed = prevNodes.slice(lastP + 1, prevIndex)
      const inserted = newIndex - lastN - 1
      if (removed.length && !inserted && removed.every((node) => isBlankParagraph(node)) &&
          lastN >= 0 && newIndex < newNodes.length) {
        const leftOld = oldOf.get(encodedIndex.get(lastN))
        const rightOld = oldOf.get(encodedIndex.get(newIndex))
        if (Number.isInteger(leftOld) && rightOld === leftOld + 1) {
          const from = endOf(kids[leftOld])
          const to = startOf(kids[rightOld])
          const gap = body.slice(from, to)
          if (/^(?:[ \t]*\r?\n){3,}[ \t]*$/.test(gap) && !edits.some((edit) => edit.from < to && edit.to > from)) {
            replace(from, to, '\n\n')
            notes.push({ level: 'empty-line-removed', at: from })
          }
        }
      }
      lastP = prevIndex
      lastN = newIndex
    }
  }

  // An ordered list authored with sequential numbers (1. 2. 3.) keeps them
  // sequential after items are inserted or removed: surviving items whose
  // number no longer matches their new position get only their digits
  // rewritten. All-same (1. 1. 1.) or custom numbering is left alone.
  // (Air report 2026-10-07: deleting an item left `3. … 5. … 6.`.)
  // A new number of another width moves the item's content column: its
  // later lines move by the same amount (Typora), or a fence 5 columns in
  // under `9.` left the item once it was `12.` (fuzz seed 1505). Returns
  // false when that cannot be done exactly: other edits inside the item, or
  // a line that does not start with the frame's prefix.
  const shiftItemLines = (item, delta, frame) => {
    const from = startOf(item)
    const to = endOf(item)
    if (edits.some((edit) => edit.to > from && edit.from < to)) return false
    const shifts = []
    for (let at = body.indexOf('\n', from); at >= 0 && at + 1 < to; at = body.indexOf('\n', at + 1)) {
      const lineStart = at + 1
      const lineEnd = body.indexOf('\n', lineStart) < 0 ? body.length : body.indexOf('\n', lineStart)
      const line = body.slice(lineStart, lineEnd).replace(/\r$/, '')
      if (!line.startsWith(frame.prefix)) {
        if (/^[ \t>]*$/.test(line)) continue
        return false
      }
      const rest = line.slice(frame.prefix.length)
      if (!rest.trim()) continue
      const cut = lineStart + frame.prefix.length
      if (delta > 0) shifts.push([cut, cut, ' '.repeat(delta)])
      // A lazy line (less indented) stays lazy.
      else if (rest.startsWith(' '.repeat(-delta))) shifts.push([cut, cut - delta, ''])
    }
    for (const [a, b, text] of shifts) replace(a, b, text)
    return true
  }

  const renumberSurvivors = (kids, survivors, frame) => {
    const numberAt = (item) => {
      const match = LIST_MARKER.exec(body.slice(startOf(item), startOf(item) + 16))
      return match ? { indent: match[1].length, digits: match[2].slice(0, -1) } : null
    }
    const numbers = kids.map((item) => numberAt(item))
    if (numbers.some((entry) => !entry || !/^\d+$/.test(entry.digits))) return
    const values = numbers.map((entry) => Number(entry.digits))
    const sequential = values.every((value, index) => value === values[0] + index)
    if (!sequential || values.length < 2 && survivors.length < 1) return
    const start = values[0]
    for (const [oldIndex, newIndex] of survivors) {
      const expected = String(start + newIndex)
      const entry = numbers[oldIndex]
      if (!entry || entry.digits === expected) continue
      const delta = expected.length - entry.digits.length
      // Numbers do not change the content; an item whose lines cannot move
      // keeps its authored number.
      if (delta && !shiftItemLines(kids[oldIndex], delta, frame)) continue
      const from = startOf(kids[oldIndex]) + entry.indent
      replace(from, from + entry.digits.length, expected)
    }
  }

  // Replace old children [oldFrom, oldTo) by new children [newFrom, newTo).
  // Can block `next` follow block `prev` on the very next line without
  // Markdown merging them (lazy continuation, setext underline, table rows,
  // HTML blocks running on)? Only then may a separator be a single newline.
  const isList = (node) => node?.type.name === 'bullet_list' || node?.type.name === 'ordered_list'
  const isSetextMd = (md) => md?.type === 'heading' && Number.isInteger(startOf(md)) && !/^[ \t]*#/.test(body.slice(startOf(md), startOf(md) + 8))
  const listCanInterrupt = (list) => {
    const first = list.firstChild
    // An item whose first line is only its marker (empty, blank, or starting
    // with a nested list: `-` + `  - x`) cannot interrupt a paragraph, and a
    // bare `-` right under a paragraph line is a setext underline (seed 79).
    // A task is never: its line always carries `[ ]` + body (U+200B when the
    // body is empty, printItem; fuzz seed 154).
    const lead = first?.firstChild
    const task = first?.attrs?.checked === true || first?.attrs?.checked === false
    const emptyLine = !task && (!lead || (lead.isTextblock ? isBlankParagraph(lead) || lead.content.size === 0 : isList(lead)))
    if (emptyLine) return false
    return list.type.name === 'bullet_list' || (list.attrs.order ?? 1) === 1
  }
  const tightAllowed = (prev, next) => {
    const a = prev.type.name
    const b = next.type.name
    if (a === 'heading' || a === 'code_block' || a === 'hr') return true
    if (a === 'paragraph') {
      return b === 'heading' || b === 'blockquote' || b === 'code_block' || (isList(next) && listCanInterrupt(next))
    }
    return false
  }
  // Separator between two siblings of a container, honouring an authored raw
  // gap when it is still valid for this pair.
  const blankSeparator = (frame) => '\n' + frame.prefix.replace(/[ \t]+$/, '') + '\n' + frame.prefix
  const tightSeparator = (frame) => '\n' + frame.prefix
  // Two neighbouring lists that Markdown reads back as ONE list (same kind,
  // same bullet / delimiter): the separator that list already has between
  // its items — none of the extra blank lines an empty paragraph between
  // them would get, which only make it loose. null when they do not merge.
  // Tightness is read from the text: Milkdown's items carry `spread: true`
  // whatever the source says. A part printed from a source list also looks
  // at that list's item gaps: split into two one-item lists, a loose
  // `- a\n\n- b` has no gap of its own left and was written tight.
  const sourceItemsLoose = (md) => (md?.children || []).some((item, index, items) =>
    index > 0 && /\n[ \t>]*\r?\n/.test(body.slice(endOf(items[index - 1]), startOf(item))))
  const mergedListSeparator = (left, right, frame) => {
    if (!isList(left?.node) || left.node.type !== right?.node?.type) return null
    const textOf = (entry) => (entry.md ? body.slice(startOf(entry.md), endOf(entry.md)) : entry.text) || ''
    const a = LIST_MARKER.exec(textOf(left))?.[2]
    const b = LIST_MARKER.exec(textOf(right))?.[2]
    if (!a || !b) return null
    if (left.node.type.name === 'ordered_list' ? a.slice(-1) !== b.slice(-1) : a !== b) return null
    const loose = [left, right].some((entry) => /\n[ \t>]*\r?\n/.test(textOf(entry)) || sourceItemsLoose(entry.listMd))
    return loose ? blankSeparator(frame) : tightSeparator(frame)
  }
  // The line break + delimiter row that follow a table's header row: the
  // authored one when `rawGap` (header end → next row start) is exactly that,
  // else one spelled from the alignments. Without the final line break.
  const headerDelimiter = (table, rawGap, containerSeparator) => {
    if (typeof rawGap === 'string') {
      const match = /^(\r?\n[^\r\n]*)\r?\n[ \t>]*$/.exec(rawGap)
      if (match && /^[ \t>]*\|?[ \t]*:?-/.test(match[1].replace(/^\r?\n/, ''))) return match[1].replace(/\r\n/g, '\n')
    }
    return containerSeparator + `| ${tableAlignments(table).map((align) => spellAlignment('---', align)).join(' | ')} |`
  }
  const pairSeparator = (container, prev, next, frame, rawGap, containerSeparator, nextMd = null) => {
    const name = container.type.name
    // After the header row comes the delimiter row: a region next to it (the
    // first body row deleted by a row handle, fuzz UI seed 128) keeps the
    // authored one.
    if (name === 'table' && prev?.type.name === 'table_header_row') return headerDelimiter(container, rawGap, containerSeparator) + containerSeparator
    if (name === 'bullet_list' || name === 'ordered_list' || name === 'table' || /^table_/.test(name)) {
      return containerSeparator
    }
    const rawHasBlank = typeof rawGap === 'string' && /\n[ \t>]*\r?\n/.test(rawGap)
    if (rawHasBlank) return rawGap.replace(/\r\n/g, '\n')
    // An authored setext heading kept after a paragraph needs a blank line:
    // the paragraph line would become part of its text (`para` + `text` +
    // `-`; fuzz seed 226, a block moved in front of it).
    if (prev?.type.name === 'paragraph' && isSetextMd(nextMd)) {
      return blankSeparator(frame)
    }
    if (typeof rawGap === 'string' && /^[ \t]*\r?\n[ \t>]*$/.test(rawGap) && tightAllowed(prev, next)) {
      return rawGap.replace(/\r\n/g, '\n')
    }
    // No usable authored gap: follow the container's own convention when a
    // single newline is safe for this pair, else a blank line.
    const containerTight = !/\n[ \t>]*\n/.test(containerSeparator)
    return containerTight && tightAllowed(prev, next) ? tightSeparator(frame) : blankSeparator(frame)
  }

  // Replace old children [oldFrom, oldTo) by new children [newFrom, newTo).
  // The replaced range includes the gaps to the unchanged neighbours, so each
  // boundary gets a separator chosen for that exact pair of blocks.
  // encodedNew (doc level) → empty paragraphs right before each block.
  const blankRunsBefore = new WeakMap()
  const replaceRegion = (srcNode, mdNode, kids, newNode, gap, frame, separator, newNodes, oldChildren) => {
    const printedNew = []
    // A list printed in place of removed blocks keeps the markers of a
    // removed list of its kind (an empty `1) ` lifted into the `+ literal`
    // list above it reprinted that list with `-`).
    const removedLists = kids.slice(gap.oldFrom, gap.oldTo).filter((md) => md?.type === 'list')
    const usedLists = []
    for (let index = gap.newFrom; index < gap.newTo; index += 1) {
      const node = newNodes[index]
      if (isBlankParagraph(node)) continue // no encoding
      let listMd = null
      if (isList(node)) {
        const at = removedLists.findIndex((md) => Boolean(md.ordered) === (node.type.name === 'ordered_list'))
        if (at >= 0) {
          listMd = removedLists.splice(at, 1)[0]
          usedLists.push(listMd)
        } else if (node.type.name === 'bullet_list') {
          // One list split in two (Enter twice in its middle): the second
          // part keeps the bullet too.
          listMd = usedLists.find((md) => !md.ordered) || null
        }
      }
      const printed = typedThematicBreak(node, kids.slice(gap.oldFrom, gap.oldTo)) ?? printBlock(node, newNode, mdNode, index, listMd)
      if (printed == null) return false
      printedNew.push({ node, text: indentContinuation(printed, frame.prefix), newIndex: index, listMd })
    }
    const prevIndex = gap.oldFrom - 1
    const nextIndex = gap.oldTo
    const prev = prevIndex >= 0 ? { node: oldChildren[prevIndex], md: kids[prevIndex], index: prevIndex, newIndex: gap.newFrom - 1 } : null
    const next = nextIndex < kids.length ? { node: oldChildren[nextIndex], md: kids[nextIndex], index: nextIndex, newIndex: gap.newTo } : null
    const blankRuns = blankRunsBefore.get(newNodes)
    let from = prev ? endOf(prev.md) : (gap.oldTo > gap.oldFrom ? startOf(kids[gap.oldFrom]) : next ? startOf(next.md) : null)
    if (!prev && from != null && printedNew.length) from = wholeBlockFrom(from, printedNew[0].text, frame.prefix)
    let to = next ? startOf(next.md) : (gap.oldTo > gap.oldFrom ? endOf(kids[gap.oldTo - 1]) : prev ? endOf(prev.md) : null)
    // Lines after a quote's last child that hold only `>` markers and
    // blanks read back as nothing (an empty paragraph written as `>` + `> `
    // after Enter in a quote): they are the quote's empty tail. Blocks
    // appended at its end take their place — left there, they followed the
    // paragraph typed into that empty line (test:middle-blockquote-empty-
    // paragraph-ui, RS-65).
    if (!next && to != null && srcNode.type.name === 'blockquote' && Number.isInteger(endOf(mdNode)) && endOf(mdNode) > to &&
        /^(?:\r?\n[ \t]*(?:>[ \t]*)+)+$/.test(body.slice(to, endOf(mdNode)))) {
      to = endOf(mdNode)
    }
    // An empty document (its text all deleted: `\n`, or nothing) has no
    // block to anchor on: the new blocks become the whole source. Without
    // this every edit after emptying a document failed to sync until the
    // warning (Air trace 2026-11-06: a heading emptied, then a whole page
    // typed). Only when the source is blank — front matter or definitions
    // also leave no block here.
    let wholeDocument = false
    if (from == null && to == null && !kids.length && srcNode.type.name === 'doc' && !body.trim() && printedNew.length) {
      from = 0
      to = body.length
      wholeDocument = true
    }
    if (from == null || to == null) return false
    // The authored gap that followed `left` (or preceded `right`) — never a
    // slice spanning deleted blocks.
    const rawGapBetween = (left, right) => {
      if (left?.md && Number.isInteger(left.index) && left.index + 1 < kids.length) {
        const gap = body.slice(endOf(left.md), startOf(kids[left.index + 1]))
        if (right?.md === kids[left.index + 1]) return gap
        // Its last line ends with the indent of the block that used to follow
        // (`  ```` after a paragraph): another block put there must not take
        // it — a moved list read `  - l` (fuzz seed 940).
        const newline = gap.lastIndexOf('\n')
        const last = gap.slice(newline + 1)
        return newline >= 0 && last.startsWith(frame.prefix) && /^[ \t]+$/.test(last.slice(frame.prefix.length))
          ? gap.slice(0, newline + 1) + frame.prefix
          : gap
      }
      if (right?.md && Number.isInteger(right.index) && right.index > 0) {
        return body.slice(endOf(kids[right.index - 1]), startOf(right.md))
      }
      return undefined
    }
    const sequence = [...(prev ? [prev] : []), ...printedNew, ...(next ? [next] : [])]
    const insertionOnly = gap.oldTo === gap.oldFrom && printedNew.length > 0
    let text = ''
    for (let index = 0; index < sequence.length; index += 1) {
      const item = sequence[index]
      if (index > 0) {
        const left = sequence[index - 1]
        // An authored gap next to an unchanged neighbour is reused when it is
        // still valid for the new pair.
        let raw = left.md || item.md ? rawGapBetween(left.md ? left : null, item.md ? item : null) : undefined
        // Blocks inserted into a top-level gap of several blank lines (the
        // line kept for an emptied paragraph, or authored spacing) take one
        // blank line on each side rather than duplicating the run (Typora).
        if (insertionOnly && srcNode.type.name === 'doc' && typeof raw === 'string' && /^(?:[ \t]*\r?\n){3,}[ \t]*$/.test(raw)) {
          raw = '\n\n'
        }
        // Between two kept blocks too: a block removed from between them
        // whose slot the editor still shows as empty paragraphs (a second
        // paragraph emptied after the first one's line was saved: the raw gap
        // before the removed block only holds the first one's line).
        const blanks = blankRuns ? blankRuns[item.newIndex] || 0 : 0
        // ...except between two lists that read back as ONE list (same kind
        // and marker): blank lines there only make it loose. Enter twice in
        // the middle of a list (RS-86) splits it around an empty paragraph
        // that has no Markdown; the list is written as it was.
        const merged = blanks ? mergedListSeparator(left, item, frame) : null
        if (merged != null) {
          text += merged
        } else {
          text += blanks ? '\n'.repeat(2 * (blanks + 1)) : pairSeparator(srcNode, left.node, item.node, frame, raw, separator, item.md)
        }
      }
      if (!item.md) text += item.text
    }
    // Every body row removed: the delimiter row still follows the header.
    if (srcNode.type.name === 'table' && prev?.node.type.name === 'table_header_row' && sequence.length === 1) {
      text += headerDelimiter(srcNode, rawGapBetween(prev, null), separator)
    }
    // An indented code block kept right after what is now a list would read
    // as that list's continuation — indented code has no spelling there — so
    // it is fenced, like Typora writes code. Yuque exports nest lists as
    // "blank + 4 spaces" (indented code); Backspace joining the paragraph
    // between the list and that code made every later edit pause (fuzz,
    // Yuque fixture seeds 46/47).
    // `2. text` is paragraph text only where it cannot start a list (right
    // after indented code — micromark; Yuque writes it there). A kept
    // paragraph like that whose predecessor changed is escaped (`2\. text`),
    // unless that predecessor is still authored indented code.
    const isIndentedCode = (md) => {
      if (md?.type !== 'code') return false
      const at = startOf(md)
      return lineStartOf(body, at) === at && /^(?: {4}|\t)/.test(body.slice(at, at + 4))
    }
    const escapeOrderedLead = (md) => {
      const at = startOf(md)
      if (md?.type !== 'paragraph' || lineStartOf(body, at) !== at) return
      const marker = /^(\d{1,9})[.)]/.exec(body.slice(at, at + 11))
      if (marker) replace(at + marker[1].length, at + marker[1].length, '\\')
    }
    // The kept next block's authored indent past the frame prefix (a fence
    // at `  ````): its content lines are read against it.
    const nextLead = (() => {
      if (!next || !(to > from)) return ''
      const lineStart = body.lastIndexOf('\n', to - 1) + 1
      const lead = lineStart > from ? body.slice(lineStart, to) : ''
      const extra = lead.startsWith(frame.prefix) ? lead.slice(frame.prefix.length) : ''
      return /^[ \t]+$/.test(extra) ? extra : ''
    })()
    let nextReprinted = false
    if (next && srcNode.type.name === 'doc') {
      const before = sequence[sequence.length - 2]
      // An indented code block kept right after what is now a list would
      // read as that list's continuation — indented code has no spelling
      // there — so it is fenced, like Typora writes code. Yuque nests lists
      // as "blank + 4 spaces" (indented code); Backspace joining the
      // paragraph between the list and that code made every later edit
      // pause (fuzz, Yuque fixture seeds 46/47).
      if (next.node.type.name === 'code_block' && isList(before?.node) && isIndentedCode(next.md) && gap.newTo < newNodes.length) {
        const fenced = printBlock(newNodes[gap.newTo], newNode, mdNode, gap.newTo)
        if (fenced == null || !/^(```|~~~)/.test(fenced)) return false
        replace(startOf(next.md), endOf(next.md), fenced)
        escapeOrderedLead(kids[nextIndex + 1])
      } else if (nextLead && isList(before?.node) && !isList(next.node) && gap.newTo < newNodes.length) {
        // Indented after what is now a list, it would be read as that list's
        // continuation (`- x` + blank + `  ````); without the indent a
        // fence's content gains it. Printed whole at the margin (seed 940).
        const printed = printBlock(newNodes[gap.newTo], newNode, mdNode, gap.newTo, next.md)
        if (printed == null) return false
        replace(startOf(next.md), endOf(next.md), printed)
        nextReprinted = true
        // The authored gap before it ends with that indent (its position
        // starts after it): kept, the block still read as the list's
        // continuation (fuzz UI seed 1607, a list dragged in front of
        // `   p`).
        if (text.endsWith(frame.prefix + nextLead)) text = text.slice(0, text.length - nextLead.length)
      } else if (!(before?.md && isIndentedCode(before.md))) {
        escapeOrderedLead(next.md)
      }
    }
    // The kept next block keeps its authored indent: its position starts
    // after it, but a fence's content lines are read relative to it
    // (`  ```` + `  code`). A separator ending at the frame prefix dropped it
    // and every code line gained two spaces (fuzz seed 940, block drag).
    if (nextLead && !nextReprinted && text.includes('\n')) {
      const lastLine = text.slice(text.lastIndexOf('\n') + 1)
      if (lastLine === frame.prefix || lastLine === frame.prefix.replace(/[ \t]+$/, '')) {
        text = text.slice(0, text.length - lastLine.length) + frame.prefix + nextLead
      }
    }
    // `from`/`to` exclude the unchanged neighbours' own bytes.
    replace(from, to, wholeDocument ? `${text}\n` : text)
    notes.push({ level: 'region', parent: srcNode.type.name, removed: gap.oldTo - gap.oldFrom, inserted: printedNew.length })
    return true
  }

  const ok = srcDoc.type === editorDoc.type && patchContainer(srcDoc, mdRoot, editorDoc, { prefix: '', quoteDepth: 0 })
  if (!ok) return { ok: false, reason: 'reprint-unexpressible', notes }

  // Apply edits back to front; overlapping edits mean a logic error.
  // A block without source offsets (a remark transform that dropped
  // `position`) must never be spliced: slice(undefined) is the whole text,
  // which printed the document twice around the edit.
  if (edits.some((edit) => !Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from > edit.to)) {
    return { ok: false, reason: 'reprint-unpositioned', notes }
  }
  edits.sort((left, right) => right.from - left.from || right.to - left.to)
  let markdown = body
  let floor = Infinity
  for (const edit of edits) {
    if (edit.to > floor) return { ok: false, reason: 'reprint-overlapping-edits', notes, edits: edits.map(({ from, to, text }) => ({ from, to, text: text.slice(0, 120), was: body.slice(from, to).slice(0, 120) })) }
    markdown = markdown.slice(0, edit.from) + edit.text + markdown.slice(edit.to)
    floor = edit.from
  }
  return { ok: true, markdown: bom + markdown, edits, notes, degraded }
}
