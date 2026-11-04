// A raw newline inside a paragraph / heading's text has no Markdown spelling:
// it reads back as a line break, so the sync paused. ProseMirror converts
// newlines for setBlockType (the hardbreak is the schema's
// linebreakReplacement, editor-crepe-setup.js), but other steps carry code
// text into a text block too — Backspace / Delete joining a paragraph with a
// code or `$$` block (fuzz FORMAT seed 18). Any `\n` in the text of a
// non-code text block becomes a SOFT line break (a source newline):
// editor-one-line-blocks.js then splits a heading there and turns a cell's
// into `<br>`, as for pasted lines. (A heading's HARD break is `<br>` in
// Markdown and stays — an authored `### a<br>b`.) A raw ProseMirror plugin
// (prosePluginsCtx).
import { Plugin } from '@milkdown/prose/state'

export function textblockNewlinesPlugin() {
  return new Plugin({
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const breakType = state.schema.linebreakReplacement
      if (!breakType) return null
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
      }
      if (!(to >= from)) return null
      const fixes = []
      state.doc.nodesBetween(Math.max(0, from), Math.min(state.doc.content.size, to), (node, pos, parent) => {
        if (!node.isText) return true
        if (!parent?.isTextblock || parent.type.spec.code || parent.type.whitespace === 'pre') return false
        if (!parent.type.contentMatch.matchType(breakType)) return false
        for (let index = node.text.indexOf('\n'); index >= 0; index = node.text.indexOf('\n', index + 1)) fixes.push(pos + index)
        return false
      })
      if (!fixes.length) return null
      const tr = state.tr
      for (let index = fixes.length - 1; index >= 0; index -= 1) {
        const at = fixes[index]
        tr.replaceWith(at, at + 1, breakType.create({ isInline: true }, null, state.doc.resolve(at).marks()))
      }
      return tr
    }
  })
}
