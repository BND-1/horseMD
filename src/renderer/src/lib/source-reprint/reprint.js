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

import { Fragment } from '@milkdown/prose/model'
import { buildInlineMap, pmInlineUnits } from './inline-map.js'
import { cachedParse, parseMarkdownCached, rememberParse } from './incremental-parse.js'

const SENTINEL = '​'

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
const attrsEqual = (left, right) => {
  if (left.type !== right.type) return false
  const ignored = new Set(ignoredAttrs[left.type.name] || [])
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
// off whitespace; Milkdown moves edge blanks out of every mark run).
const INVISIBLE_ON_BLANK = new Set(['strong', 'emphasis', 'link', 'html_span'])
const inlineRunsModuloAutolinks = (block) => {
  const runs = []
  const push = (text, marks) => {
    if (!text) return
    const previous = runs[runs.length - 1]
    if (previous && previous.marks && sameMarkSet(previous.marks, marks)) previous.text += text
    else runs.push({ text, marks })
  }
  let afterHardBreak = false
  block.forEach((child) => {
    if (!child.isText) {
      runs.push({ node: child })
      afterHardBreak = /^hard_?break$/.test(child.type.name)
      return
    }
    const marks = child.marks.filter((mark) => !isAutolinkLiteral(child, mark))
    // Blanks at the start of the line after a line break have no Markdown
    // spelling outside an HTML tag: compare that line start without them.
    let text = afterHardBreak ? child.text.replace(/^[ \t]+/, '') : child.text
    afterHardBreak = afterHardBreak && !text
    const blankMarks = marks.filter((mark) => !INVISIBLE_ON_BLANK.has(mark.type.name))
    const isCode = marks.some((mark) => mark.type.name === 'inlineCode')
    for (const piece of isCode ? [text] : text.split(/([ \t]+)/)) {
      push(piece, !isCode && /^[ \t]+$/.test(piece) ? blankMarks : marks)
    }
  })
  return runs
}
const sameInlineModuloAutolinks = (left, right) => {
  const a = inlineRunsModuloAutolinks(left)
  const b = inlineRunsModuloAutolinks(right)
  return a.length === b.length && a.every((run, index) => {
    const other = b[index]
    if (run.node || other.node) return Boolean(run.node && other.node) && sameNode(run.node, other.node)
    return run.text === other.text && sameMarkSet(run.marks, other.marks)
  })
}

// Structural equality minus editor-only attrs (recursive).
export function sameNode(left, right) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.eq(right)) return true
  if (left.isTextblock && right.isTextblock && left.type === right.type && !left.type.spec.code &&
      attrsEqual(left, right) && sameInlineModuloAutolinks(left, right)) return true
  if (!attrsEqual(left, right) || left.childCount !== right.childCount) return false
  if (left.isText) return left.text === right.text && sameMarkSet(left.marks, right.marks)
  if (left.isLeaf) return true
  for (let index = 0; index < left.childCount; index += 1) {
    if (!sameNode(left.child(index), right.child(index))) return false
  }
  return true
}

const isEmptyTextblock = (node) => node?.isTextblock && node.content.size === 0
// A paragraph holding only spaces/tabs has no encoding either: trailing
// whitespace is stripped, so it parses as nothing (fuzz seed 49).
const isBlankParagraph = (node) => {
  if (node?.type?.name !== 'paragraph') return false
  let blank = true
  node.forEach((child) => { if (!child.isText || /[^ \t]/.test(child.text)) blank = false })
  return blank
}

// LCS over two node arrays with sameNode; returns aligned pairs.
const diffSequences = (oldNodes, newNodes) => {
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

const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/

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

export function reprintSource({ source, editorDoc, previousDoc = null, parse, parseTree = null, remark, serialize, escape = 'minimal' }) {
  // `escape: 'segment'` skips character patches: every changed text block
  // reprints whole top-level inline segments, which re-escapes literal
  // delimiters around the edit (`**` + typed text → `\*你好\*`; seed 50).
  const segmentOnly = escape === 'segment'
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const body = bom ? source.slice(1) : source
  const eol = /\r\n/.test(body) ? '\r\n' : '\n'
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
  const schema = editorDoc.type.schema
  const docWith = (nodes) => schema.topNodeType.create(null, nodes)
  const toEol = (text) => (eol === '\n' ? text : text.replace(/\r?\n/g, eol))
  // Shapes with no Markdown spelling are normalized before printing
  // (design §5): emphasis/strong/strike around only whitespace or a break
  // loses the mark; a text block's leading/trailing line breaks are dropped.
  const SPAN_MARKS = new Set(['strong', 'emphasis', 'strike_through', 'highlight'])
  // Stand-in for a blank at the start of the line after a hard break: not
  // whitespace, so Milkdown does not move it out of a <font>/<span> (where
  // Yuque writes it and where it survives parsing); printed back below.
  const LINE_START_BLANK = '\uE000'
  const normalizeForPrint = (node, { trimBreaks = true, inCell: inCellAbove = false } = {}) => {
    if (node.isText) {
      if (node.text.trim() === '' && node.marks.some((mark) => SPAN_MARKS.has(mark.type.name))) {
        return node.mark(node.marks.filter((mark) => !SPAN_MARKS.has(mark.type.name)))
      }
      return node
    }
    if (node.isLeaf) {
      // A line break inside an editable <font>/<span> stays inside it (Yuque's
      // `text  \n</font>`). With a delimiter mark on it too the break leaves
      // every mark, as before: keeping only the span would cross the nesting
      // (`_<font>a_` + break + `_</font>`; Yuque's `_…</font>__<font>…_`).
      if (/^hard_?break$/.test(node.type.name) && node.marks.length) {
        return node.marks.every((mark) => mark.type.name === 'html_span') ? node : node.mark([])
      }
      return node
    }
    const children = []
    // Inside a table cell a line break is a visible `<br>`: keep it.
    const inCell = /^table_(cell|header)$/.test(node.type.name)
    node.forEach((child) => children.push(normalizeForPrint(child, { trimBreaks: trimBreaks && !inCell, inCell: inCellAbove || inCell })))
    // A heading of only spaces has no encoding beyond the empty heading
    // (`#     ` parses as `#`; seed 71).
    if (node.type.name === 'heading' && children.every((child) => child.isText && !/[^ \t]/.test(child.text))) {
      return node.copy(Fragment.empty)
    }
    if (node.isTextblock) {
      const isSoftBreak = (child) => /^hard_?break$/.test(child?.type?.name || '') && child.attrs?.isInline === true
      if (trimBreaks) {
        // Outside table cells a hard break at the very start or end has no
        // encoding either (`  \n` there is a blank line / is dropped).
        const isEdgeBreak = (child) => /^hard_?break$/.test(child?.type?.name || '')
        if (children.some((child) => !isEdgeBreak(child))) {
          while (children.length && isEdgeBreak(children[0])) children.shift()
          while (children.length && isEdgeBreak(children[children.length - 1])) children.pop()
        } else {
          while (children.length && isSoftBreak(children[0])) children.shift()
          while (children.length && isSoftBreak(children[children.length - 1])) children.pop()
        }
      }
      // Spaces before a line break have no encoding (and 2+ would turn a soft
      // break into a hard one): drop them.
      const isAnyBreak = (child) => /^hard_?break$/.test(child?.type?.name || '')
      for (let index = 0; index < children.length - 1; index += 1) {
        const child = children[index]
        if (child.isText && isAnyBreak(children[index + 1]) && /[ \t]+$/.test(child.text)) {
          const text = child.text.replace(/[ \t]+$/, '')
          children[index] = text ? node.type.schema.text(text, child.marks) : null
        }
      }
      for (let index = children.length - 1; index >= 0; index -= 1) if (!children[index]) children.splice(index, 1)
      // Milkdown's serializer moves edge spaces out of every mark run, but it
      // picks the outer run's "last text child" even when a nested run follows
      // it: `*alph* + ***␠a b***` prints `*alph**a b*** ` and the space is lost
      // (seed 57). Blanks where the bold/italic marks change have no visible
      // meaning (the validator moves them too), so print them unmarked.
      const isSpan = (mark) => SPAN_MARKS.has(mark.type.name)
      const splitEdgeBlanks = []
      children.forEach((child, index) => {
        if (!child?.isText || !child.marks.some(isSpan) || child.marks.some((mark) => mark.type.name === 'inlineCode')) {
          splitEdgeBlanks.push(child)
          return
        }
        const match = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(child.text)
        // An editable <font>/<span> leaves the blank too: alone it would print
        // as an empty `<font …></font>` (Milkdown moves the space out), which
        // parses back as raw html. Edge blanks of a span compare unmarked.
        const plainMarks = child.marks.filter((mark) => !isSpan(mark) && mark.type.name !== 'html_span')
        // At the block start too: with a span nested in bold, Milkdown's
        // #moveSpaces hands the inner run's leading blank to the outer run as
        // its only text child and then moves it out as TRAILING space
        // (`**<font> b</font>**` → `**<font>b</font>** `). Split first; the
        // block-start blank prints as `&#x20;`.
        const lead = (index === 0 || children[index - 1]?.isText) ? match[1] : ''
        const trail = index < children.length - 1 && children[index + 1]?.isText ? match[3] : ''
        if ((!lead && !trail) || !match[2]) {
          splitEdgeBlanks.push(child)
          return
        }
        if (lead) splitEdgeBlanks.push(node.type.schema.text(lead, plainMarks))
        splitEdgeBlanks.push(node.type.schema.text(lead ? match[2] + (trail ? '' : match[3]) : match[1] + match[2], child.marks))
        if (trail) splitEdgeBlanks.push(node.type.schema.text(trail, plainMarks))
      })
      children.splice(0, children.length, ...splitEdgeBlanks)
      // ...nor do blanks at the start of a continuation line, after a soft
      // break (CommonMark strips them; seed 129).
      // After a hard break (outside a table cell) they are kept, spelled so
      // they survive: Yuque's `_<font> text` holds one inside the tag, and
      // Milkdown would move a span's edge blank out to the line start, where
      // the parser drops it (and the next edit would reprint it again).
      const isHardLineBreak = (child) => !inCellAbove && !inCell && /^hard_?break$/.test(child?.type?.name || '') && child.attrs?.isInline !== true
      for (let index = 1; index < children.length; index += 1) {
        const child = children[index]
        if (!child?.isText || !/^[ \t]+/.test(child.text)) continue
        if (isSoftBreak(children[index - 1])) {
          const text = child.text.replace(/^[ \t]+/, '')
          children[index] = text ? node.type.schema.text(text, child.marks) : null
        } else if (isHardLineBreak(children[index - 1])) {
          const text = child.text.replace(/^[ \t]+/, (blanks) => LINE_START_BLANK.repeat(blanks.length))
          children[index] = node.type.schema.text(text, child.marks)
        }
      }
      // Blanks right before a soft break have no encoding either (2+ would
      // make it a hard break; seed 119: a deleted link left `bet    `).
      for (let index = 0; index < children.length - 1; index += 1) {
        const child = children[index]
        if (child?.isText && isSoftBreak(children[index + 1]) && /[ \t]+$/.test(child.text)) {
          const text = child.text.replace(/[ \t]+$/, '')
          children[index] = text ? node.type.schema.text(text, child.marks) : null
        }
      }
      for (let index = children.length - 1; index >= 0; index -= 1) if (!children[index]) children.splice(index, 1)
    }
    return node.copy(Fragment.fromArray(children))
  }
  // Empty text blocks print as Crepe's `<br />` placeholder; in source an
  // empty paragraph/item body is simply empty.
  const withoutPlaceholders = (text) => text.replace(
    /^([ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*)*)<br\s*\/?>[ \t]*$/gm,
    // GFM needs body content after `[ ]` to keep a task: an empty task body
    // is the U+200B sentinel (RS-50 convention).
    (match, prefix) => (/\[[ xX]\][ \t]*$/.test(prefix) ? prefix.replace(/[ \t]*$/, ' ') + SENTINEL : prefix.replace(/[ \t]+$/, ''))
  )
  // A trailing space has no encoding; the serializer's `&#x20;` at a line
  // end only adds noise.
  const serializeNodes = (nodes, options) => withoutPlaceholders(
    serialize(docWith(nodes.map((node) => normalizeForPrint(node, options)))).replace(/\n+$/, '')
  ).replace(/(?:&#x20;)+(?=\n|$)/g, '')
    // A leading space right after a block prefix (`## `, `- `, `> `) keeps
    // the sentinel spelling (fuzz seed 66: Enter before the space of a
    // heading); every other mid-line `&#x20;` is a plain space.
    .replace(/(^|\n)((?:[ \t]*(?:>|[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+(?:\[[ xX]\][ \t]+)?)+)&#x20;/g, `$1$2${SENTINEL} `)
    .replace(/(?<=[^\n])&#x20;/g, ' ')
    // Line-start blanks after a hard break: `&#x20;` at the line start,
    // a plain space after an opening tag or delimiter.
    .replace(/(^|\n)([ \t]*(?:>[ \t]?)*)(\uE000+)/g, (_match, start, prefix, blanks) => start + prefix + '&#x20;'.repeat(blanks.length))
    .replace(/\uE000/g, ' ')

  // Prefix every line after the first; blank lines get the trimmed prefix.
  const indentContinuation = (text, prefix) => text
    .split('\n')
    .map((line, index) => (index === 0 ? line : line ? prefix + line : prefix.replace(/[ \t]+$/, '')))
    .join('\n')

  const replace = (from, to, text, note) => {
    edits.push({ from, to, text: toEol(text) })
    if (note) notes.push(note)
  }

  // ---- children alignment -------------------------------------------------
  const mdChildren = (pmNode, mdNode) => {
    let kids = mdNode.children || []
    if (pmNode.type.name === 'doc') kids = kids.filter((child) => !MD_SKIP_IN_DOC.has(child.type))
    if (kids.length === pmNode.childCount) return kids
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
      return { prefix: frame.prefix + ' '.repeat(width), quoteDepth: frame.quoteDepth }
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
    const allSame = numbers.every((value) => value === numbers[0])
    const number = allSame ? numbers[0] : (numbers[0] || 1) + itemIndexInNew
    return `${number}${delimiter}`
  }

  // Leading spaces are spelled with the U+200B sentinel (Typora), not the
  // serializer's `&#x20;`, at the start of any printed line or item body.
  const withSentinels = (text) => text.replace(
    /(^|\n)((?:[ \t]*(?:>|[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+(?:\[[ xX]\][ \t]+)?)*)&#x20;/g,
    `$1$2${SENTINEL} `
  )
  // A cell is one line: runs between line breaks joined with `<br>` (leading
  // and trailing breaks included), pipes escaped.
  const printCellFragment = (fragment) => {
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
    table.forEach((row) => rows.push(row))
    if (!rows.length) return null
    const width = Math.max(...rows.map((row) => row.childCount))
    const cellsOf = (row) => {
      const cells = []
      row.forEach((cell) => cells.push(cell.childCount === 1 ? printCellFragment(cell.child(0).content).trim() : ''))
      while (cells.length < width) cells.push('')
      return cells
    }
    const line = (cells) => `| ${cells.join(' | ')} |`
    let delimiter = null
    if (mdTable?.position) {
      const lines = body.slice(startOf(mdTable), endOf(mdTable)).split(/\r?\n/)
      const authored = lines[1]?.trim()
      const segments = authored ? authored.replace(/^\||\|$/g, '').split('|') : []
      if (segments.length === width && segments.every((segment) => /^\s*:?-+:?\s*$/.test(segment))) delimiter = authored
    }
    if (!delimiter) {
      const aligns = []
      rows[0].forEach((cell) => aligns.push(cell.attrs.alignment))
      while (aligns.length < width) aligns.push(null)
      delimiter = `| ${aligns.map((align) => align === 'left' ? ':---' : align === 'center' ? ':---:' : align === 'right' ? '---:' : '---').join(' | ')} |`
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
  const listMarker = (list, listMd, index) => {
    const ordered = list.type.name === 'ordered_list'
    const authored = listMd ? markerFor(listMd, index, ordered) : null
    if (authored) return authored
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
    let text
    if (firstEmpty) {
      // GFM needs body content after `[ ]` (RS-50: U+200B); a plain empty
      // item is just its marker.
      text = task ? `${head} ${SENTINEL}` : head
    } else {
      let firstText = printNode(first)
      // Spaces after the marker are swallowed as marker padding.
      if (first.isTextblock && /^[ \t]/.test(firstText)) firstText = SENTINEL + firstText
      text = `${head} ${indentLines(firstText, indent)}`
    }
    let previous = firstEmpty ? null : first
    for (const child of taskLedByBlock ? children : children.slice(1)) {
      if (isEditorOnlyParagraph(child)) continue
      // An item that starts empty cannot have a blank line before its content.
      const separator = !previous || tightAllowed(previous, child) ? '\n' : '\n\n'
      text += separator + indent + indentLines(printNode(child), indent)
      previous = child
    }
    return text
  }
  const printBlock = (node, parentNode, parentMd, indexInNew, oldMd = null) => {
    if (node.type.name === 'list_item') {
      const sameKind = parentMd?.type === 'list' && Boolean(parentMd.ordered) === (parentNode.type.name === 'ordered_list')
      return printItem(node, listMarker(parentNode, sameKind ? parentMd : null, indexInNew))
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
      output = sentinel ? output.replace(/^([ \t]+)/, `${SENTINEL}$1`) : output.replace(/^[ \t]+/, '')
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
  const INVISIBLE_ON_BLANK = new Set(['strong', 'emphasis', 'link', 'html_span'])
  const visibleMarks = (marks) => (marks || []).filter((mark) => !INVISIBLE_ON_BLANK.has(mark.type.name))
  const sameUnit = (left, right) => {
    if (!left || !right || left.kind !== right.kind) return false
    if (left.kind === 'char') {
      if (left.char !== right.char) return false
      if (left.char === ' ' || left.char === '\t') return sameMarkSet(visibleMarks(left.marks), visibleMarks(right.marks))
      return sameMarkSet(left.marks, right.marks)
    }
    if (/^hard_?break$/.test(left.node?.type?.name || '') && left.node.type === right.node?.type) {
      return (left.node.attrs?.isInline === true) === (right.node.attrs?.isInline === true)
    }
    return sameMarkSet(left.marks, right.marks) && sameNode(left.node, right.node)
  }

  // Patch one text block. `mdBlock` is the mdast paragraph/heading/tableCell.
  const patchTextblock = (srcBlock, mdBlock, newBlock, frame, { cell = false } = {}) => {
    const map = buildInlineMap({ source: body, block: mdBlock, quoteDepth: frame.quoteDepth })
    const oldUnits = pmInlineUnits(srcBlock)
    if (!map || map.units.length !== oldUnits.length) {
      degraded = true
      return false
    }
    // Whitespace at the end of a text block (and at both edges of a cell) has
    // no encoding — the parsed source never has it, the editor may. Leave it
    // out of the diff, or every reprint would append it again (design §5).
    const isBlank = (unit) => unit?.kind === 'char' && (unit.char === ' ' || unit.char === '\t')
    const newUnits = pmInlineUnits(newBlock)
    while (newUnits.length && isBlank(newUnits[newUnits.length - 1]) && !isBlank(oldUnits[oldUnits.length - 1])) newUnits.pop()
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
          printed = printCellFragment(fragment)
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
  const patchNodeInner = (srcNode, mdNode, newNode, frame) => {
    const name = srcNode.type.name
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
    if (CONTAINERS.has(name)) {
      if (!attrsEqual(srcNode, newNode)) return false
      return patchContainer(srcNode, mdNode, newNode, frame)
    }
    return false
  }

  const patchCodeBlock = (srcNode, mdNode, newNode, frame) => {
    if (!attrsEqual(srcNode, newNode)) return false
    const start = startOf(mdNode)
    const end = endOf(mdNode)
    const raw = body.slice(start, end)
    const lines = raw.split(/\r?\n/)
    // `$$` math blocks (lang LaTeX, remark-math) are fenced like code: the
    // content lines sit between the `$$` lines, which stay authored.
    const open = mdNode?.lang === 'LaTeX'
      ? /^([ \t]*)(`{3,}|~{3,}|\${2,})/.exec(lines[0])
      : /^([ \t]*)(`{3,}|~{3,})/.exec(lines[0])
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
      const lead = frame.prefix + before.slice(frame.prefix.length) + indent
      const text = contentLines
        .map((line, index) => (index === 0 ? indent + line : line ? lead + line : frame.prefix.replace(/[ \t]+$/, '')))
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
    const firstLineEnd = body.indexOf('\n', start) + 1
    const lastLineStart = lineStartOf(body, end)
    const content = newNode.textContent
    const text = content
      ? content.split('\n').map((line) => (line ? frame.prefix + line : frame.prefix.replace(/[ \t]+$/, ''))).join('\n') + '\n'
      : ''
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
    const encodedNew = name === 'table_row' || name === 'table_header_row'
      ? newNodes
      : newNodes.filter((node) => !isEditorOnly(node) || emptiedSlots.has(node))
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
    const pairs = diffSequences(oldNodes, encodedNew)
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
              // Keep the line and its blank-line separators; drop the text.
              replace(startOf(md), endOf(md), '')
              notes.push({ level: 'emptied', at: startOf(md) })
              continue
            }
            const single = { oldFrom: gap.oldFrom + offset, oldTo: gap.oldFrom + offset + 1, newFrom: gap.newFrom + offset, newTo: gap.newFrom + offset + 1 }
            if (!replaceRegion(srcNode, mdNode, kids, newNode, single, innerFrame, separator, encodedNew, oldNodes)) return false
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
          if (
            blockContainer && (
              (predecessor && gapBefore != null && !/\n[ \t>]*\r?\n/.test(gapBefore) && !tightAllowed(predecessor, after)) ||
              (successor && gapAfter != null && !/\n[ \t>]*\r?\n/.test(gapAfter) && !tightAllowed(after, successor))
            )
          ) {
            const single = { oldFrom: oldIndex, oldTo: oldIndex + 1, newFrom: newIndex, newTo: newIndex + 1 }
            if (!replaceRegion(srcNode, mdNode, kids, newNode, single, innerFrame, separator, encodedNew, oldNodes)) return false
            continue
          }
          if (patchNode(before, md, after, innerFrame)) {
            survivors.push([oldIndex, newIndex])
          } else {
            const printed = printBlock(after, newNode, mdNode, gap.newFrom + offset, md)
            if (printed == null) return false
            replace(startOf(md), endOf(md), indentContinuation(printed, innerFrame.prefix))
            notes.push({ level: 'block', type: after.type.name })
          }
        }
        continue
      }
      if (!replaceRegion(srcNode, mdNode, kids, newNode, gap, innerFrame, separator, encodedNew, oldNodes)) return false
    }
    if (name === 'ordered_list') {
      renumberSurvivors(kids, survivors)
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
  const renumberSurvivors = (kids, survivors) => {
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
      const from = startOf(kids[oldIndex]) + entry.indent
      replace(from, from + entry.digits.length, expected)
    }
  }

  // Replace old children [oldFrom, oldTo) by new children [newFrom, newTo).
  // Can block `next` follow block `prev` on the very next line without
  // Markdown merging them (lazy continuation, setext underline, table rows,
  // HTML blocks running on)? Only then may a separator be a single newline.
  const isList = (node) => node?.type.name === 'bullet_list' || node?.type.name === 'ordered_list'
  const listCanInterrupt = (list) => {
    const first = list.firstChild
    // An item whose first line is only its marker (empty, blank, or starting
    // with a nested list: `-` + `  - x`) cannot interrupt a paragraph, and a
    // bare `-` right under a paragraph line is a setext underline (seed 79).
    const lead = first?.firstChild
    const emptyLine = !lead || (lead.isTextblock ? isBlankParagraph(lead) || lead.content.size === 0 : isList(lead))
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
  const pairSeparator = (container, prev, next, frame, rawGap, containerSeparator) => {
    const name = container.type.name
    if (name === 'bullet_list' || name === 'ordered_list' || name === 'table' || /^table_/.test(name)) {
      return containerSeparator
    }
    const rawHasBlank = typeof rawGap === 'string' && /\n[ \t>]*\r?\n/.test(rawGap)
    if (rawHasBlank) return rawGap.replace(/\r\n/g, '\n')
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
    for (let index = gap.newFrom; index < gap.newTo; index += 1) {
      const node = newNodes[index]
      if (isBlankParagraph(node)) continue // no encoding
      const printed = printBlock(node, newNode, mdNode, index)
      if (printed == null) return false
      printedNew.push({ node, text: indentContinuation(printed, frame.prefix), newIndex: index })
    }
    const prevIndex = gap.oldFrom - 1
    const nextIndex = gap.oldTo
    const prev = prevIndex >= 0 ? { node: oldChildren[prevIndex], md: kids[prevIndex], index: prevIndex, newIndex: gap.newFrom - 1 } : null
    const next = nextIndex < kids.length ? { node: oldChildren[nextIndex], md: kids[nextIndex], index: nextIndex, newIndex: gap.newTo } : null
    const blankRuns = blankRunsBefore.get(newNodes)
    const from = prev ? endOf(prev.md) : (gap.oldTo > gap.oldFrom ? startOf(kids[gap.oldFrom]) : next ? startOf(next.md) : null)
    const to = next ? startOf(next.md) : (gap.oldTo > gap.oldFrom ? endOf(kids[gap.oldTo - 1]) : prev ? endOf(prev.md) : null)
    if (from == null || to == null) return false
    // The authored gap that followed `left` (or preceded `right`) — never a
    // slice spanning deleted blocks.
    const rawGapBetween = (left, right) => {
      if (left?.md && Number.isInteger(left.index) && left.index + 1 < kids.length) {
        return body.slice(endOf(left.md), startOf(kids[left.index + 1]))
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
        const blanks = blankRuns && (!left.md || !item.md) ? blankRuns[item.newIndex] || 0 : 0
        text += blanks ? '\n'.repeat(2 * (blanks + 1)) : pairSeparator(srcNode, left.node, item.node, frame, raw, separator)
      }
      if (!item.md) text += item.text
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
      } else if (!(before?.md && isIndentedCode(before.md))) {
        escapeOrderedLead(next.md)
      }
    }
    // `from`/`to` exclude the unchanged neighbours' own bytes.
    replace(from, to, text)
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
    if (edit.to > floor) return { ok: false, reason: 'reprint-overlapping-edits', notes }
    markdown = markdown.slice(0, edit.from) + edit.text + markdown.slice(edit.to)
    floor = edit.from
  }
  return { ok: true, markdown: bom + markdown, edits, notes, degraded }
}
