import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { tokenAtCaret } from './editor-html-token-editing.js'

const inlineCodeEditingKey = new PluginKey('horsemd-inline-code-editing')

function inlineCodeType(state) {
  return state.schema.marks.inlineCode || state.schema.marks.code || null
}

function placeDomSelectionOnInlineCodeBoundarySide(view, pos, side) {
  // ProseMirror has one document position for both sides of a mark boundary.
  // Choose the DOM side explicitly (after a conversion the caret is outside
  // the new code) without creating a second document position.
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
    view.domObserver?.setCurSelection?.()
  } catch {
    // DOM mapping is best-effort only; the stored marks decide typing.
  }
}

const dispatchInlineCodeEdit = (view, tr, onEdit, onValueChange) => {
  onEdit?.()
  view.dispatch(tr)
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

// Typing inline code: `text stays literal until the user types the closing
// delimiter, then both delimiters go and the content becomes code (repeated
// backticks stay literal). Editing existing inline code — the caret's side
// at its edges, arrows, clicks, the backticks shown while inside, IME — is
// the token plugin's (editor-html-token-editing.js), shared with <kbd>.
export function createInlineCodeEditingPlugin({ onEdit, onValueChange } = {}) {
  return new Plugin({
    key: inlineCodeEditingKey,
    props: {
      handleTextInput(view, from, to, text) {
        const { state } = view
        const type = inlineCodeType(state)
        if (!type || from !== to || text !== '`') return false
        // Inside inline code a backtick is the token plugin's (end: leave the
        // code; elsewhere: a literal backtick in the code).
        if (tokenAtCaret(state)?.kind === 'code') return false

        // Crepe's built-in inline-code input rule consumes delimiter keystrokes.
        // Own them here so an opener stays literal until a valid closing single
        // backtick is typed. Only then remove both delimiters and mark content.
        const baseMarks = state.storedMarks || state.doc.resolve(from).marks()
        const closing = closingDelimiterRange(state, from, type)
        if (closing) {
          const mark = type.create()
          const tr = state.tr.delete(closing.from, closing.contentFrom)
          const markedTo = closing.to - 1
          tr.addMark(closing.from, markedTo, mark)
          tr.setSelection(TextSelection.create(tr.doc, markedTo))
          tr.setStoredMarks(baseMarks.filter((item) => item.type !== type))
          dispatchInlineCodeEdit(view, tr, onEdit, onValueChange)
          placeDomSelectionOnInlineCodeBoundarySide(view, markedTo, 1)
          return true
        }

        const tr = state.tr.insertText(text, from, to)
        tr.setSelection(TextSelection.create(tr.doc, from + 1))
        tr.setStoredMarks(baseMarks.filter((mark) => mark.type !== type))
        dispatchInlineCodeEdit(view, tr, onEdit, onValueChange)
        return true
      }
    }
  })
}
