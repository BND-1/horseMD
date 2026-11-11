// Large documents skip layout for off-screen top-level blocks
// (`content-visibility: auto`, `.editor-scroll.hm-cv` in app.css). The block
// holding the caret must stay laid out: Chromium cannot place an insertion
// in a block it has not laid out — with the caret after an inline atom at
// the end of a paragraph (an `<img>` html node), typed text went to the
// START of the paragraph when the caret had been set there without
// scrolling (restored on a mode switch, set by a command). This plugin marks
// that one block `hm-cv-keep`, which the content-visibility rule excludes.
//
// Only a collapsed caret moves the mark; a range selection keeps the last
// one (mapped through edits). A selected block is laid out by Chromium
// anyway, and ProseMirror rewrites the DOM selection when a decoration
// changes between two range selections in different blocks (Chromium
// `forceSelUpdate`): a copy of a selected `<strong>` lost its markup, and a
// drag across blocks would be re-set under the pointer.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const key = new PluginKey('hm-cv-keep')

const blockAt = (doc, pos) => {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  if ($pos.depth < 1) {
    // Between two top-level blocks (a node selection or a gap cursor).
    const node = doc.nodeAt($pos.pos)
    return node ? { from: $pos.pos, to: $pos.pos + node.nodeSize } : null
  }
  const from = $pos.before(1)
  return { from, to: from + $pos.node(1).nodeSize }
}

const same = (a, b) => a === b || Boolean(a && b && a.from === b.from && a.to === b.to)

export function cvKeepPlugin() {
  return new Plugin({
    key,
    state: {
      init: (_config, state) => blockAt(state.doc, state.selection.head),
      apply: (tr, previous, _oldState, state) => {
        if (!tr.docChanged && !tr.selectionSet) return previous
        let next
        if (state.selection.empty || !previous) next = blockAt(state.doc, state.selection.head)
        else next = tr.docChanged ? blockAt(state.doc, tr.mapping.map(previous.from, 1)) : previous
        return same(previous, next) ? previous : next
      }
    },
    props: {
      decorations(state) {
        const block = key.getState(state)
        if (!block) return DecorationSet.empty
        return DecorationSet.create(state.doc, [Decoration.node(block.from, block.to, { class: 'hm-cv-keep' })])
      }
    }
  })
}
