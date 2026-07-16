import { TextSelection } from '@milkdown/prose/state'
import { keybindingMatchesEvent } from '../lib/commands/keybinding-normalize.js'
import { getEffectiveKeybindingMap } from '../lib/commands/keybinding-store.js'

export function mountEditorInteractionBindings({
  view,
  viewRef,
  cleanups,
  markUserEdit,
  reportActiveBlock,
  setBlock,
  setCtxMenu,
  getKeybindings
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
  }
  const onSelectionChange = () => {
    const currentView = viewRef.current
    if (!currentView || !currentView.hasFocus()) return
    reportActiveBlock()
    updateHighlightActive()
  }
  const onUserEditIntent = () => markUserEdit()
  const onPointerDown = (event) => {
    view.dom.__horsemdLastPointerDown = { left: event.clientX, top: event.clientY, at: Date.now() }
    markUserEdit()
  }

  view.dom.addEventListener('keydown', onKeydown)
  view.dom.addEventListener('beforeinput', onUserEditIntent, true)
  view.dom.addEventListener('input', onUserEditIntent, true)
  view.dom.addEventListener('paste', onUserEditIntent, true)
  view.dom.addEventListener('drop', onUserEditIntent, true)
  view.dom.addEventListener('cut', onUserEditIntent, true)
  view.dom.addEventListener('compositionend', onUserEditIntent, true)
  view.dom.addEventListener('mousedown', onPointerDown, true)
  view.dom.addEventListener('contextmenu', onContextMenu)
  cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown))
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
