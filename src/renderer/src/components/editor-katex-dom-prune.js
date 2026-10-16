import { Plugin, PluginKey } from '@milkdown/prose/state'

const KATEX_PRUNE_KEY = new PluginKey('hm-katex-dom-prune')

function pruneKatexMathml(root) {
  if (!root?.querySelectorAll) return
  root.querySelectorAll('.katex-mathml').forEach((node) => node.remove())
}

function syncDisplayMathOverflow(root) {
  if (!root?.querySelectorAll) return
  root.querySelectorAll('.milkdown-code-block .preview > .katex-display').forEach((display) => {
    // Windows can show scrollbar buttons for an `overflow: auto` box even when
    // the formula fits. Turn scrolling on only after measuring real overflow.
    display.dataset.hmMathOverflow = display.scrollWidth > display.clientWidth + 1 ? 'true' : 'false'
  })
}

export function createKatexDomPrunePlugin() {
  return new Plugin({
    key: KATEX_PRUNE_KEY,
    view(view) {
      const root = view.dom
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          if (window.api?.platform === 'win32') pruneKatexMathml(root)
          syncDisplayMathOverflow(root)
        })
      }
      const observer = new MutationObserver(schedule)
      if (window.api?.platform === 'win32') pruneKatexMathml(root)
      syncDisplayMathOverflow(root)
      observer.observe(root, { childList: true, subtree: true })
      const resizeObserver = new ResizeObserver(schedule)
      resizeObserver.observe(root)
      return {
        update: schedule,
        destroy() {
          observer.disconnect()
          resizeObserver.disconnect()
        }
      }
    }
  })
}
