// Highlight parsing (remark, parse side) for editor-highlight.js — pure, so
// scripts/test-highlight-parse.mjs can lock it without the editor.
//   `==text==`                         → highlight (yellow)
//   `<mark class="hm-hl-red">x</mark>` → highlight of that color
// Both also around other formatting (#173).

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
export function highlightParseTransform(tree) {
  pairEqualsHighlights(tree)
  coalesceMarkHtml(tree)
  pairMarkTagsAcrossNodes(tree)
  return tree
}

// A complete `<mark class="hm-hl-COLOR">…</mark>` fragment (plain text inside).
const MARK_HTML_RE = /^<mark\s+class="hm-hl-(yellow|red|blue)"\s*>([\s\S]*?)<\/mark>$/

const isBlank = (ch) => ch === undefined || /\s/.test(ch)
const textNode = (value) => ({ type: 'text', value })
const yellowNode = (children) => ({ type: 'highlight', color: 'yellow', data: { hName: 'mark' }, children })

function pairEqualsHighlights(node) {
  if (!Array.isArray(node.children)) return
  for (const child of node.children) pairEqualsHighlights(child)
  if (node.type === 'highlight') return
  const kids = node.children
  if (!kids.some((k) => k.type === 'text' && k.value.includes('=='))) return
  // Pairs of delimiters, each end { child, offset } in `kids`.
  const pairs = []
  let pending = null
  kids.forEach((kid, index) => {
    if (kid.type !== 'text') return
    const value = kid.value
    const runs = /=+/g
    let match
    while ((match = runs.exec(value))) {
      const at = match.index
      if (match[0].length !== 2) { pending = null; continue }
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

