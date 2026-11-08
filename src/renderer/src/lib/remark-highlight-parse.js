// Highlight parsing (remark, parse side) for editor-highlight.js — pure, so
// scripts/test-highlight-parse.mjs can lock it without the editor.
//   `==text==`                         → highlight (yellow)
//   `<mark class="hm-hl-red">x</mark>` → highlight of that color
// Both also around other formatting (#173).

import { alignText } from './source-text-align.js'

// `==text==` → highlight, also around other formatting (#173, Typora
// parity: `==a **b** c==`). Markdown splits such content into several
// siblings (text, strong, text…), and the editor writes exactly this when a
// highlight covers bold text — a text-node-only match left the `==` literal
// and every such edit failed the source check. One left-to-right pass over a
// phrasing parent's children pairs each `==` with the nearest one after it
// (as CommonMark pairs delimiters), so `==摄**影**作品==，…==电影==` is two
// highlights, not one from 品== to ==电. Rules of HIGHLIGHT_RE kept: an
// opener is not next to another `=`, not `{==` / `==}` (review markup);
// content is non-empty, has no `=` in its text and no blank at either edge.
// Split text pieces carry no position (the reprint inline map scans
// unpositioned nodes); wrapped siblings keep theirs.
// With the source (`file`), a `=` written `\=` or as a character reference
// is text, never a delimiter (CommonMark; the serializer writes `\==` for
// a literal `==` that could open). Without it, or for a text node that
// cannot be followed through the source, every `=` counts.
export function highlightParseTransform(tree, file) {
  const raw = typeof file?.value === 'string' ? file.value : typeof file === 'string' ? file : ''
  // micromark offsets do not count a leading BOM.
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  pairEqualsHighlights(tree, source)
  coalesceMarkHtml(tree)
  pairMarkTagsAcrossNodes(tree)
  return tree
}

// A complete `<mark class="hm-hl-COLOR">…</mark>` fragment (plain text inside).
const MARK_HTML_RE = /^<mark\s+class="hm-hl-(yellow|red|blue)"\s*>([\s\S]*?)<\/mark>$/

const isBlank = (ch) => ch === undefined || /\s/.test(ch)
const textNode = (value) => ({ type: 'text', value })
const yellowNode = (children) => ({ type: 'highlight', color: 'yellow', data: { hName: 'mark' }, children })

// For each text child: the value indexes of `=` written escaped / as a
// reference (a Set), absent when the child cannot be followed through the
// source. Milkdown's remarkLineBreak splits a paragraph's text at soft
// breaks into pieces WITHOUT positions (before this transform runs), so
// unpositioned pieces are followed from the paragraph start / the previous
// positioned sibling: a split break skips the line ending and the next
// line's indentation / quote prefix.
function escapedEqualsByChild(node, source) {
  const found = new Map()
  if (!source) return found
  const startOf = (n) => n?.position?.start?.offset
  const endOf = (n) => n?.position?.end?.offset
  const bound = Number.isInteger(endOf(node)) ? endOf(node) : source.length
  let cursor = node.type === 'paragraph' && Number.isInteger(startOf(node)) ? startOf(node) : null
  const record = (kid, map) => {
    const escaped = new Set()
    map.forEach((entry, index) => { if (entry?.plain === false && kid.value[index] === '=') escaped.add(index) })
    found.set(kid, escaped)
  }
  node.children.forEach((kid, index) => {
    const start = startOf(kid)
    const end = endOf(kid)
    if (Number.isInteger(start) && Number.isInteger(end)) {
      if (kid.type === 'text') {
        const map = alignText(kid.value, source, start, end)
        if (map) record(kid, map)
      }
      cursor = end
      return
    }
    if (cursor === null) return
    if (kid.type === 'text') {
      const map = alignText(kid.value, source, cursor, bound)
      if (map) { record(kid, map); cursor = map.end } else cursor = null
      return
    }
    if (kid.type === 'break') {
      const rest = source.slice(cursor, bound)
      const ending = /^[\t ]*(?:\r\n|\r|\n)/.exec(rest)
      if (!ending) {
        // A line break written as a character reference (`&#10;`, the
        // serializer's empty line inside a paragraph) is split off too. It
        // sits mid-line: nothing to skip after it. Without this, every `=`
        // after one counted and `a\n&#10;\==g==` reopened as a highlight.
        const reference = /^[\t ]*(?:&#(?:0*13|[xX]0*[dD]);)?&#(?:0*10|[xX]0*[aA]);|^[\t ]*&#(?:0*13|[xX]0*[dD]);/.exec(rest)
        cursor = reference ? cursor + reference[0].length : null
        return
      }
      cursor += ending[0].length
      const next = node.children[index + 1]?.value?.[0]
      while (cursor < bound && (source[cursor] === ' ' || source[cursor] === '\t' || (source[cursor] === '>' && next !== '>'))) cursor += 1
      return
    }
    cursor = null
  })
  return found
}

function pairEqualsHighlights(node, source) {
  if (!Array.isArray(node.children)) return
  for (const child of node.children) pairEqualsHighlights(child, source)
  if (node.type === 'highlight') return
  const kids = node.children
  if (!kids.some((k) => k.type === 'text' && k.value.includes('=='))) return
  // Pairs of delimiters, each end { child, offset } in `kids`.
  const pairs = []
  let pending = null
  let escapes = null
  kids.forEach((kid, index) => {
    if (kid.type !== 'text') return
    const value = kid.value
    const escaped = value.includes('==') ? (escapes ??= escapedEqualsByChild(node, source)).get(kid) : null
    const runs = /=+/g
    let match
    while ((match = runs.exec(value))) {
      const at = match.index
      if (match[0].length !== 2 || escaped?.has(at) || escaped?.has(at + 1)) { pending = null; continue }
      // Next to another sibling (bold, code…): not a blank.
      const prev = at > 0 ? value[at - 1] : (index > 0 ? 'x' : undefined)
      const next = at + 2 < value.length ? value[at + 2] : (index + 1 < kids.length && kids[index + 1].type !== 'text' ? 'x' : undefined)
      const hasContent = pending && (pending.child !== index || pending.offset + 2 < at)
      if (hasContent && !isBlank(prev)) {
        pairs.push({ open: pending, close: { child: index, offset: at } })
        pending = null
      } else if (prev !== '{' && next !== '}' && !isBlank(next)) {
        pending = { child: index, offset: at }
      } else {
        pending = null
      }
    }
  })
  if (!pairs.length) return
  const out = []
  let p = 0
  let inner = null
  const push = (item) => (inner || out).push(item)
  kids.forEach((kid, index) => {
    if (kid.type !== 'text' || !pairs.some((pair) => pair.open.child === index || pair.close.child === index)) {
      push(kid)
      return
    }
    let from = 0
    const cut = (to) => { if (to > from) push(textNode(kid.value.slice(from, to))) }
    while (p < pairs.length) {
      const pair = pairs[p]
      if (!inner && pair.open.child === index) {
        cut(pair.open.offset)
        from = pair.open.offset + 2
        inner = []
        continue
      }
      if (inner && pair.close.child === index) {
        cut(pair.close.offset)
        from = pair.close.offset + 2
        out.push(yellowNode(inner))
        inner = null
        p += 1
        continue
      }
      break
    }
    cut(kid.value.length)
  })
  node.children = out
}

// `<mark class="hm-hl-blue">a **b**</mark>`: the tags are separate html
// siblings with the content between (coalesceMarkHtml takes only
// plain text), so they wrap everything between them (#173).
const OPEN_MARK_TAG_RE = /^<mark\s+class="hm-hl-(yellow|red|blue)"\s*>$/

function pairMarkTagsAcrossNodes(node) {
  if (!Array.isArray(node.children)) return
  for (const child of node.children) pairMarkTagsAcrossNodes(child)
  if (node.type === 'highlight') return
  const kids = node.children
  for (let i = 0; i < kids.length; i += 1) {
    const match = kids[i].type === 'html' && OPEN_MARK_TAG_RE.exec(kids[i].value)
    if (!match) continue
    let j = i + 1
    while (j < kids.length && kids[j].type !== 'highlight' &&
      !(kids[j].type === 'html' && /^<\/?mark\b/i.test(kids[j].value))) j += 1
    if (j >= kids.length || kids[j].value !== '</mark>' || j === i + 1) continue
    kids.splice(i, j - i + 1, { type: 'highlight', color: match[1], data: { hName: 'mark' }, children: kids.slice(i + 1, j) })
  }
}

// Convert inline-HTML <mark class="hm-hl-…">…</mark> into highlight mdast nodes.
// Commonmark splits `<mark>x</mark>` into open/text/close html nodes; we coalesce
// a balanced run of consecutive html+text siblings (self-contained — doesn't
// depend on the general inline-HTML merge plugin running first) and, when the
// whole run is one `<mark class=…>…</mark>`, swap it for a highlight node.
function coalesceMarkHtml(node) {
  if (!Array.isArray(node.children)) return
  for (const c of node.children) coalesceMarkHtml(c)
  const kids = node.children
  const next = []
  let i = 0
  while (i < kids.length) {
    const c = kids[i]
    if (c.type === 'html' && /^<mark\b/i.test(c.value) && !/^<\//.test(c.value)) {
      let raw = ''
      let j = i
      let matched = null
      while (j < kids.length) {
        const k = kids[j]
        if (k.type !== 'html' && k.type !== 'text') break
        raw += k.value
        j += 1
        const m = raw.match(MARK_HTML_RE)
        if (m) {
          matched = m
          break
        }
      }
      if (matched) {
        next.push({
          type: 'highlight',
          color: matched[1],
          data: { hName: 'mark' },
          children: [{ type: 'text', value: matched[2] }]
        })
        i = j
        continue
      }
    }
    next.push(c)
    i += 1
  }
  node.children = next
}

// A literal `==` that could open a highlight on reparse (exactly two, not
// after `{` — review markup `{==…==}` — and followed by a non-blank that is
// not `}`) is written `\==`: the parse never takes an escaped `=` as a
// delimiter. `a == b` and `===` stay as they are. Without it, text `段落==编`
// before a highlight `==步骤==` reopened as a highlight of `编` (fuzz seed 525).
export const highlightUnsafe = { character: '=', inConstruct: 'phrasing', before: '^|[^{=]', after: '(?==[^=\\s}])' }

// Stringify direction (remark handler, registered on remarkStringifyOptionsCtx).
// yellow → ==text== ; red/blue → <mark class="hm-hl-…">text</mark> (round-trips
// back into a colored mark via coalesceMarkHtml on reload).
export function highlightStringifyHandler(node, parent, state, info) {
  const color = node.color || 'yellow'
  const yellow = color === 'yellow'
  // The content sits between `==` / the tags: bold right inside decides its
  // delimiters by those characters, not by the text around the highlight.
  const inner = state.containerPhrasing(node, { ...info, before: yellow ? '=' : '>', after: yellow ? '=' : '<' })
  if (!inner) return ''
  // `==` cannot hold a `=` (the parse rule) nor touch one outside (the runs
  // merge): a highlighted `=` beside others is the HTML spelling, which
  // reads back the same (fuzz FORMAT seed 6).
  // `info.after` is the next sibling's first written character, and a text
  // starting `==x` is written `\==x` there — look at the raw neighbours too.
  const at = parent?.children?.indexOf(node) ?? -1
  const prevText = at > 0 && parent.children[at - 1]?.type === 'text' ? parent.children[at - 1].value : ''
  const nextText = at >= 0 && parent.children[at + 1]?.type === 'text' ? parent.children[at + 1].value : ''
  const touches = String(info?.before || '').endsWith('=') || String(info?.after || '').startsWith('=') ||
    prevText.endsWith('=') || nextText.startsWith('=')
  // `{==` / `==}` cannot open (review markup `{==…==}`): after a `{`, or
  // with content starting with `}`, the HTML spelling too.
  const review = String(info?.before || '').endsWith('{') || inner.startsWith('}')
  if (yellow && !inner.includes('=') && !touches && !review) return `==${inner}==`
  if (yellow) {
    const html = state.containerPhrasing(node, { ...info, before: '>', after: '<' })
    return `<mark class="hm-hl-yellow">${html}</mark>`
  }
  return `<mark class="hm-hl-${color}">${inner}</mark>`
}
