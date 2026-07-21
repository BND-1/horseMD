// Chunked async parsing for huge documents (Typora-style progressive render).
//
// Extracted verbatim in behavior from Editor.jsx. Milkdown/ProseMirror parse the
// WHOLE markdown string synchronously in crepe.create(), which is O(n²)-ish — a
// 1M-char doc freezes the main thread for minutes ("Not Responding").
// content-visibility can't help: the freeze is the PARSE, not paint. So for docs
// above CHUNK_THRESHOLD we create the editor with only the FIRST chunk (fast
// first paint), then parse + append the remaining chunks in the background
// (yielding between chunks so the UI never freezes, and breaking the quadratic
// blowup into linear per-chunk parses). The editor is read-only during load.
//
// `appending` (the onChange-suppression flag) is NOT managed here — the caller
// owns it, so it can be read by the editor's markdownUpdated handler.
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { normalizeDisplayMath } from './editor-math.js'

export const CHUNK_THRESHOLD = 120000 // above this, parse incrementally
export const CHUNK_SIZE = 40000 // chars per chunk (first chunk renders in ~one frame)

// Split markdown into parse-safe chunks at blank-line boundaries, never inside a
// fenced code block. Each chunk is valid standalone markdown, so parsing it
// separately reconstructs its blocks correctly (lists/tables/headings stay whole
// because they're blank-line-delimited).
export function splitMarkdown(md, target) {
  if (!md) return []
  const lines = md.split('\n')
  const chunks = []
  let cur = []
  let len = 0
  let inFence = false
  let fence = null
  for (const line of lines) {
    const m = line.match(/^\s*(```|~~~)/)
    if (m) {
      if (!inFence) { inFence = true; fence = m[1] }
      else if (fence && line.includes(fence)) { inFence = false; fence = null }
    }
    cur.push(line)
    len += line.length + 1
    if (!inFence && len >= target && /^\s*$/.test(line)) {
      chunks.push(cur.join('\n'))
      cur = []
      len = 0
    }
  }
  if (cur.length) chunks.push(cur.join('\n'))
  return chunks
}

// Stream the remaining chunks (chunks[0] is already rendered) into the live
// editor in the background. Behavior-preserving extraction from Editor.jsx:
// normalizes review markup + display math per chunk, yields between chunks,
// toggles the editor non-editable during load, and signals the host via
// onLoadingChange / onStructureChange at the same points.
//
//   rest              — the chunks after the first (already-rendered) one
//   view              — the ProseMirror EditorView to dispatch into
//   getParser         — () => parser fn (or null); parserCtx is caller-owned
//   isDestroyed       — () => boolean; aborts the loop when the editor unmounts
//   getEditable       — () => bool; keeps an external reading lock after loading
//   onLoadingChange   — (bool) optional; outline shows a skeleton while streaming
//   onStructureChange — () optional; host refreshes outline/scrollspy after load
export async function appendChunks({ rest, view, getParser, isDestroyed, getEditable, onLoadingChange, onStructureChange }) {
  if (!rest || !rest.length) return
  onLoadingChange?.(true) // outline shows a skeleton while the doc streams in
  const setEditable = (on) => {
    try { view.setProps({ editable: () => on }) } catch { /* view tearing down */ }
    try { view.dom.contentEditable = on ? 'true' : 'false' } catch { /* */ }
  }
  setEditable(false)
  const parser = getParser()
  try {
    for (const chunkText of rest) {
      if (isDestroyed()) break
      let parsed = null
      // Normalize review markup + display math in each appended chunk too —
      // defaultValue wraps firstContent with both, but these background-appended
      // chunks are parsed directly, so wrap them. (Chunking splits only at blank
      // lines; a normalized $$…$$ block has no internal blank line, so math never
      // spans two chunks.)
      try { parsed = parser ? parser(normalizeReviewMarkupMarkdown(normalizeDisplayMath(chunkText))) : null } catch { /* skip unparseable chunk */ }
      if (parsed && parsed.content && parsed.content.size > 0 && !isDestroyed()) {
        view.dispatch(view.state.tr.insert(view.state.doc.content.size, parsed.content))
      }
      // Yield to the event loop so paint/input happen between chunks (setTimeout
      // fires even when occluded; rAF/idle don't).
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    setEditable(getEditable ? getEditable() : true)
    onLoadingChange?.(false)
    // The full doc is now in the DOM — tell the host to refresh the outline
    // heading list + scrollspy (they couldn't track it during load because
    // onChange was suppressed).
    if (!isDestroyed()) onStructureChange?.()
  }
}
