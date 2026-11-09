// Author-style–aware Markdown serialization.
//
// Why this exists (P7, 0.13.197): the canonical serializer used to emit every
// list with `*` markers and blank-line (loose) spacing, regardless of how the
// document was authored. An authored compact `-` list therefore diverged from
// its own canonical form at load time, and EVERY subsequent edit had to be
// translated across that divergence. Each translation is a fresh chance to
// fail closed — a week of user-triggered warnings (diverged list joins, bold
// label deletes, pastes, boundary merges) were all micro-shapes of this one
// structural gap. The root fix: the serializer mirrors the author's list
// spelling, so canonical equals the authored bytes and the divergence family
// is never created.
//
// Mechanism: Milkdown's serializer closure ends with
// `remark.stringify(mdastTree)` on the remark instance from `remarkCtx`. That
// lookup is dynamic, so patching the instance's `stringify` intercepts every
// serialization (canonical snapshots, saves, exports) while parsing stays on
// the untouched `parse`. Before each compile we:
//   1. re-derive `list`/`listItem` spread from CONTENT (a sticky attr with
//      default `true` poisons items created by Enter/input rules; mdast truth:
//      only an item with two block children *needs* loose spacing), and
//   2. set the compile settings (bullet, ordered delimiter) to the document's
//      dominant authored spelling.

import { defaultHandlers } from 'mdast-util-to-markdown'

const defaultHardBreak = defaultHandlers.break
const BULLETS = ['-', '*', '+']
const ORDERED_DELIMITERS = ['.', ')']

const ITEM_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
const BULLET_LINE = /^ {0,3}([-*+])(?:[ \t]+|$)/
const ORDERED_LINE = /^ {0,3}\d{1,9}([.)])(?:[ \t]+|$)/

// Detect the dominant authored list spelling. Documents without list rows get
// the Typora-like defaults (`-`, `1.`, tight) so fresh scratch documents also
// serialize the way a person types them.
export const detectMarkdownListStyle = (markdown) => {
  const lines = String(markdown || '').split(/\r\n|\r|\n/)
  const bulletCounts = { '-': 0, '*': 0, '+': 0 }
  const orderedCounts = { '.': 0, ')': 0 }
  let separated = 0
  let adjacent = 0
  let previousItemIndex = -2
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const bullet = line.match(BULLET_LINE)
    if (bullet) bulletCounts[bullet[1]] += 1
    const ordered = line.match(ORDERED_LINE)
    if (ordered) orderedCounts[ordered[1]] += 1
    const isItem = ITEM_LINE.test(line)
    if (isItem) {
      if (previousItemIndex >= 0) {
        // Two item rows are "separated" only when nothing but blank lines sit
        // between them. An indented continuation line between them belongs to
        // the previous item (its own internal blocks) — counting that blank
        // as inter-item separation misreads a tight list as loose.
        let betweenHasContent = false
        for (let scan = previousItemIndex + 1; scan < index; scan += 1) {
          if (lines[scan].trim() !== '') betweenHasContent = true
        }
        if (index - previousItemIndex > 1 && !betweenHasContent) separated += 1
        else adjacent += 1
      }
      previousItemIndex = index
    } else if (line.trim() !== '' && !/^\s/.test(line)) {
      previousItemIndex = -2
    }
  }
  const bullet = BULLETS.reduce((best, token) =>
    bulletCounts[token] > bulletCounts[best] ? token : best, '-')
  const orderedDelimiter = ORDERED_DELIMITERS.reduce((best, token) =>
    orderedCounts[token] > orderedCounts[best] ? token : best, '.')
  // Hard-break / strong / emphasis spellings: count authored occurrences of
  // both forms and mirror the dominant one (`  \n` vs `\\\n`, `**` vs `__`).
  // Lines of fenced code and $$ math are content: a LaTeX `\\` there is not
  // a hard break.
  const syntaxLines = []
  mapSyntaxLines(String(markdown || ''), (line) => { syntaxLines.push(line); return line })
  const fenceStripped = syntaxLines.join('\n') + '\n'
  const twoSpaceBreaks = (fenceStripped.match(/[ \t][ \t]\r?\n/g) || []).length
  const backslashBreaks = (fenceStripped.match(/(?<!\\)(?:\\\\)*\\\r?\n/g) || []).length
  return {
    bullet: bulletCounts[bullet] > 0 ? bullet : '-',
    ordered: orderedCounts[orderedDelimiter] > 0 ? orderedDelimiter : '.',
    loose: separated > adjacent,
    hardBreak: backslashBreaks > twoSpaceBreaks ? '\\' : '  '
  }
}

const blockContentChildren = (item) =>
  (item.children || []).filter((child) => child && child.type !== 'list').length

// A block right after a nested list must be a blank line away: on the next
// line it is the list's lazy continuation (`- 1. a` + `  b` reads `a b`).
const listFollowedByBlock = (item) => {
  const children = item.children || []
  return children.some((child, index) => child?.type === 'list' && children[index + 1] && children[index + 1].type !== 'list')
}

// Re-derive mdast spread from content plus the authored loose/tight style:
//   listItem.spread — loose style OR the item genuinely has two block children
//     (two paragraphs always need the blank line to stay two paragraphs) OR
//     a block follows a nested list.
//   list.spread — the authored loose/tight style ONLY. CommonMark would also
//     call a list loose when an item contains internal blank lines, but the
//     authored bytes of such documents keep the OTHER rows adjacent, and the
//     internal padding already round-trips the structure — mirroring the
//     author beats mirroring the spec's normalization.
const normalizeListSpread = (tree, style) => {
  if (!tree || typeof tree !== 'object') return
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    if (node.type === 'listItem') {
      node.spread = Boolean(style.loose) ||
        blockContentChildren(node) > 1 ||
        listFollowedByBlock(node)
    } else if (node.type === 'list') {
      node.spread = Boolean(style.loose)
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
}

// An empty paragraph has no Markdown (docs/empty-paragraph-contract.md §1).
// Milkdown writes one as a `<br />` line ("preserve empty line"; the parser
// reads such a line back as an empty paragraph), which every writer then had
// to strip again. Before the compile it becomes an empty paragraph: at the
// top level a blank line; inside a list item or a quote nothing — written as
// an empty line it ended the item (`-` + blank line + `  ***` puts the
// divider outside the list; CommonMark spec 61). The editor keeps one in
// front of an item that starts with a block (its schema wants a paragraph
// first): the block goes on the marker line, as it reads back.
const isBrPlaceholder = (child) => child?.type === 'html' && /^<br\s*\/?>$/i.test(String(child.value || '').trim())
const isEmptyParagraph = (node) => node?.type === 'paragraph' && !(node.children || []).length
const normalizeEmptyParagraphs = (node) => {
  if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return
  node.children.forEach(normalizeEmptyParagraphs)
  if (node.type === 'listItem' || node.type === 'blockquote') {
    // Milkdown's `<br />` placeholder (preserve empty line) is an empty
    // paragraph. At the top level it stays: it reads back as one, the
    // projection drops it, and the incremental serializer's segments keep
    // text at their edges (written as nothing, every window next to one fell
    // back to a full serialization).
    for (const child of node.children) {
      if (child.type === 'paragraph' && child.children?.length === 1 && isBrPlaceholder(child.children[0])) child.children = []
    }
    // A task's first line is its checkbox line: an empty one stays (the task
    // handler writes `[ ]` + U+200B there), or the block below moves up.
    const task = node.type === 'listItem' && typeof node.checked === 'boolean'
    const kept = []
    let removed = false
    node.children.forEach((child, index) => {
      if (!(task && index === 0) && isEmptyParagraph(child)) { removed = true; return }
      const previous = kept[kept.length - 1]
      // Two lists of one kind with only empty paragraphs between them read
      // back as one list (the projection reads the top level the same way):
      // one list, not two with alternating markers.
      if (removed && previous?.type === 'list' && child.type === 'list' && Boolean(previous.ordered) === Boolean(child.ordered)) {
        previous.children = [...previous.children, ...child.children]
      } else {
        kept.push(child)
      }
      removed = false
    })
    // A quote of nothing but empty paragraphs is one empty `>` line.
    node.children = kept.length || node.type === 'listItem' ? kept : node.children.slice(0, 1)
  }
}

export const createSerializerStyleHolder = (initialMarkdown) => {
  const holder = {
    style: detectMarkdownListStyle(initialMarkdown),
    setFrom(markdown) {
      holder.style = detectMarkdownListStyle(markdown)
      return holder.style
    }
  }
  return holder
}

// The style of the document being serialized right now. The serializer is
// synchronous: the patched stringify sets it for the duration of one compile,
// and the compile options below read it (list markers, hard-break spelling).
let activeStyle = null
export const activeSerializerStyle = () => activeStyle

// Hard break in the author's spelling, written by the compiler itself — not
// rewritten on the output afterwards. Two spaces, except on a line that holds
// only the break (two breaks in a row): as two spaces that line is blank and
// ends the paragraph (fuzz UI seed 151), so it keeps the backslash. `peek`
// tells the text before the break what follows it (a space, not `\`), so the
// stock `unsafe` patterns escape a line that would otherwise read as syntax
// (a lone `-` before `␠␠` is a setext underline; fuzz seed 3908).
export function styledHardBreak(node, parent, state, info) {
  const stock = defaultHardBreak(node, parent, state, info)
  if (stock !== '\\\n' || activeStyle?.hardBreak !== '  ') return stock
  return info?.before === '\n' || info?.before === '\r' ? stock : '  \n'
}
styledHardBreak.peek = (node, parent, state, info) =>
  styledHardBreak(node, parent, state, { ...info, before: 'x' })

// A line break written together with what follows it (inline-serializer.js:
// `&#10;` soft breaks after it, or inline HTML that must not start a line on
// its own — mdast-util-to-markdown turns a line ending right before HTML into
// a space). The break is spelled here, at compile time, like `styledHardBreak`.
export function hmLineBreakRun(node, parent, state, info) {
  const tail = String(node.tail || '')
  // A table cell is one line: a soft break is `&#10;`, a hard one `<br>`.
  if (state.stack?.includes('tableCell')) return (node.hard ? '<br>' : '&#10;') + tail
  if (!node.hard) return '\n' + tail
  const lineStart = !info?.before || info.before === '\n' || info.before === '\r'
  const twoSpaces = activeStyle?.hardBreak === '  ' && !lineStart
  return (twoSpaces ? '  \n' : '\\\n') + tail
}
hmLineBreakRun.peek = (node, parent, state, info) =>
  hmLineBreakRun(node, parent, state, { ...info, before: 'x' })

// Compile options that follow the active style. The getters are read on
// every compile (remark-stringify spreads its options per call), so one
// options object serves every document.
export const serializerStyleStringifyOptions = {
  get bullet() { return activeStyle?.bullet || '*' },
  get bulletOrdered() { return activeStyle?.ordered || '.' }
}

// Calls `map(line)` for every line that is Markdown syntax and keeps the
// lines of fenced code (``` / ~~~) and $$ math blocks — content, never
// syntax — as they are. A trailing backslash in LaTeX (`\\` line breaks in
// aligned / matrix) is not a hard break, and `* x` there is not a bullet:
// both used to be rewritten, so a formula changed on every full
// serialization (the sync check then refused it: 富文本与源码不一致).
// A `$$` line that is not closed keeps the rest literal (no rewrite: still
// valid Markdown, only the authored break spelling is not applied).
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/
function mapSyntaxLines(markdown, map) {
  const parts = String(markdown).split(/(\r?\n)/)
  let open = null // { kind: 'fence', char, size } | { kind: 'math' }
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    const fence = line.match(FENCE_LINE)
    if (open?.kind === 'fence') {
      if (fence && fence[1][0] === open.char && fence[1].length >= open.size && !line.slice(fence[0].length).trim()) open = null
      continue
    }
    if (open?.kind === 'math') {
      if (/\$\$\s*$/.test(line)) open = null
      continue
    }
    if (fence) {
      open = { kind: 'fence', char: fence[1][0], size: fence[1].length }
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('$$')) {
      // `$$ x $$` on one line opens and closes.
      if (!(trimmed.length > 4 && trimmed.endsWith('$$'))) open = { kind: 'math' }
      continue
    }
    parts[index] = map(line)
  }
  return parts.join('')
}

// Patch the live remark instance so every serialization mirrors the authored
// style: list / item spread re-derived from content, and the active style set
// for the compile options above. Returns a restore function (tests).
export const applySerializerStyleToRemark = (remark, styleHolder) => {
  if (!remark || typeof remark.stringify !== 'function') return () => {}
  const originalStringify = remark.stringify.bind(remark)
  remark.stringify = (tree, ...rest) => {
    try {
      normalizeEmptyParagraphs(tree)
      normalizeListSpread(tree, styleHolder.style)
    } catch {
      // Style application must never block serialization; fall through to the
      // original compile untouched.
    }
    const previous = activeStyle
    activeStyle = styleHolder.style
    try {
      return originalStringify(tree, ...rest)
    } finally {
      activeStyle = previous
    }
  }
  return () => {
    remark.stringify = originalStringify
  }
}
