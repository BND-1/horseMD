// Editable inline HTML wrappers (Typora parity): `<font style=…>text</font>`
// and `<span style=…>text</span>` render as styled text you can click into,
// select and type in — not as one locked atom. Yuque exports wrap almost every
// line in `<font>`, so the atom made those documents nearly uneditable.
//
//   parse:     a balanced `<font …>` … `</font>` (or span) pair of inline html
//              nodes inside one parent → an `hmHtmlSpan` mdast node keeping the
//              exact open/close tag bytes → the `html_span` mark.
//   stringify: the mark → open tag + phrasing content + close tag.
//
// Left as raw html (the existing atom path): empty pairs (`<span id=x></span>`
// anchors), pairs holding another font/span pair, and unbalanced tags. A line break inside a converted span is printed as usual
// (`  ` + newline), so the close tag lands at the start of the next line
// exactly as Yuque writes it.
import { $markSchema } from '@milkdown/utils'

const TAGS = 'font|span'
const OPEN_RE = new RegExp(`^<(${TAGS})(?=[\\s>])[^>]*>$`, 'i')
const CLOSE_RE = new RegExp(`^</(${TAGS})\\s*>$`, 'i')

const openTag = (node) => {
  if (node?.type !== 'html' || typeof node.value !== 'string') return null
  const match = OPEN_RE.exec(node.value)
  if (!match || /\/\s*>$/.test(node.value)) return null
  return match[1].toLowerCase()
}
const closeTag = (node) => {
  if (node?.type !== 'html' || typeof node.value !== 'string') return null
  const match = CLOSE_RE.exec(node.value)
  return match ? match[1].toLowerCase() : null
}

// Anything inside — text (even blanks), a line break, code, an image. Only a
// pair with nothing between its tags stays raw html (`<span id=x></span>`
// anchors: dropping them from the document would lose them on reprint).
// Yuque's `<font>  \n</font>` (only a break) is converted too: kept as raw
// tags, text typed between them would parse back as a span — a different
// structure from the editor's.
const hasVisibleContent = (nodes) => nodes.some((node) => {
  if (node.type === 'text') return node.value !== ''
  if (node.type === 'break' || node.type === 'inlineCode' || node.type === 'inlineMath' || node.type === 'image') return true
  return Array.isArray(node.children) && hasVisibleContent(node.children)
})

/**
 * Replace balanced font/span pairs among `children` (one parent's phrasing
 * content) with `hmHtmlSpan` nodes. Returns the new array and the spans made,
 * so the caller can run its other inline-html passes inside them too.
 */
export function convertHtmlSpans(children) {
  if (!Array.isArray(children) || !children.some((child) => child?.type === 'html')) {
    return { children, spans: [] }
  }
  const out = []
  const spans = []
  // Open tags not yet closed: their index in `out`.
  const stack = []
  for (const child of children) {
    const opening = openTag(child)
    if (opening) {
      stack.push({ tag: opening, node: child, at: out.length, nested: false })
      out.push(child)
      continue
    }
    const closing = closeTag(child)
    if (closing) {
      const top = stack[stack.length - 1]
      if (top && top.tag === closing) {
        stack.pop()
        const inner = out.splice(top.at + 1)
        out.pop()
        if (stack.length) stack[stack.length - 1].nested = true
        if (hasVisibleContent(inner) && !top.nested) {
          const span = {
            type: 'hmHtmlSpan',
            tag: closing,
            open: top.node.value,
            close: child.value,
            children: inner
          }
          const start = top.node.position?.start
          const end = child.position?.end
          if (start && end) span.position = { start: { ...start }, end: { ...end } }
          out.push(span)
          spans.push(span)
        } else {
          out.push(top.node, ...inner, child)
        }
        continue
      }
      // A close tag that does not match the innermost open one: the markup is
      // not a clean nesting, so nothing before it may pair across it.
      stack.length = 0
    }
    out.push(child)
  }
  return { children: out, spans }
}

// --- DOM ---------------------------------------------------------------------

const ATTR_CACHE = new Map()
const ATTR_CACHE_MAX = 512
// Attributes of the authored open tag, minus anything that could run code or
// change editing (event handlers, javascript: URLs, contenteditable).
function tagAttributes(open) {
  const cached = ATTR_CACHE.get(open)
  if (cached) return cached
  const attrs = {}
  try {
    const template = document.createElement('template')
    template.innerHTML = open
    const element = template.content.firstElementChild
    for (const attr of element ? [...element.attributes] : []) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'contenteditable' || name === 'draggable') continue
      if (/^(href|src|action|formaction|xlink:href)$/.test(name) && /^\s*javascript:/i.test(attr.value)) continue
      attrs[attr.name] = attr.value
    }
  } catch {
    /* no attributes */
  }
  if (ATTR_CACHE.size >= ATTR_CACHE_MAX) ATTR_CACHE.delete(ATTR_CACHE.keys().next().value)
  ATTR_CACHE.set(open, attrs)
  return attrs
}

export const htmlSpanSchema = $markSchema('html_span', () => ({
  attrs: {
    tag: { default: 'span' },
    open: { default: '<span>' },
    close: { default: '</span>' }
  },
  // Typing at the end of the wrapped text continues it (Typora).
  inclusive: true,
  // Only the editor's own copies round-trip (the authored tag rides along);
  // a stray <font>/<span> from a web page stays plain text, as before.
  parseDOM: [
    {
      tag: 'font[data-hm-html-open], span[data-hm-html-open]',
      getAttrs: (dom) => {
        const tag = dom.tagName.toLowerCase()
        const open = dom.getAttribute('data-hm-html-open')
        return open && OPEN_RE.test(open) ? { tag, open, close: `</${tag}>` } : false
      }
    }
  ],
  toDOM: (mark) => {
    const tag = mark.attrs.tag === 'font' ? 'font' : 'span'
    return [tag, { ...tagAttributes(mark.attrs.open), class: 'hm-html-span', 'data-hm-html-open': mark.attrs.open }]
  },
  parseMarkdown: {
    match: (node) => node.type === 'hmHtmlSpan',
    runner: (state, node, markType) => {
      state.openMark(markType, { tag: node.tag, open: node.open, close: node.close })
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'html_span',
    runner: (state, mark) => {
      state.withMark(mark, 'hmHtmlSpan', undefined, {
        tag: mark.attrs.tag,
        open: mark.attrs.open,
        close: mark.attrs.close
      })
    }
  }
}))

// remark-stringify handler: the authored tags around the phrasing content.
export function htmlSpanStringifyHandler(node, _parent, state, info) {
  const tag = node.tag === 'font' ? 'font' : 'span'
  const open = typeof node.open === 'string' && OPEN_RE.test(node.open) ? node.open : `<${tag}>`
  const close = typeof node.close === 'string' && CLOSE_RE.test(node.close) ? node.close : `</${tag}>`
  const tracker = state.createTracker(info)
  let value = tracker.move(open)
  value += tracker.move(state.containerPhrasing(node, { ...tracker.current(), before: '>', after: '<' }))
  value += tracker.move(close)
  return value
}
htmlSpanStringifyHandler.peek = () => '<'

export const htmlSpanFeatures = [htmlSpanSchema]
