// ProseMirror marks an IME composition as running on compositionstart and
// ends it on compositionend, but only for events that belong to it: an event
// inside a node view that stops events (a CodeMirror code block) is not its
// own. A composition can start in the text and end in a code block: with a
// block selected (after a block drag + undo, a handle click) the first
// candidate puts ProseMirror's selection into the code block, CodeMirror takes
// focus, and the end goes to CodeMirror. ProseMirror then stayed "composing"
// for good (on desktop it has no timeout): every later edit, in the code
// block or in the text, was held as candidate text and never reached the
// source, the tab never turned dirty, and a save wrote the old file (fuzz
// seed 5964). After a compositionend in the editor that left ProseMirror
// composing, this ends the composition through ProseMirror's own handler: a
// non-bubbling compositionend on view.dom (always its own event).
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { traceEditorEvent } from './editor-input-trace.js'

const key = new PluginKey('hm-composition-end')
// The ends this plugin dispatches (the compositionend inside the code block
// is not always a trusted event either, so isTrusted cannot tell them apart).
const forwarded = new WeakSet()

export function compositionEndPlugin() {
  return new Plugin({
    key,
    view(view) {
      const onCompositionEnd = (event) => {
        if (forwarded.has(event)) return
        // After the event: ProseMirror's own handler (when the event was its
        // own) has run by then and cleared the flag.
        queueMicrotask(() => {
          if (view.isDestroyed || !view.composing) return
          traceEditorEvent('composition-end-forwarded', { target: String(event.target?.className || event.target?.nodeName || '').slice(0, 60) })
          const end = new CompositionEvent('compositionend', { bubbles: false, data: event.data ?? '' })
          forwarded.add(end)
          view.dom.dispatchEvent(end)
        })
      }
      view.dom.addEventListener('compositionend', onCompositionEnd, true)
      return {
        destroy: () => view.dom.removeEventListener('compositionend', onCompositionEnd, true)
      }
    }
  })
}
