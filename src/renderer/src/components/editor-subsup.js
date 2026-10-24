// Subscript `H~2~O` and superscript `x^2^` (Typora parity; Typora's
// Preferences › Markdown › Syntax Support, off by default — Chinese prose
// uses `~` for ranges: `需要1~2天，100~200元`). Settings › Editor turns each
// on; the switch is read at parse/typing time, and Editor.jsx re-renders the
// open documents when it changes (no reopen needed).
//
//   parse:     inside ONE text node, an unescaped `~` / `^` not next to
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

const KINDS = {
  subscript: { char: '~', tag: 'sub' },
  superscript: { char: '^', tag: 'sup' }
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
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
    if (source[at] !== char) return null
    map[index] = { at, plain: true }
    at += 1
  }
  return at <= end ? map : null
}

// Delimited runs inside one text value: [{ kind, open, close }] (value indices).
function findRuns(value, map, kinds) {
  const runs = []
  let index = 0
  while (index < value.length) {
    const kind = kinds.find((name) => KINDS[name].char === value[index])
    const char = kind && KINDS[kind].char
    const opens = kind && map[index].plain && value[index - 1] !== char && value[index + 1] !== char &&
      index + 1 < value.length && !isBlank(value[index + 1])
    if (!opens) { index += 1; continue }
    let close = -1
    for (let probe = index + 1; probe < value.length; probe += 1) {
      const current = value[probe]
      if (current === char) {
        if (!map[probe].plain) continue
        if (value[probe + 1] === char || value[probe - 1] === char) break
        close = probe
        break
      }
      // Whitespace only as the `\ ` spelling.
      if (isBlank(current) && !(current === ' ' && value[probe - 1] === '\\' && map[probe - 1].plain)) break
    }
    if (close < 0 || close === index + 1 || isBlank(value[close - 1])) { index += 1; continue }
    runs.push({ kind, open: index, close })
    index = close + 1
  }
  return runs
}

const contentValue = (raw) => raw.replace(/\\ /g, ' ')

function splitText(node, source, starts, kinds) {
  const value = node.value
  if (typeof value !== 'string' || !kinds.some((name) => value.includes(KINDS[name].char))) return null
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const map = alignText(value, source, start, end)
  if (!map) return null
  const runs = findRuns(value, map, kinds)
  if (!runs.length) return null
  const sourceAt = (index) => (index < value.length ? map[index].at : end)
  const position = (from, to) => ({ start: pointAt(starts, from), end: pointAt(starts, to) })
  const out = []
  let last = 0
  for (const run of runs) {
    if (run.open > last) {
      out.push({ type: 'text', value: value.slice(last, run.open), position: position(sourceAt(last), sourceAt(run.open)) })
    }
    const inner = value.slice(run.open + 1, run.close)
    out.push({
      type: run.kind,
      data: { hName: KINDS[run.kind].tag },
      position: position(sourceAt(run.open), sourceAt(run.close) + 1),
      children: [{ type: 'text', value: contentValue(inner), position: position(sourceAt(run.open + 1), sourceAt(run.close)) }]
    })
    last = run.close + 1
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last), position: position(sourceAt(last), end) })
  return out
}

/** remark transform: `~x~` / `^x^` in text nodes → subscript / superscript. */
export function transformSubSup(tree, file, kinds) {
  if (!kinds.length) return tree
  const raw = typeof file?.value === 'string' ? file.value : String(file ?? '')
  // micromark offsets do not count a leading BOM.
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let starts = null
  const visit = (node) => {
    if (!Array.isArray(node?.children)) return
    if (node.type === 'inlineCode' || node.type === 'code' || node.type === 'math' || node.type === 'inlineMath') return
    let changed = false
    const next = []
    for (const child of node.children) {
      if (child?.type === 'text') {
        starts ??= lineStarts(source)
        const parts = splitText(child, source, starts, kinds)
        if (parts) {
          next.push(...parts)
          changed = true
          continue
        }
      }
      visit(child)
      next.push(child)
    }
    if (changed) node.children = next
  }
  visit(tree)
  return tree
}

const stringifyHandler = (kind) => {
  const { char } = KINDS[kind]
  const handler = (node, _parent, state, info) => {
    const tracker = state.createTracker(info)
    let value = tracker.move(char)
    const inner = state.containerPhrasing(node, { ...tracker.current(), before: char, after: char })
    value += tracker.move(inner.replace(/ /g, '\\ '))
    value += tracker.move(char)
    return value
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
  const features = [
    subSchema,
    supSchema,
    $remark('subSupParse', () => () => (tree, file) => transformSubSup(tree, file, kinds())),
    // `~~x~~` stays strikethrough: neither delimiter may touch another `~`.
    $inputRule((ctx) => gated('subscript', markRule(/(?<![~\\])~(?!~)([^~\s]+)~$/, subSchema.type(ctx)))),
    $inputRule((ctx) => gated('superscript', markRule(/(?<![\^\\])\^(?!\^)([^\^\s]+)\^$/, supSchema.type(ctx))))
  ]
  let unsafeList = null
  const syncUnsafe = () => {
    // A lone `~` in text must stay escaped only while `~x~` means subscript.
    setLoneTildeEscaping(on('subscript'))
    if (!unsafeList) return
    for (const entry of Object.values(UNSAFE)) {
      const at = unsafeList.indexOf(entry)
      if (at >= 0) unsafeList.splice(at, 1)
    }
    for (const kind of kinds()) unsafeList.push(UNSAFE[kind])
  }
  return {
    features,
    attachUnsafe: (list) => { unsafeList = list; syncUnsafe(); return list },
    syncUnsafe
  }
}
