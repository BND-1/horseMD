// Raw-HTML rendering for Milkdown's `html` node + block-type conversion.

// Block-level tags whose HTML we render visually (rather than show as source).
// Targeted at the common case — HTML tables pasted into Markdown — plus a few
// other safe block containers. Inline fragments (a stray <b>, <span>) fall back
// to the default escaped-text rendering so unbalanced bits can't break layout.
const RENDER_HTML_RE =
  /^\s*<(table|thead|tbody|tfoot|tr|td|th|div|details|summary|figure|figcaption|section|article|dl|center|sub|sup|kbd|mark|abbr|u|ins|del)[\s/>]/i

// Strip <script>/<style> and inline event handlers so rendering local HTML can't
// run code. Tables/fragments parse correctly inside a <template>.
function sanitizeHtml(html) {
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
  return tpl.innerHTML
}

// ProseMirror node view for Milkdown's `html` node. Renders recognized block
// HTML as real DOM; leaves other html nodes to their default text rendering.
export function renderHtmlNodeView(node) {
  const value = node.attrs?.value || ''
  if (!RENDER_HTML_RE.test(value)) {
    // Not something we render — mimic the default: escaped text in a span.
    const span = document.createElement('span')
    span.setAttribute('data-type', 'html')
    span.textContent = value
    return { dom: span, ignoreMutation: () => true }
  }
  const dom = document.createElement('div')
  dom.className = 'hm-html-block'
  dom.setAttribute('data-type', 'html')
  dom.contentEditable = 'false'
  dom.innerHTML = sanitizeHtml(value)
  // The node is an atom with no editable content; ignore inner DOM mutations so
  // ProseMirror doesn't try to reconcile the rendered HTML.
  return { dom, ignoreMutation: () => true, stopEvent: () => false }
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
