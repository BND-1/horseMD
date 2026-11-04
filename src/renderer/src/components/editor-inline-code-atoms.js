// Inline code holds text only. Markdown has no spelling for an image or a
// formula inside a code span, and Milkdown's serializer replaced such a node
// with an empty code span — selecting text around an image and pressing the
// inline-code shortcut lost the image on save (combination test). The mark
// is taken off every non-text inline node it lands on; the text around keeps
// it. A raw ProseMirror plugin (prosePluginsCtx).
import { Plugin } from '@milkdown/prose/state'

// Remove inline code from non-text inline nodes in [from, to). Returns
// whether anything changed. Pure enough for the test harness.
export function stripCodeFromAtoms(tr, from = 0, to = tr.doc.content.size) {
  const code = Object.values(tr.doc.type.schema.marks).find((type) => type.spec.code)
  if (!code) return false
  let changed = false
  tr.doc.nodesBetween(Math.max(0, from), Math.min(tr.doc.content.size, to), (node, pos) => {
    if (node.isInline && !node.isText && code.isInSet(node.marks)) {
      tr.removeMark(pos, pos + node.nodeSize, code)
      changed = true
    }
    return true
  })
  return changed
}

export function inlineCodeAtomsPlugin() {
  return new Plugin({
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      // Ranges the transactions touched, mapped to the final document.
      let from = Infinity
      let to = -Infinity
      for (const tr of transactions) {
        tr.mapping.maps.forEach((map, index) => {
          map.forEach((_a, _b, start, end) => {
            const rest = tr.mapping.slice(index + 1)
            from = Math.min(from, rest.map(start, -1))
            to = Math.max(to, rest.map(end, 1))
          })
        })
        for (const step of tr.steps) {
          if (step.mark && step.from != null) { from = Math.min(from, step.from); to = Math.max(to, step.to) }
        }
      }
      if (!(to > from)) return null
      const tr = state.tr
      return stripCodeFromAtoms(tr, from, to) ? tr : null
    }
  })
}
