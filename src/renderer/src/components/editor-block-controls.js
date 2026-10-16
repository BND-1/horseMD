// Block-type controls shared by keyboard, context-menu, toolbar and status-bar
// actions.
//
//   viewRef        — ref to the ProseMirror EditorView
//   setCtxMenu     — setter used to close the block context menu after setBlock
//   onActiveBlock  — pushes the cursor's current block id up to the parent
//   lastBlockRef   — ref caching the last reported block id (dedupe)
// Returns block conversion commands plus reportActiveBlock.
import { blockById, currentBlockId } from '../blocks.js'
import { wrapIn } from '@milkdown/prose/commands'
import { TextSelection } from '@milkdown/prose/state'
import { convertBlock } from './editor-html.js'

export function createBlockControls({ viewRef, setCtxMenu, onActiveBlock, lastBlockRef }) {
  // Convert the block the cursor sits in to a given block id (paragraph/h1…h6).
  const setBlock = (id, blockPos = null) => {
    const view = viewRef.current
    if (!view) return false
    const def = blockById(id)
    if (!def) return false
    const changed = convertBlock(
      view,
      def.name,
      def.level ? { level: def.level } : {},
      blockPos
    )
    view.focus()
    reportActiveBlock()
    setCtxMenu(null)
    return changed === true
  }

  const canConvertCurrentBlockToList = (blockPos) => {
    const state = viewRef.current?.state
    if (!state || !Number.isFinite(blockPos)) return false
    const safePos = Math.max(0, Math.min(blockPos, state.doc.content.size))
    const $pos = state.doc.resolve(safePos)
    let hasParagraph = false
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const typeName = $pos.node(depth).type.name
      if (typeName === 'list_item' || typeName === 'table' || typeName === 'code_block') return false
      if (typeName === 'paragraph') hasParagraph = true
    }
    return hasParagraph
  }

  // Wrap a normal text block in the requested list structure. Task lists use
  // Milkdown's regular bullet-list container with a checked list-item attr.
  // This keeps the schema and Markdown serializer on their supported path.
  const convertCurrentBlockToList = (targetType, blockPos) => {
    const view = viewRef.current
    let state = view?.state
    if (!canConvertCurrentBlockToList(blockPos)) return false
    if (state && Number.isFinite(blockPos)) {
      const safePos = Math.max(0, Math.min(blockPos, state.doc.content.size))
      state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(safePos))))
    }
    const listType = state?.schema.nodes[targetType === 'task_list' ? 'bullet_list' : targetType]
    if (!listType || !['bullet_list', 'ordered_list', 'task_list'].includes(targetType)) return false

    let transaction = null
    if (!wrapIn(listType)(state, (tr) => { transaction = tr }) || !transaction) return false

    if (targetType === 'task_list') {
      const $from = transaction.selection.$from
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name !== 'list_item') continue
        const pos = $from.before(depth)
        const item = transaction.doc.nodeAt(pos)
        if (item) transaction.setNodeMarkup(pos, item.type, { ...item.attrs, checked: false }, item.marks)
        break
      }
    }

    view.dispatch(transaction)
    view.focus()
    reportActiveBlock()
    setCtxMenu(null)
    return true
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

  return { setBlock, canConvertCurrentBlockToList, convertCurrentBlockToList, reportActiveBlock }
}
