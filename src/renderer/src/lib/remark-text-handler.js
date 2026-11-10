import { cjkFriendlyToMarkdown } from 'mdast-util-to-markdown-cjk-friendly'
import { gfmTableToMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item'
import { defaultHandlers } from 'mdast-util-to-markdown'

// Milkdown's default remark `text` stringify handler has a fast path,
// `if (/^[^*_\\]*\s+$/.test(value)) return value`, meant to keep the space
// before a mark (`a **b**`) from being entity-encoded. It also skips every
// other escape for ANY text node that ends in whitespace — typically the text
// right before inline code. So a paragraph whose text is `    second ` +
// `code` serialized as `    second \`code\``, which reopens as an indented
// code block; `1. foo ` / `# h ` / `- x ` / `> q ` before inline code became a
// list / heading / quote (fuzz seed 36, 2026-10-06: Tab at a paragraph start
// inserts four spaces). The canonical then agreed with the broken candidate,
// so validation could not catch it.
//
// Keep the fast path's intent — trailing whitespace stays raw — but escape the
// non-whitespace head with the normal `state.safe`. A whitespace-only run is
// raw unless it starts a line with a space/tab, whose first character is encoded exactly
// as mdast-util-to-markdown encodes any other leading space (`&#x20;`, which
// source preservation spells as the U+200B sentinel).
const TRAILING_WHITESPACE_FAST_PATH = /^([^*_\\]*?)(\s+)$/

const encodeCharacter = (character) =>
  `&#x${character.charCodeAt(0).toString(16).toUpperCase()};`

// GFM strikethrough escapes EVERY `~` in text, but with `singleTilde: false`
// (Typora parity) only `~~` strikes: a lone tilde typed or pasted as text —
// `1~2天`, `H~2~O` with subscript off — was saved as `1\~2天` / `H\~2\~O`,
// backslashes the user never typed (and, once subscript was turned on, the
// escaped `~2~` stayed text). Unescape a `\~` whose neighbours are ordinary
// characters; at a text-node edge it stays escaped (the next node may start
// with `~`). With subscript on (editor-subsup.js) every `~` must stay escaped.
let loneTildesNeedEscape = false
export function setLoneTildeEscaping(value) { loneTildesNeedEscape = value === true }
const unescapeLoneTildes = (text) => {
  if (loneTildesNeedEscape || !text.includes('\\~')) return text
  return text.replace(/\\~/g, (match, at, all) => {
    const before = all[at - 1]
    const after = all[at + 2]
    if (before == null || after == null) return match
    if (before === '~' || after === '~' || all.slice(at + 2, at + 4) === '\\~' || all.slice(at - 2, at) === '\\~') return match
    return '~'
  })
}

export function safeTrailingWhitespaceTextHandler(node, parent, state, info) {
  return unescapeLoneTildes(textHandler(node, parent, state, info))
}

function textHandler(node, parent, state, info) {
  // A table cell is one line: a line ending in its text (a soft break, or
  // `&#10;` read from the file) would end the row and lose the rest of it
  // (docs/rich-source-fuzzing.md read back cut, found by the projection
  // guard). It is written `&#10;`, as the file had it.
  if (/[\r\n]/.test(node.value) && state.stack?.includes('tableCell')) {
    const parts = node.value.split(/\r\n|\r|\n/)
    return parts.map((part, index) => (part
      ? textHandler({ ...node, value: part }, parent, state, { ...info, before: index ? ';' : info?.before, after: index < parts.length - 1 ? '&' : info?.after })
      : '')).join('&#10;')
  }
  // The CJK-friendly strong/emphasis handler (below) asks the next text node
  // to encode its first character when it is outside the BMP (an emoji):
  // `**foo.**&#x1F600;`. Its own text handler does that; this one replaces it.
  if (state.cjkFriendlyEncodeAfterSupplementaryText) {
    state.cjkFriendlyEncodeAfterSupplementaryText = false
    const [first = ''] = [...node.value]
    if (first) {
      const rest = textHandler({ ...node, value: node.value.slice(first.length) }, parent, state, { ...info, before: ';' })
      return `&#x${first.codePointAt(0).toString(16).toUpperCase()};${rest}`
    }
  }
  // U+200B + a space at the start of a text node is the leading-space
  // sentinel's spelling (markdown-leading-space.js strips it on read). Text
  // that really starts so is written with the entity, which reads back as
  // content (fuzz seed 1286).
  if (/^\u200B[ \t]/.test(node.value)) {
    const rest = textHandler({ ...node, value: node.value.slice(1) }, parent, state, { ...info, before: ';' })
    return `&#x200B;${rest}`
  }
  // Blanks right before a line break have no Markdown (CommonMark strips
  // them before a line ending; before a cell's `<br>` or a backslash break
  // they show nothing either). Written, two of them turn a soft break into
  // a hard one. Text of only blanks keeps its spelling (an empty line ends
  // the paragraph).
  const siblings = parent?.children
  const at = siblings ? siblings.indexOf(node) : -1
  const next = at >= 0 ? siblings[at + 1] : undefined
  // The end of a paragraph / heading is a line end too, whether or not a
  // block follows (the last block wrote its blanks, the others did not: the
  // same block serialized differently by position).
  const blockEnd = at >= 0 && at === siblings.length - 1 && (parent.type === 'paragraph' || parent.type === 'heading')
  const beforeBreak = blockEnd || next?.type === 'break' || next?.type === 'hmLineBreakRun' || /^[\r\n]/.test(info?.after || '')
  let value = node.value.replace(/([^ \t\r\n])[ \t]+(?=[\r\n])/g, '$1')
  if (beforeBreak && /[^ \t][ \t]+$/.test(value)) value = value.replace(/[ \t]+$/, '')
  const match = TRAILING_WHITESPACE_FAST_PATH.exec(value)
  if (!match) return state.safe(value, { ...info, encode: [] })
  const [, head, tail] = match
  if (!head) return blankLines(value, !info?.before || /[\r\n]$/.test(info.before), beforeBreak)
  const spelled = blankLines(tail, false, beforeBreak)
  if (!spelled) return state.safe(head, { ...info, encode: [] })
  return state.safe(head, { ...info, after: spelled[0], encode: [] }) + spelled
}

// Whitespace after the text's last visible character, line by line. Blanks
// before a line ending have no Markdown: CommonMark strips them, and two of
// them turn the soft break after them into a hard one (`**a**  ` + a soft
// break, a blank-only text after `&#10;`; projection guard). A line of ONLY
// blanks keeps one, encoded: dropped, the empty line would end the
// paragraph; raw, it is that empty line. A leading space/tab is indentation:
// its first character is encoded as mdast-util-to-markdown encodes any
// leading space (`&#x20;`, which source preservation spells as the U+200B
// sentinel). A soft-break text node ("\n") stays raw.
function blankLines(text, lineStart, endsWithBreak) {
  const parts = text.split(/(\r\n|\r|\n)/)
  let out = ''
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    const eol = parts[index + 1] || ''
    const atStart = index === 0 ? lineStart : true
    const endsLine = Boolean(eol) || (index === parts.length - 1 && endsWithBreak)
    let spelled = endsLine ? line.replace(/[ \t]+$/, '') : line
    if (endsLine && !spelled && line && atStart) spelled = line[0]
    if (atStart && /^[ \t]/.test(spelled)) spelled = encodeCharacter(spelled[0]) + spelled.slice(1)
    out += spelled + eol
  }
  return out
}

// Milkdown's default strong/emphasis stringify handlers keep the authored
// marker (`__x__` stays `__`) but skip CommonMark's attention encoding, so a
// bold run ending in punctuation followed by a letter printed `**foo.**abc`,
// which parses back as literal asterisks (Yuque exports: `**<font>…</font>**`
// then typed text). The CJK-friendly handlers (the ones remark-cjk-friendly
// registers, also handling `**「重点」**内容`) encode `**foo.**&#x61;bc`;
// wrap them so the node's own marker is still used.
const withMarker = (handle, option) => {
  const wrapped = (node, parent, state, info) => {
    const saved = state.options[option]
    if (node?.marker) state.options[option] = node.marker
    try {
      return handle(node, parent, state, info)
    } finally {
      state.options[option] = saved
    }
  }
  wrapped.peek = (node, _parent, state) => node?.marker || state.options[option] || '*'
  return wrapped
}

const cjkAttention = cjkFriendlyToMarkdown().handlers
export const strongStringifyHandler = withMarker(cjkAttention.strong, 'strong')
export const emphasisStringifyHandler = withMarker(cjkAttention.emphasis, 'emphasis')

// GFM strikethrough: the default `delete` handler pairs `~~` by plain
// CommonMark flanking, so `le~~\`ad\`~~pha` (and, before the CJK-friendly
// parse side, `说「~~重点」内容~~`) read back as literal tildes. `~~` follows
// the same flanking rules as `**` (GFM spec; remark-cjk-friendly-gfm-
// strikethrough relaxes them for CJK the same way), so the CJK-friendly strong
// handler serializes it with `~` as the marker: it encodes a neighbour
// (`&#x61;`) only where the run would not pair.
export const deleteStringifyHandler = (node, parent, state, info) => {
  const saved = state.options.strong
  state.options.strong = '~'
  try {
    return cjkAttention.strong(node, parent, state, info)
  } finally {
    state.options.strong = saved
  }
}
deleteStringifyHandler.peek = () => '~'

// GFM task items in an ordered list written with `)`: the upstream handler
// (mdast-util-gfm-task-list-item 2.0.0) inserts the checkbox only after
// `-`/`*`/`+`/`1.` — its regex has no `1)`. Milkdown writes `1)` for an
// ordered list right after another one (so they stay two lists), and the
// task's `[x]` was dropped: `1) 已完成任务` (fuzz UI seed 236). Same
// insertion as upstream, for `)`.
const gfmTaskListItem = gfmTaskListItemToMarkdown().handlers.listItem
// A task's checkbox is written in front of its first paragraph's text. With
// nothing there, the stock handler dropped the checkbox (`*`) or wrote it on
// the next line (`*\n[ ]   * x`): `- [ ]` alone is a plain item holding the
// text `[ ]`. An empty task item keeps the box with a U+200B after it (Typora
// writes the same), as its first paragraph — also before a nested list or a
// block that leads the item.
const isEmptyParagraph = (child) => child?.type === 'paragraph' &&
  (child.children || []).every((inline) => inline.type === 'text' && !/[^ \t]/.test(inline.value || ''))
export const taskListItemStringifyHandler = (node, parent, state, info) => {
  if (typeof node.checked === 'boolean') {
    const children = node.children || []
    const head = children[0]
    if (!head || isEmptyParagraph(head) || head.type !== 'paragraph') {
      const sentinel = { type: 'paragraph', children: [{ type: 'text', value: '\u200B' }] }
      const rest = head && head.type === 'paragraph' ? children.slice(1) : children
      node = { ...node, children: [sentinel, ...rest] }
    }
  }
  let value = gfmTaskListItem(node, parent, state, info)
  const head = node.children?.[0]
  if (typeof node.checked === 'boolean' && head?.type === 'paragraph' && /^\d+\)/.test(value) &&
      !/^\d+\)(?:[\r\n]| {1,3})\[[ xX]\] /.test(value)) {
    value = value.replace(/^(\d+\)(?:[\r\n]| {1,3}))/, `$1[${node.checked ? 'x' : ' '}] `)
  }
  return value
}

// An autolink (`<https://…>`) has no escapes: a backslash in it is the
// character itself. The stock link handler writes its text through the
// phrasing escapes anyway, so `<https://a?b=\*>` came back as `\\*` — another
// URL (CommonMark spec examples 20, 603; found by the projection guard,
// lib/source-sync/projection.js). Same test as upstream
// (format-link-as-autolink.js); the URL is written as it is.
const isAutolink = (node, state) => {
  const child = node.children?.length === 1 ? node.children[0] : null
  return Boolean(!state.options.resourceLink && node.url && !node.title && child?.type === 'text' &&
    (child.value === node.url || 'mailto:' + child.value === node.url) &&
    /^[a-z][a-z+.-]+:/i.test(node.url) && !/[\0- <>\u007F]/.test(node.url))
}
export const autolinkSafeLinkHandler = (node, parent, state, info) => {
  if (!isAutolink(node, state)) return defaultHandlers.link(node, parent, state, info)
  return `<${node.children[0].value}>`
}
autolinkSafeLinkHandler.peek = (node, parent, state, info) =>
  isAutolink(node, state) ? '<' : defaultHandlers.link.peek(node, parent, state, info)

// A GFM table row has as many cells as the widest row; the stock handler
// writes each row as it is, and a header row without cells (left by a
// prosemirror-tables fix that cannot add body cells to a header row) made
// the first body row the header — one row was lost on reopen (fuzz seed
// 5619). Rows are padded with empty cells before writing (the editor and
// the projection read short rows as padded too).
const gfmTable = gfmTableToMarkdown()
export const tableStringifyHandler = (node, parent, state, info) => {
  let rows = node.children || []
  // Milkdown leaves a row without cells out of the mdast (its runner); the
  // header row it marks `isHeader`. A first row without the mark means the
  // header row was empty: it comes back as an empty header row.
  if (rows.length && rows[0].isHeader !== true) rows = [{ type: 'tableRow', isHeader: true, children: [] }, ...rows]
  const width = Math.max(0, ...rows.map((row) => row.children?.length || 0))
  const padded = rows !== node.children || rows.some((row) => (row.children?.length || 0) < width)
    ? { ...node, children: rows.map((row) => ((row.children?.length || 0) < width ? { ...row, children: [...(row.children || []), ...Array.from({ length: width - (row.children?.length || 0) }, () => ({ type: 'tableCell', children: [] }))] } : row)) }
    : node
  return gfmTable.handlers.table(padded, parent, state, info)
}
