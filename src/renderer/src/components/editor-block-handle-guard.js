import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

const blockHandleGuardKey = new PluginKey('hm-block-handle-gutter')
const HANDLE_TRIGGER_WIDTH = 36

const findHandle = (view) => {
  const root = view.dom.closest('.milkdown') || view.dom.parentElement
  return root?.querySelector('.milkdown-block-handle') || null
}

const hideHandle = (view) => {
  const handle = findHandle(view)
  if (handle) handle.dataset.show = 'false'
}

const isHandleTrigger = (view, event) => {
  const editorRect = view.dom.getBoundingClientRect()
  const inEditorRail = event.clientX >= editorRect.left &&
    event.clientX <= editorRect.left + HANDLE_TRIGGER_WIDTH
  if (inEditorRail) return true

  // A nested marker sits to the right of the editor-level rail. Keep list
  // bullets/numbers as natural reveal targets, but only within their painted
  // rectangle; the operation bar itself still renders on the one shared rail.
  const target = event.target instanceof Element ? event.target : null
  const marker = target?.closest('li')?.querySelector(':scope > .label-wrapper')
  const markerRect = marker?.getBoundingClientRect()
  return !!markerRect &&
    event.clientX >= markerRect.left - 2 &&
    event.clientX <= markerRect.right + 2 &&
    event.clientY >= markerRect.top - 2 &&
    event.clientY <= markerRect.bottom + 2
}

/**
 * Milkdown normally positions the operation bar from each active block's own
 * rectangle. Lists, nested lists, headings and paragraphs do not share the
 * same left edge, so that produces several visible handle rails. Keep the
 * active block's vertical rectangle but replace its horizontal anchor with the
 * ProseMirror content edge. Floating UI remains the only positioning owner.
 */
export const getBlockHandlePosition = ({ active, editorDom }) => {
  const blockRect = active.el.getBoundingClientRect()
  const editorRect = editorDom.getBoundingClientRect()
  return new DOMRect(editorRect.left, blockRect.top, 0, blockRect.height)
}

/**
 * Crepe's block service deliberately resolves a block from the vertical mouse
 * coordinate even when the pointer is over inline text. HorseMD exposes the
 * affordance only at the editor's leading edge. This plugin filters visibility
 * only; it never changes handle coordinates or layout.
 */
export function createBlockHandleGutterPlugin() {
  return new Plugin({
    key: blockHandleGuardKey,
    view(view) {
      let handleAllowed = false
      const root = view.dom.closest('.milkdown') || view.dom.parentElement
      const scrollPort = view.dom.closest('.editor-scroll')

      const onPointerMove = (event) => {
        handleAllowed = isHandleTrigger(view, event)
        if (handleAllowed) return

        // Milkdown receives pointermove through ProseMirror's bubbling event
        // handler. Stop it before a text hover can schedule another block.
        event.stopImmediatePropagation()
        hideHandle(view)
      }
      const onPointerLeave = (event) => {
        if (event.relatedTarget instanceof Element &&
          event.relatedTarget.closest('.milkdown-block-handle')) return
        handleAllowed = false
        hideHandle(view)
      }
      const onScroll = () => {
        handleAllowed = false
        hideHandle(view)
      }
      const observer = new MutationObserver(() => {
        const handle = findHandle(view)
        if (!handleAllowed && handle?.dataset.show === 'true') {
          handle.dataset.show = 'false'
        }
      })

      view.dom.addEventListener('pointermove', onPointerMove, true)
      view.dom.addEventListener('pointerleave', onPointerLeave, true)
      root?.addEventListener('pointerleave', onPointerLeave, true)
      scrollPort?.addEventListener('scroll', onScroll, { passive: true })
      root && observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-show']
      })

      return {
        destroy() {
          observer.disconnect()
          view.dom.removeEventListener('pointermove', onPointerMove, true)
          view.dom.removeEventListener('pointerleave', onPointerLeave, true)
          root?.removeEventListener('pointerleave', onPointerLeave, true)
          scrollPort?.removeEventListener('scroll', onScroll)
        }
      }
    }
  })
}
