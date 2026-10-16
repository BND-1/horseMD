import { TextSelection, Plugin } from '@milkdown/prose/state'
import { strikeInputIsSingleTilde, strikeInputWouldCorruptCriticMarkup } from '../strikeGuard.js'

// Reconstruct `{~~old~>new~~}` substitution markers that GFM strikethrough
// consumed during parse. remark turns `{~~old~>new~~}` into three mdast nodes:
// text("{") + <delete>old~>new</delete> + text("}"). This merges the three
// nodes back into one literal text node so substitution renders via the robust
// text-scan path as addition/deletion do.
export function remarkReconstructSubstitution() {
  const textOf = (node) => {
    if (!node) return ''
    if (node.value != null) return String(node.value)
    if (node.children) return node.children.map(textOf).join('')
    return ''
  }
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return
      for (const c of node.children) walk(c)
      const kids = node.children
      const out = []
      for (let i = 0; i < kids.length; i++) {
        const a = kids[i]
        const b = kids[i + 1]
        const c = kids[i + 2]
        if (
          a && b && c &&
          a.type === 'text' && b.type === 'delete' && c.type === 'text' &&
          /\{$/.test(a.value) && /^\}/.test(c.value) &&
          textOf(b).includes('~>')
        ) {
          out.push({ type: 'text', value: `${a.value.slice(0, -1)}{~~${textOf(b)}~~}${c.value.slice(1)}` })
          i += 2
          continue
        }
        out.push(a)
      }
      node.children = out
    }
    walk(tree)
    return tree
  }
}

// Runtime backstop for macOS IME composition paths that bypass handleTextInput
// and let the GFM strike input rule corrupt `{~~old~>new~~}`. If a strike mark
// touched a textblock where oldState had an intact substitution marker, restore
// that textblock content from oldState.
export function createSubstitutionLiveReconstructPlugin() {
  return new Plugin({
    appendTransaction(transs, oldState, newState) {
      if (!transs.some((tr) => tr.docChanged)) return null
      const touchedStrike = transs.some((t) =>
        t.steps.some((s) => s.mark && s.mark.type && /strike|del/i.test(s.mark.type.name))
      )
      if (!touchedStrike) return null

      const toRestore = []
      const walk = (nNode, oNode, nStart, oStart) => {
        if (nNode.isTextblock) {
          const nPos = nStart - 1
          if (oNode && oNode.isTextblock) {
            let hasStrike = false
            nNode.forEach((c) => {
              if (c.marks.some((m) => /strike|del/i.test(m.type.name))) hasStrike = true
            })
            if (hasStrike) {
              const oldMarkers = oNode.textContent.match(/\{~~[\s\S]*?~~\}/g) || []
              if (oldMarkers.length && !oldMarkers.every((m) => nNode.textContent.includes(m))) {
                toRestore.push({ nPos, oPos: oStart - 1, oldNode: oNode })
              }
            }
          }
          return
        }
        const count = Math.min(nNode.childCount, oNode ? oNode.childCount : 0)
        let nOff = 0
        let oOff = 0
        for (let i = 0; i < nNode.childCount; i++) {
          const nc = nNode.child(i)
          const oc = i < count && oNode ? oNode.child(i) : null
          if (oc) {
            walk(nc, oc, nStart + nOff + 1, oStart + oOff + 1)
            oOff += oc.nodeSize
          }
          nOff += nc.nodeSize
        }
      }
      walk(newState.doc, oldState.doc, 0, 0)
      if (!toRestore.length) return null

      const tr = newState.tr
      toRestore.sort((a, b) => b.nPos - a.nPos)
      for (const { nPos, oPos, oldNode } of toRestore) {
        const size = newState.doc.nodeAt(nPos).nodeSize
        tr.replaceWith(nPos + 1, nPos + size - 1, oldNode.content)
        const head = oldState.selection.head
        if (head > oPos && head < oPos + oldNode.nodeSize) {
          tr.setSelection(TextSelection.create(tr.doc, nPos + (head - oPos)))
        }
      }
      return tr
    }
  })
}

// Prevent the GFM strikethrough input rule from eating CriticMarkup
// substitution markers, and from striking a single-tilde pair (Typora only
// strikes `~~x~~`). This plugin must be prepended before inputRules.
export function createStrikeGuardPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        const $from = view.state.doc.resolve(from)
        const textBefore = $from.parent.textBetween(
          Math.max(0, $from.parentOffset - 500),
          $from.parentOffset,
          null,
          '￼'
        )
        const critic = strikeInputWouldCorruptCriticMarkup(textBefore, text)
        if (!critic && !strikeInputIsSingleTilde(textBefore, text)) return false
        const tr = view.state.tr.insertText(text, from, to)
        // The input rule matches the FIRST tilde run in the line, so a literal
        // `~30~` earlier would also block a `~~x~~` being closed at the
        // cursor. Apply that strike here, as the rule would have.
        const strike = !critic && view.state.schema.marks.strike_through
        const closing = strike && /(?<![\w:/])~~([^~](?:[^]*?[^~])?)~~$/.exec(textBefore + text)
        if (closing) {
          const start = from - textBefore.length + closing.index
          const contentEnd = start + 2 + closing[1].length
          tr.delete(contentEnd, contentEnd + 2).delete(start, start + 2)
            .addMark(start, start + closing[1].length, strike.create())
            .removeStoredMark(strike)
        }
        view.dispatch(tr)
        return true
      }
    }
  })
}
