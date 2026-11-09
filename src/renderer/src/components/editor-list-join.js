// Two lists of the same kind that an edit puts directly next to each other
// join (Typora parity). In Markdown they are one list: `1. a` + `1. b` reads
// back as items 1 and 2, `- a` + `- b` as one list. The editor kept them
// apart — ProseMirror's input rules join a typed list only with the list
// before it, and only an ordered one whose number continues — so typing
// `1. ` on the line after a list showed a new list starting at 1, and the
// file said item 3 (reopen showed it). Written apart (`1)`), the user saw
// a delimiter they never typed (user report, test-repeated-ordered-list-
// middle-ui). Joined, the editor shows what the file says.
//
// Whether two lists are one is what the file says, not a guess: the edit is
// printed against the current source (`readsAsOne`, the reprint engine) and
// only the pairs that print as one list join — same marker (`1.` typed after
// `1.`, the paragraph between two `-` lists deleted). Different markers
// (`+ a` + `- b`, `- ` typed next to a `*` list) are two lists in Markdown
// and in Typora: they stay two. Only an adjacency the transactions made;
// never for programmatic replacements (source mode, an external reload,
// chunked loading): there the source already holds them as it means them.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Mapping, canJoin } from '@milkdown/prose/transform'
import { touchedBlocks } from './editor-one-line-blocks.js'

const key = new PluginKey('hm-list-join')
const isList = (node) => node?.type?.name === 'bullet_list' || node?.type?.name === 'ordered_list'
const adjacentAt = (doc, pos) => {
  if (pos <= 0 || pos >= doc.content.size) return false
  let $pos
  try { $pos = doc.resolve(pos) } catch { return false }
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter
  return isList(before) && before.type === after?.type
}

// Boundaries between two same-kind sibling lists inside [from, to].
const boundariesIn = (doc, from, to) => {
  const found = []
  const scan = (container, contentStart) => {
    let previous = null
    container.forEach((child, offset) => {
      const at = contentStart + offset
      if (previous && isList(child) && previous.type === child.type && at >= from && at <= to) found.push(at)
      previous = child
      if (!child.isTextblock && !child.isLeaf && at + child.nodeSize >= from && at <= to) scan(child, at + 1)
    })
  }
  scan(doc, 0)
  return found
}

export function listJoinPlugin({ isProgrammaticChange = () => false, readsAsOne = () => new Set() } = {}) {
  return new Plugin({
    key,
    appendTransaction(transactions, oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      if (transactions.some((tr) => tr.getMeta('addToHistory') === false || tr.getMeta('hm-programmatic') || tr.getMeta(key))) return null
      if (isProgrammaticChange()) return null
      const boundaries = new Set()
      for (const [from, to] of touchedBlocks(transactions, state.doc)) {
        for (const at of boundariesIn(state.doc, from, to)) boundaries.add(at)
      }
      if (!boundaries.size) return null
      const mapping = new Mapping()
      for (const tr of transactions) mapping.appendMapping(tr.mapping)
      const back = mapping.invert()
      // A list whose type was just converted (ordered → bullet, a task list
      // → bullet…) stays the list it was: the user changed its kind, not
      // where it ends. It is written apart from its neighbour (list-
      // boundaries.js), as before the join existed (test:list-conversion-ui:
      // a task list then an ordered list turned bullet). Typed lists and
      // lists brought together by a deletion still join.
      const converted = (at) => {
        const $at = state.doc.resolve(at)
        const sides = [[at - $at.nodeBefore.nodeSize, $at.nodeBefore], [at, $at.nodeAfter]]
        return sides.some(([pos, node]) => {
          const old = oldState.doc.nodeAt(back.map(pos, 1))
          return isList(old) && old.type !== node.type
        })
      }
      const fresh = [...boundaries].filter((at) => !adjacentAt(oldState.doc, back.map(at, -1)) && !adjacentAt(oldState.doc, back.map(at, 1)) && !converted(at))
      if (!fresh.length) return null
      let one
      try { one = readsAsOne(state.doc) } catch { one = null }
      if (!one?.size) return null
      const tr = state.tr
      // Bottom-up: a join shifts only what follows it.
      for (const at of fresh.sort((a, b) => b - a)) {
        if (!one.has(state.doc.resolve(at).nodeAfter)) continue
        if (adjacentAt(tr.doc, at) && canJoin(tr.doc, at)) tr.join(at)
      }
      return tr.docChanged ? tr.setMeta(key, true) : null
    }
  })
}
