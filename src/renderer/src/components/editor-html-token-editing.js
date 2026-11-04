// Key-like inline HTML (`<kbd>Esc</kbd>`, <samp>, <var>, <tt>) edits like
// inline code (editor-inline-code.js), not like a style.
//
// The html_span mark is inclusive: typing at the end of a Yuque <font> run or
// a <u> continues it, like bold. For a key that pulled every character typed
// after `<kbd>Esc</kbd>` into the key (the caret sits on the same document
// position on both sides of the boundary). Obsidian and Typora show the tags
// while the caret is in the element and type after it once it is closed.
//
// Here, for these tags only:
//   - at either edge of a key the caret is OUTSIDE unless the user went in
//     (a click on the key, an arrow from outside, typing / deleting inside);
//     the side is the stored marks, so typing and IME follow it;
//   - while the caret is inside, the authored tags show in grey around the
//     key (decorations, never in the document), as inline code shows `;
//   - ←/→ at an edge first cross the tag (inside ↔ outside), then move.
// Font/span/u/b… keep the inclusive behaviour.
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

export const HTML_TOKEN_TAGS = new Set(['kbd', 'samp', 'var', 'tt'])

const tokenKey = new PluginKey('horsemd-html-token-editing')
const INSIDE = 'hmTokenInside'

const isTokenMark = (mark) => mark.type.name === 'html_span' && HTML_TOKEN_TAGS.has(String(mark.attrs.tag).toLowerCase())

// Ranges of key spans in the text block around `$pos`: [{ from, to, mark }].
// A span is the run of inline nodes carrying the same mark (nested raw
// html atoms included).
function tokenRanges($pos) {
  const parent = $pos.parent
  if (!parent.isTextblock) return []
  const start = $pos.start()
  const ranges = []
  let open = null
  parent.forEach((node, offset) => {
    const from = start + offset
    const mark = node.marks.find(isTokenMark)
    if (open && mark && mark.eq(open.mark) && open.to === from) {
      open.to = from + node.nodeSize
      return
    }
    open = mark ? { from, to: from + node.nodeSize, mark } : null
    if (open) ranges.push(open)
  })
  return ranges
}

// Where an empty selection is relative to the keys of its text block.
//   inside: the key range the caret edits (strictly inside, or at an edge
//           with that key in the stored marks), else null
//   before / after: the key ending / starting at the caret
function caretContext(state) {
  const { selection } = state
  if (!selection.empty || !(selection instanceof TextSelection)) return null
  const $head = selection.$head
  const head = selection.head
  const ranges = tokenRanges($head)
  if (!ranges.length) return null
  const before = ranges.find((r) => r.to === head) || null
  const after = ranges.find((r) => r.from === head) || null
  const within = ranges.find((r) => r.from < head && head < r.to) || null
  const stored = state.storedMarks
  let inside = within
  if (!inside && stored) {
    if (before && before.mark.isInSet(stored)) inside = before
    else if (after && after.mark.isInSet(stored)) inside = after
  }
  return { head, before, after, within, inside, ranges }
}

const withoutTokens = (marks) => marks.filter((mark) => !isTokenMark(mark))

// The marks for typing on a given side of `pos`: the marks around the caret
// without any key, plus `mark` for inside.
function sideMarks(state, pos, range) {
  const $pos = state.doc.resolve(pos)
  const base = withoutTokens(range ? markSetAt(state, range) : $pos.marks())
  return range ? range.mark.addToSet(base) : base
}
// Marks of the key's own text (so a key inside bold stays bold).
function markSetAt(state, range) {
  const node = state.doc.nodeAt(range.from)
  return node ? node.marks : []
}

function setSide(state, pos, range) {
  const tr = state.tr
  if (state.selection.head !== pos || !state.selection.empty) tr.setSelection(TextSelection.create(state.doc, pos))
  tr.setStoredMarks(sideMarks(state, pos, range))
  return tr.setMeta(INSIDE, range ? 'in' : 'out')
}

const tagWidget = (text, title, side) => () => {
  const span = document.createElement('span')
  span.className = `hm-html-token-tag ${side}`
  span.contentEditable = 'false'
  span.setAttribute('aria-hidden', 'true')
  span.textContent = text
  if (title && title !== text) span.title = title
  return span
}

function tagLabels(mark) {
  const tag = String(mark.attrs.tag).toLowerCase()
  const open = String(mark.attrs.open || `<${tag}>`)
  return { open: open.length > 24 ? `<${tag} …>` : open, openTitle: open, close: `</${tag}>` }
}

function decorations(state) {
  const context = caretContext(state)
  const range = context?.inside
  if (!range) return null
  const labels = tagLabels(range.mark)
  return DecorationSet.create(state.doc, [
    // marks: [] — drawn outside every mark, never inside a neighbouring key.
    Decoration.widget(range.from, tagWidget(labels.open, labels.openTitle, 'open'), { key: `hm-token-open:${labels.openTitle}`, side: -1, marks: [] }),
    Decoration.widget(range.to, tagWidget(labels.close, '', 'close'), { key: `hm-token-close:${labels.close}`, side: 1, marks: [] })
  ])
}

// Put the DOM caret on the side of the key boundary the state says: the
// browser keeps it inside <kbd> at its end, where Chromium would also
// compose IME text.
function placeDomCaret(view) {
  if (view.composing || !view.hasFocus?.()) return
  const context = caretContext(view.state)
  if (!context || context.within) return
  const { head, before, after, inside } = context
  if (!before && !after) return
  // inside the key ending here → end of its text; inside the key starting
  // here → start of its text; outside → between the keys / next to them.
  let side
  if (inside) side = inside === before ? -1 : 1
  else side = before ? 1 : -1
  try {
    const point = view.domAtPos(head, side)
    const selection = view.dom.ownerDocument.getSelection()
    if (!point || !selection) return
    const inKey = (node) => {
      const element = node?.nodeType === 1 ? node : node?.parentElement
      return Boolean(element?.closest?.('.hm-html-span'))
    }
    // Already on the right side: leave the browser's caret alone.
    const current = selection.rangeCount ? selection.getRangeAt(0) : null
    if (current?.collapsed && inKey(current.startContainer) === Boolean(inside) && current.startContainer === point.node && current.startOffset === point.offset) return
    const range = view.dom.ownerDocument.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    view.domObserver?.setCurSelection?.()
  } catch {
    // best effort: the stored marks still decide where typing goes
  }
}

/** Raw ProseMirror plugin (prosePluginsCtx). */
export function createHtmlTokenEditingPlugin() {
  return new Plugin({
    key: tokenKey,
    // A caret that lands on a key edge without a decided side (click next to
    // the key, arrows, Home/End, Enter/Backspace joins) is outside, unless an
    // edit made inside the key left it there (Backspace at the key's end).
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some((tr) => tr.getMeta(INSIDE))) return null
      if (newState.storedMarks) return null
      const context = caretContext(newState)
      if (!context || context.within || (!context.before && !context.after)) return null
      // An edit inside the key, or a selection reset to the same spot (the
      // DOM selection read back after a click), keeps the side it had.
      const edited = transactions.some((tr) => tr.docChanged)
      const old = caretContext(oldState)
      const was = old?.inside
      if (was && (edited || old.head === context.head)) {
        const keep = [context.before, context.after].find((r) => r && r.mark.eq(was.mark))
        if (keep) return setSide(newState, context.head, keep)
      }
      return setSide(newState, context.head, null)
    },
    props: {
      decorations,

      handleKeyDown(view, event) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return false
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
        const { state } = view
        const context = caretContext(state)
        if (!context) return false
        const { head, before, after, within, inside } = context
        const right = event.key === 'ArrowRight'
        let tr = null
        if (right) {
          if (inside && inside === before) tr = setSide(state, head, null) // Esc|</kbd> → </kbd>|
          else if (!inside && after) tr = setSide(state, head, after) // |<kbd>Ctrl → <kbd>|Ctrl
          else if (within && head + 1 === within.to) tr = setSide(state, head + 1, within) // Es|c → Esc|</kbd>
        } else {
          if (inside && inside === after) tr = setSide(state, head, null)
          else if (!inside && before) tr = setSide(state, head, before)
          else if (within && head - 1 === within.from) tr = setSide(state, head - 1, within)
        }
        if (!tr) return false
        view.dispatch(tr.scrollIntoView())
        event.preventDefault()
        return true
      },

      handleClick(view, pos, event) {
        if (view.editable === false || event.button !== 0 || event.shiftKey) return false
        const key = event.target?.closest?.('.hm-html-span')
        if (!key || !view.dom.contains(key)) return false
        const { state } = view
        const $pos = state.doc.resolve(pos)
        // The key that was clicked (two adjacent keys share the boundary).
        const range = tokenRanges($pos).find((r) => r.from <= pos && pos <= r.to && key.contains(view.domAtPos(r.from, 1).node))
        if (!range || (pos !== range.from && pos !== range.to)) return false
        view.dispatch(setSide(state, pos, range))
        view.focus()
        return true
      },

      handleDOMEvents: {
        // The tags push the key aside when they appear, so a second click on
        // the same spot lands on a tag: keep the caret in the key (at that
        // tag's edge) instead of leaving it — clicks used to toggle the tags
        // on and off.
        mousedown(view, event) {
          const tag = event.target?.closest?.('.hm-html-token-tag')
          if (!tag || !view.dom.contains(tag) || event.button !== 0 || view.editable === false) return false
          const range = caretContext(view.state)?.inside
          if (!range) return false
          event.preventDefault()
          const pos = tag.classList.contains('open') ? range.from : range.to
          view.dispatch(setSide(view.state, pos, range))
          view.focus()
          return true
        }
      },

      // Inside a key at its edge: type into the key and stay inside (the
      // stored marks are cleared by every edit).
      handleTextInput(view, from, to, text) {
        if (from !== to) return false
        const { state } = view
        const context = caretContext(state)
        const range = context?.inside
        if (!range || context.within) return false
        const marks = state.storedMarks || []
        const tr = state.tr.replaceWith(from, to, state.schema.text(text, marks))
        tr.setSelection(TextSelection.create(tr.doc, from + text.length))
        tr.setStoredMarks(marks)
        tr.setMeta(INSIDE, 'in')
        view.dispatch(tr.scrollIntoView())
        return true
      }
    },
    view: () => ({ update: (view) => placeDomCaret(view) })
  })
}
