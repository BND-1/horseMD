import { TextSelection } from '@milkdown/prose/state'
import { TableMap, cellAround, columnResizingPluginKey } from '@milkdown/prose/tables'

const clamp = (value, min, max) => {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

const readColumnWidths = (table) => {
  const widths = []
  for (const row of table.rows) {
    let column = 0
    for (const cell of row.cells) {
      const span = Math.max(1, Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1)
      const values = (cell.getAttribute('data-colwidth') || '')
        .split(',')
        .map((value) => Number.parseInt(value, 10))
      for (let index = 0; index < span; index += 1) {
        if (Number.isFinite(values[index]) && values[index] > 0) {
          widths[column + index] = values[index]
        }
      }
      column += span
    }
  }
  return widths
}

const readRenderedColumnWidths = (table) => {
  const widths = []
  for (const row of table.rows) {
    let column = 0
    for (const cell of row.cells) {
      const span = Math.max(1, Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1)
      const measured = cell.getBoundingClientRect().width / span
      for (let index = 0; index < span; index += 1) {
        widths[column + index] = Math.max(widths[column + index] || 0, measured)
      }
      column += span
    }
  }
  return widths
}

const applyColumnGroupWidths = (table, widths) => {
  let colgroup = table.querySelector('colgroup.hm-column-widths')
  if (!colgroup) {
    colgroup = document.createElement('colgroup')
    colgroup.className = 'hm-column-widths'
    table.insertBefore(colgroup, table.firstChild)
  }
  while (colgroup.children.length < widths.length) {
    colgroup.appendChild(document.createElement('col'))
  }
  while (colgroup.children.length > widths.length) {
    colgroup.lastElementChild?.remove()
  }
  widths.forEach((width, index) => {
    const col = colgroup.children[index]
    const cssWidth = `${width}px`
    if (col.style.width !== cssWidth) col.style.width = cssWidth
  })

  const tableWidth = `${Math.ceil(widths.reduce((total, width) => total + width, 0))}px`
  if (table.style.width !== tableWidth) table.style.width = tableWidth
  if (table.style.minWidth !== tableWidth) table.style.minWidth = tableWidth
}

const getColumnResizeInfo = (view, cellPos) => {
  try {
    const $cell = view.state.doc.resolve(cellPos)
    const table = $cell.node(-1)
    const cell = $cell.nodeAfter
    if (!table || !cell || table.type.name !== 'table') return null
    const tableStart = $cell.start(-1)
    const map = TableMap.get(table)
    const column = map.colCount($cell.pos - tableStart) + cell.attrs.colspan - 1
    if (column < 0 || column >= map.width) return null
    return { cellPos, column }
  } catch {
    return null
  }
}

const getColumnResizeAtPointer = (view, event, side) => {
  try {
    // Match prosemirror-tables' edge lookup: sample a few pixels inside the
    // cell, then resolve the actual cell position instead of relying on its
    // asynchronous hover plugin state.
    const point = view.posAtCoords({
      left: event.clientX + (side === 'left' ? 5 : -5),
      top: event.clientY
    })
    if (!point) return null
    const $cell = cellAround(view.state.doc.resolve(point.pos))
    if (!$cell) return null
    if (side === 'right') return getColumnResizeInfo(view, $cell.pos)

    const table = $cell.node(-1)
    const tableStart = $cell.start(-1)
    const map = TableMap.get(table)
    const mapIndex = map.map.indexOf($cell.pos - tableStart)
    if (mapIndex < 0 || mapIndex % map.width === 0) return null
    return getColumnResizeInfo(view, tableStart + map.map[mapIndex - 1])
  } catch {
    return null
  }
}

// This mirrors prosemirror-tables' internal updateColumnWidth. Crepe replaces
// the default TableView, so its native live-resize path has no persistent
// colgroup to update. Keeping the final transaction here lets the preview stay
// DOM-only while retaining the standard data-colwidth document format.
const persistColumnWidth = (view, resize, width) => {
  const $cell = view.state.doc.resolve(resize.cellPos)
  const table = $cell.node(-1)
  const map = TableMap.get(table)
  const tableStart = $cell.start(-1)
  const tr = view.state.tr
  for (let row = 0; row < map.height; row += 1) {
    const mapIndex = row * map.width + resize.column
    if (row && map.map[mapIndex] === map.map[mapIndex - map.width]) continue
    const pos = map.map[mapIndex]
    const cell = table.nodeAt(pos)
    if (!cell) continue
    const attrs = cell.attrs
    const index = attrs.colspan === 1 ? 0 : resize.column - map.colCount(pos)
    if (attrs.colwidth?.[index] === width) continue
    const colwidth = attrs.colwidth ? attrs.colwidth.slice() : Array(attrs.colspan).fill(0)
    colwidth[index] = width
    tr.setNodeMarkup(tableStart + pos, null, { ...attrs, colwidth })
  }
  if (!tr.docChanged) return false
  view.dispatch(tr)
  return true
}

const syncRenderedTableColumnWidths = (host) => {
  host.querySelectorAll('.milkdown-table-block table.children').forEach((table) => {
    const storedWidths = readColumnWidths(table)
    const hasStoredWidths = storedWidths.some(Boolean)
    if (!hasStoredWidths) {
      if (table.dataset.hmColumnPreview === 'true') return
      if (table.dataset.hmColumnWidths !== 'true') return
      table.querySelector('colgroup.hm-column-widths')?.remove()
      table.style.removeProperty('width')
      table.style.removeProperty('min-width')
      delete table.dataset.hmColumnWidths
      return
    }

    // Crepe renders tables without the colgroup used by ProseMirror's default
    // TableView. Use each currently rendered column as the fallback for columns
    // the user has not resized, and use data-colwidth for the columns they did.
    const renderedWidths = readRenderedColumnWidths(table)
    const columnWidths = Array.from({ length: Math.max(storedWidths.length, renderedWidths.length) }, (_, index) => (
      storedWidths[index] || renderedWidths[index] || 1
    ))
    table.dataset.hmColumnWidths = 'true'
    applyColumnGroupWidths(table, columnWidths)
  })
}

const mountSlashMenuBounds = ({ host, scrollEl, cleanups }) => {
  const margin = 8
  let raf = 0

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      fix()
    })
  }

  const fix = () => {
    const menu = host.querySelector('.milkdown-slash-menu[data-show="true"]')
    if (!menu || menu.offsetParent === null) return
    const rect = menu.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const boundsRect = scrollEl?.getBoundingClientRect?.()
    const safe = {
      left: Math.max(0, boundsRect?.left ?? 0) + margin,
      top: Math.max(0, boundsRect?.top ?? 0) + margin,
      right: Math.min(window.innerWidth, boundsRect?.right ?? window.innerWidth) - margin,
      bottom: Math.min(window.innerHeight, boundsRect?.bottom ?? window.innerHeight) - margin
    }
    if (safe.right <= safe.left || safe.bottom <= safe.top) return

    const left = Number.parseFloat(menu.style.left || '0')
    const top = Number.parseFloat(menu.style.top || '0')
    let nextLeft = left
    let nextTop = top
    if (rect.left < safe.left) nextLeft += safe.left - rect.left
    else if (rect.right > safe.right) nextLeft -= rect.right - safe.right
    if (rect.top < safe.top) nextTop += safe.top - rect.top
    else if (rect.bottom > safe.bottom) nextTop -= rect.bottom - safe.bottom

    nextLeft = clamp(nextLeft, left + safe.left - rect.left, left + safe.right - rect.right)
    nextTop = clamp(nextTop, top + safe.top - rect.top, top + safe.bottom - rect.bottom)
    if (Math.abs(nextLeft - left) > 0.5) menu.style.left = `${Math.round(nextLeft)}px`
    if (Math.abs(nextTop - top) > 0.5) menu.style.top = `${Math.round(nextTop)}px`

    const groups = menu.querySelector('.menu-groups')
    if (groups) {
      const previousMaxHeight = groups.style.maxHeight
      const tabHeight = menu.querySelector('.tab-group')?.getBoundingClientRect?.().height || 0
      const available = Math.max(96, safe.bottom - safe.top - tabHeight - 16)
      const nextMaxHeight = `${Math.min(420, Math.floor(available))}px`
      groups.style.maxHeight = nextMaxHeight
      if (previousMaxHeight !== nextMaxHeight) schedule()
    }
  }

  const observer = new MutationObserver(schedule)
  observer.observe(host, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'data-show']
  })
  window.addEventListener('resize', schedule)
  scrollEl?.addEventListener('scroll', schedule, { passive: true })
  cleanups.push(() => {
    if (raf) cancelAnimationFrame(raf)
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    scrollEl?.removeEventListener('scroll', schedule)
  })
}

const mountTableHandleBounds = ({ view, host, scrollEl, cleanups, markUserEdit }) => {
  if (!scrollEl) return
  const margin = 8
  const resizeHoldMs = 220
  const resizeMoveTolerance = 4
  let raf = 0
  let resizeIntent = null

  const setTranslate = (element, x, y) => {
    const next = x || y ? `${Math.round(x)}px ${Math.round(y)}px` : ''
    if (element.style.translate !== next) element.style.translate = next
  }

  const getTranslate = (element) => {
    const [x = '0', y = '0'] = element.style.translate.split(/\s+/)
    return [Number.parseFloat(x) || 0, Number.parseFloat(y) || 0]
  }

  const fitShift = (start, end, safeStart, safeEnd) => (
    clamp(0, safeStart - start, safeEnd - end)
  )

  const fix = () => {
    raf = 0
    // Crepe owns the table node view instead of ProseMirror's default TableView.
    // The native resize plugin still persists data-colwidth, so reflect those
    // stored widths onto Crepe's rendered cells after each table transaction.
    syncRenderedTableColumnWidths(host)
    const scrollRect = scrollEl.getBoundingClientRect()
    const safe = {
      left: Math.max(0, scrollRect.left) + margin,
      top: Math.max(0, scrollRect.top) + margin,
      right: Math.min(window.innerWidth, scrollRect.right) - margin,
      bottom: Math.min(window.innerHeight, scrollRect.bottom) - margin
    }

    host.querySelectorAll('.milkdown-table-block').forEach((block) => {
      const controlsOpen = !!block.querySelector('.button-group[data-show="true"]')
      block.classList.toggle('hm-table-controls-open', controlsOpen)
    })

    // Crepe positions its add-column/add-row indicator relative to its internal
    // wrapper. Table margins and scrolling can leave that indicator starting
    // above the visible grid. Snap it to the actual table bounds so the yellow
    // line covers the column/row boundary it represents.
    host.querySelectorAll('.milkdown-table-block .line-handle').forEach((handle) => {
      if (handle.dataset.show !== 'true' || handle.offsetParent === null) {
        setTranslate(handle, 0, 0)
        return
      }
      const block = handle.closest('.milkdown-table-block')
      const table = block?.querySelector('table.children')
      const tableRect = table?.getBoundingClientRect()
      if (!tableRect?.width || !tableRect.height) return

      const [previousShiftX, previousShiftY] = getTranslate(handle)
      const handleRect = handle.getBoundingClientRect()
      const rawLeft = handleRect.left - previousShiftX
      const rawTop = handleRect.top - previousShiftY
      if (handle.dataset.role === 'y-line-drag-handle') {
        handle.style.height = `${Math.round(tableRect.height)}px`
        setTranslate(handle, 0, tableRect.top - rawTop)
      } else if (handle.dataset.role === 'x-line-drag-handle') {
        handle.style.width = `${Math.round(tableRect.width)}px`
        setTranslate(handle, tableRect.left - rawLeft, 0)
      }
    })

    host.querySelectorAll('.milkdown-table-block .line-handle').forEach((handle) => {
      const button = handle.querySelector('.add-button')
      if (!button) return
      if (handle.dataset.show !== 'true' || handle.offsetParent === null) {
        setTranslate(button, 0, 0)
        return
      }
      const wrapperRect = handle.closest('.table-wrapper')?.getBoundingClientRect()
      if (!wrapperRect) return
      const buttonRect = button.getBoundingClientRect()
      const [previousShiftX, previousShiftY] = getTranslate(button)
      const rawLeft = buttonRect.left - previousShiftX
      const rawRight = buttonRect.right - previousShiftX
      const rawTop = buttonRect.top - previousShiftY
      const rawBottom = buttonRect.bottom - previousShiftY
      const buttonSafe = {
        left: Math.max(safe.left, wrapperRect.left) + 2,
        top: Math.max(safe.top, wrapperRect.top) + 2,
        right: Math.min(safe.right, wrapperRect.right) - 2,
        bottom: Math.min(safe.bottom, wrapperRect.bottom) - 2
      }
      const shiftX = fitShift(rawLeft, rawRight, buttonSafe.left, buttonSafe.right)
      const shiftY = fitShift(rawTop, rawBottom, buttonSafe.top, buttonSafe.bottom)
      setTranslate(button, shiftX, shiftY)
    })

    host.querySelectorAll('.milkdown-table-block .cell-handle').forEach((handle) => {
      const group = handle.querySelector('.button-group')
      if (handle.dataset.show !== 'true' || handle.offsetParent === null) {
        setTranslate(handle, 0, 0)
        if (group) {
          group.classList.remove('hm-table-menu-below')
          setTranslate(group, 0, 0)
        }
        return
      }

      const block = handle.closest('.milkdown-table-block')
      const blockRect = block?.getBoundingClientRect()
      const wrapperRect = block?.querySelector('.table-wrapper')?.getBoundingClientRect()
      const horizontalSafe = {
        left: Math.max(safe.left, (blockRect?.left ?? safe.left) + margin),
        right: Math.min(safe.right, (blockRect?.right ?? safe.right) - margin)
      }
      if (horizontalSafe.right <= horizontalSafe.left) return

      let handleRect = handle.getBoundingClientRect()
      const [previousShiftX, previousShiftY] = getTranslate(handle)
      const rawRect = {
        left: handleRect.left - previousShiftX,
        right: handleRect.right - previousShiftX,
        top: handleRect.top - previousShiftY,
        bottom: handleRect.bottom - previousShiftY
      }
      if (handle.dataset.role === 'col-drag-handle') {
        const safeBottom = Math.min(safe.bottom, (blockRect?.bottom ?? safe.bottom) - margin)
        const rawCenterX = (rawRect.left + rawRect.right) / 2
        const headerCell = [...(block?.querySelectorAll('th') || [])].reduce((closest, cell) => {
          const rect = cell.getBoundingClientRect()
          const distance = Math.abs(rect.left + rect.width / 2 - rawCenterX)
          return !closest || distance < closest.distance ? { rect, distance } : closest
        }, null)?.rect
        const preferredLeft = headerCell
          ? headerCell.left + (headerCell.width - handleRect.width) / 2
          : rawRect.left
        const preferredTop = headerCell
          ? headerCell.top - handleRect.height / 2
          : rawRect.top
        const targetLeft = clamp(
          preferredLeft,
          horizontalSafe.left,
          horizontalSafe.right - handleRect.width
        )
        const targetTop = clamp(preferredTop, safe.top, safeBottom - handleRect.height)
        const shiftX = targetLeft - rawRect.left
        const shiftY = targetTop - rawRect.top
        setTranslate(handle, shiftX, shiftY)
        handleRect = handle.getBoundingClientRect()
      } else {
        const handleSafeLeft = Math.max(horizontalSafe.left, (wrapperRect?.left ?? horizontalSafe.left) + 2)
        const handleSafeRight = Math.min(horizontalSafe.right, wrapperRect?.right ?? horizontalSafe.right)
        const shiftX = fitShift(rawRect.left, rawRect.right, handleSafeLeft, handleSafeRight)
        setTranslate(handle, shiftX, 0)
        handleRect = handle.getBoundingClientRect()
      }

      if (!group || group.dataset.show !== 'true' || group.offsetParent === null) return
      const menuHorizontalSafe = block?.classList.contains('hm-table-controls-open') ? safe : horizontalSafe
      const groupHeight = group.offsetHeight
      const verticalSafe = block?.classList.contains('hm-table-controls-open')
        ? { top: safe.top, bottom: safe.bottom }
        : {
            top: Math.max(safe.top, (blockRect?.top ?? safe.top) + margin),
            bottom: Math.min(safe.bottom, (blockRect?.bottom ?? safe.bottom) - margin)
          }
      const spaceAbove = handleRect.top - verticalSafe.top
      const spaceBelow = verticalSafe.bottom - handleRect.bottom
      const placeBelow = spaceAbove < groupHeight + margin &&
        (spaceBelow >= groupHeight + margin || spaceBelow > spaceAbove)
      group.classList.toggle('hm-table-menu-below', placeBelow)

      const [previousGroupShiftX, previousGroupShiftY] = getTranslate(group)
      const groupRect = group.getBoundingClientRect()
      const rawLeft = groupRect.left - previousGroupShiftX
      const rawTop = groupRect.top - previousGroupShiftY
      const preferredLeft = handleRect.left + (handleRect.width - groupRect.width) / 2
      const preferredTop = placeBelow
        ? handleRect.bottom + margin
        : handleRect.top - groupRect.height - margin
      const targetLeft = clamp(
        preferredLeft,
        menuHorizontalSafe.left,
        menuHorizontalSafe.right - groupRect.width
      )
      const targetTop = clamp(
        preferredTop,
        verticalSafe.top,
        verticalSafe.bottom - groupRect.height
      )
      const shiftX = targetLeft - rawLeft
      const shiftY = targetTop - rawTop
      setTranslate(group, shiftX, shiftY)
    })
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(fix)
  }
  const onTablePointer = (event) => {
    if (event.target.closest?.('.milkdown-table-block')) schedule()
  }
  const clearResizeIntent = () => {
    if (!resizeIntent) return null
    const intent = resizeIntent
    resizeIntent = null
    if (intent.timer) clearTimeout(intent.timer)
    window.removeEventListener('mousemove', intent.onMove, true)
    window.removeEventListener('mouseup', intent.onMouseUp, true)
    return intent
  }

  // A column boundary has two deliberately distinct interactions: hover shows
  // Crepe's add-column affordance; holding the mouse down starts resize mode.
  // This prevents a quick pass over a table edge from looking like a resize
  // action while keeping the actual drag responsive once it is intentional.
  const onColumnResizeMouseDown = (event) => {
    if (event.button !== 0) return
    const cell = event.target.closest?.('.milkdown-table-block th, .milkdown-table-block td')
    if (!cell || !host.contains(cell)) return
    const rect = cell.getBoundingClientRect()
    if (Math.min(Math.abs(event.clientX - rect.left), Math.abs(rect.right - event.clientX)) > 6) return
    const table = cell.closest('table.children')
    const side = Math.abs(event.clientX - rect.left) < Math.abs(rect.right - event.clientX)
      ? 'left'
      : 'right'
    const resize = getColumnResizeAtPointer(view, event, side)
    if (!table || !resize) return

    const block = table.closest('.milkdown-table-block')
    const tableIndex = [...host.querySelectorAll('.milkdown-table-block')].indexOf(block)
    if (tableIndex < 0) return

    const activeCell = view.nodeDOM(resize.cellPos)
    const measuredWidths = readRenderedColumnWidths(table)
    const startWidth = Math.max(
      25,
      activeCell instanceof HTMLElement ? activeCell.getBoundingClientRect().width : 0,
      measuredWidths[resize.column] || 0
    )
    if (!startWidth) return

    clearResizeIntent()
    const intent = {
      cell,
      table,
      tableIndex,
      startX: event.clientX,
      startY: event.clientY,
      resize,
      widths: measuredWidths,
      startWidth,
      currentWidth: Math.round(startWidth),
      active: false,
      timer: 0,
      onMove: null,
      onMouseUp: null
    }
    intent.onMove = (moveEvent) => {
      if (intent.active) {
        // Keep the native hover state frozen while the pointer leaves the
        // original edge. The guide follows the previewed column boundary.
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
        const width = Math.max(25, Math.round(intent.startWidth + moveEvent.clientX - intent.startX))
        if (width === intent.currentWidth) return
        intent.currentWidth = width
        const currentTable = host.querySelectorAll('.milkdown-table-block')[intent.tableIndex]
          ?.querySelector('table.children')
        if (!currentTable) return
        intent.table = currentTable
        const widths = intent.widths.slice()
        widths[intent.resize.column] = width
        currentTable.dataset.hmColumnPreview = 'true'
        applyColumnGroupWidths(currentTable, widths)
        return
      }
      if (Math.abs(moveEvent.clientX - intent.startX) > resizeMoveTolerance ||
        Math.abs(moveEvent.clientY - intent.startY) > resizeMoveTolerance) {
        clearResizeIntent()
      }
    }
    intent.onMouseUp = (upEvent) => {
      const finished = clearResizeIntent()
      if (finished?.active) {
        upEvent.preventDefault()
        upEvent.stopPropagation()
        document.body.classList.remove('hm-table-resizing')
        finished.table.closest('.milkdown-table-block')?.classList.remove('hm-table-resizing')
        finished.table.dataset.hmColumnPreview = ''
        // The layout binding intercepts this boundary press before the editor's
        // normal pointer-intent listener sees it, so mark it explicitly before
        // dispatching the document transaction.
        markUserEdit()
        persistColumnWidth(view, finished.resize, finished.currentWidth)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          syncRenderedTableColumnWidths(host)
          schedule()
        }))
        return
      }
      schedule()
    }
    resizeIntent = intent
    intent.timer = window.setTimeout(() => {
      if (resizeIntent !== intent) return
      // The native plugin remains responsible for the visual edge decoration,
      // but it updates lazily on hover. Restoring its handle can make Crepe
      // replace the table node view, so reacquire the table by stable ordinal
      // afterwards instead of writing a preview to detached DOM.
      if (columnResizingPluginKey.getState(view.state)?.activeHandle !== resize.cellPos) {
        view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: resize.cellPos }))
      }
      const currentTable = host.querySelectorAll('.milkdown-table-block')[intent.tableIndex]
        ?.querySelector('table.children')
      if (!currentTable) return
      intent.table = currentTable
      currentTable.dataset.hmColumnPreview = 'true'
      applyColumnGroupWidths(currentTable, intent.widths)
      intent.active = true
      document.body.classList.add('hm-table-resizing')
      currentTable.closest('.milkdown-table-block')?.classList.add('hm-table-resizing')
    }, resizeHoldMs)
    window.addEventListener('mousemove', intent.onMove, true)
    window.addEventListener('mouseup', intent.onMouseUp, true)
    event.preventDefault()
    event.stopPropagation()
  }
  const observer = new MutationObserver(schedule)
  observer.observe(host, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-show', 'data-colwidth', 'colspan']
  })
  host.addEventListener('pointermove', onTablePointer, { passive: true })
  host.addEventListener('click', onTablePointer, true)
  host.addEventListener('mousedown', onColumnResizeMouseDown, true)
  host.addEventListener('scroll', schedule, true)
  document.addEventListener('selectionchange', schedule)
  window.addEventListener('resize', schedule)
  schedule()
  cleanups.push(() => {
    if (raf) cancelAnimationFrame(raf)
    const intent = clearResizeIntent()
    if (intent?.active) {
      document.body.classList.remove('hm-table-resizing')
      intent.table.closest('.milkdown-table-block')?.classList.remove('hm-table-resizing')
    }
    observer.disconnect()
    host.querySelectorAll('.hm-table-controls-open').forEach((block) => {
      block.classList.remove('hm-table-controls-open')
    })
    host.removeEventListener('pointermove', onTablePointer)
    host.removeEventListener('click', onTablePointer, true)
    host.removeEventListener('mousedown', onColumnResizeMouseDown, true)
    host.removeEventListener('scroll', schedule, true)
    document.removeEventListener('selectionchange', schedule)
    window.removeEventListener('resize', schedule)
  })
}

export function mountEditorLayoutBindings({ view, host, cleanups, markUserEdit, reportActiveBlock }) {
  const scrollEl = host.closest('.editor-scroll')
  mountSlashMenuBounds({ host, scrollEl, cleanups })
  mountTableHandleBounds({ view, host, scrollEl, cleanups, markUserEdit })

  const onBlankAreaMouseDown = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (event.target.closest?.('button, input, textarea, select, a')) return
    const nestedEditable = event.target.closest?.('[contenteditable="true"]')
    if (nestedEditable && nestedEditable !== view.dom) return
    const lastBlock = view.dom.lastElementChild
    const contentBottom = lastBlock?.getBoundingClientRect().bottom ?? view.dom.getBoundingClientRect().top
    if (event.clientY <= contentBottom + 1) return
    if (scrollEl) {
      const scrollRect = scrollEl.getBoundingClientRect()
      const scrollbarWidth = scrollEl.offsetWidth - scrollEl.clientWidth
      if (scrollbarWidth > 0 && event.clientX >= scrollRect.right - scrollbarWidth) return
    }

    event.preventDefault()
    view.dom.__horsemdLastPointerDown = { left: event.clientX, top: event.clientY, at: Date.now() }
    const { state } = view
    const paragraphType = state.schema.nodes.paragraph
    const trailingNode = state.doc.lastChild
    const hasTrailingEmptyParagraph = trailingNode?.type === paragraphType && trailingNode.content.size === 0
    let tr = state.tr
    if (paragraphType && !hasTrailingEmptyParagraph) {
      markUserEdit()
      tr = tr.insert(state.doc.content.size, paragraphType.create())
    }
    view.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView())
    view.focus()
    reportActiveBlock()
  }
  const blankAreaTarget = scrollEl || host
  blankAreaTarget.addEventListener('mousedown', onBlankAreaMouseDown)
  cleanups.push(() => blankAreaTarget.removeEventListener('mousedown', onBlankAreaMouseDown))

}
