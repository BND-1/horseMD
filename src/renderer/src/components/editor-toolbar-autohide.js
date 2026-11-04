// Auto-hide the selection toolbar: fade out over 0.5s after 1s of no hover.
//
// Milkdown's SelectionTooltip shows the .milkdown-toolbar via a `data-show` attr
// (Crepe's own CSS hides it at `[data-show='false']` — but display:none is
// INSTANT, not a fade). So we drive a two-step hide:
//   1. after HIDE_MS of no hover → add .hm-toolbar-fading (opacity 1→0 over
//      FADE_MS, via the transition in app.css).
//   2. when the fade finishes → set data-show='false' (Milkdown display:none).
// Hovering at any point cancels both timers + restores opacity (remove the
// class). Re-selecting also cancels + restores; Milkdown re-shows (data-show=
// 'true') on the selection change itself.
//
// The TooltipProvider only re-runs show/hide when doc/selection change (early-
// returns when unchanged), so toggling these is clean. Wired via prosePluginsCtx.
//
// The countdown starts when the selection is finished — on mouseup, not while
// the button is still held (Feishu / Notion): a slow drag used to fade the
// toolbar mid-drag, and after the release it never came back (no selection
// change left to re-show it), so the colour picker was out of reach.
import { Plugin } from '@milkdown/prose/state'

const HIDE_MS = 1000 // visible-for-this-long before the fade starts
const FADE_MS = 500  // fade-out duration
const FADING_CLASS = 'hm-toolbar-fading'

export function toolbarAutohidePlugin() {
  let hideTimer = 0 // fires HIDE_MS → start the fade
  let fadeTimer = 0 // fires FADE_MS after fade starts → fully hide
  let hovered = false
  let bound = null
  let dragging = false // the primary button went down in the editor and is still held

  const findToolbar = (view) => {
    const host = view.dom.closest?.('.milkdown') || view.dom.parentElement
    return host ? host.querySelector('.milkdown-toolbar') : null
  }

  const restore = (el) => {
    // Cancel any pending hide/fade + bring opacity back to 1.
    clearTimeout(hideTimer)
    clearTimeout(fadeTimer)
    if (el) el.classList.remove(FADING_CLASS)
  }

  const startFade = (el) => {
    if (hovered || !el) return
    clearTimeout(fadeTimer)
    el.classList.add(FADING_CLASS)
    fadeTimer = setTimeout(() => {
      el.classList.remove(FADING_CLASS)
      el.dataset.show = 'false'
    }, FADE_MS)
  }

  const armHide = (el) => {
    clearTimeout(hideTimer)
    if (!el) return
    hideTimer = setTimeout(() => startFade(el), HIDE_MS)
  }

  const bindHover = (el) => {
    if (!el || el === bound) return
    bound = el
    el.addEventListener('mouseenter', () => { hovered = true; restore(el) })
    el.addEventListener('mouseleave', () => { hovered = false; armHide(el) })
  }

  return new Plugin({
    view(view) {
      const onDown = (e) => { if (e.button === 0) dragging = true }
      // Capture on window: the release may happen outside the editor.
      const onUp = (e) => {
        if (e.button !== 0 || !dragging) return
        dragging = false
        const el = findToolbar(view)
        if (view.state.selection.empty || !el) return
        restore(el)
        armHide(el)
      }
      view.dom.addEventListener('mousedown', onDown, true)
      window.addEventListener('mouseup', onUp, true)
      return {
        update: (view, prev) => {
          const el = findToolbar(view)
          bindHover(el)
          const sel = view.state.selection
          if (sel.empty) { restore(el); return }
          // On a real selection change: restore opacity (cancel any in-flight
          // fade) + re-arm the hide timer — once the drag is over (onUp arms
          // it then). Milkdown's own update re-shows it.
          if (!prev || !prev.selection.eq(sel)) { restore(el); if (!dragging) armHide(el) }
        },
        destroy: () => {
          clearTimeout(hideTimer); clearTimeout(fadeTimer)
          view.dom.removeEventListener('mousedown', onDown, true)
          window.removeEventListener('mouseup', onUp, true)
        },
      }
    },
  })
}
