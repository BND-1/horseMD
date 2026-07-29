import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const inlineCodeEditingKey = new PluginKey('horsemd-inline-code-editing')
const inactiveEditingState = Object.freeze({
  active: false,
  pendingOpenAt: null
})

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

function editingState(state) {
  const value = inlineCodeEditingKey.getState(state)
  if (value && typeof value === 'object') return value
  return value
    ? { active: true, pendingOpenAt: null }
    : inactiveEditingState
}

function setEditingState(tr, active, pendingOpenAt = null) {
  return tr.setMeta(inlineCodeEditingKey, { active, pendingOpenAt })
}

function setActive(tr, active) {
  return setEditingState(tr, active)
}

function marksWith(mark, marks = []) {
  return mark.addToSet(marks)
}

export function inlineCodeRangeAtSelection(state) {
  const type = inlineCodeType(state)
  const { selection } = state
  if (!type || !selection.empty || !selection.$head.parent.isTextblock) return null

  const parentStart = selection.$head.start()
  const caret = selection.head
  let match = null
  selection.$head.parent.forEach((node, offset) => {
    if (!node.isText || !type.isInSet(node.marks)) return
    const from = parentStart + offset
    const to = from + node.nodeSize
    if (caret >= from && caret <= to) match = { from, to }
  })
  return match
}

const delimiterWidget = (side) =>
  () => {
    const delimiter = document.createElement('span')
    delimiter.className = `hm-inline-code-delimiter ${side}`
    delimiter.contentEditable = 'false'
    delimiter.setAttribute('aria-hidden', 'true')
    delimiter.textContent = '`'
    return delimiter
  }

function inlineCodeEditingDecorations(state) {
  if (!editingState(state).active) return null
  const range = inlineCodeRangeAtSelection(state)
  if (!range) return null
  return DecorationSet.create(state.doc, [
    Decoration.widget(range.from, delimiterWidget('open'), {
      key: 'hm-inline-code-open',
      side: -1
    }),
    Decoration.widget(range.to, delimiterWidget('close'), {
      key: 'hm-inline-code-close',
      side: 1
    })
  ])
}

const dispatchInlineCodeEdit = (view, tr, nextState, onEdit, onValueChange) => {
  onEdit?.()
  view.dispatch(setEditingState(tr, nextState.active, nextState.pendingOpenAt))
  // Milkdown does not emit markdownUpdated for every plugin-owned transaction.
  // Notify the Editor lifecycle explicitly so source mode and save state never
  // lag behind a literal backtick or deferred inline-code conversion.
  onValueChange?.()
}

// Adds the boundary behaviours expected from a WYSIWYG inline-code mark:
// standard `text` typing enters code after the first text character, literal
// repeated backticks remain available, and clicking a rendered code boundary
// keeps subsequent text inside that mark.
export function createInlineCodeEditingPlugin({ onEdit, onValueChange } = {}) {
  return new Plugin({
    key: inlineCodeEditingKey,
    state: {
      init: () => inactiveEditingState,
      apply(tr, current) {
        const explicit = tr.getMeta(inlineCodeEditingKey)
        if (explicit && typeof explicit === 'object') return explicit
        if (typeof explicit === 'boolean') {
          return explicit ? { active: true, pendingOpenAt: null } : inactiveEditingState
        }
        if (tr.selectionSet) return inactiveEditingState
        if (current.pendingOpenAt != null && tr.docChanged) {
          const mapped = tr.mapping.mapResult(current.pendingOpenAt)
          if (mapped.deleted) return inactiveEditingState
          return { ...current, pendingOpenAt: mapped.pos }
        }
        return current
      }
    },
    props: {
      decorations: inlineCodeEditingDecorations,

      handleTextInput(view, from, to, text) {
        const { state } = view
        const type = inlineCodeType(state)
        if (!type || from !== to) return false

        const current = editingState(state)
        if (current.active) {
          const baseMarks = state.storedMarks || state.doc.resolve(from).marks()
          if (text === '`') {
            const tr = setActive(state.tr.setSelection(TextSelection.create(state.doc, from)), false)
            tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
            dispatchInlineCodeEdit(view, tr, inactiveEditingState, onEdit, onValueChange)
            return true
          }

          const mark = type.create()
          const tr = state.tr.replaceWith(from, to, state.schema.text(text, marksWith(mark, baseMarks)))
          tr.setSelection(TextSelection.create(tr.doc, from + text.length))
          tr.setStoredMarks(marksWith(mark, baseMarks))
          dispatchInlineCodeEdit(
            view,
            tr,
            { active: true, pendingOpenAt: null },
            onEdit,
            onValueChange
          )
          return true
        }

        // Crepe's built-in inline-code input rule consumes delimiter keystrokes
        // before a user can finish typing `` or ```. Own literal backtick input
        // here so every typed delimiter is retained. The deferred pair branch
        // below turns `` + ordinary text into inline code after intent is clear.
        if (text === '`') {
          const baseMarks = state.storedMarks || state.doc.resolve(from).marks()
          const $from = state.doc.resolve(from)
          const previousCharacter = $from.parentOffset > 0
            ? $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset)
            : ''
          const tr = state.tr.insertText(text, from, to)
          tr.setSelection(TextSelection.create(tr.doc, from + 1))
          tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
          dispatchInlineCodeEdit(
            view,
            tr,
            {
              active: false,
              pendingOpenAt: previousCharacter === '`' ? null : from
            },
            onEdit,
            onValueChange
          )
          return true
        }

        if (
          current.pendingOpenAt != null &&
          from === current.pendingOpenAt + 1 &&
          state.doc.textBetween(current.pendingOpenAt, from) === '`'
        ) {
          const $from = state.doc.resolve(from)
          const mark = type.create()
          const baseMarks = state.storedMarks || $from.marks()
          const tr = state.tr.delete(current.pendingOpenAt, from)
          tr.insert(
            current.pendingOpenAt,
            state.schema.text(text, marksWith(mark, baseMarks))
          )
          tr.setSelection(TextSelection.create(tr.doc, current.pendingOpenAt + text.length))
          tr.setStoredMarks(marksWith(mark, baseMarks))
          dispatchInlineCodeEdit(
            view,
            tr,
            { active: true, pendingOpenAt: null },
            onEdit,
            onValueChange
          )
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
        dispatchInlineCodeEdit(
          view,
          tr,
          { active: true, pendingOpenAt: null },
          onEdit,
          onValueChange
        )
        return true
      },

      handleKeyDown(view, event) {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
        ) {
          return false
        }

        const { state } = view
        const range = inlineCodeRangeAtSelection(state)
        const exitsLeft = event.key === 'ArrowLeft' && state.selection.head === range?.from
        const exitsRight = event.key === 'ArrowRight' && state.selection.head === range?.to
        if (!exitsLeft && !exitsRight) return false

        // A mark boundary has one ProseMirror position for both visual sides.
        // Keep that position and clear the stored inline-code mark so one arrow
        // press moves across the rendered delimiter without skipping text.
        const type = inlineCodeType(state)
        const baseMarks = state.storedMarks || state.selection.$head.marks()
        const tr = state.tr.setSelection(TextSelection.create(state.doc, state.selection.head))
        tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
        view.dispatch(setActive(tr, false))
        return true
      },

      handleClick(view, pos, event) {
        const target = event.target
        const code = target?.closest?.('code')
        if (!code || !view.dom.contains(code)) return false
        const $pos = view.state.doc.resolve(pos)
        const type = inlineCodeType(view.state)
        const mark = type?.isInSet($pos.marks()) || inlineCodeMarkBefore(view.state, pos)
        if (!mark) return false

        const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
        tr.setStoredMarks(marksWith(mark, view.state.storedMarks || view.state.doc.resolve(pos).marks()))
        view.dispatch(setActive(tr, true))
        view.focus()
        return true
      },

      handleDOMEvents: {
        blur(view) {
          const current = editingState(view.state)
          if (current.active || current.pendingOpenAt != null) {
            view.dispatch(setActive(view.state.tr, false))
          }
          return false
        }
      }
    }
  })
}
