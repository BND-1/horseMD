import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const inlineCodeEditingKey = new PluginKey('horsemd-inline-code-editing')
const inactiveEditingState = Object.freeze({
  active: false
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
    ? { active: true }
    : inactiveEditingState
}

function setEditingState(tr, active) {
  return tr.setMeta(inlineCodeEditingKey, { active })
}

function setActive(tr, active) {
  return setEditingState(tr, active)
}

function marksWith(mark, marks = []) {
  return mark.addToSet(marks)
}

function placeDomSelectionOnInlineCodeBoundarySide(view, pos, side) {
  // ProseMirror has one document position for both sides of a mark boundary.
  // Its state selection therefore does not change when an arrow leaves inline
  // code, and the view normally leaves Chromium's DOM caret in the old <code>
  // text node. Choose the corresponding DOM side explicitly without creating
  // a second document position or skipping a neighbouring character.
  if (typeof view.domAtPos !== 'function') return
  try {
    const point = view.domAtPos(pos, side)
    const selection = view.dom?.ownerDocument?.getSelection?.()
    if (!point || !selection) return
    const range = view.dom.ownerDocument.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    // Keep ProseMirror's DOM observer in sync with the intentionally moved
    // visual side of this otherwise unchanged state selection.
    view.domObserver?.setCurSelection?.()
  } catch {
    // DOM mapping is best-effort only. The stored-mark state below is still
    // sufficient for correct typing when a browser cannot expose the boundary.
  }
}

function domSelectionInsideInlineCode(view) {
  const selection = view.dom?.ownerDocument?.getSelection?.()
  const anchor = selection?.anchorNode
  if (!anchor) return null
  const element = anchor.nodeType === 1 ? anchor : anchor.parentElement
  const code = element?.closest?.('code')
  return Boolean(code && view.dom.contains(code))
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
  view.dispatch(setEditingState(tr, nextState.active))
  // Milkdown does not emit markdownUpdated for every plugin-owned transaction.
  // Notify the Editor lifecycle explicitly so source mode and save state never
  // lag behind a literal backtick or deferred inline-code conversion.
  onValueChange?.()
}

function closingDelimiterRange(state, pos, type) {
  const $pos = state.doc.resolve(pos)
  if (!$pos.parent.isTextblock || $pos.parentOffset <= 1) return null

  // Keep offsets aligned with the ProseMirror textblock even when it contains
  // inline atoms. The closing delimiter can pair only with the final unmatched
  // single-backtick run; `` and ``` remain literal Markdown input.
  const text = $pos.parent.textBetween(0, $pos.parentOffset, '\ufffc', '\ufffc')
  const runs = [...text.matchAll(/`+/g)]
  const opener = runs.at(-1)
  if (!opener || opener[0].length !== 1) return null

  const openOffset = opener.index
  if (openOffset == null || openOffset >= text.length - 1) return null
  let backslashes = 0
  for (let index = openOffset - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    backslashes += 1
  }
  if (backslashes % 2 === 1) return null

  const from = $pos.start() + openOffset
  const contentFrom = from + 1
  const to = pos
  if (state.doc.rangeHasMark(contentFrom, to, type)) return null
  return { from, contentFrom, to }
}

// Adds the boundary behaviours expected from a WYSIWYG inline-code mark:
// `text remains literal until the user types the closing delimiter, repeated
// backticks remain available, and clicking rendered code allows editing it.
export function createInlineCodeEditingPlugin({ onEdit, onValueChange } = {}) {
  return new Plugin({
    key: inlineCodeEditingKey,
    state: {
      init: () => inactiveEditingState,
      apply(tr, current) {
        const explicit = tr.getMeta(inlineCodeEditingKey)
        if (explicit && typeof explicit === 'object') return explicit
        if (typeof explicit === 'boolean') {
          return explicit ? { active: true } : inactiveEditingState
        }
        if (tr.selectionSet) return inactiveEditingState
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
            { active: true },
            onEdit,
            onValueChange
          )
          return true
        }

        // Crepe's built-in inline-code input rule consumes delimiter keystrokes.
        // Own them here so an opener stays literal until a valid closing single
        // backtick is typed. Only then remove both delimiters and mark content.
        if (text === '`') {
          const baseMarks = state.storedMarks || state.doc.resolve(from).marks()
          const closing = closingDelimiterRange(state, from, type)
          if (closing) {
            const mark = type.create()
            const tr = state.tr.delete(closing.from, closing.contentFrom)
            const markedTo = closing.to - 1
            tr.addMark(closing.from, markedTo, mark)
            tr.setSelection(TextSelection.create(tr.doc, markedTo))
            tr.setStoredMarks(baseMarks.filter((item) => item.type !== type))
            dispatchInlineCodeEdit(view, tr, inactiveEditingState, onEdit, onValueChange)
            placeDomSelectionOnInlineCodeBoundarySide(view, markedTo, 1)
            return true
          }

          const tr = state.tr.insertText(text, from, to)
          tr.setSelection(TextSelection.create(tr.doc, from + 1))
          tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
          dispatchInlineCodeEdit(view, tr, inactiveEditingState, onEdit, onValueChange)
          return true
        }

        return false
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

        // Once this plugin has placed the DOM caret on the prose side of the
        // shared mark boundary, the next arrow must be native navigation into
        // the neighbouring text. Re-handling that same ProseMirror position
        // would make the caret appear to leave <code> yet permanently block
        // further left/right movement.
        const domInsideCode = domSelectionInsideInlineCode(view)
        if (!editingState(state).active && domInsideCode === false) return false

        // A mark boundary has one ProseMirror position for both visual sides.
        // Keep that position and clear the stored inline-code mark so typing is
        // outside the code, then place the DOM caret on the corresponding prose
        // side without moving into or skipping an adjacent character.
        const type = inlineCodeType(state)
        const baseMarks = state.storedMarks || state.selection.$head.marks()
        const tr = state.tr.setSelection(TextSelection.create(state.doc, state.selection.head))
        tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
        view.dispatch(setActive(tr, false))
        placeDomSelectionOnInlineCodeBoundarySide(view, state.selection.head, exitsRight ? 1 : -1)
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
          if (current.active) {
            view.dispatch(setActive(view.state.tr, false))
          }
          return false
        }
      }
    }
  })
}
