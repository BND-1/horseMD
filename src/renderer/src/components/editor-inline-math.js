import { Plugin, PluginKey } from '@milkdown/prose/state'

const INLINE_MATH_KEY = new PluginKey('hm-inline-math-editing')

const isEscaped = (text, index) => {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

export function findInlineMathSpans(text) {
  const spans = []
  for (let open = 0; open < text.length; open++) {
    if (text[open] !== '$' || isEscaped(text, open)) continue
    if (text[open - 1] === '$' || text[open + 1] === '$') continue
    for (let close = open + 1; close < text.length; close++) {
      if (text[close] === '\n') break
      if (text[close] !== '$' || isEscaped(text, close)) continue
      if (text[close - 1] === '$' || text[close + 1] === '$') continue
      if (close > open + 1) {
        spans.push({ from: open, to: close + 1, value: text.slice(open + 1, close) })
      }
      open = close
      break
    }
  }
  return spans
}

export function inlineMathAtCaret(text, offset) {
  return findInlineMathSpans(text).find((span) => offset > span.from && offset < span.to) || null
}

const textblockStream = (node) => {
  let text = ''
  node.forEach((child) => {
    text += child.isText ? child.text : '\uFFFC'.repeat(child.nodeSize)
  })
  return text
}

const pendingAtSelection = (state) => {
  const { selection } = state
  if (!selection.empty || !selection.$head.parent.isTextblock) return null
  const $head = selection.$head
  const span = inlineMathAtCaret(textblockStream($head.parent), $head.parentOffset)
  if (!span) return null
  const start = $head.start()
  return { from: start + span.from, to: start + span.to, value: span.value }
}

export function createInlineMathEditingPlugin() {
  return new Plugin({
    key: INLINE_MATH_KEY,
    state: {
      init: () => null,
      apply(tr, pending, _oldState, newState) {
        const meta = tr.getMeta(INLINE_MATH_KEY)
        if (meta?.clear) return null
        if (pending && tr.docChanged) {
          pending = {
            ...pending,
            from: tr.mapping.map(pending.from),
            to: tr.mapping.map(pending.to, -1)
          }
        }
        if (!tr.docChanged) return pending
        const current = pendingAtSelection(newState)
        if (current) return current
        if (!pending || pending.to > newState.doc.content.size) return null
        return newState.doc.textBetween(pending.from, pending.to) === `$${pending.value}$`
          ? pending
          : null
      }
    },
    appendTransaction(transactions, _oldState, newState) {
      const pending = INLINE_MATH_KEY.getState(newState)
      if (!pending) return null
      const commit = transactions.some((tr) => tr.getMeta(INLINE_MATH_KEY)?.commit)
      const caretInside = newState.selection.empty &&
        newState.selection.head > pending.from && newState.selection.head < pending.to
      if (!commit && caretInside) return null

      const mathType = newState.schema.nodes.math_inline
      if (!mathType || pending.to > newState.doc.content.size) return null
      if (newState.doc.textBetween(pending.from, pending.to) !== `$${pending.value}$`) return null
      return newState.tr
        .replaceWith(pending.from, pending.to, mathType.create({ value: pending.value }))
        .setMeta(INLINE_MATH_KEY, { clear: true })
    },
    view(view) {
      const onBlur = () => {
        setTimeout(() => {
          if (!INLINE_MATH_KEY.getState(view.state)) return
          view.dispatch(view.state.tr.setMeta(INLINE_MATH_KEY, { commit: true }))
        }, 0)
      }
      view.dom.addEventListener('blur', onBlur, true)
      return { destroy: () => view.dom.removeEventListener('blur', onBlur, true) }
    }
  })
}
