// Mouse selection of table cells (prosemirror-tables CellSelection). Two
// gestures lost it on Windows (`test:context-copy-ui`):
//
// 1. A drag across cells. Any native dragstart ends the cell drag. On the
//    way out of the first cell the pointer passes Crepe's row / column
//    handles: the table plugin then sets a one-cell CellSelection of the
//    start cell, whose DOM selection covers the cell's text — the very point
//    the mouse went down on. Chromium on Windows starts a text drag as soon
//    as the pointer moves with the press inside a selection (macOS waits
//    ~150 ms first), so the drag carried the text away and no cells were
//    selected. A text drag needs a press ON an existing selection; this one
//    was made by the drag itself: while a cell drag is in progress the
//    native drag is cancelled and kept from the table plugin's stop handler.
// 2. A right-click on a selected cell. The right button's press moved the
//    caret to the click point and the cells were deselected: Windows opens
//    the context menu on the release (it saw a caret: 复制 disabled), macOS
//    on the press, before the caret move (cells gone while the menu was
//    open). The press on a selected cell is prevented, and the selection at
//    the press is put back if anything still moved it when the menu opens,
//    as in Typora and spreadsheet apps. The menu handler
//    (editor-dom-interactions.js) keeps a CellSelection too: its DOM
//    selection is the last cell's text, which it used to commit.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { CellSelection, tableEditingKey } from '@milkdown/prose/tables'
import { traceEditorEvent } from './editor-input-trace.js'

const key = new PluginKey('hm-table-cell-drag')

export function tableCellDragPlugin() {
  return new Plugin({
    key,
    // A capture listener on the editor root: the table is a node view whose
    // stopEvent hides its events from ProseMirror's own handlers, and the
    // table plugin stops on a dragstart that bubbles to the document.
    view(view) {
      const onDragStart = (event) => {
        if (tableEditingKey.getState(view.state) == null) return
        event.preventDefault()
        event.stopPropagation()
        traceEditorEvent('table-cell-drag-native-drag-cancelled', { target: String(event.target?.nodeName || '') })
      }
      let rightPress = null
      const onMouseDown = (event) => {
        rightPress = null
        if (event.button !== 2 || !(view.state.selection instanceof CellSelection)) return
        if (!event.target?.closest?.('td, th')?.classList.contains('selectedCell')) return
        // The press would move the caret: macOS opens the menu first, then
        // the caret move replaced the cells while the menu was open.
        event.preventDefault()
        rightPress = { selection: view.state.selection, doc: view.state.doc, at: Date.now() }
      }
      // Capture on the editor root: runs before the context menu handler
      // (editor-dom-interactions.js, bubble phase on the same element).
      const onContextMenu = () => {
        const press = rightPress
        rightPress = null
        if (!press || Date.now() - press.at > 2000 || view.isDestroyed) return
        if (view.state.doc !== press.doc || view.state.selection.eq(press.selection)) return
        view.dispatch(view.state.tr.setSelection(press.selection))
        traceEditorEvent('table-cell-selection-kept-for-context-menu', {})
      }
      view.dom.addEventListener('dragstart', onDragStart, true)
      view.dom.addEventListener('mousedown', onMouseDown, true)
      view.dom.addEventListener('contextmenu', onContextMenu, true)
      return {
        destroy: () => {
          view.dom.removeEventListener('dragstart', onDragStart, true)
          view.dom.removeEventListener('mousedown', onMouseDown, true)
          view.dom.removeEventListener('contextmenu', onContextMenu, true)
        }
      }
    }
  })
}
