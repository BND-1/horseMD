// Keep list items' `listType` consistent with their parent list (fuzz seed 60).
//
// Deleting across the end of a bullet list and the start of an ordered list
// joins them into ONE bullet_list whose later items still carry
// `listType: 'ordered'` (rendered with numbers). Markdown cannot spell a list
// that mixes both, so the saved file reopens as all bullets. Milkdown's
// syncListOrderPlugin only converts a bullet list whose FIRST item is ordered;
// this plugin resets the remaining mixed items to the parent's type, so the
// editor shows what the file will say.
import { Plugin, PluginKey } from '@milkdown/prose/state'

export function createListTypeSyncPlugin() {
  return new Plugin({
    key: new PluginKey('HORSEMD_LIST_TYPE_SYNC'),
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null
      let tr = null
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== 'bullet_list') return true
        // Milkdown converts the whole list when its first item is ordered.
        if (node.firstChild?.attrs?.listType === 'ordered') return true
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
