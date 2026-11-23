// Adding table rows and columns from the keyboard and the「+」bars
// (#181: "the add-row / add-column buttons are hard to hit, Enter in the last
// row adds no row"). Typora: Mod+Enter inserts a row under the current one;
// Tab in the last cell adds a row (Typora, Word, Google Docs, Notion). Notion /
// Obsidian: a「+」bar under the last row and beside the last column.
//
// New body cells take their column's alignment (Milkdown's
// addRowWithAlignment); a new column is prosemirror-tables' addColumn (what
// Crepe's own add-column button runs).
import { TextSelection } from '@milkdown/prose/state'
import { CellSelection, TableMap, addColumn, deleteColumn, deleteRow, selectedRect } from '@milkdown/prose/tables'

const CELL_TYPES = new Set(['table_cell', 'table_header'])

// The table around `$pos`: { pos, node, depth, cellPos } or null.
export function tableAround($pos) {
  let cellPos = null
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (CELL_TYPES.has(node.type.name) && cellPos == null) cellPos = $pos.before(d)
    if (node.type.name === 'table') return { pos: $pos.before(d), node, depth: d, cellPos }
  }
  return null
}

// A body row for `table`: one empty cell per column, aligned like its header.
function bodyRow(schema, table, map) {
  const cells = []
  for (let col = 0; col < map.width; col++) {
    const header = table.nodeAt(map.map[col])
    cells.push(schema.nodes.table_cell.createAndFill({ alignment: header?.attrs.alignment ?? null }))
  }
  return schema.nodes.table_row.create(null, cells)
}

// Inserts a body row at `rowIndex` (0 = before the header is never asked for)
// and puts the caret in column `col` of it. Returns the transaction.
export function insertRowAt(state, tablePos, rowIndex, col = 0) {
  const table = state.doc.nodeAt(tablePos)
  if (!table || table.type.name !== 'table') return null
  const map = TableMap.get(table)
  const index = Math.max(1, Math.min(rowIndex, table.childCount))
  let rowPos = tablePos + 1
  for (let i = 0; i < index; i++) rowPos += table.child(i).nodeSize
  const tr = state.tr.insert(rowPos, bodyRow(state.schema, table, map))
  const row = tr.doc.nodeAt(rowPos)
  let cellPos = rowPos + 1
  for (let i = 0; i < Math.min(col, row.childCount - 1); i++) cellPos += row.child(i).nodeSize
  return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)))
}

// Inserts a column at index `col` and puts the caret in row `caretRow` of it.
export function insertColumnAt(state, tablePos, col, caretRow = 0) {
  const table = state.doc.nodeAt(tablePos)
  if (!table || table.type.name !== 'table') return null
  const map = TableMap.get(table)
  const tableStart = tablePos + 1
  const at = Math.max(0, Math.min(col, map.width))
  const tr = addColumn(state.tr, { map, tableStart, table }, at)
  const next = tr.doc.nodeAt(tablePos)
  const nextMap = TableMap.get(next)
  // No alignment (`---`): the schema's default 'left' would write `:---`.
  for (let row = 0; row < nextMap.height; row++) {
    const pos = tableStart + nextMap.map[row * nextMap.width + at]
    const cell = tr.doc.nodeAt(pos)
    if (cell && cell.attrs.alignment != null) tr.setNodeMarkup(pos, null, { ...cell.attrs, alignment: null })
  }
  const row = Math.max(0, Math.min(caretRow, nextMap.height - 1))
  const cellPos = tableStart + nextMap.map[row * nextMap.width + at]
  return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)))
}

// Appends a column and puts the caret in its header cell.
export const appendColumn = (state, tablePos) => insertColumnAt(state, tablePos, Infinity, 0)

// The right-click menu's 表格 submenu (Typora: insert row above / below,
// column left / right, delete row / column). `null` outside a table.
export function tableMenuContext(state) {
  const { selection } = state
  const $at = selection instanceof CellSelection ? selection.$headCell : selection.$head
  const found = tableAround($at)
  if (!found) return null
  let rect
  try { rect = selectedRect(state) } catch { return null }
  const { map } = rect
  return {
    tablePos: found.pos,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    // The header row has no row above it; a GFM table keeps its header and
    // one body row; every table keeps one column.
    canRowAbove: rect.top > 0,
    canDeleteRow: rect.top > 0 && (map.height - 1) - (rect.bottom - rect.top) >= 1,
    canDeleteCol: rect.right - rect.left < map.width
  }
}

export function runTableMenuAction(view, action) {
  const state = view.state
  const context = tableMenuContext(state)
  if (!context) return false
  let tr = null
  if (action === 'rowAbove' && context.canRowAbove) tr = insertRowAt(state, context.tablePos, context.top, context.left)
  else if (action === 'rowBelow') tr = insertRowAt(state, context.tablePos, context.bottom, context.left)
  else if (action === 'colLeft') tr = insertColumnAt(state, context.tablePos, context.left, context.top)
  else if (action === 'colRight') tr = insertColumnAt(state, context.tablePos, context.right, context.top)
  else if (action === 'deleteRow' && context.canDeleteRow) return deleteRow(state, view.dispatch)
  else if (action === 'deleteCol' && context.canDeleteCol) return deleteColumn(state, view.dispatch)
  if (!tr) return false
  view.dispatch(tr.scrollIntoView())
  return true
}

// Mod+Enter in a cell: a new row under the caret's row, caret in the same
// column (Typora). In the header row the new row is the first body row.
export const insertRowBelow = (state, dispatch) => {
  const found = tableAround(state.selection.$head)
  if (!found || found.cellPos == null) return false
  const map = TableMap.get(found.node)
  const rect = map.findCell(found.cellPos - (found.pos + 1))
  if (dispatch) dispatch(insertRowAt(state, found.pos, rect.bottom, rect.left).scrollIntoView())
  return true
}

// Tab in the last cell: a new row at the end, caret in its first cell.
export const appendRowFromLastCell = (state, dispatch) => {
  if (!state.selection.empty) return false
  const found = tableAround(state.selection.$head)
  if (!found || found.cellPos == null) return false
  const map = TableMap.get(found.node)
  if (found.cellPos - (found.pos + 1) !== map.map[map.map.length - 1]) return false
  if (dispatch) dispatch(insertRowAt(state, found.pos, found.node.childCount, 0).scrollIntoView())
  return true
}
