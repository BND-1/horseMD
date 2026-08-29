import { exitCode } from '@milkdown/prose/commands'
import { TextSelection } from '@milkdown/prose/state'

const domContains = (container, candidate) => {
  if (!container || !candidate) return false
  if (container === candidate) return true
  try {
    return container.contains?.(candidate) === true
  } catch {
    return false
  }
}

const topLevelCodeBlockForDom = (view, blockDom) => {
  const doc = view?.state?.doc
  if (!doc || !blockDom) return null
  let mappedPosition = null
  try {
    const value = view.posAtDOM?.(blockDom, 0)
    if (Number.isFinite(value)) mappedPosition = value
  } catch {
    // Node views are not required to expose a DOM position. `nodeDOM` remains
    // the primary identity proof below.
  }

  let match = null
  doc.forEach((node, offset, index) => {
    if (match || node?.type?.name !== 'code_block' || node.content?.size <= 0) return
    let nodeDom = null
    try { nodeDom = view.nodeDOM?.(offset) || null } catch {}
    const sameNodeView =
      domContains(nodeDom, blockDom) ||
      domContains(blockDom, nodeDom)
    const mappedInsideNode = Number.isFinite(mappedPosition) &&
      mappedPosition >= offset &&
      mappedPosition <= offset + node.nodeSize
    if (!sameNodeView && !mappedInsideNode) return
    match = Object.freeze({ node, offset, index })
  })
  return match
}

/**
 * Convert the CodeMirror-owned Mod+Enter event into ProseMirror's official
 * `exitCode` command without exposing an EditorView test hook or inventing a
 * parallel document mutation.
 *
 * The command state uses an ephemeral selection at the end of the exact PM
 * code_block matched by its node-view DOM. The resulting transaction has the
 * same `before` document as the live view, so it can be dispatched as the one
 * document-changing transaction observed by SourceSyncTransactionJournal.
 */
export function exitCodeBlockFromDomEvent({ event, view } = {}) {
  if (!event || !view?.state?.doc || typeof view.dispatch !== 'function') return false
  const blockDom = event.target?.closest?.('.milkdown-code-block') || null
  if (!blockDom || !domContains(view.dom, blockDom)) return false

  const match = topLevelCodeBlockForDom(view, blockDom)
  if (!match) return false

  const codeEnd = match.offset + 1 + match.node.content.size
  let commandState
  try {
    commandState = view.state.apply(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, codeEnd))
    )
  } catch {
    return false
  }

  let transaction = null
  try {
    const applicable = exitCode(commandState, (next) => { transaction = next })
    if (!applicable || !transaction?.docChanged) return false
  } catch {
    return false
  }

  event.preventDefault?.()
  event.stopImmediatePropagation?.()
  try {
    view.dispatch(transaction.scrollIntoView())
    view.focus?.()
    return true
  } catch {
    return false
  }
}
