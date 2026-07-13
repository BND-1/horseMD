import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'

const inlineCodeEditingKey = new PluginKey('horsemd-inline-code-editing')

function inlineCodeType(state) {
  return state.schema.marks.inlineCode || state.schema.marks.code || null
}

export function inlineCodeMarkBefore(state, pos) {
  const type = inlineCodeType(state)
  if (!type || pos <= 0 || pos > state.doc.content.size) return null
  const $pos = state.doc.resolve(pos)
  const before = type.isInSet($pos.nodeBefore?.marks || [])
  const after = type.isInSet($pos.nodeAfter?.marks || [])
  return before && !after ? before : null
}

function setActive(tr, active) {
  return tr.setMeta(inlineCodeEditingKey, active)
}

function marksWith(mark, marks = []) {
  return mark.addToSet(marks)
}

// Adds the two boundary behaviours expected from a WYSIWYG inline-code mark:
// typing an empty pair enters code immediately, and clicking the rendered
// code's trailing edge keeps subsequent text inside that mark. The underlying
// Markdown input rule and non-inclusive schema remain unchanged.
export function createInlineCodeEditingPlugin() {
  return new Plugin({
    key: inlineCodeEditingKey,
    state: {
      init: () => false,
      apply(tr, active) {
        const explicit = tr.getMeta(inlineCodeEditingKey)
        if (typeof explicit === 'boolean') return explicit
        return tr.selectionSet ? false : active
      }
    },
    props: {
      handleTextInput(view, from, to, text) {
        const { state } = view
        const type = inlineCodeType(state)
        if (!type || from !== to) return false

        if (inlineCodeEditingKey.getState(state)) {
          const baseMarks = state.storedMarks || state.doc.resolve(from).marks()
          if (text === '`') {
            const tr = setActive(state.tr.setSelection(TextSelection.create(state.doc, from)), false)
            tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
            view.dispatch(tr)
            return true
          }

          const mark = type.create()
          const tr = state.tr.replaceWith(from, to, state.schema.text(text, marksWith(mark, baseMarks)))
          tr.setSelection(TextSelection.create(tr.doc, from + text.length))
          tr.setStoredMarks(marksWith(mark, baseMarks))
          view.dispatch(setActive(tr, true))
          return true
        }

        if (text !== '`' || from < 1) return false
        const $from = state.doc.resolve(from)
        if ($from.parentOffset < 1 || $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset) !== '`') {
          return false
        }
        if (type.isInSet($from.nodeBefore?.marks || [])) return false

        const tr = state.tr.delete(from - 1, from)
        tr.setSelection(TextSelection.create(tr.doc, from - 1))
        tr.setStoredMarks(marksWith(type.create(), state.storedMarks || $from.marks()))
        view.dispatch(setActive(tr, true))
        return true
      },

      handleClick(view, pos, event) {
        const target = event.target
        const code = target?.closest?.('code')
        if (!code || !view.dom.contains(code)) return false
        const mark = inlineCodeMarkBefore(view.state, pos)
        if (!mark) return false

        const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
        tr.setStoredMarks(marksWith(mark, view.state.storedMarks || view.state.doc.resolve(pos).marks()))
        view.dispatch(setActive(tr, true))
        view.focus()
        return true
      }
    }
  })
}
