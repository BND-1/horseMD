import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

const blockHandleGuardKey = new PluginKey('hm-block-handle-gutter')
const GUTTER_WIDTH = 36

const hideBlockHandles = (view) => {
  const root = view.dom.closest('.milkdown') || view.dom.parentElement
  root?.querySelectorAll('.milkdown-block-handle[data-show="true"]')
    .forEach((handle) => { handle.dataset.show = 'false' })
}

// Milkdown's BlockEdit service finds the hovered block from the editor's
// horizontal midpoint, so its stock handle opens while the pointer is anywhere
// on a line. Restrict that affordance to the left edge, where a block-level
// drag handle is expected, and keep inline text (including raw HTML atoms)
// free of unrelated controls.
export function createBlockHandleGutterPlugin() {
  return new Plugin({
    key: blockHandleGuardKey,
    props: {
      handleDOMEvents: {
        pointermove(view, event) {
          const rect = view.dom.getBoundingClientRect()
          const inGutter = event.clientX >= rect.left &&
            event.clientX <= rect.left + GUTTER_WIDTH
          if (inGutter) return false

          hideBlockHandles(view)
          return true
        }
      }
    }
  })
}
