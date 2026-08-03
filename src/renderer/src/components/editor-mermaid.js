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
// Mermaid maintains module-level rendering state (including the temporary SVG
// target). Rendering different diagrams concurrently can therefore strand every
// caller in its loading state. Keep the work queue module-local and serialize
// every actual `mermaid.render()` call; callers for the same source still share
// one queued job through `pending` above.
let renderQueue = Promise.resolve()
// CodeMirror emits a document update for every keystroke. A Mermaid render is
// asynchronous, so an older, temporarily-invalid source (for example `B -->`)
// can finish after the user has completed `B --> C`. Track the actual block,
// rather than only its Vue callback: Milkdown's callback is created during the
// first preview render and is not guaranteed to be recreated on each keystroke.
const previewBlockByCallback = new WeakMap()
const latestPreviewSource = new WeakMap()
const pendingPreviewRefresh = new WeakMap()
let previewTranslator = null
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
// Markdown copied from Windows editors can retain CRLF inside a fenced block,
// while CodeMirror exposes the same document as LF lines. Preview freshness is
// source-sensitive, so every path must use one canonical newline representation
// or a successful render is incorrectly discarded as stale.
const normalizeMermaidSource = (code) => String(code || '').replace(/\r\n?/g, '\n')
const canonicalMermaidSource = (code) => normalizeMermaidSource(code).trim()

function queueMermaidRender(job) {
  // Keep the queue alive after an individual failure so a bad diagram can never
  // block every later diagram in the document.
  const run = renderQueue.then(job, job)
  renderQueue = run.catch(() => {})
  return run
}

const removeRenderTarget = (id) => {
  document.getElementById(id)?.remove()
  document.getElementById('d' + id)?.remove()
}

// Render `code` to an SVG (async, cached), then call every onDone waiting on it.
// Mermaid is initialize()d at most once per theme (re-initializing on every
// render is a known way to break subsequent diagrams). The first render after
// the lazy import can race with Mermaid's init, so retry the same queued job once
// before caching an error. Importantly, the retry keeps *all* existing waiters.
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
  void queueMermaidRender(async () => {
    const renderOnce = async () => {
      const id = 'hm-mermaid-' + ++idSeq
      try {
        const mermaid = await getMermaid()
        if (mermaidTheme !== theme) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
          mermaidTheme = theme
        }
        const { svg } = await mermaid.render(id, code)
        return { svg }
      } catch (e) {
        return { error: (e && e.message) || String(e) }
      } finally {
        removeRenderTarget(id)
      }
    }

    let result = await renderOnce()
    if (result.error) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      result = await renderOnce()
    }
    cache.set(k, result)
    const cbs = pending.get(k) || []
    pending.delete(k)
    cbs.forEach((cb) => cb?.())
  })
}

// PDF export must not depend on whether the live preview happened to be
// mounted, visible, or finished rendering. Resolve the same strict Mermaid
// renderer explicitly and use the light theme that matches the PDF surface.
export async function renderMermaidForExport(code, { theme = 'default' } = {}) {
  const trimmed = canonicalMermaidSource(code)
  if (!trimmed) return null
  const key = keyFor(theme, trimmed)
  if (!cache.has(key)) {
    await new Promise((resolve) => ensureRender(theme, trimmed, resolve))
  }
  const result = cache.get(key)
  return result?.svg || null
}

// The HTML string to show as the block's preview for a given mermaid source.
// Kicks off (or reuses) a render; `onUpdate` fires when an async render lands.
function previewHtml(code, t, onUpdate) {
  const trimmed = canonicalMermaidSource(code)
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
  previewTranslator = t
  return (language, text, setPreview) => {
    const lang = String(language || '').toLowerCase()
    if (lang !== 'mermaid') return null
    const source = canonicalMermaidSource(text)
    // Crepe always provides setPreview here. Keep a safe sync-only fallback so
    // this renderer remains usable from callers that only request HTML.
    if (typeof setPreview !== 'function') return previewHtml(source, t, () => {})
    claimPreviewBlock(setPreview, source)
    const refresh = () => {
      // Rendering source changes faster than Mermaid can finish. The node view
      // invokes this renderer again with the newer source, so the current
      // invocation is authoritative only while it remains the latest one.
      if (!isCurrentPreview(setPreview, source)) return
      const next = previewHtml(source, t, refresh)
      if (isCurrentPreview(setPreview, source)) setPreview(next)
    }
    const html = previewHtml(source, t, refresh)
    return html // a string return sets the preview immediately (sync path)
  }
}

export function readMermaidCodeSource(code, view = null) {
  if (!code) return ''
  const block = code.closest?.('.milkdown-code-block')
  // CodeMirror virtualizes long documents, so its DOM is only a visual window.
  // When the ProseMirror view is available (input / save paths), resolve the
  // complete code_block node first. This is the same full-document boundary as
  // the code-block Copy command and must remain the source of truth.
  if (view && block) {
    try {
      const pos = view.posAtDOM(block, 0)
      const $pos = view.state.doc.resolve(pos)
      const ancestors = []
      for (let depth = $pos.depth; depth >= 0; depth -= 1) ancestors.push($pos.node(depth))
      const node = [
        ...ancestors,
        view.state.doc.nodeAt(pos),
        $pos.nodeAfter,
        $pos.nodeBefore
      ].find((candidate) => candidate?.type?.name === 'code_block')
      if (node) return normalizeMermaidSource(node.textContent)
    } catch {}

    // A CodeMirror node view can shield `posAtDOM`. Its wrapper order still
    // matches the document's code_block order, providing a complete-node
    // fallback without ever treating virtual `.cm-line` DOM as full content.
    const blockIndex = [...view.dom.querySelectorAll('.milkdown-code-block')].indexOf(block)
    if (blockIndex >= 0) {
      let currentIndex = -1
      let matched = null
      view.state.doc.descendants((node) => {
        if (node.type.name !== 'code_block') return true
        currentIndex += 1
        if (currentIndex !== blockIndex) return true
        matched = node
        return false
      })
      if (matched) return normalizeMermaidSource(matched.textContent)
    }
  }
  // innerText intentionally returns an empty string while Crepe hides the code
  // panel in preview-only mode. This DOM-only fallback is sufficient only for
  // short, fully mounted blocks; initial preview ownership below compares it as
  // a prefix rather than assuming it is the whole source.
  const lines = [...code.querySelectorAll('.cm-line')]
  if (lines.length) return normalizeMermaidSource(lines.map((line) => line.textContent || '').join('\n'))
  return normalizeMermaidSource(code.textContent)
}

function blockSource(block) {
  return canonicalMermaidSource(readMermaidCodeSource(block?.querySelector('.cm-content')))
}

function claimPreviewBlock(setPreview, source) {
  // The immediate Vue watch can run before its CodeMirror DOM is mounted. A
  // microtask catches the mounted block before Mermaid's lazy render completes.
  queueMicrotask(() => {
    const current = previewBlockByCallback.get(setPreview)
    if (current?.isConnected) {
      // `text` is the complete ProseMirror node content provided by Crepe. Keep
      // it as the freshness baseline; CodeMirror's DOM may only contain a
      // virtualized subset of a long diagram.
      latestPreviewSource.set(current, source)
      return
    }
    const blocks = [...document.querySelectorAll('.milkdown-code-block')]
    const block = blocks.find((candidate) => {
      if (candidate.__horsemdMermaidPreviewCallback === setPreview) return true
      if (candidate.__horsemdMermaidPreviewCallback) return false
      const visibleSource = blockSource(candidate)
      // Long CodeMirror documents virtualize their line DOM. At initial mount
      // the visible portion is the leading source prefix, not the whole node.
      // A prefix match safely claims that block without ever using the partial
      // DOM text as Mermaid input.
      return visibleSource === source ||
        (!!visibleSource && source.startsWith(visibleSource))
    })
    if (!block) return
    block.__horsemdMermaidPreviewCallback = setPreview
    previewBlockByCallback.set(setPreview, block)
    latestPreviewSource.set(block, source)
  })
}

function isCurrentPreview(setPreview, source) {
  const block = previewBlockByCallback.get(setPreview)
  if (block?.isConnected) return latestPreviewSource.get(block) === source
  // Before the Vue component has mounted, permit its first render. Once the
  // CodeMirror source changes, the old source is absent and its completion is
  // suppressed instead of overwriting the block with a stale parse error.
  return [...document.querySelectorAll('.milkdown-code-block')]
    .some((candidate) => {
      const visibleSource = blockSource(candidate)
      return visibleSource === source ||
        (!!visibleSource && source.startsWith(visibleSource))
    })
}

// Milkdown's CodeMirror node view can update ProseMirror before its Vue preview
// watch runs, leaving renderPreview's original callback attached to the old
// content. Refresh the actual preview panel from the CodeMirror input path.
// Debouncing keeps normal typing to one Mermaid render rather than one render
// per character, while `latestPreviewSource` rejects every superseded result.
export function refreshMermaidPreviewFromCodeBlock(block, source) {
  if (!block || String(block.querySelector('.language-button')?.textContent || '').trim().toLowerCase() !== 'mermaid') return
  const normalized = canonicalMermaidSource(source)
  latestPreviewSource.set(block, normalized)
  const existing = pendingPreviewRefresh.get(block)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pendingPreviewRefresh.delete(block)
    if (!block.isConnected || latestPreviewSource.get(block) !== normalized) return
    const panel = block.querySelector('.preview')
    if (!panel) return
    const update = () => {
      if (!block.isConnected || latestPreviewSource.get(block) !== normalized) return
      panel.innerHTML = previewHtml(normalized, previewTranslator || ((key) => key), update)
    }
    update()
  }, 120)
  pendingPreviewRefresh.set(block, timer)
}

// Mermaid diagram-type keywords that START a new diagram. A header is valid only
// at the start of the source or a later line. Searching anywhere in the text is
// unsafe: labels can legitimately contain strings such as "flowchart TD" or
// "sequenceDiagram", which previously split one diagram into duplicate blocks.
import { Plugin, PluginKey } from '@milkdown/prose/state'
const DIRECTIONS = '(?:TB|TD|BT|RL|LR)'
const DIAGRAM_HEADER_SOURCE =
  '(?:(?:flowchart|graph)\\s+' + DIRECTIONS + '\\b' +
  '|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|block-beta|architecture-beta|packet-beta)(?=\\s|$))'
const DIAGRAM_START = new RegExp(
  '^' + DIAGRAM_HEADER_SOURCE,
  'i'
)
const DIAGRAM_LINE_START = new RegExp(
  '^' + DIAGRAM_HEADER_SOURCE,
  'gim'
)

// Does `text` begin with a mermaid diagram header? (Used by the paste handler to
// turn pasted raw mermaid into a block instead of plain text.)
export function startsAsMermaid(text) {
  const t = String(text || '').trim()
  return !!t && DIAGRAM_START.test(t)
}

// Split mermaid source into one chunk per diagram, by finding every diagram
// header at column zero. A second paste is now intercepted at the CodeMirror
// block boundary, so this plugin is only a safety net for already-mashed source
// and no longer needs the old, false-positive-prone mid-line heuristic.
function splitDiagrams(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n')
  DIAGRAM_LINE_START.lastIndex = 0
  const idx = []
  let m
  while ((m = DIAGRAM_LINE_START.exec(t))) idx.push(m.index)
  if (idx.length <= 1) return []
  const segs = []
  for (let i = 0; i < idx.length; i++) {
    const seg = t.slice(idx[i], idx[i + 1] ?? t.length).replace(/^\s+|\s+$/g, '')
    if (seg) segs.push(seg)
  }
  return segs
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
