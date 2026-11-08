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
//
// Such a block also loses the code's blank-only first / last lines: a
// paragraph cannot start or end with a line break or a line of blanks in
// Markdown (CommonMark strips them; the serializer and the validator treat
// them as absent), so a code block `   ⏎abc` turned into a paragraph showed a
// line the file never got, and reopening dropped it — with it the next line's
// indent. Only blocks the code text has just reached are trimmed: a typed
// Shift+Enter at a paragraph's end stays while the user goes on typing.
import { Plugin } from '@milkdown/prose/state'
import { ReplaceAroundStep } from '@milkdown/prose/transform'

const isBlankText = (node) => node.isText && /^[\t ]*$/.test(node.text)

// [from, to) document ranges of a text block's blank edge lines.
function blankEdgeLines(block, start) {
  const kids = []
  block.forEach((child, offset) => kids.push({ child, at: start + offset }))
  const isBreak = (entry) => entry && !entry.child.isText && entry.child.type.name === 'hardbreak'
  const cuts = []
  let head = 0
  for (;;) {
    let k = head
    while (kids[k] && isBlankText(kids[k].child)) k += 1
    if (!isBreak(kids[k])) break
    head = k + 1
  }
  let tail = kids.length
  for (;;) {
    let k = tail
    while (k > head && isBlankText(kids[k - 1].child)) k -= 1
    if (k <= head || !isBreak(kids[k - 1])) break
    tail = k - 1
  }
  if (head > 0) cuts.push([kids[0].at, kids[head - 1].at + kids[head - 1].child.nodeSize])
  if (tail < kids.length && tail >= head) cuts.push([kids[tail].at, kids[kids.length - 1].at + kids[kids.length - 1].child.nodeSize])
  return cuts
}

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
      // Start positions (in `state.doc`) of code blocks turned into a text
      // block by these transactions (setBlockType: a ReplaceAroundStep at the
      // node's start).
      const converted = []
      transactions.forEach((tr, trIndex) => {
        tr.steps.forEach((step, index) => {
          if (!(step instanceof ReplaceAroundStep)) return
          if (!tr.docs[index].nodeAt(step.from)?.type.spec.code) return
          let at = tr.mapping.slice(index).map(step.from, -1)
          for (const later of transactions.slice(trIndex + 1)) at = later.mapping.map(at, -1)
          converted.push(at)
        })
      })
      const fixes = []
      const touched = new Set()
      // Every text block the changed range touches is scanned WHOLE: deleting
      // a selection from a paragraph's end into a code block joins the code
      // text in just after the range (fuzz seed 936: delete + split at the
      // boundary, the joined `const a = 1\n…` started at the range end).
      state.doc.nodesBetween(Math.max(0, from), Math.min(state.doc.content.size, to), (node, pos) => {
        if (!node.isTextblock) return true
        if (node.type.spec.code || node.type.whitespace === 'pre' || !node.type.contentMatch.matchType(breakType)) return false
        node.forEach((child, offset) => {
          if (!child.isText) return
          const at = pos + 1 + offset
          for (let index = child.text.indexOf('\n'); index >= 0; index = child.text.indexOf('\n', index + 1)) {
            fixes.push(at + index)
            touched.add(pos)
          }
        })
        return false
      })
      for (const at of converted) {
        const node = at >= 0 && at < state.doc.content.size ? state.doc.nodeAt(at) : null
        if (node?.isTextblock && !node.type.spec.code && node.type.contentMatch.matchType(breakType)) touched.add(at)
      }
      if (!fixes.length && !touched.size) return null
      const tr = state.tr
      for (let index = fixes.length - 1; index >= 0; index -= 1) {
        const at = fixes[index]
        tr.replaceWith(at, at + 1, breakType.create({ isInline: true }, null, state.doc.resolve(at).marks()))
      }
      const cuts = []
      for (const pos of touched) {
        const at = tr.mapping.map(pos, 1)
        const block = tr.doc.nodeAt(at)
        if (block?.isTextblock) cuts.push(...blankEdgeLines(block, at + 1))
      }
      cuts.sort((a, b) => b[0] - a[0]).forEach(([cutFrom, cutTo]) => tr.delete(cutFrom, cutTo))
      return tr.docChanged ? tr : null
    }
  })
}
