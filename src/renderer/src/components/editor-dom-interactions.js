import { TextSelection } from '@milkdown/prose/state'
import { keybindingMatchesEvent } from '../lib/commands/keybinding-normalize.js'
import { getEffectiveKeybindingMap } from '../lib/commands/keybinding-store.js'
import { isReadOnlyMutationKey } from './editor-read-only.js'

export function mountEditorInteractionBindings({
  view,
  viewRef,
  cleanups,
  markUserEdit,
  reportActiveBlock,
  setBlock,
  setCtxMenu,
  getKeybindings,
  isReadOnly
}) {
  const updateHighlightActive = () => {
    const currentView = viewRef.current
    let active = false
    if (currentView && currentView.hasFocus()) {
      const { from, $from, empty, to } = currentView.state.selection
      const type = currentView.state.schema.marks.highlight
      if (type) {
        active = empty
          ? ($from.storedMarks || []).some((mark) => mark.type === type)
          : currentView.state.doc.rangeHasMark(from, to, type)
      }
    }
    document.querySelectorAll('.milkdown-toolbar .hm-highlight-item')
      .forEach((button) => button.classList.toggle('active', active))
  }

  const onKeydown = (event) => {
    if (isReadOnly?.()) {
      // Keep navigation, selection and copy available. Everything else that can
      // write (including CodeMirror's independent key handler) is stopped at
      // the ProseMirror root during capture.
      if (isReadOnlyMutationKey(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    markUserEdit()
    const keybindings = getKeybindings?.() || getEffectiveKeybindingMap()
    const platform = window.api?.platform || (navigator.platform?.toLowerCase().includes('mac') ? 'darwin' : 'win32')
    if (keybindingMatchesEvent(keybindings['editor.block.paragraph']?.[0], event, platform)) {
      event.preventDefault()
      setBlock('paragraph')
      return
    }
    for (let level = 1; level <= 6; level += 1) {
      if (keybindingMatchesEvent(keybindings[`editor.block.h${level}`]?.[0], event, platform)) {
        event.preventDefault()
        setBlock('h' + level)
        return
      }
    }
  }
  const onContextMenu = (event) => {
    if (window.api?.platform === 'ios' || window.api?.platform === 'android') return
    // A selection update can make Crepe refresh a table node view. Its internal
    // horizontal scroller is not part of ProseMirror state, so preserve it
    // explicitly before opening the context menu on a far-right column handle.
    const tableBlock = event.target.closest?.('.milkdown-table-block')
    const tableWrapper = tableBlock?.querySelector('.table-wrapper')
    const scrollLeft = tableWrapper?.scrollLeft
    // Selecting a column can replace the whole Crepe table node view. Keep its
    // stable ordinal under this editor root, rather than restoring a detached
    // wrapper from the old node view.
    const tableIndex = tableBlock
      ? [...view.dom.querySelectorAll('.milkdown-table-block')].indexOf(tableBlock)
      : -1
    const restoreTableScroll = () => {
      if (!Number.isFinite(scrollLeft)) return
      const currentDom = viewRef.current?.dom || view.dom
      const nextBlock = tableIndex >= 0
        ? currentDom.querySelectorAll('.milkdown-table-block')[tableIndex]
        : tableBlock
      const nextWrapper = nextBlock?.querySelector('.table-wrapper')
      if (nextWrapper) nextWrapper.scrollLeft = scrollLeft
    }
    event.preventDefault()
    const currentView = viewRef.current
    if (currentView) {
      const at = currentView.posAtCoords({ left: event.clientX, top: event.clientY })
      if (at) {
        const $pos = currentView.state.doc.resolve(at.pos)
        currentView.dispatch(currentView.state.tr.setSelection(TextSelection.near($pos)))
        reportActiveBlock()
      }
    }
    setCtxMenu({ x: event.clientX, y: event.clientY })
    // The view update and its node-view DOM work can span two animation frames.
    // Restore twice rather than using a fixed timeout, and only for the table
    // that received this context menu.
    requestAnimationFrame(() => {
      restoreTableScroll()
      requestAnimationFrame(() => {
        restoreTableScroll()
        requestAnimationFrame(restoreTableScroll)
      })
    })
  }
  const onSelectionChange = () => {
    const currentView = viewRef.current
    if (!currentView || !currentView.hasFocus()) return
    reportActiveBlock()
    updateHighlightActive()
  }
  const onUserEditIntent = () => markUserEdit()
  const onReadOnlyInput = (event) => {
    if (!isReadOnly?.()) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onPointerDown = (event) => {
    view.dom.__horsemdLastPointerDown = { left: event.clientX, top: event.clientY, at: Date.now() }
    markUserEdit()
  }

  view.dom.addEventListener('keydown', onKeydown, true)
  view.dom.addEventListener('beforeinput', onReadOnlyInput, true)
  view.dom.addEventListener('paste', onReadOnlyInput, true)
  view.dom.addEventListener('drop', onReadOnlyInput, true)
  view.dom.addEventListener('cut', onReadOnlyInput, true)
  view.dom.addEventListener('beforeinput', onUserEditIntent, true)
  view.dom.addEventListener('input', onUserEditIntent, true)
  view.dom.addEventListener('paste', onUserEditIntent, true)
  view.dom.addEventListener('drop', onUserEditIntent, true)
  view.dom.addEventListener('cut', onUserEditIntent, true)
  view.dom.addEventListener('compositionend', onUserEditIntent, true)
  view.dom.addEventListener('mousedown', onPointerDown, true)
  view.dom.addEventListener('contextmenu', onContextMenu)
  cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown, true))
  cleanups.push(() => view.dom.removeEventListener('beforeinput', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('cut', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('beforeinput', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('input', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('cut', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('compositionend', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('mousedown', onPointerDown, true))
  cleanups.push(() => view.dom.removeEventListener('contextmenu', onContextMenu))

  document.addEventListener('selectionchange', onSelectionChange)
  cleanups.push(() => document.removeEventListener('selectionchange', onSelectionChange))

  return { updateHighlightActive }
}
