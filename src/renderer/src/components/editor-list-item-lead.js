// A list item that starts with an empty paragraph followed by a paragraph has
// no Markdown: `-` + a next line reads back as one paragraph on the marker
// line. Milkdown's schema puts that empty paragraph before an item whose
// content starts with a list (`- 2. x` is a bullet holding an ordered item);
// Backspace at the start of `x` lifts the ordered item into a paragraph and
// left the empty one above it — an empty line in the editor that no reopen
// gives back, and a source written `-` + `  x` (Typora: `- x`). The empty
// paragraph is removed after every transaction that touches such an item, so
// the editor shows what the file says. An empty paragraph before a nested
// list stays: the schema requires the item to start with a paragraph.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { touchedBlocks } from './editor-one-line-blocks.js'

const key = new PluginKey('hm-list-item-lead')

export function listItemLeadPlugin() {
  return new Plugin({
    key,
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const paragraph = state.schema.nodes.paragraph
      const leads = []
      for (const [from, to] of touchedBlocks(transactions, state.doc)) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== 'list_item' || node.childCount < 2) return true
          const first = node.child(0)
          const second = node.child(1)
          if (first.type === paragraph && first.content.size === 0 && second.type === paragraph) leads.push(pos + 1)
          return true
        })
      }
      if (!leads.length) return null
      const tr = state.tr
      for (const pos of [...new Set(leads)].sort((a, b) => b - a)) {
        const node = tr.doc.nodeAt(pos)
        if (node?.type === paragraph && node.content.size === 0) tr.delete(pos, pos + node.nodeSize)
      }
      return tr.docChanged ? tr : null
    }
  })
}
