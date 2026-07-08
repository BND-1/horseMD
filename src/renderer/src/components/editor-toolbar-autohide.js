// Auto-hide the selection toolbar after 3s of no hover.
//
// Milkdown's SelectionTooltip shows the .milkdown-toolbar via a `data-show`
// attribute on the element (`'true'`/`'false'`) — Crepe's own CSS hides it at
// `[data-show='false']`. Its TooltipProvider re-runs show()/hide() ONLY when the
// doc/selection changes (it early-returns when both are unchanged), so setting
// `data-show='false'` ourselves hides it cleanly AND Milkdown re-shows it
// automatically on the next selection change. So all we do here is arm a 3s
// timer when a (non-empty) selection is made; hovering the toolbar cancels it.
//
// Purely additive: reads editor state + toggles an attribute on Milkdown's own
// element. Never touches the doc or selection. Wired via prosePluginsCtx (the
// channel for raw ProseMirror plugins — NOT crepe.editor.use).
import { Plugin } from '@milkdown/prose/state'

const HIDE_MS = 1000

export function toolbarAutohidePlugin() {
  let timer = 0
  let hovered = false
  let bound = null // the toolbar element hover listeners are attached to

  const findToolbar = (view) => {
    // The toolbar lives inside the editor's .milkdown wrapper (appended to
    // view.dom.parentElement by the TooltipProvider).
    const host = view.dom.closest?.('.milkdown') || view.dom.parentElement
    return host ? host.querySelector('.milkdown-toolbar') : null
  }

  const bindHover = (el) => {
    if (!el || el === bound) return
    bound = el
    el.addEventListener('mouseenter', () => { hovered = true; clearTimeout(timer) })
    el.addEventListener('mouseleave', () => { hovered = false; arm(el) })
  }

  const hide = (el) => {
    if (hovered || !el) return
    el.dataset.show = 'false'
  }

  const arm = (el) => {
    clearTimeout(timer)
    if (!el) return
    timer = setTimeout(() => hide(el), HIDE_MS)
  }

  return new Plugin({
    view(view) {
      return {
        update: (view, prev) => {
          const el = findToolbar(view)
          bindHover(el)
          const sel = view.state.selection
          if (sel.empty) { clearTimeout(timer); return }
          // Re-arm only on a real selection change (not every transaction), so
          // hovering + clicking a toolbar button (which changes the selection)
          // doesn't needlessly restart the timer while still hovered.
          if (!prev || !prev.selection.eq(sel)) arm(el)
        },
        destroy: () => { clearTimeout(timer) },
      }
    },
  })
}
