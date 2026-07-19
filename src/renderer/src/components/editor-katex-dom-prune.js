import { Plugin, PluginKey } from '@milkdown/prose/state'

const KATEX_PRUNE_KEY = new PluginKey('hm-katex-dom-prune')

function pruneKatexMathml(root) {
  if (!root?.querySelectorAll) return
  root.querySelectorAll('.katex-mathml').forEach((node) => node.remove())
}

export function createKatexDomPrunePlugin() {
  return new Plugin({
    key: KATEX_PRUNE_KEY,
    view(view) {
      if (window.api?.platform !== 'win32') return {}
      const root = view.dom
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          pruneKatexMathml(root)
        })
      }
      const observer = new MutationObserver(schedule)
      pruneKatexMathml(root)
      observer.observe(root, { childList: true, subtree: true })
      return {
        update: schedule,
        destroy() {
          observer.disconnect()
        }
      }
    }
  })
}
