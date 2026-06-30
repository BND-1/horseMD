// Block-type + floating level-badge controls. Extracted verbatim in behavior
// from Editor.jsx.
//
//   viewRef        — ref to the ProseMirror EditorView
//   host           — this editor's root DOM element (closest .editor-scroll lookup)
//   t              — (key) => localized string (tRef.current in Editor.jsx)
//   setLevel       — setter for the floating level-badge state (null hides it)
//   setCtxMenu     — setter used to close the block context menu after setBlock
//   onActiveBlock  — pushes the cursor's current block id up to the parent
//   lastBlockRef   — ref caching the last reported block id (dedupe)
//   cleanups       — the editor's cleanup array (levelTimer clearTimeout on unmount)
//
// Returns { setBlock, reportActiveBlock, refreshLevel, scheduleLevel }.
//   setBlock/reportActiveBlock push block TYPE to the status bar.
//   refreshLevel/scheduleLevel position the floating level badge (perf-sensitive:
//   refreshLevel does forced reflows; scheduleLevel throttles to 200ms).
import { blockById, currentBlockId } from '../blocks.js'
import { convertBlock } from './editor-html.js'

export function createBlockControls({ viewRef, host, t, setLevel, setCtxMenu, onActiveBlock, lastBlockRef, cleanups }) {
  // Convert the block the cursor sits in to a given block id (paragraph/h1…h6).
  const setBlock = (id) => {
    const view = viewRef.current
    if (!view) return
    const def = blockById(id)
    if (!def) return
    convertBlock(view, def.name, def.level ? { level: def.level } : {})
    view.focus()
    reportActiveBlock()
    refreshLevel()
    setCtxMenu(null)
  }

  // Push the cursor's current block type up to the parent (status bar).
  const reportActiveBlock = () => {
    const view = viewRef.current
    if (!view) return
    const id = currentBlockId(view.state)
    if (id !== lastBlockRef.current) {
      lastBlockRef.current = id
      onActiveBlock?.(id)
    }
  }

  // Position the floating level badge next to the caret's line. Hidden when the
  // editor isn't focused or the caret has scrolled out of view.
  const refreshLevel = () => {
    const view = viewRef.current
    if (!view || !view.hasFocus()) {
      setLevel(null)
      return
    }
    const sel = view.state.selection
    let coords
    try {
      coords = view.coordsAtPos(sel.from)
    } catch {
      return
    }
    const scrollEl = host.closest('.editor-scroll')
    const r = scrollEl
      ? scrollEl.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, left: 0 }
    if (coords.bottom < r.top + 2 || coords.top > r.bottom - 2) {
      setLevel(null)
      return
    }
    const id = currentBlockId(view.state)
    const def = blockById(id)
    // Only headings (H1…H6) and plain paragraphs get a badge.
    if (!def) {
      setLevel(null)
      return
    }
    // Anchor to the current block's left edge so the tag sits just beside the
    // text, not floating off at the pane edge.
    let blockLeft = coords.left
    try {
      let el = view.domAtPos(sel.from).node
      if (el && el.nodeType === 3) el = el.parentElement
      const pm = view.dom
      while (el && el !== pm && el.parentElement && el.parentElement !== pm) {
        el = el.parentElement
      }
      if (el && el !== pm) blockLeft = el.getBoundingClientRect().left
    } catch {
      /* fall back to the caret x */
    }
    const kind = id === 'paragraph' ? 'text' : 'heading'
    const label = id === 'paragraph' ? t('block.paragraph') : def.short
    // The badge's right edge: normally 10px left of the text. But Crepe's block
    // drag-handle (shown on hover) also lives in that gutter — when it's visible
    // on the caret's line, tuck the badge just left of the handle so the two
    // sit side by side instead of overlapping. The badge stays visible either way.
    let badgeRight = blockLeft - 10
    const handle = document.querySelector('.milkdown-block-handle[data-show="true"]')
    if (handle) {
      const hr = handle.getBoundingClientRect()
      if (hr.width && hr.height && coords.bottom > hr.top && coords.top < hr.bottom) {
        badgeRight = Math.min(badgeRight, hr.left - 6)
      }
    }
    // Sit in the gutter; if the window is too narrow for that, tuck the tag
    // against the pane's left edge instead.
    const align = badgeRight - r.left >= 46 ? 'right' : 'left'
    const x = align === 'right' ? badgeRight : r.left + 6
    setLevel({ label, kind, align, top: (coords.top + coords.bottom) / 2, x })
  }

  // refreshLevel does forced layout reads (coordsAtPos / getBoundingClientRect).
  // Selection change and scroll fire on every keystroke; on a large document
  // that synchronous reflow is the main typing lag AND the main cause of the
  // scroll "chase" (#17) — the main thread is busy reflowing while the
  // compositor piles up scroll frames.
  // Throttle: at most once per 200ms (not per frame). On fast scroll the level
  // badge simply doesn't update until you pause — a fine trade-off vs freezing.
  let levelTimer = 0
  const scheduleLevel = () => {
    if (levelTimer) return
    levelTimer = setTimeout(() => {
      levelTimer = 0
      refreshLevel()
    }, 200)
  }
  cleanups.push(() => {
    if (levelTimer) clearTimeout(levelTimer)
  })

  return { setBlock, reportActiveBlock, refreshLevel, scheduleLevel }
}
