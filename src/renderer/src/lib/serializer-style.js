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
  const text = String(markdown || '')
  const fenceStripped = text.split(/(?:\r\n|\r|\n)/)
    .filter((line) => !/^\s*(?:`{3,}|~{3,})/.test(line))
    .join('\n')
  const twoSpaceBreaks = (fenceStripped.match(/[ \t][ \t]\r?\n/g) || []).length
  const backslashBreaks = (fenceStripped.match(/\\\r?\n/g) || []).length
  return {
    bullet: bulletCounts[bullet] > 0 ? bullet : '-',
    ordered: orderedCounts[orderedDelimiter] > 0 ? orderedDelimiter : '.',
    loose: separated > adjacent,
    hardBreak: backslashBreaks > twoSpaceBreaks ? '\\' : '  '
  }
}

const blockContentChildren = (item) =>
  (item.children || []).filter((child) => child && child.type !== 'list').length

// An EMPTY paragraph serializes as the inline-html `<br />` placeholder —
// either an empty mdast paragraph (fresh serializer state) or a paragraph
// whose only child IS that html node (what the editor round-trips). When more
// blocks follow it inside the same item, tight spacing turns the next line
// into a lazy continuation of that paragraph instead of a new block (only an
// ordered list starting at `1.` may interrupt a paragraph), so the blank
// separator is REQUIRED for the item to round-trip.
const isEmptyPlaceholderParagraph = (paragraph) =>
  (paragraph?.children || []).every((child) =>
    (!child.children && child.type === 'html' &&
      /^<br\s*\/?>$/i.test(String(child.value || '').trim())) ||
    (child.type === 'text' && !String(child.value || '').trim()))

const hasEmptyNonLastParagraph = (item) => {
  const children = item.children || []
  return children.some((child, index) =>
    index < children.length - 1 &&
    child && child.type === 'paragraph' &&
    isEmptyPlaceholderParagraph(child))
}

// Re-derive mdast spread from content plus the authored loose/tight style:
//   listItem.spread — loose style OR the item genuinely has two block children
//     (two paragraphs always need the blank line to stay two paragraphs) OR
//     an empty placeholder paragraph is followed by more blocks.
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
        hasEmptyNonLastParagraph(node)
    } else if (node.type === 'list') {
      node.spread = Boolean(style.loose)
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
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

// Patch the live remark instance so every serialization mirrors the authored
// style. Returns a restore function (unused in production, handy in tests).
// remark-stringify always emits backslash hard breaks; authors who wrote
// `text␠␠\n` get their two-space spelling back. Only outside fenced code,
// where a literal trailing backslash is content, not syntax.
const rewriteHardBreaks = (markdown, spelling) => {
  if (spelling === '\\' || !markdown) return markdown
  const parts = String(markdown).split(/(\r?\n)/)
  let inFence = false
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && line.endsWith('\\')) {
      parts[index] = `${line.slice(0, -1)}  `
    }
  }
  return parts.join('')
}

// The unified instance is FROZEN long before we get it (Milkdown parses the
// default value during create), so `data('settings')` cannot carry compile
// options — styling the markers must happen on the compiled string. Line-level
// and fence-aware: `*` markers become the authored bullet (`*emphasis*` needs
// a following space and never matches), and `1.` becomes `1)` only for
// authors who wrote it that way. Nested lists keep the stock alternate marker;
// same-marker nesting re-parses to the identical tree either way.
const rewriteListMarkers = (markdown, style) => {
  if (!markdown) return markdown
  if (style.bullet === '*' && style.ordered === '.') return markdown
  const parts = String(markdown).split(/(\r?\n)/)
  let inFence = false
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    let next = line
    if (style.bullet !== '*') {
      next = next.replace(/^([ \t>]*)\*([ \t]|$)/, `$1${style.bullet}$2`)
    }
    if (style.ordered === ')') {
      next = next.replace(/^([ \t>]*\d{1,9})\.([ \t]|$)/, '$1)$2')
    }
    parts[index] = next
  }
  return parts.join('')
}

export const applySerializerStyleToRemark = (remark, styleHolder) => {
  if (!remark || typeof remark.stringify !== 'function') return () => {}
  const originalStringify = remark.stringify.bind(remark)
  remark.stringify = (tree, ...rest) => {
    try {
      normalizeListSpread(tree, styleHolder.style)
    } catch {
      // Style application must never block serialization; fall through to the
      // original compile untouched.
    }
    const output = originalStringify(tree, ...rest)
    try {
      return rewriteHardBreaks(
        rewriteListMarkers(output, styleHolder.style),
        styleHolder.style.hardBreak
      )
    } catch {
      return output
    }
  }
  return () => {
    remark.stringify = originalStringify
  }
}
