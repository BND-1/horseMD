// A table's header row always has the table's width in header cells.
// prosemirror-tables' fixTables pads a short row with cells of the row's
// first cell type — for a header row left WITHOUT cells it takes a body
// cell, which the header row cannot hold, so the row stayed empty: the
// editor showed a table without a header and Milkdown wrote no header row
// (the first body row became the header; fuzz seed 5619). Empty header
// cells are added here, in the touched tables only.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { touchedBlocks } from './editor-one-line-blocks.js'

const key = new PluginKey('hm-table-header-cells')

export function tableHeaderCellsPlugin() {
  return new Plugin({
    key,
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(key))) return null
      const headerCell = state.schema.nodes.table_header
      if (!headerCell) return null
      const fixes = []
      for (const [from, to] of touchedBlocks(transactions, state.doc)) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== 'table') return true
          let width = 0
          node.forEach((row) => { width = Math.max(width, row.childCount) })
          const header = node.firstChild
          if (width && header?.type.name === 'table_header_row' && header.childCount === 0) {
            // Each column's alignment lives on its cells; the serializer
            // writes the delimiter row from the header's: take the column's
            // from the first body row that has that cell.
            const aligns = Array.from({ length: width }, (_unused, column) => {
              let alignment = null
              node.forEach((row) => { if (alignment == null && column < row.childCount) alignment = row.child(column).attrs.alignment ?? null })
              return alignment
            })
            fixes.push({ at: pos + 2, aligns })
          }
          return false
        })
      }
      if (!fixes.length) return null
      const tr = state.tr
      // Bottom-up: an insertion shifts only what follows it.
      for (const { at, aligns } of fixes.sort((a, b) => b.at - a.at)) {
        const cells = aligns.map((alignment) => headerCell.createAndFill({ alignment }))
        if (cells.some((cell) => !cell)) continue
        tr.insert(at, cells)
      }
      return tr.docChanged ? tr.setMeta(key, true) : null
    }
  })
}
