// Table paste (#152). A GFM table is a plain grid: no merged cells, and each
// cell holds exactly one paragraph. Two paste paths broke that and left a
// document Markdown can't spell, so every save failed closed:
//
// 1. Merged cells. Excel / WPS / web tables carry colspan / rowspan. They
//    are split here into a plain grid (Typora does the same): the merged
//    content stays in its top-left cell, the rest of the area gets empty cells.
// 2. Pasting into a table cell. Milkdown's clipboard plugin owns every paste
//    and replaces the selection with the slice, so a pasted table or several
//    paragraphs split the surrounding table in three. In a cell, a pasted
//    table now fills the cells from the caret (spreadsheet style, growing the
//    table as needed), and other block content joins into the cell with line
//    breaks (saved as `<br>`).
import { Fragment, Slice } from '@milkdown/prose/model'
import { Plugin, TextSelection } from '@milkdown/prose/state'
import { CellSelection, TableMap } from '@milkdown/prose/tables'

const CELL_TYPES = new Set(['table_cell', 'table_header'])
const ROW_TYPES = new Set(['table_row', 'table_header_row'])

const plainAttrs = (attrs) => ({ ...attrs, colspan: 1, rowspan: 1, colwidth: null })
const emptyCellLike = (type, attrs) => type.createAndFill(attrs ? { alignment: attrs.alignment } : null)

// Rebuild a table node as a grid with every span split. A covered slot gets
// an empty cell of its row's type. A row without cells stays as it is: an
// HTML table without <th> parses with an empty header row, which Milkdown's
// own paste rule fills afterwards.
function splitTableSpans(table) {
  let hasSpan = false
  table.descendants((node) => {
    if (CELL_TYPES.has(node.type.name) && (node.attrs.colspan > 1 || node.attrs.rowspan > 1)) hasSpan = true
    return !hasSpan && !CELL_TYPES.has(node.type.name)
  })
  if (!hasSpan) return table
  const { schema } = table.type
  const height = table.childCount
  const slots = Array.from({ length: height }, () => [])
  for (let r = 0; r < height; r += 1) {
    let c = 0
    table.child(r).forEach((cell) => {
      if (!CELL_TYPES.has(cell.type.name)) return
      while (slots[r][c]) c += 1
      const colspan = Math.max(1, cell.attrs.colspan || 1)
      const rowspan = Math.max(1, cell.attrs.rowspan || 1)
      for (let rr = r; rr < Math.min(height, r + rowspan); rr += 1) {
        for (let cc = c; cc < c + colspan; cc += 1) {
          slots[rr][cc] = rr === r && cc === c ? { cell } : { covered: cell }
        }
      }
      c += colspan
    })
  }
  const rows = []
  for (let r = 0; r < height; r += 1) {
    const rowNode = table.child(r)
    if (!slots[r].length) { rows.push(rowNode); continue }
    const cellType = rowNode.type.name === 'table_header_row' ? schema.nodes.table_header : schema.nodes.table_cell
    const cells = []
    for (let c = 0; c < slots[r].length; c += 1) {
      const slot = slots[r][c]
      if (slot?.cell) cells.push(slot.cell.type.create(plainAttrs(slot.cell.attrs), slot.cell.content, slot.cell.marks))
      else cells.push(emptyCellLike(cellType, slot?.covered.attrs))
    }
    rows.push(rowNode.type.create(rowNode.attrs, cells))
  }
  return table.type.create(table.attrs, rows)
}

// A bare row (an open slice) can only split its colspans; a rowspan has no
// rows to reach, so it collapses to one row.
function splitRowSpans(row) {
  let changed = false
  const cells = []
  row.forEach((cell) => {
    if (!CELL_TYPES.has(cell.type.name)) { cells.push(cell); return }
    const { colspan = 1, rowspan = 1 } = cell.attrs
    if (colspan <= 1 && rowspan <= 1) { cells.push(cell); return }
    changed = true
    cells.push(cell.type.create(plainAttrs(cell.attrs), cell.content, cell.marks))
    for (let i = 1; i < colspan; i += 1) cells.push(emptyCellLike(cell.type, cell.attrs))
  })
  return changed ? row.type.create(row.attrs, cells) : row
}

function mapFragment(fragment) {
  let changed = false
  const nodes = []
  fragment.forEach((node) => {
    let next = node
    if (node.type.name === 'table') next = splitTableSpans(node)
    else if (ROW_TYPES.has(node.type.name)) next = splitRowSpans(node)
    else if (!node.isLeaf && !node.isTextblock) {
      const content = mapFragment(node.content)
      if (content !== node.content) next = node.copy(content)
    }
    if (next !== node) changed = true
    nodes.push(next)
  })
  return changed ? Fragment.from(nodes) : fragment
}

// ── Pasted HTML tables (before ProseMirror parses them) ──────────────────
// A cell holds one paragraph, and a <tr> holding any <th> parses as the
// header row. Web / Notion / Confluence / Word tables break both: a cell with
// several paragraphs, a list, a heading, a code block or a nested table spills
// out of the table, and a body row using <th> as a row header starts a new
// table. The table then came out as several small tables with its content in
// between. Flatten every cell to inline content joined by <br> (list items get
// "• " / "1. ", headings turn bold, a nested table becomes one line per row),
// make body <th> plain cells, and move <caption> above the table.
const CELL_BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'ADDRESS', 'DETAILS', 'SUMMARY'])

function cellLines(node, doc) {
  const lines = []
  let line = []
  const endLine = () => { if (line.some((n) => n.nodeType !== 3 || n.nodeValue.trim())) lines.push(line); line = [] }
  const pushLines = (more, wrap) => { endLine(); more.forEach((l) => lines.push(wrap ? wrap(l) : l)) }
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) { line.push(child); continue }
    if (child.nodeType !== 1) continue
    const tag = child.tagName
    if (tag === 'BR') { endLine(); continue }
    if (!CELL_BLOCKS.has(tag) && !child.querySelector([...CELL_BLOCKS].join(','))) { line.push(child); continue }
    if (tag === 'HR') { endLine(); continue }
    if (tag === 'UL' || tag === 'OL') {
      let n = Number(child.getAttribute('start')) || 1
      for (const item of [...child.children]) {
        if (item.tagName !== 'LI') continue
        const marker = tag === 'OL' ? `${n++}. ` : '• '
        const itemLines = cellLines(item, doc)
        itemLines.forEach((l, i) => l.unshift(doc.createTextNode(i ? '  ' : marker)))
        pushLines(itemLines)
      }
      continue
    }
    if (tag === 'PRE') {
      pushLines(child.textContent.replace(/\n$/, '').split('\n').filter((t) => t.trim()).map((t) => {
        const code = doc.createElement('code'); code.textContent = t; return [code]
      }))
      continue
    }
    if (tag === 'TABLE') {
      const rows = [...child.rows].map((row) => [doc.createTextNode([...row.cells].map((c) => c.textContent.trim().replace(/\s+/g, ' ')).join(' | '))])
      pushLines(rows.filter((l) => l[0].nodeValue.replace(/[|\s]/g, '')))
      continue
    }
    if (/^H[1-6]$/.test(tag)) {
      pushLines(cellLines(child, doc), (l) => { const strong = doc.createElement('strong'); strong.append(...l); return [strong] })
      continue
    }
    // Other blocks (p, div, blockquote…) and inline wrappers around blocks:
    // their content becomes lines.
    pushLines(cellLines(child, doc))
  }
  endLine()
  return lines
}

function flattenCell(cell) {
  if (!cell.querySelector([...CELL_BLOCKS].join(','))) return
  const doc = cell.ownerDocument
  const lines = cellLines(cell, doc)
  const out = []
  lines.forEach((l, i) => { if (i) out.push(doc.createElement('br')); out.push(...l) })
  cell.replaceChildren(...out)
}

export function normalizePastedTableHtml(root) {
  // Outermost tables only: nested ones are flattened into their cell.
  const tables = [...root.querySelectorAll('table')].filter((t) => !t.parentElement?.closest('td, th'))
  for (const table of tables) {
    const doc = table.ownerDocument
    table.querySelectorAll(':scope > caption').forEach((caption) => {
      const p = doc.createElement('p'); p.append(...caption.childNodes); table.before(p); caption.remove()
    })
    const rows = [...table.rows]
    rows.forEach((row) => [...row.cells].forEach(flattenCell))
    rows.forEach((row, index) => {
      const cells = [...row.cells]
      const header = index === 0 && cells.some((c) => c.tagName === 'TH')
      for (const cell of cells) {
        const want = header ? 'TH' : 'TD'
        if (cell.tagName === want) continue
        const next = doc.createElement(want.toLowerCase())
        for (const attr of cell.attributes) next.setAttribute(attr.name, attr.value)
        next.append(...cell.childNodes)
        cell.replaceWith(next)
      }
    })
  }
}

// transformPasted: split merged cells anywhere in the pasted slice.
export function normalizePastedTableSpans(slice) {
  let content
  try { content = mapFragment(slice.content) } catch (error) {
    tracePaste({ step: 'normalize-error', error: String(error?.stack || error) })
    return slice
  }
  tracePaste({ step: 'normalize', changed: content !== slice.content, slice: slice.toJSON(), out: content === slice.content ? null : content.toJSON() })
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

export function createTableSpanPastePlugin() {
  return new Plugin({ props: { transformPasted: (slice) => normalizePastedTableSpans(slice) } })
}

function tracePaste(entry) {
  if (typeof window === 'undefined' || !window.__hmTablePasteTrace) return
  window.__hmTablePasteTrace.push(entry)
}

// The table cell holding the selection, or null.
function selectionCell(state) {
  const sel = state.selection
  if (sel instanceof CellSelection) {
    const $a = sel.$anchorCell, $h = sel.$headCell
    return { table: $a.node(-1), tablePos: $a.before(-1), cellPos: Math.min($a.pos, $h.pos), cellSelection: sel }
  }
  const $from = sel.$from
  for (let d = $from.depth; d > 0; d -= 1) {
    if (CELL_TYPES.has($from.node(d).type.name)) {
      if (!sel.empty && !$from.sameParent(sel.$to)) return null
      return { table: $from.node(d - 2), tablePos: $from.before(d - 2), cellPos: $from.before(d) }
    }
  }
  return null
}

// Inline content of a pasted cell (its paragraph's content).
function cellInline(cell) {
  return cell.firstChild?.isTextblock ? cell.firstChild.content : Fragment.empty
}

// The pasted grid of a slice that carries table structure, as rows of inline
// fragments; null when the slice has no table cells.
function pastedGrid(slice) {
  let content = slice.content
  while (content.childCount === 1 && !ROW_TYPES.has(content.firstChild.type.name) &&
    !CELL_TYPES.has(content.firstChild.type.name) && content.firstChild.type.name !== 'table' &&
    !content.firstChild.isTextblock && !content.firstChild.isLeaf) {
    content = content.firstChild.content
  }
  if (content.childCount === 1 && content.firstChild.type.name === 'table') content = content.firstChild.content
  const first = content.firstChild
  if (!first) return null
  if (ROW_TYPES.has(first.type.name)) {
    const rows = []
    content.forEach((row) => {
      if (!ROW_TYPES.has(row.type.name) || !row.childCount) return
      const cells = []
      row.forEach((cell) => { if (CELL_TYPES.has(cell.type.name)) cells.push(cellInline(cell)) })
      rows.push(cells)
    })
    // A one-row table without <th> parses with an empty header row filled in
    // by Milkdown (GFM needs one); it is not part of what was copied.
    while (rows.length > 1 && rows[0].every((cell) => !cell.size)) rows.shift()
    return rows.length ? rows : null
  }
  if (CELL_TYPES.has(first.type.name)) {
    const cells = []
    content.forEach((cell) => { if (CELL_TYPES.has(cell.type.name)) cells.push(cellInline(cell)) })
    return [cells]
  }
  return null
}

// Fill the table from the selected cell with the pasted grid, growing it as
// needed. The whole table is rebuilt: GFM tables have no spans, so a plain
// grid of rows × cells is the complete structure.
function fillTable(view, at, grid) {
  const { state } = view
  const { schema } = state
  const { table, tablePos } = at
  const tableStart = tablePos + 1
  let top = 0, left = 0
  {
    const map = TableMap.get(table)
    const rect = map.findCell(at.cellPos - tableStart)
    top = rect.top
    left = rect.left
  }
  const pasteWidth = Math.max(...grid.map((row) => row.length))
  const height = Math.max(table.childCount, top + grid.length)
  let width = left + pasteWidth
  table.forEach((row) => { width = Math.max(width, row.childCount) })
  const header = table.firstChild
  const alignmentAt = (c) => header?.maybeChild(c)?.attrs.alignment ?? null
  const rows = []
  let lastPasted = null
  for (let r = 0; r < height; r += 1) {
    const old = r < table.childCount ? table.child(r) : null
    const rowType = r === 0 ? schema.nodes.table_header_row : schema.nodes.table_row
    const cellType = r === 0 ? schema.nodes.table_header : schema.nodes.table_cell
    const cells = []
    for (let c = 0; c < width; c += 1) {
      const pasted = r >= top && r < top + grid.length && c >= left && c < left + pasteWidth
      const existing = old?.maybeChild(c)
      const attrs = existing ? existing.attrs : { alignment: alignmentAt(c) }
      if (pasted) {
        const inline = grid[r - top][c - left] || Fragment.empty
        cells.push(cellType.create(attrs, schema.nodes.paragraph.create(null, inline)))
        lastPasted = [r, c]
      } else if (existing) cells.push(existing)
      else cells.push(cellType.createAndFill({ alignment: alignmentAt(c) }))
    }
    rows.push(rowType.create(old?.attrs, cells))
  }
  const next = table.type.create(table.attrs, rows)
  const tr = state.tr.replaceWith(tablePos, tablePos + table.nodeSize, next)
  if (lastPasted) {
    // Caret at the end of the last pasted cell.
    let pos = tablePos + 1
    for (let r = 0; r < lastPasted[0]; r += 1) pos += next.child(r).nodeSize
    pos += 1
    const row = next.child(lastPasted[0])
    for (let c = 0; c < lastPasted[1]; c += 1) pos += row.child(c).nodeSize
    const cell = row.child(lastPasted[1])
    tr.setSelection(TextSelection.create(tr.doc, pos + cell.nodeSize - 2))
  }
  view.dispatch(tr.scrollIntoView())
  return true
}

// Join pasted blocks into one cell's inline content, line breaks between them.
function flattenToInline(slice, schema) {
  const parts = []
  const breakNode = schema.nodes.hardbreak
  const pushLines = (fragment) => { if (fragment.size) parts.push(fragment) }
  slice.content.descendants((node) => {
    if (node.type.name === 'code_block') {
      node.textContent.split('\n').forEach((line) => pushLines(line ? Fragment.from(schema.text(line)) : Fragment.empty))
      return false
    }
    if (node.isTextblock) { pushLines(node.content); return false }
    return true
  })
  if (!parts.length) return null
  let out = Fragment.empty
  parts.forEach((part, index) => {
    if (index && breakNode) out = out.addToEnd(breakNode.create())
    else if (index) out = out.addToEnd(schema.text(' '))
    out = out.append(part)
  })
  return out
}

// Slices that replaceSelection already fits inside a cell paragraph: inline
// nodes only, or one paragraph opened on both sides.
function fitsInCell(slice) {
  const { content } = slice
  if (!content.childCount) return true
  let inline = true
  content.forEach((node) => { if (!node.isInline) inline = false })
  if (inline) return true
  return content.childCount === 1 && content.firstChild.type.name === 'paragraph' && slice.openStart >= 1 && slice.openEnd >= 1
}

// handlePaste (and the Markdown paste path): paste inside a table cell
// without splitting the table. Returns true when handled.
export function pasteIntoTableCell(view, slice) {
  const at = selectionCell(view.state)
  tracePaste({ step: 'paste', inCell: !!at, slice: slice.toJSON() })
  if (!at) return false
  const grid = pastedGrid(normalizePastedTableSpans(slice))
  if (grid) return fillTable(view, at, grid)
  if (at.cellSelection || fitsInCell(slice)) return false
  const inline = flattenToInline(slice, view.state.schema)
  if (!inline) return false
  const tr = view.state.tr.replaceSelection(new Slice(inline, 0, 0))
  view.dispatch(tr.scrollIntoView())
  return true
}
