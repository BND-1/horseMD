// One-line blocks: a GFM table cell and an ATX heading are one line of
// Markdown. A soft line break (hardbreak with isInline — a newline inside a
// paragraph, kept visible by "preserve single line breaks") has no spelling
// there, so a document holding one can never be saved exactly: the source
// sync stopped with「检测到富文本与源码不一致」(#171 fuzz: a two-line quote
// pasted into a cell, seed 30; two lines of plain text pasted into a heading,
// seed 40). Any path can bring one in — paste, drop, joining blocks — so the
// rule holds after every transaction, as Typora's model does:
//   - in a cell the break becomes a <br> line break (Enter in a cell does the
//     same, editor-tablebreak.js);
//   - a heading ends at the break and the rest becomes a paragraph below it.
// Hard breaks (`<br>` read from the file) are left alone.
import { Plugin, PluginKey } from '@milkdown/prose/state'

const key = new PluginKey('hm-one-line-blocks')
const isSoftBreak = (node, br) => node.type === br && node.attrs.isInline === true

// Top-level block ranges (final document) that the transactions touched.
function touchedBlocks(transactions, doc) {
  const ranges = []
  transactions.forEach((tr, index) => {
    const maps = tr.mapping.maps
    maps.forEach((map, at) => {
      map.forEach((_oldStart, _oldEnd, from, to) => {
        let start = from
        let end = to
        for (let k = at + 1; k < maps.length; k += 1) { start = maps[k].map(start, -1); end = maps[k].map(end, 1) }
        for (let t = index + 1; t < transactions.length; t += 1) { start = transactions[t].mapping.map(start, -1); end = transactions[t].mapping.map(end, 1) }
        ranges.push([start, end])
      })
    })
  })
  const size = doc.content.size
  return ranges.map(([from, to]) => {
    const $from = doc.resolve(Math.max(0, Math.min(size, from)))
    const $to = doc.resolve(Math.max(0, Math.min(size, to)))
    return [$from.depth ? $from.before(1) : $from.pos, $to.depth ? $to.after(1) : $to.pos]
  })
}

const cellAncestor = ($pos) => {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const name = $pos.node(depth).type.name
    if (name === 'table_cell' || name === 'table_header') return true
  }
  return false
}

export function oneLineBlocksPlugin() {
  return new Plugin({
    key,
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const { schema } = state
      const br = schema.nodes.hardbreak || schema.nodes.hard_break
      if (!br) return null
      const cellBreaks = []
      const headingBreaks = []
      for (const [from, to] of touchedBlocks(transactions, state.doc)) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!isSoftBreak(node, br)) return
          const $pos = state.doc.resolve(pos)
          if (cellAncestor($pos)) cellBreaks.push(pos)
          else if ($pos.parent.type.name === 'heading') headingBreaks.push(pos)
        })
      }
      if (!cellBreaks.length && !headingBreaks.length) return null
      const tr = state.tr
      for (const pos of new Set(cellBreaks)) {
        const node = tr.doc.nodeAt(pos)
        if (node && isSoftBreak(node, br)) tr.setNodeMarkup(pos, null, { ...node.attrs, isInline: false })
      }
      // Last first: earlier positions stay valid. Only the first break of a
      // heading splits it (the paragraph after may hold soft breaks).
      const firstPerHeading = new Map()
      for (const pos of headingBreaks) {
        const start = state.doc.resolve(pos).before()
        if (!firstPerHeading.has(start) || firstPerHeading.get(start) > pos) firstPerHeading.set(start, pos)
      }
      const paragraph = schema.nodes.paragraph
      for (const pos of [...firstPerHeading.values()].sort((a, b) => b - a)) {
        const mapped = tr.mapping.map(pos)
        const node = tr.doc.nodeAt(mapped)
        if (!node || !isSoftBreak(node, br)) continue
        tr.delete(mapped, mapped + node.nodeSize)
        tr.split(mapped, 1, [{ type: paragraph }])
      }
      return tr.docChanged ? tr : null
    }
  })
}
