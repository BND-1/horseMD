// Multi-window tab transfer (tab tear-off), renderer side.
//
// A tab drag carries ONLY the custom type below (value: a drag key, see
// Tabs.jsx). Nothing goes into text/plain: an editor or textarea drop would
// type it into a document. Main owns the decision where a drag ended
// (tab:dragEnd reads the cursor); the renderer only reports the tab strip's
// screen rectangle and, in a target window, the insert index of a drop on
// its own strip (tab:dropIndex).
import { useEffect } from 'react'

export const TAB_DRAG_TYPE = 'application/x-horsemd-tab'

export const hasTabDrag = (event) => {
  const types = event?.dataTransfer?.types
  if (!types) return false
  try {
    return Array.from(types).includes(TAB_DRAG_TYPE)
  } catch {
    return false
  }
}

// The window's role, from the preload (`?hmWindow=secondary`). Mobile and
// older preloads have none: always the main window.
export const windowRole = () => (window.api?.windowRole === 'secondary' ? 'secondary' : 'main')

// The tab-bar band in SCREEN coordinates (DIP), extended 32 px below the bar,
// so a drag released on (or just under) the strip counts as "stayed here".
// CSS px → DIP: the page zoom is outerWidth / innerWidth for HorseMD's
// frameless windows (a framed window's borders add a few px; ignored).
export function tabStripScreenRect(el) {
  if (!el?.getBoundingClientRect) return null
  const r = el.getBoundingClientRect()
  let zoom = window.innerWidth > 0 && window.outerWidth > 0 ? window.outerWidth / window.innerWidth : 1
  if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5 || Math.abs(zoom - 1) < 0.02) zoom = 1
  const left0 = window.screenX + Math.max(0, (window.outerWidth - window.innerWidth * zoom) / 2)
  const top0 = window.screenY + Math.max(0, window.outerHeight - window.innerHeight * zoom - Math.max(0, (window.outerWidth - window.innerWidth * zoom) / 2))
  return {
    left: Math.round(left0 + r.left * zoom),
    top: Math.round(top0 + r.top * zoom),
    right: Math.round(left0 + r.right * zoom),
    bottom: Math.round(top0 + (r.bottom + 32) * zoom)
  }
}

// While a HorseMD tab is dragged over this window, the window accepts it
// everywhere (no "not allowed" cursor, no snap-back animation on macOS) but
// nothing below the tab strip sees it: the editor would show a drop cursor or
// insert text, the file tree would try to move a file. Capture phase on
// window, so this runs before ProseMirror / React handlers; the tab strip
// (.tabs) keeps its own handlers (reorder, insert marker, tab:dropIndex).
export function useTabDragGuard(enabled) {
  useEffect(() => {
    if (!enabled) return undefined
    const onDragOver = (event) => {
      if (!hasTabDrag(event)) return
      event.preventDefault()
      try { event.dataTransfer.dropEffect = 'move' } catch { /* read-only in some phases */ }
      if (event.target?.closest?.('.tabs')) return
      event.stopPropagation()
    }
    const onDrop = (event) => {
      if (!hasTabDrag(event)) return
      if (event.target?.closest?.('.tabs')) return
      // Main moves the tab here (cursor inside this window) from the source's
      // dragend; the drop itself inserts nothing.
      event.preventDefault()
      event.stopPropagation()
    }
    const onDragEnter = (event) => {
      if (!hasTabDrag(event) || event.target?.closest?.('.tabs')) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [enabled])
}

// The picture under the cursor while a tab is dragged (tear-off / merge /
// reorder): a small document card — file icon, name, folder — instead of the
// browser's translucent snapshot of the tab pill (user review 2026-11-15:
// "like dragging a file out"). Built in the DOM for the drag start only:
// Chromium snapshots it in setDragImage, then it is removed.
const FILE_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5'
export function setTabDragImage(dataTransfer, { title, folder, dirty }) {
  if (!dataTransfer?.setDragImage || typeof document === 'undefined') return
  const card = document.createElement('div')
  card.className = 'hm-tab-drag-card'
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('class', 'hm-tab-drag-icon')
  for (const seg of FILE_ICON.split(' M')) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', seg.startsWith('M') ? seg : 'M' + seg)
    icon.appendChild(path)
  }
  const text = document.createElement('div')
  text.className = 'hm-tab-drag-text'
  const name = document.createElement('div')
  name.className = 'hm-tab-drag-name'
  name.textContent = title || ''
  text.appendChild(name)
  if (folder) {
    const sub = document.createElement('div')
    sub.className = 'hm-tab-drag-folder'
    sub.textContent = folder
    text.appendChild(sub)
  }
  card.appendChild(icon)
  card.appendChild(text)
  if (dirty) {
    const dot = document.createElement('span')
    dot.className = 'hm-tab-drag-dot'
    card.appendChild(dot)
  }
  ;(document.querySelector('.app') || document.body).appendChild(card)
  try {
    // Grab point: a little inside the card's top-left, like picking up a file.
    dataTransfer.setDragImage(card, 22, 18)
  } catch { /* old engines */ }
  setTimeout(() => card.remove(), 0)
}
