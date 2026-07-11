export const codeMirrorSelectionInfo = (view, selection) => {
  try {
    if (!view || !selection?.isCollapsed || !selection.anchorNode) return null
    const anchor = selection.anchorNode.nodeType === 1
      ? selection.anchorNode
      : selection.anchorNode.parentElement
    const cm = anchor?.closest?.('.cm-editor')
    const codeBlock = cm?.closest?.('.milkdown-code-block')
    if (!cm || !codeBlock || !view.dom.contains(codeBlock)) return null

    const doc = view.dom.ownerDocument
    const win = doc.defaultView
    const textOffsetIn = (container, target, targetOffset) => {
      const walker = doc.createTreeWalker(container, win.NodeFilter.SHOW_TEXT)
      let offset = 0
      let node
      while ((node = walker.nextNode())) {
        if (node === target) {
          return offset + Math.max(0, Math.min(targetOffset || 0, node.nodeValue.length))
        }
        offset += node.nodeValue.length
      }
      return offset
    }

    const lines = [...cm.querySelectorAll('.cm-content .cm-line')]
    let local = 0
    let found = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.contains(selection.anchorNode)) {
        local += textOffsetIn(line, selection.anchorNode, selection.anchorOffset)
        found = true
        break
      }
      local += line.textContent.length
      if (i < lines.length - 1) local += 1
    }
    if (!found) return null

    const blockPos = view.posAtDOM(codeBlock, 0)
    const codeNode = view.state.doc.nodeAt(blockPos)
    const maxLocal = codeNode?.isTextblock ? codeNode.content.size : local
    const safeLocal = Math.max(0, Math.min(local, maxLocal))
    return { blockPos, local: safeLocal, pmPos: blockPos + 1 + safeLocal }
  } catch {
    return null
  }
}
