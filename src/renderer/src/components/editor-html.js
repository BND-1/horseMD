// Raw-HTML rendering for Milkdown's `html` node + block-type conversion.

// Tags we render as real DOM instead of escaped source. Split into block vs
// inline so the node view returns the right wrapper element (a block <div> or an
// inline <span>) — Milkdown's `html` node is an inline atom, so an inline
// fragment must render inline to sit inside a paragraph (issue #14).
const BLOCK_TAGS =
  'table|thead|tbody|tfoot|tr|td|th|div|details|summary|figure|figcaption|section|article|dl|center|blockquote|pre|hr|ul|ol|li|h1|h2|h3|h4|h5|h6|p|form|fieldset|nav|header|footer|main|aside'
// Safe inline tags (formatting/semantic). Anything not here (iframe/object/embed,
// unknown tags, …) falls back to escaped-text so it can't run or break layout.
const INLINE_TAGS =
  'span|mark|sub|sup|kbd|u|ins|del|abbr|small|font|cite|q|samp|var|time|b|i|strong|em|a|bdo|bdi|ruby|rt|rp|label|dfn|big|tt|s|strike'

const BLOCK_RE = new RegExp(`^\\s*<(${BLOCK_TAGS})[\\s/>]`, 'i')
const INLINE_RE = new RegExp(`^\\s*<(${INLINE_TAGS})[\\s/>]`, 'i')

// Strip <script>/<style> and inline event handlers so rendering local HTML can't
// run code. Tables/fragments parse correctly inside a <template>.
//
// Memoized by the raw HTML string: an html node's attrs.value is immutable (it
// round-trips unchanged on save), but the node view is reconstructed whenever
// ProseMirror re-renders it (decoration/selection changes). Re-parsing +
// sweeping every attribute each time is wasteful on a doc with many raw-HTML
// tables — the cache returns the sanitized string instantly. Capped (FIFO) so a
// pathological variety of fragments can't grow it without bound.
const SANITIZE_CACHE = new Map()
const SANITIZE_CACHE_MAX = 256
function sanitizeHtml(html) {
  const cached = SANITIZE_CACHE.get(html)
  if (cached !== undefined) return cached
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll('script, style').forEach((el) => el.remove())
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  })
  const out = tpl.innerHTML
  if (SANITIZE_CACHE.size >= SANITIZE_CACHE_MAX) {
    SANITIZE_CACHE.delete(SANITIZE_CACHE.keys().next().value)
  }
  SANITIZE_CACHE.set(html, out)
  return out
}

// ProseMirror node view for Milkdown's `html` node. Renders recognized HTML as
// real DOM (block tags → a block <div>, inline tags → an inline <span>); leaves
// unsafe/unknown html nodes to the default escaped-text rendering. The node is
// an atom (no editable content), so we ignore inner DOM mutations — the original
// HTML round-trips through attrs.value when saving.
export function renderHtmlNodeView(node) {
  const value = node.attrs?.value || ''
  const isBlock = BLOCK_RE.test(value)
  const isInline = !isBlock && INLINE_RE.test(value)
  if (!isBlock && !isInline) {
    // Not something we render — mimic the default: escaped text in a span.
    const span = document.createElement('span')
    span.setAttribute('data-type', 'html')
    span.textContent = value
    return { dom: span, ignoreMutation: () => true }
  }
  const dom = document.createElement(isBlock ? 'div' : 'span')
  dom.className = isBlock ? 'hm-html-block' : 'hm-html-inline'
  dom.setAttribute('data-type', 'html')
  dom.contentEditable = 'false'
  dom.innerHTML = sanitizeHtml(value)
  return { dom, ignoreMutation: () => true, stopEvent: () => false }
}

// HTML void elements (no closing tag) — don't push them on the balance stack.
const VOID_TAGS = new Set([
  'br', 'img', 'hr', 'input', 'wbr', 'meta', 'link', 'area', 'base',
  'col', 'embed', 'source', 'track', 'param'
])

// Does a raw HTML fragment have all its tags closed? Used to decide when a run of
// inline-HTML nodes forms one complete, renderable fragment (so `<span>红字</span>`
// becomes a single node instead of open / text / close).
function isBalancedFragment(s) {
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g
  const stack = []
  let m
  while ((m = re.exec(s)) !== null) {
    const tag = m[1].toLowerCase()
    const closing = m[0].charAt(1) === '/'
    const selfClosing = /\/\s*$/.test(m[2])
    if (closing) {
      if (stack[stack.length - 1] !== tag) return false
      stack.pop()
    } else if (selfClosing || VOID_TAGS.has(tag)) {
      /* void / self-closed: nothing to close */
    } else {
      stack.push(tag)
    }
  }
  return stack.length === 0
}

// An inline `html` node that opens a tag (not a closer, comment, or void tag),
// i.e. the likely start of a `<tag>…</tag>` fragment worth merging.
function isOpeningInlineTag(s) {
  return typeof s === 'string' && /^<[a-zA-Z][\w-]*\b[^>]*>$/.test(s) && !/^<\//.test(s) && !/^<!--/.test(s)
}

// Merge consecutive `html` + `text` mdast siblings that form a balanced inline
// HTML fragment into a single `html` node. Commonmark parses `<span>x</span>`
// as three nodes (open tag / text / close tag); Milkdown turns each into an
// inline atom, so without merging the per-node renderer can't reconstruct the
// span around its text. We only coalesce runs of plain html+text — if markdown
// marks (emphasis, links…) sit inside the HTML we leave it alone (rare, and
// merging would drop their formatting).
function coalesceChildren(node) {
  if (!Array.isArray(node.children)) return
  for (const c of node.children) coalesceChildren(c)
  const kids = node.children
  const next = []
  let i = 0
  while (i < kids.length) {
    const c = kids[i]
    if (c.type === 'html' && isOpeningInlineTag(c.value)) {
      let raw = ''
      let j = i
      let balanced = false
      while (j < kids.length) {
        const k = kids[j]
        if (k.type !== 'html' && k.type !== 'text') break
        raw += k.value
        j += 1
        if (isBalancedFragment(raw)) {
          balanced = true
          break
        }
      }
      if (balanced && j > i + 1) {
        next.push({ type: 'html', value: raw })
        i = j
        continue
      }
    }
    next.push(c)
    i += 1
  }
  node.children = next
}

// A remark plugin (parse side) that merges fragmented inline HTML into whole
// fragments so the node view can render them. Registered in Editor.jsx.
export function remarkMergeInlineHtml() {
  return (tree) => {
    coalesceChildren(tree)
    return tree
  }
}

// Convert the block containing the cursor to a different type. Operates on the
// textblock the selection actually sits in and commits through the view so
// ProseMirror's state stays in sync.
export function convertBlock(view, typeName, attrs = {}) {
  const { state } = view
  const { schema, selection } = state
  const { $from } = selection

  const targetType = schema.nodes[typeName]
  if (!targetType) return

  let depth = $from.depth
  while (depth > 0 && !$from.node(depth).isTextblock) depth--
  const node = depth >= 0 ? $from.node(depth) : null
  if (!node) return

  // No-op if it's already exactly what we'd convert to.
  if (node.type.name === typeName) {
    if (typeName === 'heading' && node.attrs.level === attrs.level) return
    if (typeName === 'paragraph') return
  }

  const pos = $from.before(depth)
  view.dispatch(state.tr.setNodeMarkup(pos, targetType, attrs))
}
