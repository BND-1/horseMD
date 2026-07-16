import { TextSelection } from '@milkdown/prose/state'

const clamp = (value, min, max) => {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
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

const mountTableHandleBounds = ({ host, scrollEl, cleanups }) => {
  if (!scrollEl) return
  const margin = 8
  let raf = 0

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
  const observer = new MutationObserver(schedule)
  observer.observe(host, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-show']
  })
  host.addEventListener('pointermove', onTablePointer, { passive: true })
  host.addEventListener('click', onTablePointer, true)
  host.addEventListener('scroll', schedule, true)
  document.addEventListener('selectionchange', schedule)
  window.addEventListener('resize', schedule)
  schedule()
  cleanups.push(() => {
    if (raf) cancelAnimationFrame(raf)
    observer.disconnect()
    host.querySelectorAll('.hm-table-controls-open').forEach((block) => {
      block.classList.remove('hm-table-controls-open')
    })
    host.removeEventListener('pointermove', onTablePointer)
    host.removeEventListener('click', onTablePointer, true)
    host.removeEventListener('scroll', schedule, true)
    document.removeEventListener('selectionchange', schedule)
    window.removeEventListener('resize', schedule)
  })
}

export function mountEditorLayoutBindings({ view, host, cleanups, markUserEdit, reportActiveBlock }) {
  const scrollEl = host.closest('.editor-scroll')
  mountSlashMenuBounds({ host, scrollEl, cleanups })
  mountTableHandleBounds({ host, scrollEl, cleanups })

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
