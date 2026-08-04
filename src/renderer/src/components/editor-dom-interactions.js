import { TextSelection } from '@milkdown/prose/state'
import { keybindingMatchesEvent } from '../lib/commands/keybinding-normalize.js'
import { getEffectiveKeybindingMap } from '../lib/commands/keybinding-store.js'
import { isReadOnlyMutationKey } from './editor-read-only.js'
import { readMermaidCodeSource, refreshMermaidPreviewFromCodeBlock } from './editor-mermaid.js'

export function mountEditorInteractionBindings({
  view,
  viewRef,
  cleanups,
  markUserEdit,
  onRichEditPending,
  reportActiveBlock,
  setBlock,
  canConvertBlockToList,
  getListConversionContext,
  setCtxMenu,
  getKeybindings,
  getSelectionToolbarEnabled,
  onMarkdownInputIntent,
  isReadOnly
}) {
  const noteUserInteraction = () => {
    view.dom.__horsemdUserInteractionAt = performance.now()
  }

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

  // Markdown list input rules consume the space after a typed `-`, `*`, `+`,
  // or `1.`/`1)`. Capture the authored marker during keydown, while the literal
  // marker is still present in the ProseMirror text block. By `beforeinput` the
  // input rule may already have replaced the block with a list, which loses
  // both the user's marker choice and the raw position needed by source preservation.
  // Keep the beforeinput path below as a fallback for non-keyboard insertion
  // (IME/accessibility APIs), but physical typing must take this earlier path.
  const noteListInputRuleIntent = () => {
    const { selection } = view.state
    if (!selection.empty || !selection.$from.parent.isTextblock) return
    const prefix = selection.$from.parent.textBetween(0, selection.$from.parentOffset)
    const marker = prefix.match(/^([-+*]|\d{1,9}[.)])$/)?.[1]
    if (!marker) return
    onMarkdownInputIntent?.({
      type: /^\d/.test(marker) ? 'ordered-list' : 'bullet-list',
      marker
    })
  }

  const onKeydown = (event) => {
    noteUserInteraction()
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
    if (!event.ctrlKey && !event.metaKey && !event.altKey &&
      (event.key === ' ' || event.code === 'Space')) {
      noteListInputRuleIntent()
    }
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
    // The source+preview right pane is intentionally a viewer. Suppress the
    // app menu there so formatting, review and block operations cannot imply
    // that preview content is editable.
    if (isReadOnly?.()) {
      event.preventDefault()
      return
    }
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
    let listConversion = null
    let blockPos = null
    let blockListConvertible = false
    if (currentView) {
      const at = currentView.posAtCoords({ left: event.clientX, top: event.clientY })
      if (at) {
        blockPos = at.pos
        blockListConvertible = canConvertBlockToList?.(blockPos) === true
        // ProseMirror can report the outer list boundary for a click on an
        // indented item. Resolve the actual DOM list item as a fallback so the
        // context menu can explain why a nested conversion is unavailable.
        const positions = [at.pos]
        try {
          positions.push(currentView.posAtDOM(event.target, 0))
        } catch {
          /* the exact click target is not always a ProseMirror DOM node */
        }
        const listItem = event.target.closest?.('li')
        if (listItem) {
          try {
            positions.push(currentView.posAtDOM(listItem, 0) + 1)
          } catch {
            /* the node may have been refreshed by a table/list node view */
          }
        }
        for (const position of positions) {
          listConversion = getListConversionContext?.(currentView.state, position) || null
          if (listConversion) break
        }
        const domSelection = currentView.dom.ownerDocument.getSelection()
        let preservedTextSelection = false
        // ProseMirror normally syncs DOM selection changes immediately. A
        // context-menu event can race that sync on macOS/Windows, though. Read
        // the browser's selected range once here and commit it to editor state
        // before opening actions that depend on it.
        if (domSelection && !domSelection.isCollapsed &&
          currentView.dom.contains(domSelection.anchorNode) &&
          currentView.dom.contains(domSelection.focusNode)) {
          try {
            const anchor = currentView.posAtDOM(domSelection.anchorNode, domSelection.anchorOffset)
            const head = currentView.posAtDOM(domSelection.focusNode, domSelection.focusOffset)
            currentView.dispatch(currentView.state.tr.setSelection(
              TextSelection.create(currentView.state.doc, anchor, head)
            ))
            preservedTextSelection = true
          } catch {
            // Fall back to the clicked caret position below for node-view DOM.
          }
        }
        // Right-clicking selected text must keep that range selected. Besides
        // matching native editor behavior, it makes the fallback formatting
        // menu usable when the floating selection toolbar is disabled.
        if (!preservedTextSelection) {
          const $pos = currentView.state.doc.resolve(at.pos)
          currentView.dispatch(currentView.state.tr.setSelection(TextSelection.near($pos)))
        }
        reportActiveBlock()
        const activeSelection = currentView.state.selection
        const showTextFormatting = getSelectionToolbarEnabled?.() === false && !activeSelection.empty
        setCtxMenu({
          x: event.clientX,
          y: event.clientY,
          listConversion,
          blockPos,
          blockListConvertible,
          showTextFormatting,
          selection: showTextFormatting
            ? { anchor: activeSelection.anchor, head: activeSelection.head }
            : null
        })
      } else {
        setCtxMenu({ x: event.clientX, y: event.clientY, listConversion, blockPos, blockListConvertible, showTextFormatting: false, selection: null })
      }
    } else {
      setCtxMenu({ x: event.clientX, y: event.clientY, listConversion, blockPos, blockListConvertible, showTextFormatting: false, selection: null })
    }
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
  const onUserEditIntent = (event) => {
    noteUserInteraction()
    markUserEdit()
    // Milkdown only publishes source-preserving Markdown after its built-in
    // 200ms debounce. `input` is already a real committed DOM mutation, so the
    // app can safely show its unsaved indicator now without serializing on
    // every keystroke. Paste/cut/drop can mutate without an input event on
    // some platforms, so they get the same visual hint.
    if (event.type === 'input' || event.type === 'paste' || event.type === 'cut' || event.type === 'drop') {
      onRichEditPending?.()
    }
    if (
      event.type === 'beforeinput' &&
      event.inputType === 'insertText' &&
      event.data === ' '
    ) {
      noteListInputRuleIntent()
    }
  }
  const onMermaidCodeInput = (event) => {
    const code = event.target.closest?.('.milkdown-code-block .cm-content')
    const block = code?.closest('.milkdown-code-block')
    if (block) refreshMermaidPreviewFromCodeBlock(block, readMermaidCodeSource(code, view))
  }
  const onReadOnlyInput = (event) => {
    if (!isReadOnly?.()) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onPointerDown = (event) => {
    view.dom.__horsemdLastPointerDown = { left: event.clientX, top: event.clientY, at: Date.now() }
    noteUserInteraction()
    // Preview-side pointer interactions may select/copy or establish scroll
    // ownership, but they are not edits and must never produce a dirty state.
    if (!isReadOnly?.()) markUserEdit()
  }

  view.dom.addEventListener('keydown', onKeydown, true)
  view.dom.addEventListener('beforeinput', onReadOnlyInput, true)
  view.dom.addEventListener('paste', onReadOnlyInput, true)
  view.dom.addEventListener('drop', onReadOnlyInput, true)
  view.dom.addEventListener('cut', onReadOnlyInput, true)
  view.dom.addEventListener('beforeinput', onUserEditIntent, true)
  view.dom.addEventListener('input', onUserEditIntent, true)
  view.dom.addEventListener('input', onMermaidCodeInput, true)
  view.dom.addEventListener('paste', onUserEditIntent, true)
  view.dom.addEventListener('drop', onUserEditIntent, true)
  view.dom.addEventListener('cut', onUserEditIntent, true)
  view.dom.addEventListener('compositionend', onUserEditIntent, true)
  // Crepe's task-list label toggles on pointerdown and prevents the compatible
  // mousedown event. Capture pointerdown at the editor root so that checkbox
  // attribute transactions enter the same markdownUpdated/save path as typing.
  view.dom.addEventListener('pointerdown', onPointerDown, true)
  view.dom.addEventListener('mousedown', onPointerDown, true)
  view.dom.addEventListener('contextmenu', onContextMenu)
  cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown, true))
  cleanups.push(() => view.dom.removeEventListener('beforeinput', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('cut', onReadOnlyInput, true))
  cleanups.push(() => view.dom.removeEventListener('beforeinput', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('input', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('input', onMermaidCodeInput, true))
  cleanups.push(() => view.dom.removeEventListener('paste', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('drop', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('cut', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('compositionend', onUserEditIntent, true))
  cleanups.push(() => view.dom.removeEventListener('pointerdown', onPointerDown, true))
  cleanups.push(() => view.dom.removeEventListener('mousedown', onPointerDown, true))
  cleanups.push(() => view.dom.removeEventListener('contextmenu', onContextMenu))

  document.addEventListener('selectionchange', onSelectionChange)
  cleanups.push(() => document.removeEventListener('selectionchange', onSelectionChange))

  return { updateHighlightActive }
}
