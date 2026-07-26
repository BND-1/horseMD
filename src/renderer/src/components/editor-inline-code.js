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

const dispatchInlineCodeEdit = (view, tr, active, onEdit, onValueChange) => {
  onEdit?.()
  view.dispatch(setActive(tr, active))
  // Milkdown does not emit markdownUpdated for every plugin-owned transaction.
  // Notify the Editor lifecycle explicitly so source mode and save state never
  // lag behind a literal backtick or deferred inline-code conversion.
  onValueChange?.()
}

// Adds the two boundary behaviours expected from a WYSIWYG inline-code mark:
// typing two backticks followed by text enters code, and clicking the rendered
// code's trailing edge keeps subsequent text inside that mark. The underlying
// Markdown input rule and non-inclusive schema remain unchanged.
export function createInlineCodeEditingPlugin({ onEdit, onValueChange } = {}) {
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
            dispatchInlineCodeEdit(view, tr, false, onEdit, onValueChange)
            return true
          }

          const mark = type.create()
          const tr = state.tr.replaceWith(from, to, state.schema.text(text, marksWith(mark, baseMarks)))
          tr.setSelection(TextSelection.create(tr.doc, from + text.length))
          tr.setStoredMarks(marksWith(mark, baseMarks))
          dispatchInlineCodeEdit(view, tr, true, onEdit, onValueChange)
          return true
        }

        // Crepe's built-in inline-code input rule consumes delimiter keystrokes
        // before a user can finish typing `` or ```. Own literal backtick input
        // here so every typed delimiter is retained. The deferred pair branch
        // below turns `` + ordinary text into inline code after intent is clear.
        if (text === '`') {
          const baseMarks = state.storedMarks || state.doc.resolve(from).marks()
          const tr = state.tr.insertText(text, from, to)
          tr.setSelection(TextSelection.create(tr.doc, from + 1))
          tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
          dispatchInlineCodeEdit(view, tr, false, onEdit, onValueChange)
          return true
        }
        if (from < 2) return false
        const $from = state.doc.resolve(from)
        if (
          $from.parentOffset < 2 ||
          $from.parent.textBetween($from.parentOffset - 2, $from.parentOffset) !== '``' ||
          type.isInSet($from.nodeBefore?.marks || [])
        ) {
          return false
        }

        const mark = type.create()
        const tr = state.tr.delete(from - 2, from)
        tr.insert(from - 2, state.schema.text(text, marksWith(mark, state.storedMarks || $from.marks())))
        tr.setSelection(TextSelection.create(tr.doc, from - 2 + text.length))
        tr.setStoredMarks(marksWith(mark, state.storedMarks || $from.marks()))
        dispatchInlineCodeEdit(view, tr, true, onEdit, onValueChange)
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
