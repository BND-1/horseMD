import { TextSelection } from '@milkdown/prose/state'

export function mountEditorInteractionBindings({
  view,
  viewRef,
  cleanups,
  markUserEdit,
  reportActiveBlock,
  refreshLevel,
  scheduleLevel,
  setBlock,
  setCtxMenu,
  setLevel
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
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    if (event.key >= '1' && event.key <= '6') {
      event.preventDefault()
      setBlock('h' + event.key)
    } else if (event.key === '0') {
      event.preventDefault()
      setBlock('paragraph')
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
    scheduleLevel()
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

  const onBlur = () => setLevel(null)
  const onFocus = () => refreshLevel()
  const onMove = () => scheduleLevel()
  view.dom.addEventListener('blur', onBlur)
  view.dom.addEventListener('focus', onFocus)
  view.dom.addEventListener('mousemove', onMove, { passive: true })
  document.addEventListener('selectionchange', onSelectionChange)
  cleanups.push(() => view.dom.removeEventListener('blur', onBlur))
  cleanups.push(() => view.dom.removeEventListener('focus', onFocus))
  cleanups.push(() => view.dom.removeEventListener('mousemove', onMove))
  cleanups.push(() => document.removeEventListener('selectionchange', onSelectionChange))

  return { updateHighlightActive }
}
