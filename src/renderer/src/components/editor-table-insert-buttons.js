// Insert a row / column exactly where the pointer is (#181; Feishu / Notion).
// The pointer near a column boundary shows a「+」above the header at that
// boundary (outside the table, never covered) and marks the boundary line; a
// click inserts a column there. Near a row boundary the「+」sits left of the
// table at that line and inserts a row there. Every boundary counts: before the
// first column, after the last column, under the last row (not above the
// header: a GFM table's header is its first row).
//
// Crepe's own grid-line「+」(within 8 px of a boundary, centred on the table
// edge: half hidden in the header / first column) is switched off in app.css.
// These buttons live in an overlay next to the editor DOM (never inside the
// contenteditable or Crepe's Vue node view), positioned against the layer, so
// they scroll with the document.
import { TextSelection } from '@milkdown/prose/state'
import { TableMap } from '@milkdown/prose/tables'
import { insertColumnAt, insertRowAt } from './editor-table-insert.js'

// How near a boundary the pointer must be (inside the table).
const EDGE = 10
// How far outside the table, towards the button, it still counts.
const OUTSIDE = 34
// Button size and its gap from the table.
const SIZE = 22
const GAP = 6
const HIDE_DELAY_MS = 400

const plusIcon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>'

export function mountTableInsertButtons({ view, host, cleanups, markUserEdit, onRichEditPending, t = (k, f) => f }) {
  const root = view.dom.parentElement
  if (!root) return
  const layer = document.createElement('div')
  layer.className = 'hm-table-insert-layer'
  root.appendChild(layer)

  const make = (kind, label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `hm-table-insert hm-table-insert-${kind}`
    button.dataset.kind = kind
    button.dataset.show = 'false'
    button.tabIndex = -1
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = plusIcon
    const line = document.createElement('div')
    line.className = `hm-table-insert-line hm-table-insert-line-${kind}`
    line.dataset.show = 'false'
    layer.append(line, button)
    return { button, line }
  }
  const col = make('col', t('table.insertColHere', '在这里插入一列'))
  const row = make('row', t('table.insertRowHere', '在这里插入一行'))

  // What is shown: { kind, block, index } per kind.
  const target = { col: null, row: null }
  let hideTimer = 0

  const setShown = (kind, value) => {
    target[kind] = value
    const parts = kind === 'col' ? col : row
    parts.button.dataset.show = value ? 'true' : 'false'
    parts.line.dataset.show = value ? 'true' : 'false'
  }
  const hideAll = () => {
    clearTimeout(hideTimer)
    hideTimer = 0
    setShown('col', null)
    setShown('row', null)
  }
  const hideSoon = () => {
    if ((!target.col && !target.row) || hideTimer) return
    hideTimer = setTimeout(hideAll, HIDE_DELAY_MS)
  }
  const keep = () => {
    clearTimeout(hideTimer)
    hideTimer = 0
  }

  // Boundaries of a table block in viewport coordinates.
  const geometry = (block) => {
    const table = block.querySelector('table.children')
    const wrapper = block.querySelector('.table-wrapper')
    const t = table?.getBoundingClientRect()
    const w = wrapper?.getBoundingClientRect()
    if (!t?.width || !w || !table.rows.length) return null
    const first = table.rows[0]
    const xs = [...first.cells].map((cell) => cell.getBoundingClientRect().left)
    xs.push(first.cells[first.cells.length - 1].getBoundingClientRect().right)
    // Row boundaries from 1 (under the header) to the bottom.
    const ys = [...table.rows].map((tr) => tr.getBoundingClientRect().bottom)
    return {
      table: t,
      visibleLeft: Math.max(t.left, w.left),
      visibleRight: Math.min(t.right, w.right),
      xs,
      ys
    }
  }

  const nearest = (values, value, from = 0) => {
    let best = -1
    let distance = Infinity
    for (let i = from; i < values.length; i++) {
      const d = Math.abs(values[i] - value)
      if (d < distance) { best = i; distance = d }
    }
    return { index: best, distance }
  }

  const place = (kind, g, index) => {
    const layerRect = layer.getBoundingClientRect()
    const parts = kind === 'col' ? col : row
    if (kind === 'col') {
      const x = g.xs[index]
      Object.assign(parts.button.style, {
        left: `${Math.round(x - SIZE / 2 - layerRect.left)}px`,
        top: `${Math.round(g.table.top - GAP - SIZE - layerRect.top)}px`
      })
      Object.assign(parts.line.style, {
        left: `${Math.round(x - 1 - layerRect.left)}px`,
        top: `${Math.round(g.table.top - layerRect.top)}px`,
        width: '2px',
        height: `${Math.round(g.table.height)}px`
      })
    } else {
      const y = g.ys[index]
      Object.assign(parts.button.style, {
        left: `${Math.round(g.visibleLeft - GAP - SIZE - layerRect.left)}px`,
        top: `${Math.round(y - SIZE / 2 - layerRect.top)}px`
      })
      Object.assign(parts.line.style, {
        left: `${Math.round(g.visibleLeft - layerRect.left)}px`,
        top: `${Math.round(y - 1 - layerRect.top)}px`,
        width: `${Math.round(g.visibleRight - g.visibleLeft)}px`,
        height: '2px'
      })
    }
  }

  // The boundary the pointer is at, if any: { col?: {block, index}, row?: … }.
  const tableBlocks = view.dom.getElementsByClassName('milkdown-table-block')
  const hit = (x, y) => {
    for (const block of tableBlocks) {
      const g = geometry(block)
      if (!g) continue
      const { table } = g
      const inX = x >= g.visibleLeft - OUTSIDE && x <= g.visibleRight + EDGE
      const inY = y >= table.top - OUTSIDE && y <= table.bottom + EDGE
      if (!inX || !inY) continue
      const result = { block, g }
      // Columns: along a boundary inside the table, or in the strip above it.
      if (y <= table.bottom && x >= g.visibleLeft - EDGE && x <= g.visibleRight + EDGE) {
        const c = nearest(g.xs, x)
        const reach = y < table.top ? SIZE / 2 + 4 : EDGE
        if (c.index >= 0 && c.distance <= reach) result.col = c.index
      }
      // Rows: along a boundary inside the table, or in the strip left of it.
      if (x <= g.visibleRight && y >= g.ys[0] - EDGE) {
        const r = nearest(g.ys, y)
        const reach = x < g.visibleLeft ? SIZE / 2 + 4 : EDGE
        if (r.index >= 0 && r.distance <= reach) result.row = r.index
      }
      return result
    }
    return null
  }

  const onPointerMove = (event) => {
    if (event.buttons || document.body.classList.contains('hm-table-resizing')) return
    if (!view.editable) return hideAll()
    const over = event.target
    if (over === col.button || over === row.button || col.button.contains(over) || row.button.contains(over)) return keep()
    const found = hit(event.clientX, event.clientY)
    if (!found || (found.col == null && found.row == null)) return hideSoon()
    keep()
    for (const kind of ['col', 'row']) {
      const index = found[kind]
      if (index == null) {
        // Leaving one kind while the other shows: drop it at once.
        if (target[kind]) setShown(kind, null)
        continue
      }
      place(kind, found.g, index)
      setShown(kind, { block: found.block, index })
    }
  }

  const tablePosOf = (el) => {
    let found = null
    view.state.doc.descendants((node, pos) => {
      if (found != null) return false
      if (node.type.name !== 'table') return true
      const dom = view.nodeDOM(pos)
      if (dom === el || dom?.contains?.(el) || el.contains?.(dom)) found = pos
      return false
    })
    return found
  }

  const onDown = (event) => {
    // Keep the editor's focus and selection until the click.
    event.preventDefault()
    event.stopPropagation()
  }
  const onClick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const kind = event.currentTarget.dataset.kind
    const shown = target[kind]
    if (!shown || !view.editable) return
    const pos = tablePosOf(shown.block)
    if (pos == null) return
    // First put the caret in the cell beside the boundary, as its own
    // (selection-only) transaction: undo restores the selection from before
    // the insert, and with the caret still wherever it was (often the
    // document start: a click on a button does not move it) ⌘Z jumped the
    // page there (Air trace 2026-11-23).
    {
      const table = view.state.doc.nodeAt(pos)
      const map = TableMap.get(table)
      const r = kind === 'row' ? Math.min(shown.index, map.height - 1) : 0
      const c = kind === 'row' ? 0 : Math.max(0, Math.min(shown.index, map.width) - 1)
      const cellPos = pos + 1 + map.map[r * map.width + c]
      const near = TextSelection.near(view.state.doc.resolve(cellPos + 1))
      if (!view.state.selection.eq(near)) view.dispatch(view.state.tr.setSelection(near))
    }
    const state = view.state
    const table = state.doc.nodeAt(pos)
    // Row boundary i lies under table row i: the new row is row i + 1. A new
    // column at boundary i is column i; the caret goes to the row the pointer
    // was in (the header when it came from above).
    const tr = kind === 'row'
      ? insertRowAt(state, pos, shown.index + 1, 0)
      : insertColumnAt(state, pos, Math.min(shown.index, TableMap.get(table).width), 0)
    if (!tr) return
    markUserEdit?.()
    onRichEditPending?.()
    view.dispatch(tr)
    view.focus()
    hideAll()
  }
  for (const { button } of [col, row]) {
    button.addEventListener('pointerdown', onDown)
    button.addEventListener('mousedown', onDown)
    button.addEventListener('click', onClick)
  }

  const onScroll = () => hideAll()
  const target0 = host || root
  target0.addEventListener('pointermove', onPointerMove, { passive: true })
  target0.addEventListener('pointerleave', hideSoon)
  layer.addEventListener('pointermove', onPointerMove, { passive: true })
  layer.addEventListener('pointerleave', hideSoon)
  target0.addEventListener('scroll', onScroll, { capture: true, passive: true })
  target0.addEventListener('keydown', hideAll, true)
  window.addEventListener('resize', onScroll)

  cleanups.push(() => {
    clearTimeout(hideTimer)
    target0.removeEventListener('pointermove', onPointerMove)
    target0.removeEventListener('pointerleave', hideSoon)
    target0.removeEventListener('scroll', onScroll, { capture: true })
    target0.removeEventListener('keydown', hideAll, true)
    window.removeEventListener('resize', onScroll)
    layer.remove()
  })
}
