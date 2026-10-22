// Typora parity: `![](images/英国生活 篇-1.jpg)` and `[x](my notes.md)` are an
// image / link in Typora, whose parser accepts any characters (one level of
// parentheses included) in a link destination. CommonMark forbids a bare
// space there, so micromark leaves the whole construct as literal text, and
// documents exported by Zhihu/WeChat tools (file names built from titles)
// showed `![](…)` as text instead of their images.
//
// Parse-side only: text nodes are re-scanned with Typora's own image/link
// patterns, restricted to destinations that contain a space or tab (anything
// else CommonMark already handles, or rejects for a reason we keep). The new
// nodes carry exact source positions, so the source reprint engine keeps the
// authored bytes; a re-serialized node prints the valid `<…>` spelling, which
// Typora reads too. Must run before remarkImageBlockWithPosition so a lone
// image still becomes an image block.

// Typora 0.11 `image` / `link` (TypeMark), anchored at the match start, with
// newlines kept out of the destination and the title.
const LABEL = String.raw`((?:\[[^\]\n]*\]|[^\[\]\n])*)`
const DEST = String.raw`((?:\([^)\n]*\)|[^()\n])*?)`
const TITLE = String.raw`(?:[ \t]+(['"])([^\n]*?)\4)?`
const CONSTRUCT_RE = new RegExp(String.raw`(!?)\[${LABEL}\]\(${DEST}${TITLE}[ \t]*\)`, 'g')

// Source characters micromark drops from a paragraph's text value: line
// prefixes (`> `, indentation) and trailing spaces before a soft line break.
const SKIPPABLE = new Set([' ', '\t', '>'])

function lineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1)
  return starts
}

function pointAt(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo] + 1, offset }
}

// value index -> source offset, or null when the text holds escapes,
// entities or anything else that is not a plain copy of the source.
function alignText(node, source) {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const value = node.value
  const map = new Array(value.length + 1)
  let si = start
  for (let i = 0; i < value.length; i += 1) {
    while (si < end && source[si] !== value[i] && SKIPPABLE.has(source[si])) si += 1
    if (si >= end || source[si] !== value[i]) return null
    map[i] = si
    si += 1
  }
  map[value.length] = si
  return map
}

function splitText(node, source, starts) {
  const value = node.value
  if (!value.includes('](') || !/[ \t]/.test(value)) return null
  let map
  const out = []
  let last = 0
  const piece = (from, to) => ({
    type: 'text',
    value: value.slice(from, to),
    position: { start: pointAt(starts, map[from]), end: pointAt(starts, map[to - 1] + 1) }
  })
  CONSTRUCT_RE.lastIndex = 0
  for (let match; (match = CONSTRUCT_RE.exec(value));) {
    const [whole, bang, label, rawDest, , title] = match
    const dest = rawDest.trim()
    if (!/[ \t]/.test(dest) || dest.startsWith('<')) continue
    map ??= alignText(node, source)
    if (!map) return null
    const from = match.index
    const to = from + whole.length
    if (from > last) out.push(piece(last, from))
    const position = { start: pointAt(starts, map[from]), end: pointAt(starts, map[to - 1] + 1) }
    const common = { url: dest, title: title ?? null, position }
    if (bang) {
      out.push({ type: 'image', alt: label, ...common })
    } else {
      const labelFrom = from + 1
      const children = label ? [{ type: 'text', value: label, position: { start: pointAt(starts, map[labelFrom]), end: pointAt(starts, map[labelFrom + label.length - 1] + 1) } }] : []
      out.push({ type: 'link', ...common, children })
    }
    last = to
  }
  if (!out.length) return null
  if (last < value.length) out.push(piece(last, value.length))
  return out
}

function walk(parent, source, starts) {
  if (!Array.isArray(parent?.children)) return
  const next = []
  let changed = false
  for (const child of parent.children) {
    // Inside a link a nested link is not allowed; leave its text alone.
    const parts = child.type === 'text' && parent.type !== 'link' ? splitText(child, source, starts) : null
    if (parts) {
      next.push(...parts)
      changed = true
    } else {
      walk(child, source, starts)
      next.push(child)
    }
  }
  if (changed) parent.children = next
}

export function remarkSpacedLinkDestinations() {
  return (tree, file) => {
    let source = typeof file?.value === 'string' ? file.value : String(file?.value ?? '')
    // micromark offsets do not count a leading BOM.
    if (source.startsWith('﻿')) source = source.slice(1)
    if (!source.includes('](')) return
    walk(tree, source, lineStarts(source))
  }
}
