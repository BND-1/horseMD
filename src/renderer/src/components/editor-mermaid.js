// Live Mermaid rendering for ```mermaid code blocks — via Crepe's built-in
// code-block "preview" mechanism, the same one LaTeX uses. The diagram is the
// block's preview, shown by default with the source hidden; the code block's own
// toolbar gets a Hide/Edit toggle (next to Copy). No custom widget decoration.
//
// Mermaid is loaded lazily (dynamic import) only when a diagram is present.
// Rendered SVGs are cached by theme::code so re-renders are instant and the two
// themes don't clobber each other.

const cache = new Map()
// Renders in flight, keyed by theme::code → array of waiting onDone callbacks.
// Using a Map (not a Set) means a SECOND block with the same source (or any
// caller that arrives mid-render) still gets its onDone fired when the render
// lands — otherwise it would sit on "rendering…" forever.
const pending = new Map()
const retried = new Set() // keys whose first render errored and get a one-shot retry
let mermaidMod = null
let mermaidTheme = null // theme mermaid was last initialize()d for
let idSeq = 0 // monotonic render id (guaranteed unique, unlike Math.random)

async function getMermaid() {
  if (mermaidMod) return mermaidMod
  const m = await import('mermaid')
  mermaidMod = m.default || m
  return mermaidMod
}

const curTheme = () => (document.body.classList.contains('dark') ? 'dark' : 'default')
const keyFor = (theme, code) => theme + '::' + code

// Render `code` to an SVG (async, cached), then call every onDone waiting on it.
// Mermaid is initialize()d at most once per theme (re-initializing on every
// render is a known way to break subsequent diagrams). The FIRST render after
// the lazy import can race with Mermaid's init and fail — on error we retry once
// before caching the error.
async function ensureRender(theme, code, onDone) {
  const k = keyFor(theme, code)
  if (cache.has(k)) {
    onDone?.()
    return
  }
  const waiters = pending.get(k)
  if (waiters) {
    // Already rendering this exact source — just queue, don't start a second.
    waiters.push(onDone)
    return
  }
  pending.set(k, onDone ? [onDone] : [])
  const id = 'hm-mermaid-' + ++idSeq
  let result = null
  try {
    const mermaid = await getMermaid()
    if (mermaidTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
      mermaidTheme = theme
    }
    const { svg } = await mermaid.render(id, code)
    result = { svg }
    retried.delete(k)
  } catch (e) {
    if (!retried.has(k)) {
      retried.add(k)
      pending.delete(k)
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
      setTimeout(() => ensureRender(theme, code, onDone), 300)
      return
    }
    result = { error: (e && e.message) || String(e) }
    retried.delete(k)
  } finally {
    if (result) cache.set(k, result)
    const cbs = pending.get(k) || []
    pending.delete(k)
    document.getElementById(id)?.remove()
    document.getElementById('d' + id)?.remove()
    cbs.forEach((cb) => cb?.())
  }
}

// The HTML string to show as the block's preview for a given mermaid source.
// Kicks off (or reuses) a render; `onUpdate` fires when an async render lands.
function previewHtml(code, t, onUpdate) {
  const trimmed = (code || '').trim()
  if (!trimmed) return ''
  const theme = curTheme()
  const c = cache.get(keyFor(theme, trimmed))
  if (c && c.svg) return c.svg
  if (c && c.error) return `<div class="hm-mermaid-error">${t('mermaid.error')} ${escapeHtml(c.error)}</div>`
  ensureRender(theme, trimmed, onUpdate)
  return `<div class="hm-mermaid-hint">${t('mermaid.rendering')}</div>`
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

// Build the `renderPreview(language, text, setPreview)` for codeBlockConfig.
// Returns null for non-mermaid blocks (no preview, no toggle → normal code
// block). For mermaid, returns the diagram HTML synchronously when cached, or
// kicks the async render and updates via setPreview when it lands.
export function createMermaidPreviewRenderer(getT) {
  const t = (k) => (getT ? getT(k) : k)
  return (language, text, setPreview) => {
    const lang = String(language || '').toLowerCase()
    if (lang !== 'mermaid') return null
    const html = previewHtml(text, t, () => setPreview(previewHtml(text, t, () => {})))
    return html // a string return sets the preview immediately (sync path)
  }
}

// Mermaid diagram-type keywords that START a new diagram. Used to split a block
// that accidentally holds two diagrams (e.g. pasting a 2nd diagram into a
// non-empty mermaid block appends it, mashing both into one parse error).
import { Plugin, PluginKey } from '@milkdown/prose/state'
const DIAGRAM_TYPES = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'stateDiagram-v2', 'erDiagram', 'gantt', 'pie', 'journey', 'gitGraph',
  'mindmap', 'timeline', 'quadrantChart', 'requirementDiagram', 'C4Context',
  'sankey-beta', 'block-beta', 'architecture-beta', 'packet-beta'
]
const DIAGRAM_START = new RegExp('^(?:' + DIAGRAM_TYPES.join('|') + ')\\b', 'i')

// Split mermaid source into one chunk per diagram (each begins with a diagram
// keyword). Returns [] for a single/empty diagram.
function splitDiagrams(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const segs = []
  let cur = null
  for (const line of lines) {
    if (DIAGRAM_START.test(line.trim())) {
      if (cur) segs.push(cur)
      cur = [line]
    } else {
      if (!cur) cur = []
      cur.push(line)
    }
  }
  if (cur) segs.push(cur)
  return segs
    .map((s) => s.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''))
    .filter((s) => s.trim())
}

// appendTransaction plugin: when a mermaid block ends up holding 2+ diagrams,
// split it into one code_block per diagram. Catches the "paste a 2nd diagram
// into the block" mashup (the paste itself is handled by CodeMirror, below the
// ProseMirror layer, so we react after the fact). Idempotent — each resulting
// block has one diagram, so it won't re-split.
export function createMermaidSplitPlugin() {
  return new Plugin({
    key: new PluginKey('hm-mermaid-split'),
    appendTransaction(transs, _oldState, newState) {
      if (!transs.some((t) => t.docChanged)) return null
      const jobs = []
      newState.doc.descendants((node, pos) => {
        if (
          node.type.name === 'code_block' &&
          String(node.attrs.language || '').toLowerCase() === 'mermaid'
        ) {
          const segs = splitDiagrams(node.textContent)
          if (segs.length > 1) jobs.push({ pos, size: node.nodeSize, segs })
        }
        return true
      })
      if (!jobs.length) return null
      const tr = newState.tr
      // Replace from the last block back so earlier positions stay valid.
      jobs.sort((a, b) => b.pos - a.pos)
      for (const { pos, size, segs } of jobs) {
        const type = newState.schema.nodes.code_block
        const nodes = segs.map((s) => type.create({ language: 'mermaid' }, s ? newState.schema.text(s) : null))
        tr.replaceWith(pos, pos + size, nodes)
      }
      return tr.setMeta('addToHistory', false)
    }
  })
}
