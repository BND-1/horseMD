// Incremental Markdown parse for the rich→source sync (large-document cost,
// 2026-10-23). Every sync parses two whole files: the committed source (the
// reprint engine's base) and the reprinted candidate (verification). On a
// 350 KB Yuque export that was ~170 ms per pause on an M-series Mac and
// ~0.4 s on a Windows i5. An edit changes a few blocks, so only those are
// parsed again and the rest of the previous parse is reused — the editor
// document reuses the unchanged ProseMirror nodes too, which lets the
// semantic comparison skip them (memoized per node).
//
// The result must be EXACTLY what a full parse gives, or the verification
// would compare the editor against a document nobody will ever open. It is,
// because the window is cut where the Markdown parser's state is empty:
//
//   start: the document start, or the line start of a top-level block whose
//          previous block is a real paragraph followed by a blank line, an
//          ATX/setext heading or a thematic break — nothing can continue
//          past those (no lazy line, no setext underline, no open container);
//   end:   after a top-level paragraph followed by a blank line (or EOF), a
//          heading or a thematic break — checked on the window's OWN parse,
//          so an unclosed fence/`$$`/HTML block opened by the edit (which
//          would swallow the rest of the file) never ends a window.
//
// Text outside the window is byte-identical and starts from the same empty
// state, so it parses the same (positions shifted). Not local, so always a
// full parse: link/footnote definitions (global, and remark-inline-links
// deletes them from the tree — detected by `]:` in the text), frontmatter
// (only at line 1: a window starting with `---`/`+++`; and a file that
// starts with one — an unclosed fence changes how the rest parses), a BOM.
//
// `globalThis.__hmIncrementalParseCheck = true` also runs the full parse and
// reports any difference (tests and the fuzzer turn it on).
import { ParserState } from '@milkdown/kit/transformer'

const ANCHORS = new Set(['paragraph', 'heading', 'thematicBreak'])
const MAX_ENTRIES = 3
// A window larger than this share of the file is parsed whole.
const MAX_WINDOW_SHARE = 0.5

const startOf = (node) => node?.position?.start?.offset
const endOf = (node) => node?.position?.end?.offset
const isLineEnd = (code) => code === 10 || code === 13

const lineStart = (text, offset) => {
  let at = offset
  while (at > 0 && !isLineEnd(text.charCodeAt(at - 1))) at -= 1
  return at
}
const lineEnd = (text, offset) => {
  let at = offset
  while (at < text.length && !isLineEnd(text.charCodeAt(at))) at += 1
  return at
}
const blanksOnly = (text, from, to) => {
  for (let at = from; at < to; at += 1) {
    const code = text.charCodeAt(at)
    if (code !== 32 && code !== 9) return false
  }
  return true
}
// `at` is a line end: the next line is blank, or there is none.
const blankLineFollows = (text, at) => {
  if (at >= text.length) return true
  let next = at + (text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10 ? 2 : 1)
  while (next < text.length && (text.charCodeAt(next) === 32 || text.charCodeAt(next) === 9)) next += 1
  return next >= text.length || isLineEnd(text.charCodeAt(next))
}
const BLANK_LINE = /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/
const eolCount = (text) => {
  let count = 0
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at)
    if (code === 10) count += 1
    else if (code === 13) {
      count += 1
      if (text.charCodeAt(at + 1) === 10) at += 1
    }
  }
  return count
}
// A paragraph that only wraps raw HTML is an HTML block (Milkdown's
// remarkHtmlTransformer): types 1–5 run until their end tag, so it is no
// boundary.
const onlyHtml = (node) => Array.isArray(node.children) && node.children.length > 0 &&
  node.children.every((child) => child?.type === 'html')
const isAnchor = (node) => ANCHORS.has(node?.type) &&
  Number.isInteger(startOf(node)) && Number.isInteger(endOf(node)) &&
  !(node.type === 'paragraph' && onlyHtml(node))
const mayHoldDefinitions = (text) => text.includes(']:')
const startsLikeFrontmatter = (text, at) => text.startsWith('---', at) || text.startsWith('+++', at)

const shiftPoint = (point, offset, line) => (point ? { ...point, offset: point.offset + offset, line: point.line + line } : point)
const shiftPosition = (position, offset, line) => (position
  ? { ...position, start: shiftPoint(position.start, offset, line), end: shiftPoint(position.end, offset, line) }
  : position)
// The window's fresh tree: shift in place.
const shiftInPlace = (node, offset, line) => {
  if (node.position) node.position = shiftPosition(node.position, offset, line)
  if (Array.isArray(node.children)) for (const child of node.children) shiftInPlace(child, offset, line)
}
// The previous tree's nodes are shared with its cache entry: copy.
const shiftedCopy = (node, offset, line) => {
  const copy = { ...node }
  if (node.position) copy.position = shiftPosition(node.position, offset, line)
  if (Array.isArray(node.children)) copy.children = node.children.map((child) => shiftedCopy(child, offset, line))
  return copy
}

/**
 * Convert top-level mdast children to ProseMirror blocks one by one (what
 * Milkdown's root runner does in one go), recording how many blocks each
 * child made. Returns null if a runner left the stack unbalanced.
 */
export function mdastToBlocks(schema, children) {
  const state = new ParserState(schema)
  state.openNode(schema.topNodeType)
  const top = state.top()
  const counts = []
  for (const child of children) {
    const before = top.content.length
    state.next(child)
    if (state.top() !== top) return null
    counts.push(top.content.length - before)
  }
  return { nodes: top.content.slice(), counts }
}

const docFrom = (schema, nodes, attrs = null) => {
  const doc = schema.topNodeType.createAndFill(attrs, nodes)
  return doc && doc.childCount === nodes.length ? doc : null
}

export const parseMarkdownFull = (remark, schema, body) => {
  const mdRoot = remark.runSync(remark.parse(body), body)
  const blocks = mdastToBlocks(schema, mdRoot.children || [])
  const doc = blocks ? docFrom(schema, blocks.nodes) : null
  if (doc) return { body, mdRoot, srcDoc: doc, counts: blocks.counts, noDefs: !mayHoldDefinitions(body) }
  // Unusual shape (empty document, unbalanced runner): Milkdown's own path.
  const state = new ParserState(schema)
  state.next(mdRoot)
  return { body, mdRoot, srcDoc: state.toDoc(), counts: null, noDefs: false }
}

/**
 * Parse `markdown` by reparsing only the changed top-level blocks of `base`
 * (a cache entry). Null when the edit is not provably local.
 */
export function incrementalParse(base, markdown, remark, schema) {
  const old = base?.body
  const kids = base?.mdRoot?.children
  if (typeof old !== 'string' || typeof markdown !== 'string' || !Array.isArray(kids) || !kids.length) return null
  if (!base.noDefs || !Array.isArray(base.counts) || base.counts.length !== kids.length) return null
  if (markdown.charCodeAt(0) === 0xfeff || old.charCodeAt(0) === 0xfeff) return null
  // A file starting with a frontmatter fence is parsed whole: an UNCLOSED
  // fence changes how the whole rest of the file parses (micromark's
  // frontmatter extension: every later list/quote becomes paragraph text).
  if (startsLikeFrontmatter(markdown, 0) || startsLikeFrontmatter(old, 0)) return null
  if (markdown === old) return base
  if (!kids.every((kid) => Number.isInteger(startOf(kid)) && Number.isInteger(endOf(kid)))) return null

  // The changed range: [a, bOld) in the old text, [a, bNew) in the new one.
  const shortest = Math.min(old.length, markdown.length)
  let a = 0
  while (a < shortest && old.charCodeAt(a) === markdown.charCodeAt(a)) a += 1
  let tail = 0
  while (tail < shortest - a && old.charCodeAt(old.length - 1 - tail) === markdown.charCodeAt(markdown.length - 1 - tail)) tail += 1
  const bOld = old.length - tail
  const delta = markdown.length - old.length

  // Window start: kids[k] at line start `s`, with an empty parser state there.
  let k = kids.findIndex((kid) => endOf(kid) >= a)
  if (k < 0) k = kids.length - 1
  let s = 0
  while (k > 0) {
    const previous = kids[k - 1]
    const at = lineStart(old, startOf(kids[k]))
    const closed = isAnchor(previous) && endOf(previous) < at && at <= a &&
      (previous.type !== 'paragraph' || BLANK_LINE.test(old.slice(endOf(previous), at)))
    if (closed && !startsLikeFrontmatter(markdown, at)) {
      s = at
      break
    }
    k -= 1
  }

  // Window end: after kids[m], a closed block entirely past the change.
  let m = k
  while (m < kids.length && startOf(kids[m]) < bOld) m += 1
  let eOld = old.length
  for (; m < kids.length; m += 1) {
    const kid = kids[m]
    if (!isAnchor(kid)) continue
    const end = lineEnd(old, endOf(kid))
    if (!blanksOnly(old, endOf(kid), end)) continue
    if (kid.type === 'paragraph' && !blankLineFollows(old, end)) continue
    eOld = end
    break
  }
  const eNew = eOld + delta
  if (eNew < s || eOld < bOld) return null
  const windowText = markdown.slice(s, eNew)
  if (windowText.length > markdown.length * MAX_WINDOW_SHARE) return null
  if (mayHoldDefinitions(windowText)) return null

  const tree = remark.runSync(remark.parse(windowText), windowText)
  const fresh = Array.isArray(tree?.children) ? tree.children : null
  if (!fresh) return null
  if (m < kids.length) {
    // The window must END in the same kind of closed block (an unclosed
    // construct opened by the edit would have swallowed it).
    const last = fresh.at(-1)
    if (!isAnchor(last) || last.type !== kids[m].type || !blanksOnly(windowText, endOf(last), windowText.length)) return null
  }
  const blocks = mdastToBlocks(schema, fresh)
  if (!blocks) return null

  const lineOffset = s === 0 ? 0 : kids[k].position.start.line - 1
  for (const child of fresh) shiftInPlace(child, s, lineOffset)
  const lineDelta = eolCount(windowText) - eolCount(old.slice(s, eOld))
  const after = m < kids.length ? kids.slice(m + 1) : []
  const shiftedAfter = delta === 0 && lineDelta === 0 ? after : after.map((kid) => shiftedCopy(kid, delta, lineDelta))

  const counts = base.counts
  let before = 0
  for (let index = 0; index < k; index += 1) before += counts[index]
  let through = before
  for (let index = k; index <= Math.min(m, kids.length - 1); index += 1) through += counts[index]
  const oldBlocks = []
  base.srcDoc.forEach((node) => oldBlocks.push(node))
  if (oldBlocks.length !== counts.reduce((sum, count) => sum + count, 0)) return null
  const nodes = [...oldBlocks.slice(0, before), ...blocks.nodes, ...oldBlocks.slice(through)]
  const srcDoc = docFrom(schema, nodes, base.srcDoc.attrs)
  if (!srcDoc) return null

  const rootPosition = base.mdRoot.position
  let end
  if (m < kids.length) end = shiftPoint(rootPosition?.end, delta, lineDelta)
  else {
    const windowEnd = tree.position?.end
    end = windowEnd ? { ...windowEnd, offset: windowEnd.offset + s, line: windowEnd.line + lineOffset } : rootPosition?.end
  }
  const mdRoot = {
    ...base.mdRoot,
    children: [...kids.slice(0, k), ...fresh, ...shiftedAfter],
    ...(rootPosition ? { position: { ...rootPosition, end } } : {})
  }
  return {
    body: markdown,
    mdRoot,
    srcDoc,
    counts: [...counts.slice(0, k), ...blocks.counts, ...counts.slice(m + 1)],
    noDefs: true,
    incremental: { window: windowText.length, blocks: blocks.nodes.length }
  }
}

// --- Per-editor cache -------------------------------------------------------

// remark processor (one per editor) → recent entries, newest first: the
// committed source and the latest candidates. Entries are only read.
const caches = new WeakMap()
const cacheKey = (remark) => (remark && (typeof remark === 'object' || typeof remark === 'function') ? remark : null)

const sameTree = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export function rememberParse(remark, entry) {
  const key = cacheKey(remark)
  if (!key || !entry || typeof entry.body !== 'string') return
  const entries = (caches.get(key) || []).filter((other) => other.body !== entry.body)
  entries.unshift(entry)
  caches.set(key, entries.slice(0, MAX_ENTRIES))
}

// A parse option changed: cached trees were made under the old one.
export function forgetParses(remark) {
  const key = cacheKey(remark)
  if (key) caches.delete(key)
}

export function cachedParse(remark, body) {
  const key = cacheKey(remark)
  return (key && (caches.get(key) || []).find((entry) => entry.body === body)) || null
}

const checkEnabled = () => globalThis.__hmIncrementalParseCheck === true

/**
 * `{ body, mdRoot, srcDoc }` for `body`: cached, incremental from a cached
 * neighbour, or full. Every result is remembered.
 */
export function parseMarkdownCached(remark, schema, body, { onMismatch = null } = {}) {
  const cached = cachedParse(remark, body)
  if (cached) return cached
  let entry = null
  for (const base of caches.get(cacheKey(remark)) || []) {
    try {
      entry = incrementalParse(base, body, remark, schema)
    } catch {
      entry = null
    }
    if (entry) break
  }
  if (entry && checkEnabled()) {
    const full = parseMarkdownFull(remark, schema, body)
    if (!full.srcDoc.eq(entry.srcDoc) || !sameTree(full.mdRoot, entry.mdRoot)) {
      const report = { at: Date.now(), length: body.length, window: entry.incremental?.window ?? null }
      if (!Array.isArray(globalThis.__hmIncrementalParseMismatch)) globalThis.__hmIncrementalParseMismatch = []
      globalThis.__hmIncrementalParseMismatch.push(report)
      try { onMismatch?.(report) } catch { /* reporting only */ }
      entry = full
    }
  }
  if (!entry) entry = parseMarkdownFull(remark, schema, body)
  rememberParse(remark, entry)
  return entry
}
