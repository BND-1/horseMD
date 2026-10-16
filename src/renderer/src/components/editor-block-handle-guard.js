import { blockServiceInstance } from '@milkdown/kit/plugin/block'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

const blockHandleGuardKey = new PluginKey('hm-block-handle-gutter')

const findHandle = (view) => {
  const root = view.dom.closest('.milkdown') || view.dom.parentElement
  return root?.querySelector('.milkdown-block-handle') || null
}

const hideHandle = (view) => {
  const handle = findHandle(view)
  if (handle) handle.dataset.show = 'false'
}

const isEditorGutterTrigger = (view, event, triggerRoot) => {
  if (!(triggerRoot instanceof Element)) return false
  const editorRect = view.dom.getBoundingClientRect()
  const rootRect = triggerRoot.getBoundingClientRect()
  return event.clientX >= rootRect.left &&
    event.clientX < editorRect.left &&
    event.clientY >= editorRect.top &&
    event.clientY <= editorRect.bottom
}

const isListMarkerTrigger = (event) => {
  // A nested marker sits to the right of the editor-level gutter. Keep list
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
 * coordinate even when the pointer is over inline text. HorseMD therefore
 * listens on the editor host and forwards only the real leading gutter to that
 * service. Text inside ProseMirror never doubles as a reveal target; list
 * markers remain explicit in-editor targets. This plugin filters visibility
 * only and never changes handle coordinates or document state.
 */
export function createBlockHandleGutterPlugin(ctx) {
  return new Plugin({
    key: blockHandleGuardKey,
    view(view) {
      let handleAllowed = false
      const root = view.dom.closest('.milkdown') || view.dom.parentElement
      const triggerRoot = view.dom.closest('.editor-host') || root || view.dom
      const scrollPort = view.dom.closest('.editor-scroll')
      let blockService = null
      try {
        blockService = ctx.get(blockServiceInstance.key)
      } catch {
        // Fail closed if BlockEdit has not installed its service yet.
      }

      const onPointerMove = (event) => {
        const target = event.target instanceof Element ? event.target : null
        if (target?.closest('.milkdown-block-handle')) {
          handleAllowed = true
          return
        }

        const gutterTrigger = isEditorGutterTrigger(view, event, triggerRoot)
        handleAllowed = gutterTrigger || isListMarkerTrigger(event)
        if (!handleAllowed) {
          // Do not stop this event: table handles and other node views also own
          // pointermove interactions below ProseMirror. Milkdown may schedule its
          // block handle later, so hide now and let the observer reject that
          // delayed visibility write without consuming another feature's event.
          hideHandle(view)
          return
        }

        // Pointer events in the real host gutter never reach ProseMirror's
        // handleDOMEvents. Feed only their Y coordinate into the same Milkdown
        // service so active-block lookup remains single-sourced.
        if (gutterTrigger) blockService?.mousemoveCallback(view, event)
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

      triggerRoot.addEventListener('pointermove', onPointerMove, true)
      triggerRoot.addEventListener('pointerleave', onPointerLeave, true)
      scrollPort?.addEventListener('scroll', onScroll, { passive: true })
      root && observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-show']
      })

      return {
        destroy() {
          observer.disconnect()
          triggerRoot.removeEventListener('pointermove', onPointerMove, true)
          triggerRoot.removeEventListener('pointerleave', onPointerLeave, true)
          scrollPort?.removeEventListener('scroll', onScroll)
        }
      }
    }
  })
}
