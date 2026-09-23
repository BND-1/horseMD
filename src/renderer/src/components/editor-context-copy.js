import { TextSelection } from '@milkdown/prose/state'
import { EditorView as CodeMirrorView } from '@codemirror/view'

// Capture ownership before a menu takes focus. Never serialize the entire
// document or read virtualized .cm-line DOM as the selected code's contents.
// The normal copy event retains HorseMD's text/plain + text/html +
// text/markdown contract (and CodeMirror's own partial-copy handling).
export function captureEditorContextCopy(view, target, {
  findCodeMirror = element => CodeMirrorView.findFromDOM(element),
  executeCopy = document => document.execCommand('copy')
} = {}) {
  if (!view?.dom?.isConnected || view.isDestroyed) return null
  const document = view.dom.ownerDocument
  const snapshot = view.state.doc
  const owned = () => !view.isDestroyed && view.dom.isConnected && view.state.doc === snapshot
  const perform = () => {
    try { return executeCopy(document) === true } catch { return false }
  }
  const codeRoot = target?.closest?.('.cm-editor')
  if (codeRoot && view.dom.contains(codeRoot)) {
    let codeView
    try { codeView = findCodeMirror(codeRoot) } catch { return null }
    const codeSelection = codeView?.state.selection
    if (!codeSelection?.ranges.some(range => !range.empty)) return null
    const codeDocument = codeView.state.doc
    return Object.freeze({
      kind: 'code',
      copy() {
        if (!owned() || !codeRoot.isConnected || codeView.state.doc !== codeDocument) return false
        try {
          codeView.dispatch({ selection: codeSelection })
          codeView.focus()
          return perform()
        } catch { return false }
      }
    })
  }

  const browserSelection = document.getSelection()
  let selection = view.state.selection
  if (browserSelection && !browserSelection.isCollapsed) {
    // A selection in a different mounted tab must never be copied by this menu.
    if (!view.dom.contains(browserSelection.anchorNode) ||
        !view.dom.contains(browserSelection.focusNode)) return null
    try {
      selection = TextSelection.create(snapshot,
        view.posAtDOM(browserSelection.anchorNode, browserSelection.anchorOffset),
        view.posAtDOM(browserSelection.focusNode, browserSelection.focusOffset))
    } catch { return null }
  }
  if (selection.empty) return null
  return Object.freeze({
    kind: 'rich',
    copy() {
      if (!owned()) return false
      try {
        view.dispatch(view.state.tr.setSelection(selection))
        view.focus()
        return perform()
      } catch { return false }
    }
  })
}
