// Keep list items' `listType` consistent with their parent list (fuzz seed 60).
//
// Deleting across the end of a bullet list and the start of an ordered list
// joins them into ONE bullet_list whose later items still carry
// `listType: 'ordered'` (rendered with numbers). Markdown cannot spell a list
// that mixes both, so the saved file reopens as all bullets. Milkdown's
// syncListOrderPlugin only converts a bullet list whose FIRST item is ordered;
// this plugin resets the remaining mixed items to the parent's type, so the
// editor shows what the file will say.
//
// Milkdown's plugin also skips every batch with a non-generic transaction
// (a drop, a paste: `uiEvent` meta) or an addToHistory:false one. A block
// dropped / Tab-ed so that an ordered item led a bullet list then stayed
// that way: shown as `1.`, saved as `-` (fuzz UI seed 286). In those batches
// this plugin applies Milkdown's rule itself: the list becomes ordered.
//
// Items of an ORDERED list are always ordered. Milkdown means to do that but
// overwrites its `changed` flag with the label check, so an item whose label
// is already right keeps `listType: 'bullet'` (shown as a bullet, saved as
// `1.`; fuzz UI seed 403, after undo steps around list edits).
import { Plugin, PluginKey } from '@milkdown/prose/state'

const milkdownSyncRuns = (transactions) =>
  !transactions.some((transaction) => transaction.getMeta('addToHistory') === false || !transaction.isGeneric)

export function createListTypeSyncPlugin() {
  return new Plugin({
    key: new PluginKey('HORSEMD_LIST_TYPE_SYNC'),
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null
      const milkdownRuns = milkdownSyncRuns(transactions)
      const orderedList = newState.schema.nodes.ordered_list
      let tr = null
      newState.doc.descendants((node, pos) => {
        if (node.type.name === 'ordered_list') {
          const order = Number(node.attrs.order) || 1
          node.forEach((item, offset, index) => {
            if (item.type.name !== 'list_item' || item.attrs.listType === 'ordered') return
            tr = tr || newState.tr
            tr.setNodeMarkup(pos + 1 + offset, undefined, { ...item.attrs, listType: 'ordered', label: `${index + order}.` })
          })
          return true
        }
        if (node.type.name !== 'bullet_list') return true
        if (node.firstChild?.attrs?.listType === 'ordered') {
          // Milkdown converts the whole list when its first item is ordered.
          if (milkdownRuns || !orderedList) return true
          tr = tr || newState.tr
          tr.setNodeMarkup(pos, orderedList, { order: 1, spread: node.attrs.spread })
          node.forEach((item, offset, index) => {
            if (item.type.name !== 'list_item') return
            const attrs = { ...item.attrs, listType: 'ordered', label: `${index + 1}.` }
            if (attrs.listType !== item.attrs.listType || attrs.label !== item.attrs.label) tr.setNodeMarkup(pos + 1 + offset, undefined, attrs)
          })
          return true
        }
        node.forEach((item, offset) => {
          if (item.type.name !== 'list_item' || item.attrs.listType !== 'ordered') return
          tr = tr || newState.tr
          tr.setNodeMarkup(pos + 1 + offset, undefined, { ...item.attrs, listType: 'bullet' })
        })
        return true
      })
      return tr ? tr.setMeta('addToHistory', false) : null
    }
  })
}
