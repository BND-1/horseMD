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

// A formula KaTeX cannot parse shows its source in red; the reason was only
// in the hover title, so users took it for a formula HorseMD cannot show
// (#179: `\left\{ … \end{array}` without `\right.` — MathJax, i.e. Typora,
// Obsidian and GitHub, refuses it too, and says why). The reason is written
// under / after it (an attribute shown by CSS: ProseMirror ignores
// mutations inside a leaf, and no node is added to the document DOM).
export function mathErrorMessage(title, t) {
  const detail = String(title || '')
    .replace(/^ParseError:\s*/, '')
    .replace(/^KaTeX parse error:\s*/, '')
    .replace(/\s+at (?:position \d+|end of input):[\s\S]*$/, '')
    .trim()
  if (!detail) return ''
  if (/^Expected '\\right'/.test(detail)) return t('math.error.missingRight')
  const unknown = detail.match(/^Undefined control sequence:\s*(\\\S+)/)
  if (unknown) return t('math.error.unknownCommand', { cmd: unknown[1] })
  return t('math.error.generic', { detail })
}

function labelMathErrors(root, t) {
  if (!root?.querySelectorAll || !t) return
  root.querySelectorAll('.katex-error').forEach((node) => {
    const title = node.getAttribute('title') || ''
    if (node.dataset.hmMathErrorFor === title) return
    node.dataset.hmMathErrorFor = title
    node.dataset.hmMathError = mathErrorMessage(title, t)
  })
}

export function createKatexDomPrunePlugin({ t } = {}) {
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
          labelMathErrors(root, t)
        })
      }
      const observer = new MutationObserver(schedule)
      if (window.api?.platform === 'win32') pruneKatexMathml(root)
      syncDisplayMathOverflow(root)
      labelMathErrors(root, t)
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
