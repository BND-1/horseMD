import { codeMirrorSelectionInfo } from './components/editor-codemirror-selection.js'
const SNIPPET_LEN = 24

// --------------------------- shared snippet matching ---------------------------

// Strip markdown syntax so a SOURCE-side snippet matches the rich doc's visible
// text (which has no link/emphasis/code/heading syntax). ORDER MATTERS: strip
// structural markers (heading/blockquote/list) BEFORE emphasis — otherwise the
// emphasis `\*` eats a bullet-list `*` first and leaves the trailing space.
const stripMdForSnippet = (s) => s
  .replace(/^\s{0,3}#{1,6}\s*/gm, '')         // heading markers
  .replace(/^\s{0,3}>\s?/gm, '')              // blockquote markers
  .replace(/^\s{0,3}[-*+]\s+/gm, '')          // bullet list markers
  .replace(/^\s{0,3}\d+\.\s+/gm, '')          // ordered list markers
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image ![alt](url) → alt
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // link [text](url) → text
  .replace(/```[\s\S]*?```/g, '')            // fenced code blocks
  .replace(/[`]+/g, '')                       // inline code backticks
  .replace(/\*\*|__|~~|\*|_/g, '')            // emphasis (after markers, so it
                                              // can't swallow a bullet `*`)

// All PM-position spans where `snippet` occurs in the doc's visible text. Walks
// the text nodes once, then indexOf-loops over the joined chars. [] if absent.
const visibleOccurrences = (doc, snippet) => {
  if (!snippet) return []
  let chars = ''
  const starts = [] // starts[i] = PM position of visible char i
  doc.descendants((node, pos) => {
    if (node.isText) {
      const t = node.text
      for (let i = 0; i < t.length; i++) { starts.push(pos + i); chars += t[i] }
      return false
    }
    return true
  })
  const out = []
  let from = 0
  for (;;) {
    const idx = chars.indexOf(snippet, from)
    if (idx < 0) break
    out.push({ start: starts[idx], end: starts[idx + snippet.length - 1] + 1 })
    from = idx + 1 // overlap-by-one so adjacent repeats each match
  }
  return out
}

// First PM position (snippet START) nearest `nearestTo` — used by the caret
// restore (caret = snippetStart + snipOff) and the viewport restore (the
// snippet's start goes to the top). Falls back to the FIRST occurrence when no
// hint is given.
const posAtText = (doc, snippet, nearestTo = -1) => {
  const occ = visibleOccurrences(doc, snippet)
  if (!occ.length) return -1
  if (nearestTo < 0) return occ[0].start
  let best = occ[0]
  let bd = Infinity
  for (const o of occ) {
    const d = Math.abs(o.start - nearestTo)
    if (d < bd) { bd = d; best = o }
  }
  return best.start
}

// Char index of the `needle` occurrence in `hay` nearest `nearestTo` (last one
// when no hint). Source-side twin of posAtText for the textarea.
const nearestIndexOf = (hay, needle, nearestTo = -1) => {
  if (!needle) return -1
  const occ = []
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i < 0) break
    occ.push(i)
    from = i + 1
  }
  if (!occ.length) return -1
  if (nearestTo < 0) return occ[occ.length - 1]
  let best = occ[0]
  let bd = Infinity
  for (const o of occ) {
    const d = Math.abs(o - nearestTo)
    if (d < bd) { bd = d; best = o }
  }
  return best
}

const appendInlineVisible = (out, raw, base = 0) => {
  let i = 0
  const push = (ch, rawIndex) => {
    out.text += ch
    out.map.push(rawIndex)
  }
  while (i < raw.length) {
    if (raw.startsWith('![', i)) {
      const close = raw.indexOf(']', i + 2)
      if (close >= 0 && raw[close + 1] === '(') {
        const end = raw.indexOf(')', close + 2)
        if (end >= 0) {
          // ProseMirror images are atom nodes and contribute no characters to
          // the rich text stream. Alt text must therefore consume no visible
          // index here, otherwise every image shifts all later source carets.
          i = end + 1
          continue
        }
      }
    }
    if (raw[i] === '[') {
      const close = raw.indexOf(']', i + 1)
      if (close >= 0 && raw[close + 1] === '(') {
        const end = raw.indexOf(')', close + 2)
        if (end >= 0) {
          for (let j = i + 1; j < close; j++) push(raw[j], base + j)
          i = end + 1
          continue
        }
      }
    }
    if (raw[i] === '`') {
      i++
      continue
    }
    if (raw[i] === '<') {
      const end = raw.indexOf('>', i + 1)
      if (end >= 0) {
        i = end + 1
        continue
      }
    }
    if ((raw[i] === '*' || raw[i] === '_' || raw[i] === '~') && raw[i + 1] === raw[i]) {
      i += 2
      continue
    }
    if (raw[i] === '*' || raw[i] === '_' || raw[i] === '~') {
      i++
      continue
    }
    push(raw[i], base + i)
    i++
  }
}

const appendRawVisible = (out, raw, base = 0) => {
  for (let i = 0; i < raw.length; i++) {
    out.text += raw[i]
    out.map.push(base + i)
  }
}

// Markdown source does not have the same text stream as ProseMirror: table pipes,
// heading hashes, list markers, link URLs and emphasis markers exist only in
// source. Build a lightweight "visible source text" buffer plus a visible-char →
// raw-char map so a rich caret snippet can land on the textarea char that renders
// that same visible text.
const sourceVisibleIndex = (md) => {
  const out = { text: '', map: [] }
  if (!md) return out
  const lines = md.split(/(\n)/)
  let rawPos = 0
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '\n') {
      if (inFence) {
        out.text += line
        out.map.push(rawPos)
      }
      rawPos += 1
      continue
    }
    const lineStart = rawPos
    rawPos += line.length
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      appendRawVisible(out, line, lineStart)
      continue
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) continue
    const tableLike = /^\s*\|.*\|\s*$/.test(line)
    if (tableLike) {
      let cursor = 0
      const cells = line.split('|')
      for (const cell of cells) {
        const cellRawStart = cursor
        cursor += cell.length + 1
        const leading = cell.match(/^\s*/)?.[0].length || 0
        const trailing = cell.match(/\s*$/)?.[0].length || 0
        const core = cell.slice(leading, Math.max(leading, cell.length - trailing))
        if (core) appendInlineVisible(out, core, lineStart + cellRawStart + leading)
      }
      continue
    }
    const marker = line.match(/^(\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+))/)
    const offset = marker ? marker[0].length : 0
    appendInlineVisible(out, line.slice(offset), lineStart + offset)
  }
  return out
}

const visibleSourcePosition = (md, snippet, snipOff = 0, nearestTo = -1) => {
  if (!md || !snippet) return -1
  const idx = sourceVisibleIndex(md)
  const occ = []
  let from = 0
  for (;;) {
    const i = idx.text.indexOf(snippet, from)
    if (i < 0) break
    const rawStart = idx.map[i]
    const rawTarget = idx.map[Math.min(i + snipOff, idx.map.length - 1)]
    if (rawStart != null && rawTarget != null) occ.push({ rawStart, rawTarget })
    from = i + 1
  }
  if (!occ.length) return -1
  let best = occ[0]
  let bd = Infinity
  for (const o of occ) {
    const d = nearestTo >= 0 ? Math.abs(o.rawStart - nearestTo) : 0
    if (d < bd) { bd = d; best = o }
  }
  return best.rawTarget
}

const sourceVisiblePositionAtRaw = (md, rawPos) => {
  const idx = sourceVisibleIndex(md)
  const map = idx.map
  if (!map.length) return { visibleIndex: 0, visibleAffinity: 'forward' }
  const raw = Math.max(0, Math.min(rawPos || 0, md.length))
  let lo = 0
  let hi = map.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (map[mid] < raw) lo = mid + 1
    else hi = mid
  }
  return {
    visibleIndex: lo,
    visibleAffinity: map[lo] === raw ? 'forward' : 'backward'
  }
}

const sourceRawFromVisibleIndex = (md, visibleIndex, affinity = 'forward') => {
  const idx = sourceVisibleIndex(md)
  const map = idx.map
  if (!map.length) return 0
  const v = Math.max(0, Math.min(Math.round(visibleIndex || 0), map.length))
  if (affinity === 'backward' && v > 0) return Math.min(md.length, map[v - 1] + 1)
  if (v < map.length) return map[v]
  return Math.min(md.length, map[map.length - 1] + 1)
}

const richVisiblePositionAtPos = (doc, pmPos) => {
  let acc = 0
  let found = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (!node.isText) return true
    const len = node.text.length
    if (pmPos <= pos) {
      found = { visibleIndex: acc, visibleAffinity: 'forward' }
    } else if (pmPos < pos + len) {
      found = { visibleIndex: acc + (pmPos - pos), visibleAffinity: 'forward' }
    } else if (pmPos === pos + len) {
      found = { visibleIndex: acc + len, visibleAffinity: 'backward' }
    }
    acc += len
    return false
  })
  return found || { visibleIndex: acc, visibleAffinity: 'backward' }
}

const richDomVisiblePositionAtSelection = (view) => {
  try {
    const root = view?.dom
    const doc = root?.ownerDocument
    const sel = doc?.getSelection?.()
    if (!root || !doc || !sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null
    const info = codeMirrorSelectionInfo(view, sel)
    if (!info) return null
    const base = richVisiblePositionAtPos(view.state.doc, info.blockPos + 1)
    return { visibleIndex: base.visibleIndex + info.local, visibleAffinity: 'forward' }
  } catch {
    return null
  }
}

const richPointerVisiblePosition = (view) => {
  try {
    const pointer = view?.dom?.__horsemdLastPointerDown
    if (!pointer || Date.now() - pointer.at > 2500) return null
    const doc = view.dom.ownerDocument
    const hit = doc.elementFromPoint(pointer.left, pointer.top)
    if (!hit || !view.dom.contains(hit)) return null
    if (!hit.closest?.('td,th')) return null
    const at = view.posAtCoords({ left: pointer.left, top: pointer.top })
    if (!at || !Number.isFinite(at.pos)) return null
    return richVisiblePositionAtPos(view.state.doc, at.pos)
  } catch {
    return null
  }
}

const richPosFromVisibleIndex = (doc, visibleIndex, affinity = 'forward') => {
  const v = Math.max(0, Math.round(visibleIndex || 0))
  let acc = 0
  let fallback = 1
  let target = null
  doc.descendants((node, pos) => {
    if (target != null) return false
    if (!node.isText) return true
    const len = node.text.length
    if (v < acc + len) {
      target = pos + (v - acc)
    } else if (v === acc + len) {
      if (affinity === 'forward') {
        fallback = pos + len
      } else {
        target = pos + len
      }
    }
    acc += len
    fallback = pos + len
    return false
  })
  return target != null ? target : fallback
}

export {
  nearestIndexOf,
  posAtText,
  richDomVisiblePositionAtSelection,
  richPointerVisiblePosition,
  richPosFromVisibleIndex,
  richVisiblePositionAtPos,
  sourceRawFromVisibleIndex,
  sourceVisiblePositionAtRaw,
  stripMdForSnippet,
  visibleSourcePosition
}
