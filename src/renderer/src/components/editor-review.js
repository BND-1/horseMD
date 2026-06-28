import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import { REVIEW_KINDS, scanReviewMarkup, wrapReviewSelection } from '../reviewMarkup.js'

export { REVIEW_KINDS }

const REVIEW_PLUGIN_KEY = new PluginKey('hm-review-markup')

const REVIEW_CLASS_BY_KIND = {
  [REVIEW_KINDS.addition]: 'hm-review-mark hm-review-add',
  [REVIEW_KINDS.deletion]: 'hm-review-mark hm-review-del',
  [REVIEW_KINDS.substitution]: 'hm-review-mark hm-review-sub',
  [REVIEW_KINDS.comment]: 'hm-review-mark hm-review-comment',
  [REVIEW_KINDS.highlight]: 'hm-review-mark hm-review-highlight'
}

export function createReviewDecorationPlugin() {
  return new Plugin({
    key: REVIEW_PLUGIN_KEY,
    props: {
      decorations(state) {
        const decorations = []

        state.doc.descendants((node, pos) => {
          if (!node.isText || !node.text) return true

          for (const match of scanReviewMarkup(node.text)) {
            const className = REVIEW_CLASS_BY_KIND[match.kind]
            if (!className || match.end <= match.start) continue
            decorations.push(
              Decoration.inline(pos + match.start, pos + match.end, {
                class: className
              })
            )
          }

          return true
        })

        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
}

export function applyReviewMarkupInView(view, kind) {
  if (!view) return { ok: false, reason: 'no-view' }

  const { from, to } = view.state.selection
  const selected = view.state.doc.textBetween(from, to, '\n')
  const result = wrapReviewSelection(selected, 0, selected.length, kind)
  if (result.error) return { ok: false, reason: result.error }

  let tr = view.state.tr.insertText(result.text, from, to)
  tr = tr.setSelection(
    TextSelection.create(
      tr.doc,
      from + result.selectionStart,
      from + result.selectionEnd
    )
  )
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return { ok: true }
}
