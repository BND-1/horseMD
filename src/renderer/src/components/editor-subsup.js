// Subscript `H~2~O` and superscript `x^2^` (Typora parity; Typora's
// Preferences › Markdown › Syntax Support, off by default — Chinese prose
// uses `~` for ranges: `需要1~2天，100~200元`). Settings › Editor turns each
// on; the switch is read at parse/typing time, and Editor.jsx re-renders the
// open documents when it changes (no reopen needed).
//
//   parse:     inside one text node (or across siblings: other formatting
//              inside, `~a **b** c~`), an unescaped `~` / `^` not next to
//              another, non-blank content without unescaped whitespace
//              (`\ ` spells a space, like Typora/Pandoc), then the same
//              delimiter → a `subscript` / `superscript` mdast node with exact
//              source positions (the reprint engine keeps the authored bytes).
//              The text is aligned to the source so an escaped `\~` never
//              delimits; a text node that cannot be aligned is left alone.
//   stringify: `~content~` / `^content^`, spaces written `\ `.
//   typing:    the closing delimiter converts, like `==highlight==`.
import { markRule } from '@milkdown/prose'
import { $inputRule, $markSchema, $remark } from '@milkdown/utils'
import { setLoneTildeEscaping } from '../lib/remark-text-handler.js'
import { setHtmlMarkTags } from './editor-html-span.js'

const KINDS = {
  subscript: { char: '~', tag: 'sub' },
  superscript: { char: '^', tag: 'sup' }
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const ENTITY = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const isBlank = (char) => char === ' ' || char === '\t' || char === '\n' || char === '\r'

const lineStarts = (source) => {
  const starts = [0]
  for (let at = 0; at < source.length; at += 1) {
    const code = source.charCodeAt(at)
    if (code === 10) starts.push(at + 1)
    else if (code === 13) {
      if (source.charCodeAt(at + 1) === 10) at += 1
      starts.push(at + 1)
    }
  }
  return starts
}
const pointAt = (starts, offset) => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - starts[low] + 1, offset }
}

// value index -> { at: source offset, plain: written literally } for a text
// node, or null when the value cannot be followed through the source
// (entities, unusual continuation prefixes).
function alignText(value, source, start, end) {
  const map = new Array(value.length)
  let at = start
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\n') {
      if (source[at] === '\r' && source[at + 1] === '\n') at += 1
      if (source[at] !== '\n' && source[at] !== '\r') return null
      map[index] = { at, plain: true }
      at += 1
      // Continuation-line indentation and quote prefixes are not in the value.
      const next = value[index + 1]
      while (at < end && (source[at] === ' ' || source[at] === '\t' || (source[at] === '>' && next !== '>'))) at += 1
      continue
    }
    if (source[at] === '\\' && ASCII_PUNCT.test(source[at + 1] || '') && source[at + 1] === char) {
      map[index] = { at, plain: false }
      at += 2
      continue
    }
    // A character reference (`&#x65;` — the strong / emphasis handlers
    // encode a neighbour that way, a tab inside sub/sup is `&#x9;`).
    if (source[at] === '&') {
      const entity = ENTITY.exec(source.slice(at, at + 40))
      if (entity) {
        const decoded = entity[1] ? String.fromCodePoint(parseInt(entity[1], 16)) : entity[2] ? String.fromCodePoint(parseInt(entity[2], 10)) : NAMED[entity[3]]
        if (decoded && decoded === value.slice(index, index + decoded.length)) {
          for (let k = 0; k < decoded.length; k += 1) map[index + k] = { at: at + (k ? entity[0].length : 0), plain: false }
          index += decoded.length - 1
          at += entity[0].length
          continue
        }
      }
    }
    if (source[at] !== char) return null
    map[index] = { at, plain: true }
    at += 1
  }
  return at <= end ? map : null
}

const contentValue = (raw) => raw.replace(/\\ /g, ' ')

// One left-to-right pass over a phrasing parent's children (as CommonMark
// pairs delimiters, and as lib/remark-highlight-parse.js pairs `==`): each
// unescaped `~` / `^` not next to another one opens, the nearest valid one
// after it closes. The content may hold other formatting (`~a **b** c~`,
// `~中==内==容~` — what the editor writes for a subscript over formatted
// text; Pandoc / markdown-it-sub parity) but no whitespace written
// literally (`\ ` and character references are fine) and no blank at either
// edge. Runs nested in the content are paired when it is visited. Pieces keep
// exact positions (the source reprint keeps the authored bytes).
function pairDelimiters(node, source, starts, kinds) {
  const kids = node.children
  const info = kids.map((kid) => {
    if (kid.type !== 'text') return null
    const start = kid.position?.start?.offset
    const end = kid.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
    const map = alignText(kid.value, source, start, end)
    return map ? { value: kid.value, map, start, end } : null
  })
  if (!info.some((entry) => entry && kinds.some((name) => entry.value.includes(KINDS[name].char)))) return false
  const escapedBlank = (entry, at) => entry.map[at]?.plain === false ||
    (entry.value[at] === ' ' && entry.value[at - 1] === '\\' && entry.map[at - 1]?.plain)
  const literalBlank = (entry, at) => isBlank(entry.value[at]) && !escapedBlank(entry, at)
  const nestedBlankFree = (child) => {
    if (child.type === 'inlineCode' || child.type === 'inlineMath' || child.type === 'html' || child.type === 'image') return true
    if (child.type === 'text') {
      const start = child.position?.start?.offset
      const end = child.position?.end?.offset
      const map = Number.isInteger(start) && Number.isInteger(end) ? alignText(child.value, source, start, end) : null
      const entry = { value: child.value, map: map || [] }
      for (let at = 0; at < child.value.length; at += 1) if (literalBlank(entry, at)) return false
      return true
    }
    return Array.isArray(child.children) ? child.children.every(nestedBlankFree) : true
  }
  // The character just before / after (k, at); 'x' for a non-text sibling.
  const charAt = (k, at) => {
    const entry = info[k]
    if (entry && at >= 0 && at < entry.value.length) return entry.value[at]
    if (at < 0) return k > 0 ? (info[k - 1] ? info[k - 1].value.slice(-1) || undefined : 'x') : undefined
    return k + 1 < kids.length ? (info[k + 1] ? info[k + 1].value[0] : 'x') : undefined
  }
  const pairs = []
  const pending = {}
  for (let k = 0; k < kids.length; k += 1) {
    const entry = info[k]
    if (!entry) {
      if (!nestedBlankFree(kids[k])) for (const name of kinds) pending[name] = null
      continue
    }
    for (let at = 0; at < entry.value.length; at += 1) {
      if (literalBlank(entry, at)) { for (const name of kinds) pending[name] = null; continue }
      const kind = kinds.find((name) => KINDS[name].char === entry.value[at])
      if (!kind || !entry.map[at].plain) continue
      const char = KINDS[kind].char
      if (charAt(k, at - 1) === char || charAt(k, at + 1) === char) { pending[kind] = null; continue }
      const open = pending[kind]
      const before = charAt(k, at - 1)
      const hasContent = open && !(open.k === k && open.at === at - 1)
      if (hasContent && before !== undefined && !(entry && at > 0 && literalBlank(entry, at - 1))) {
        // A closer: drop runs found inside (visited later) and other kinds
        // opened inside (they would cross).
        while (pairs.length && (pairs[pairs.length - 1].k > open.k || (pairs[pairs.length - 1].k === open.k && pairs[pairs.length - 1].at > open.at))) pairs.pop()
        for (const name of kinds) if (name !== kind && pending[name] && (pending[name].k > open.k || (pending[name].k === open.k && pending[name].at > open.at))) pending[name] = null
        pairs.push({ kind, k: open.k, at: open.at, closeK: k, closeAt: at })
        pending[kind] = null
        continue
      }
      const after = charAt(k, at + 1)
      pending[kind] = after !== undefined && !(at + 1 < entry.value.length && literalBlank(entry, at + 1)) ? { k, at } : null
    }
  }
  if (!pairs.length) return false
  const position = (from, to) => ({ start: pointAt(starts, from), end: pointAt(starts, to) })
  const offsetOf = (k, at) => (at < info[k].value.length ? info[k].map[at].at : info[k].end)
  const piece = (k, from, to) => ({ type: 'text', value: info[k].value.slice(from, to), position: position(offsetOf(k, from), offsetOf(k, to)) })
  const unescapeSpaces = (child) => {
    if (child.type === 'text') child.value = contentValue(child.value)
    else if (Array.isArray(child.children) && child.type !== 'inlineCode') child.children.forEach(unescapeSpaces)
  }
  const out = []
  let k = 0
  let at = 0
  for (const pair of pairs) {
    while (k < pair.k) {
      // Never an empty text node (ProseMirror drops the run before it).
      if (at === 0) out.push(kids[k])
      else if (at < info[k].value.length) out.push(piece(k, at, info[k].value.length))
      k += 1
      at = 0
    }
    if (pair.at > at) out.push(piece(k, at, pair.at))
    const inner = []
    if (pair.k === pair.closeK) {
      if (pair.closeAt > pair.at + 1) inner.push(piece(k, pair.at + 1, pair.closeAt))
    } else {
      if (info[pair.k].value.length > pair.at + 1) inner.push(piece(pair.k, pair.at + 1, info[pair.k].value.length))
      inner.push(...kids.slice(pair.k + 1, pair.closeK))
      if (pair.closeAt > 0) inner.push(piece(pair.closeK, 0, pair.closeAt))
    }
    inner.forEach(unescapeSpaces)
    out.push({
      type: pair.kind,
      data: { hName: KINDS[pair.kind].tag },
      position: position(offsetOf(pair.k, pair.at), offsetOf(pair.closeK, pair.closeAt) + 1),
      children: inner
    })
    k = pair.closeK
    at = pair.closeAt + 1
  }
  if (k < kids.length) {
    if (at > 0) {
      if (at < info[k].value.length) out.push(piece(k, at, info[k].value.length))
      k += 1
    }
    out.push(...kids.slice(k))
  }
  node.children = out
  return true
}

/** remark transform: `~x~` / `^x^` → subscript / superscript. */
export function transformSubSup(tree, file, kinds) {
  if (!kinds.length) return tree
  const raw = typeof file?.value === 'string' ? file.value : String(file ?? '')
  // micromark offsets do not count a leading BOM.
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let starts = null
  const visit = (node) => {
    if (!Array.isArray(node?.children)) return
    if (node.type === 'inlineCode' || node.type === 'code' || node.type === 'math' || node.type === 'inlineMath') return
    if (node.children.some((child) => child?.type === 'text')) {
      starts ??= lineStarts(source)
      pairDelimiters(node, source, starts, kinds)
    }
    for (const child of node.children) visit(child)
  }
  visit(tree)
  return tree
}

const stringifyHandler = (kind) => {
  const { char } = KINDS[kind]
  // Blanks in the TEXT inside (nested text too) are written `\ ` (space)
  // and `&#x9;` (tab) — sub/sup content holds no whitespace. Inline code,
  // link destinations and the like keep theirs: only the text handler is
  // wrapped while the content is written.
  const { tag } = KINDS[kind]
  const handler = (node, _parent, state, info) => {
    const tracker = state.createTracker(info)
    const text = state.handlers.text
    state.handlers.text = (child, parent, inner, details) => text(child, parent, inner, details).replace(/ /g, '\\ ').replace(/\t/g, '&#x9;')
    let content
    try {
      content = state.containerPhrasing(node, { ...tracker.current(), before: char, after: char })
    } finally {
      state.handlers.text = text
    }
    // `~` against another `~` (a strikethrough around, inside or next to
    // it): `~~~x~~~` reads as neither — written as the HTML tag instead,
    // which reads back as this mark (convertHtmlSpans, setHtmlMarkTags).
    const touches = content.startsWith(char) || content.endsWith(char) ||
      String(info?.before || '').endsWith(char) || String(info?.after || '').startsWith(char)
    if (touches) {
      const open = `<${tag}>`
      const html = state.containerPhrasing(node, { ...tracker.current(), before: '>', after: '<' })
      return tracker.move(open) + tracker.move(html) + tracker.move(`</${tag}>`)
    }
    return tracker.move(char) + tracker.move(content) + tracker.move(char)
  }
  handler.peek = () => char
  return handler
}
export const subscriptStringifyHandler = stringifyHandler('subscript')
export const superscriptStringifyHandler = stringifyHandler('superscript')

const markSchema = (kind, isOn) => $markSchema(kind, () => ({
  // Typing after `H~2~` is back to normal text (Typora).
  inclusive: false,
  excludes: kind === 'subscript' ? 'superscript' : 'subscript',
  // Only the editor's own copies, and only while the syntax is on: a pasted
  // <sub> with the syntax off would save as `~x~` and reopen as text.
  parseDOM: [{ tag: `${KINDS[kind].tag}.hm-${KINDS[kind].tag}`, getAttrs: () => (isOn() ? null : false) }],
  toDOM: () => [KINDS[kind].tag, { class: `hm-${KINDS[kind].tag}` }, 0],
  parseMarkdown: {
    match: (node) => node.type === kind,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === kind,
    runner: (state, mark) => {
      state.withMark(mark, kind)
    }
  }
}))

const UNSAFE = {
  // `~` is already escaped by GFM strikethrough's own unsafe pattern.
  subscript: { character: '~', inConstruct: 'phrasing' },
  superscript: { character: '^', inConstruct: 'phrasing' }
}

/**
 * Milkdown features for `crepe.editor.use(...)`. `getSyntax()` returns the
 * current `{ subscript, superscript }` settings and is read on every parse,
 * typed delimiter and paste, so a change applies without recreating the
 * editor. `attachUnsafe(array)` keeps remark-stringify's escape list (the
 * array in the stringify options) in step with it: with superscript on, a
 * literal `^` must not pair up on reparse.
 */
export function createSubSupFeatures(getSyntax = () => ({})) {
  const on = (kind) => getSyntax()?.[kind] === true
  const kinds = () => ['subscript', 'superscript'].filter(on)
  const subSchema = markSchema('subscript', () => on('subscript'))
  const supSchema = markSchema('superscript', () => on('superscript'))
  const gated = (kind, rule) => {
    const handler = rule.handler
    rule.handler = (state, match, start, end) => (on(kind) ? handler(state, match, start, end) : null)
    return rule
  }
  // Before the highlight parse (registered separately, ahead of it):
  // `==~x~==` is split here first, then paired as a highlight across the
  // pieces; the highlight parse leaves its own pieces unpositioned.
  const parse = $remark('subSupParse', () => () => (tree, file) => transformSubSup(tree, file, kinds()))
  const features = [
    subSchema,
    supSchema,
    // `~~x~~` stays strikethrough: neither delimiter may touch another `~`.
    $inputRule((ctx) => gated('subscript', markRule(/(?<![~\\])~(?!~)([^~\s]+)~$/, subSchema.type(ctx)))),
    $inputRule((ctx) => gated('superscript', markRule(/(?<![\^\\])\^(?!\^)([^\^\s]+)\^$/, supSchema.type(ctx))))
  ]
  let unsafeList = null
  const syncUnsafe = () => {
    // A lone `~` in text must stay escaped only while `~x~` means subscript.
    setLoneTildeEscaping(on('subscript'))
    // `<sub>` / `<sup>` read as these marks while they are on (the
    // serializer writes them where `~` would touch `~~`).
    setHtmlMarkTags(Object.fromEntries(kinds().map((kind) => [KINDS[kind].tag, kind])))
    if (!unsafeList) return
    for (const entry of Object.values(UNSAFE)) {
      const at = unsafeList.indexOf(entry)
      if (at >= 0) unsafeList.splice(at, 1)
    }
    for (const kind of kinds()) unsafeList.push(UNSAFE[kind])
  }
  return {
    parse,
    features,
    attachUnsafe: (list) => { unsafeList = list; syncUnsafe(); return list },
    syncUnsafe
  }
}
