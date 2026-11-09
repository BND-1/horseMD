// Editable inline HTML wrappers (Typora parity): `<font style=…>text</font>`,
// `<span style=…>text</span>`, `<kbd>Esc</kbd>`, `<u>…</u>` … render as
// formatted text you can click into, select and type in — not as one locked
// atom you could only change in source mode. Yuque exports wrap almost every
// line in `<font>`; notes write keys as `<kbd>Ctrl</kbd>`.
//
//   parse:     a balanced open/close pair of one of HTML_SPAN_TAGS (inline
//              html nodes inside one parent) → an `hmHtmlSpan` mdast node
//              keeping the exact open/close tag bytes → the `html_span` mark.
//   stringify: the mark → open tag + phrasing content + close tag.
//
// Left as raw html (the existing atom path): empty pairs (`<span id=x></span>`
// anchors), pairs inside another such pair (two html_span marks cannot share
// text: the outer pair is the span), unbalanced tags, and every other tag — `<a>` (a link), `<mark>`
// (the highlight colours own it), `<img>`, ruby. A line break inside a
// converted span is printed as usual (`  ` + newline), so the close tag lands
// at the start of the next line exactly as Yuque writes it.
import { $markSchema } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import { HTML_SPAN_TAGS } from '../lib/html-span-tags.js'

const TAG_SET = new Set(HTML_SPAN_TAGS)
const SEPARATE_TAGS = new Set(['kbd', 'q'])
const TAGS = HTML_SPAN_TAGS.join('|')
const tagName = (tag) => (TAG_SET.has(String(tag || '').toLowerCase()) ? String(tag).toLowerCase() : 'span')
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
// `<sub>` / `<sup>` with no attributes are the subscript / superscript
// marks while that syntax is on (editor-subsup.js sets this): such a pair
// becomes that mdast node, and pairs inside it stay editable spans
// (`<sub>中<kbd>内</kbd></sub>`) — it is not the "outer span".
let markTags = {}
export function setHtmlMarkTags(tags) { markTags = tags || {} }

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
      if (top && top.tag === closing && markTags[closing] && top.node.value === `<${closing}>` && child.value === `</${closing}>`) {
        stack.pop()
        const inner = out.splice(top.at + 1)
        out.pop()
        const node = { type: markTags[closing], data: { hName: closing }, children: inner }
        const start = top.node.position?.start
        const end = child.position?.end
        if (start && end) node.position = { start: { ...start }, end: { ...end } }
        out.push(node)
        continue
      }
      if (top && top.tag === closing) {
        stack.pop()
        let inner = out.splice(top.at + 1)
        out.pop()
        if (stack.length) stack[stack.length - 1].nested = true
        // A pair holding another pair: the OUTER one is the editable span
        // (two html_span marks cannot share text) and the inner pairs go back
        // to raw html inside it — a Yuque `<font>` keeps a `<b>` typed in it
        // as HTML, as before <b>/<kbd> became editable.
        if (top.nested) {
          const unwrapped = new Set()
          inner = inner.flatMap((node) => {
            if (node.type !== 'hmHtmlSpan' || !node.raw) return [node]
            unwrapped.add(node)
            return node.raw
          })
          for (let index = spans.length - 1; index >= 0; index -= 1) if (unwrapped.has(spans[index])) spans.splice(index, 1)
        }
        if (hasVisibleContent(inner)) {
          // `<kbd>Ctrl</kbd><kbd>V</kbd>`: two pairs right next to each
          // other are two keys. Identical marks on adjacent text merge in
          // ProseMirror (one `CtrlV` key), so the second gets the other
          // `part` — derived from the source alone, so every parse agrees.
          // Only for tags drawn as one box each (a key, a quotation): two
          // adjacent <font>/<b> runs look the same merged, and Yuque's
          // break-only `<font>  \n</font><font>b</font>` relies on merging.
          const previous = out[out.length - 1]
          const part = SEPARATE_TAGS.has(closing) && previous?.type === 'hmHtmlSpan' && previous.open === top.node.value && previous.close === child.value
            ? 1 - (previous.part || 0)
            : 0
          const span = {
            type: 'hmHtmlSpan',
            tag: closing,
            open: top.node.value,
            close: child.value,
            part,
            children: inner
          }
          const start = top.node.position?.start
          const end = child.position?.end
          if (start && end) span.position = { start: { ...start }, end: { ...end } }
          // Its source nodes, in case an enclosing pair takes over.
          Object.defineProperty(span, 'raw', { value: [top.node, ...inner, child], enumerable: false })
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
    close: { default: '</span>' },
    // 0 / 1, alternating between pairs written right next to each other.
    part: { default: 0 }
  },
  // Typing at the end of the wrapped text continues it (Typora).
  inclusive: true,
  // Only the editor's own copies round-trip (the authored tag rides along);
  // a stray <font>/<kbd> from a web page stays plain text, as before.
  parseDOM: [
    {
      tag: HTML_SPAN_TAGS.map((tag) => `${tag}[data-hm-html-open]`).join(', '),
      getAttrs: (dom) => {
        const tag = dom.tagName.toLowerCase()
        const open = dom.getAttribute('data-hm-html-open')
        return open && OPEN_RE.test(open) ? { tag, open, close: `</${tag}>`, part: dom.getAttribute('data-hm-html-part') === '1' ? 1 : 0 } : false
      }
    }
  ],
  toDOM: (mark) => {
    const tag = tagName(mark.attrs.tag)
    return [tag, { ...tagAttributes(mark.attrs.open), class: 'hm-html-span', 'data-hm-html-open': mark.attrs.open, ...(mark.attrs.part ? { 'data-hm-html-part': '1' } : {}) }]
  },
  parseMarkdown: {
    match: (node) => node.type === 'hmHtmlSpan',
    runner: (state, node, markType) => {
      state.openMark(markType, { tag: node.tag, open: node.open, close: node.close, part: node.part ? 1 : 0 })
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
        close: mark.attrs.close,
        // Milkdown merges adjacent mark nodes whose props are equal: two
        // keys (`<kbd>Ctrl</kbd><kbd>V</kbd>`, parts 0 and 1) were written
        // as one key. Only <kbd>/<q> get another part; <font> still merges.
        part: mark.attrs.part ?? 0
      })
    }
  }
}))

// remark-stringify handler: the authored tags around the phrasing content.
export function htmlSpanStringifyHandler(node, _parent, state, info) {
  const tag = tagName(node.tag)
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


// `part` is derived from the source (see convertHtmlSpans): a key right
// after an identical key takes the other part, anything else 0. An edit can
// change who is adjacent — typing `+` between `<kbd>Ctrl</kbd><kbd>V</kbd>`
// left V with part 1, which no parse of the new source gives, and the sync
// stopped with「富文本与源码不一致」. Re-derive the parts of the text blocks a
// transaction touched.
function fixPartsInBlock(tr, block, start) {
  const runs = [] // { from, to, mark } — adjacent nodes with one key mark
  let before = null // the run of the inline node right before, if a key
  block.forEach((node, offset) => {
    const from = start + offset
    const mark = node.marks.find((m) => m.type.name === 'html_span' && SEPARATE_TAGS.has(tagName(m.attrs.tag))) || null
    if (!mark) {
      before = null
      return
    }
    if (before && before.to === from && before.mark.eq(mark)) {
      before.to = from + node.nodeSize
      return
    }
    const follows = before && before.to === from && before.mark.attrs.open === mark.attrs.open && before.mark.attrs.close === mark.attrs.close
    before = { from, to: from + node.nodeSize, mark, part: follows ? 1 - before.part : 0 }
    runs.push(before)
  })
  let fixed = 0
  for (const run of runs) {
    if (run.mark.attrs.part === run.part) continue
    tr.removeMark(run.from, run.to, run.mark)
    tr.addMark(run.from, run.to, run.mark.type.create({ ...run.mark.attrs, part: run.part }))
    fixed += 1
  }
  return fixed
}

const keyMarkOf = (node) => node?.marks.find((m) => m.type.name === 'html_span' && SEPARATE_TAGS.has(tagName(m.attrs.tag))) || null

// A deletion that brings two identical keys together (`<kbd>Ctrl</kbd>+<kbd>C</kbd>`,
// Backspace on `+`) would merge them into one `CtrlC` key: ProseMirror joins
// text with equal marks. In Typora / Obsidian they stay two keys. Returns the
// right-hand key's old range per deletion, to be given the other part.
function keysJoinedBy(t) {
  const out = []
  t.steps.forEach((step, index) => {
    const doc = t.docs[index]
    t.mapping.maps[index].forEach((oldFrom, oldTo, newFrom, newTo) => {
      if (newFrom !== newTo || oldFrom === oldTo) return
      const left = keyMarkOf(doc.resolve(oldFrom).nodeBefore)
      const $right = doc.resolve(oldTo)
      const right = keyMarkOf($right.nodeAfter)
      if (!left || !right || !left.eq(right)) return
      // The right key's extent in the old document.
      const start = $right.start()
      let end = oldTo
      let open = true
      $right.parent.forEach((node, offset) => {
        const nodeEnd = start + offset + node.nodeSize
        if (!open || nodeEnd <= oldTo) return
        if (keyMarkOf(node)?.eq(right)) end = nodeEnd
        else open = false
      })
      out.push({ index, from: oldTo, to: end, mark: right })
    })
  })
  return out
}

export function createHtmlSpanPartPlugin() {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!state.schema.marks.html_span || !transactions.some((t) => t.docChanged)) return null
      const tr = state.tr
      // Keep keys a deletion brought together apart (other part on the right).
      transactions.forEach((t, ti) => {
        for (const join of keysJoinedBy(t)) {
          const rest = t.mapping.slice(join.index)
          let from = rest.map(join.from, 1)
          let to = rest.map(join.to, -1)
          for (const later of transactions.slice(ti + 1)) { from = later.mapping.map(from, 1); to = later.mapping.map(to, -1) }
          if (from >= to) continue
          tr.removeMark(from, to, join.mark)
          tr.addMark(from, to, join.mark.type.create({ ...join.mark.attrs, part: 1 - join.mark.attrs.part }))
        }
      })
      // The changed ranges, in the new document.
      let ranges = []
      for (const t of transactions) {
        ranges = ranges.map((r) => ({ from: t.mapping.map(r.from, -1), to: t.mapping.map(r.to, 1) }))
        t.mapping.maps.forEach((map, index) => {
          const rest = t.mapping.slice(index + 1)
          map.forEach((_oldFrom, _oldTo, newFrom, newTo) => ranges.push({ from: rest.map(newFrom, -1), to: rest.map(newTo, 1) }))
        })
      }
      const size = tr.doc.content.size
      let fixed = 0
      const seen = new Set()
      for (const range of ranges) {
        const from = Math.max(0, Math.min(range.from, size) - 1)
        const to = Math.min(size, Math.max(range.to, from) + 1)
        tr.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isTextblock) return true
          if (!seen.has(pos)) {
            seen.add(pos)
            fixed += fixPartsInBlock(tr, node, pos + 1)
          }
          return false
        })
      }
      return fixed || tr.docChanged ? tr : null
    }
  })
}
