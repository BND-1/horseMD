// Table UX: a single click inside a table cell should place the caret directly
// (TextSelection) so the user can edit immediately. Milkdown's TableNodeView
// intercepts cell mousedown and converts it into a NodeSelection (selecting the
// cell), which forced a double-click to start editing and also interrupted
// drag-to-select text inside cells. Row/column selection stays on the floating
// handle buttons, which the original stopEvent still intercepts.
//
// Same surgical prototype-patch pattern as editor-codeblock-eager.js: the
// private `handleClick` is unreachable, but `stopEvent` (public) routes through
// it, so overriding stopEvent is the stable seam.
import { TableNodeView } from '@milkdown/components/table-block'

if (
  typeof TableNodeView?.prototype?.stopEvent !== 'function'
) {
  // eslint-disable-next-line no-console
  console.warn('[horsemd] table click patch: TableNodeView API changed.')
}

const tableProto = TableNodeView.prototype
const originalStopEvent = tableProto.stopEvent

tableProto.stopEvent = function tableStopEvent(event) {
  const insideCell = event?.target instanceof Element &&
    Boolean(event.target.closest('th, td'))
  if (
    (event.type === 'mousedown' || event.type === 'pointerdown') &&
    insideCell
  ) {
    // Let ProseMirror's default mousedown place the caret in the cell.
    return false
  }
  return originalStopEvent.call(this, event)
}
