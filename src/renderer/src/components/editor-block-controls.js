// Block-type controls shared by keyboard, context-menu, toolbar and status-bar
// actions.
//
//   viewRef        — ref to the ProseMirror EditorView
//   setCtxMenu     — setter used to close the block context menu after setBlock
//   onActiveBlock  — pushes the cursor's current block id up to the parent
//   lastBlockRef   — ref caching the last reported block id (dedupe)
// Returns { setBlock, reportActiveBlock }.
import { blockById, currentBlockId } from '../blocks.js'
import { convertBlock } from './editor-html.js'

export function createBlockControls({ viewRef, setCtxMenu, onActiveBlock, lastBlockRef }) {
  // Convert the block the cursor sits in to a given block id (paragraph/h1…h6).
  const setBlock = (id) => {
    const view = viewRef.current
    if (!view) return
    const def = blockById(id)
    if (!def) return
    convertBlock(view, def.name, def.level ? { level: def.level } : {})
    view.focus()
    reportActiveBlock()
    setCtxMenu(null)
  }

  // Push the cursor's current block type up to the parent (status bar).
  const reportActiveBlock = () => {
    const view = viewRef.current
    if (!view) return
    const id = currentBlockId(view.state)
    if (id !== lastBlockRef.current) {
      lastBlockRef.current = id
      onActiveBlock?.(id)
    }
  }

  return { setBlock, reportActiveBlock }
}
