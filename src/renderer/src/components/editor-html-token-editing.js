// Inline code and key-like inline HTML (`<kbd>Esc</kbd>`, <samp>, <var>,
// <tt>) are TOKENS: they edit the same way (Typora / Obsidian).
//
// The caret sits on one document position on both sides of a token's edge
// (`Esc|` inside the key and `|` after it are the same position), so the
// side is kept explicitly, in the stored marks; typing and IME follow it.
//   - at either edge the caret is OUTSIDE unless the user went in (a click
//     on the token, an arrow from outside, typing / composing inside);
//   - ←/→ at an edge first cross the delimiter (inside ↔ outside), then
//     move — so the start and the end of a token are reachable from the
//     keyboard, and typing there goes where the caret shows;
//   - while the caret is inside, the delimiters show around the token
//     (decorations, never in the document): backticks for inline code, the
//     authored tags in grey for a key — the same whether the caret came by
//     mouse or by keyboard (user report 2026-11-22: arrows into inline code
//     showed no backticks, its start could not be typed at).
//   - IME (user report 2026-11-22: editing a key name with a Chinese IME
//     went wrong): ProseMirror ends a composition whenever stored marks are
//     set while it runs, and passes composed text to handleTextInput too.
//     Setting the side during a composition tore each word apart (a key's
//     next word went after the key; inline code `ab` became `aabab`). So
//     nothing here touches the state while an IME composes; composed text
//     is ProseMirror's own transaction (marked as code when the browser
//     composed it inside the <code>), and the side is read from the DOM
//     caret when the composition ends.
// <font>/<span>/<u>/<b>… keep the inclusive behaviour of a style.
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

export const HTML_TOKEN_TAGS = new Set(['kbd', 'samp', 'var', 'tt'])

const tokenKey = new PluginKey('horsemd-html-token-editing')
const INSIDE = 'hmTokenInside'

const isKeyMark = (mark) => mark.type.name === 'html_span' && HTML_TOKEN_TAGS.has(String(mark.attrs.tag).toLowerCase())
const isCodeMark = (mark) => mark.type.name === 'inlineCode' || mark.type.name === 'code'
const kindOf = (mark) => (isCodeMark(mark) ? 'code' : isKeyMark(mark) ? 'key' : null)
const isTokenMark = (mark) => kindOf(mark) !== null
// The rendered element of a token (where the DOM caret goes when inside).
const TOKEN_ELEMENTS = '.hm-html-span, code'

// Ranges of tokens in the text block around `$pos`: [{ from, to, mark, kind }].
// A token is the run of inline nodes carrying the same mark (nested raw
// html atoms, other marks inside included).
function tokenRanges($pos) {
  const parent = $pos.parent
  if (!parent.isTextblock) return []
  const start = $pos.start()
  const ranges = []
  let open = null
  parent.forEach((node, offset) => {
    const from = start + offset
    const mark = (open && node.marks.find((m) => m.eq(open.mark))) || node.marks.find(isTokenMark)
    if (open && mark && mark.eq(open.mark) && open.to === from) {
      open.to = from + node.nodeSize
      return
    }
    open = mark ? { from, to: from + node.nodeSize, mark, kind: kindOf(mark) } : null
    if (open) ranges.push(open)
  })
  return ranges
}

// Where an empty selection is relative to the tokens of its text block.
//   inside: the token range the caret edits (strictly inside, or at an edge
//           with that token in the stored marks), else null
//   before / after: the token ending / starting at the caret
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

// The token the caret edits, for other plugins (inline-code typing).
export function tokenAtCaret(state) {
  return caretContext(state)?.inside || null
}

const withoutTokens = (marks) => marks.filter((mark) => !isTokenMark(mark))

// The marks for typing on a given side of `pos`: the marks around the caret
// without any token, plus `range.mark` for inside.
function sideMarks(state, pos, range) {
  const $pos = state.doc.resolve(pos)
  const base = withoutTokens(range ? markSetAt(state, range) : $pos.marks())
  return range ? range.mark.addToSet(base) : base
}
// Marks of the token's own text (so a key inside bold stays bold).
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

// `pos` of the state before `transactions`, in the state after them.
function mapPos(transactions, pos) {
  return transactions.reduce((at, tr) => tr.mapping.map(at, -1), pos)
}

// Composed (IME) text reaches handleTextInput while the composition runs
// and in the read right after it ends.
function fromComposition(view) {
  if (view.composing) return true
  const ended = view.input?.compositionEndedAt
  return typeof ended === 'number' && typeof performance !== 'undefined' && performance.now() - ended < 150
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

const backtickWidget = (side) => () => {
  const delimiter = document.createElement('span')
  delimiter.className = `hm-inline-code-delimiter ${side}`
  delimiter.contentEditable = 'false'
  delimiter.setAttribute('aria-hidden', 'true')
  delimiter.textContent = '`'
  return delimiter
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
  if (range.kind === 'code') {
    return DecorationSet.create(state.doc, [
      Decoration.widget(range.from, backtickWidget('open'), { key: 'hm-inline-code-open', side: -1, marks: [] }),
      Decoration.widget(range.to, backtickWidget('close'), { key: 'hm-inline-code-close', side: 1, marks: [] })
    ])
  }
  const labels = tagLabels(range.mark)
  return DecorationSet.create(state.doc, [
    // marks: [] — drawn outside every mark, never inside a neighbouring key.
    Decoration.widget(range.from, tagWidget(labels.open, labels.openTitle, 'open'), { key: `hm-token-open:${labels.openTitle}`, side: -1, marks: [] }),
    Decoration.widget(range.to, tagWidget(labels.close, '', 'close'), { key: `hm-token-close:${labels.close}`, side: 1, marks: [] })
  ])
}

// Put the DOM caret on the side of the token edge the state says: the
// browser keeps it inside <kbd> / <code> at its end, where Chromium would
// also compose IME text.
function placeDomCaret(view) {
  // While (and right after) an IME composes, the browser's caret is where
  // the text goes; moving it would move the rest of the composition.
  if (fromComposition(view) || !view.hasFocus?.()) return
  const context = caretContext(view.state)
  if (!context || context.within) return
  const { head, before, after, inside } = context
  if (!before && !after) return
  // inside the token ending here → end of its text; inside the token
  // starting here → start of its text; outside → between / next to them.
  let side
  if (inside) side = inside === before ? -1 : 1
  else side = before ? 1 : -1
  try {
    const point = view.domAtPos(head, side)
    const selection = view.dom.ownerDocument.getSelection()
    if (!point || !selection) return
    const inToken = (node) => {
      const element = node?.nodeType === 1 ? node : node?.parentElement
      return Boolean(element?.closest?.(TOKEN_ELEMENTS))
    }
    // Already on the right side: leave the browser's caret alone.
    const current = selection.rangeCount ? selection.getRangeAt(0) : null
    if (current?.collapsed && inToken(current.startContainer) === Boolean(inside) && current.startContainer === point.node && current.startOffset === point.offset) return
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

// The token element (of `range`) the DOM caret is in, if any.
function domCaretInToken(view, range) {
  const selection = view.dom.ownerDocument.getSelection()
  const node = selection?.focusNode
  const element = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(TOKEN_ELEMENTS)
  if (!element || !view.dom.contains(element)) return false
  try {
    return element.contains(view.domAtPos(range.from, 1).node)
  } catch {
    return false
  }
}

// IME text: ProseMirror inserts it (its transaction carries the composition;
// a replacement transaction broke the composition). Inline code does not
// continue at its end (inclusive: false), so text the browser composed
// inside the <code> at its end would be read as text after it — the DOM
// and the document disagree and the composition is torn apart. Give that
// text the token's mark in ProseMirror's own transaction.
function composedIntoToken(view, from, to, text, deflt) {
  if (typeof deflt !== 'function' || !text) return false
  const ranges = tokenRanges(view.state.doc.resolve(from))
  const range = ranges.find((r) => r.to === from) || ranges.find((r) => r.to === to && r.from < from)
  if (!range || range.kind !== 'code' || !domCaretInToken(view, range)) return false
  const tr = deflt()
  if (!tr) return false
  tr.addMark(from, from + text.length, range.mark)
  view.dispatch(tr)
  return true
}

// After a composition: the caret at a token edge takes the side the DOM
// caret is on (inside the token's element = inside).
function alignSideWithDom(view) {
  const { state } = view
  const context = caretContext(state)
  if (!context || context.within) return
  const range = [context.before, context.after].find((r) => r && domCaretInToken(view, r)) || null
  if ((context.inside || null) === range || (range && context.inside && context.inside.mark.eq(range.mark) && context.inside.from === range.from)) return
  if (!range && !context.inside) return
  view.dispatch(setSide(state, context.head, range))
}

/** Raw ProseMirror plugin (prosePluginsCtx). `onEdit` / `onValueChange`:
 * the Editor's edit marker and sync notification for the edits this plugin
 * dispatches itself (Milkdown does not report every plugin transaction). */
export function createHtmlTokenEditingPlugin({ onEdit, onValueChange } = {}) {
  const dispatchEdit = (view, tr) => {
    onEdit?.()
    view.dispatch(tr.scrollIntoView())
    onValueChange?.()
  }
  let pluginView = null
  return new Plugin({
    key: tokenKey,
    // A caret that lands on a token edge without a decided side (click next
    // to the token, arrows, Home/End, Enter/Backspace joins, a typed closing
    // tag / backtick) is outside, unless an edit made inside the token left
    // it there (Backspace at its end). After IME: alignSideWithDom.
    appendTransaction(transactions, oldState, newState) {
      // Never during an IME composition: ProseMirror ends a composition when
      // stored marks are set (prosemirror-view updateStateInner), which tore
      // every composed word at a token edge apart. The side is settled from
      // the DOM once it ends (compositionend → alignSideWithDom).
      if (pluginView && fromComposition(pluginView)) return null
      if (transactions.some((tr) => tr.getMeta(INSIDE))) return null
      const context = caretContext(newState)
      if (!context || context.within || (!context.before && !context.after)) return null
      if (newState.storedMarks) return null
      const edited = transactions.some((tr) => tr.docChanged)
      // An edit inside the token, or a selection reset to the same spot (the
      // DOM selection read back after a click), keeps the side it had.
      // Into another text block (Enter, a join) only from the middle of the
      // token: Enter inside inline code continues it on the new line, like
      // bold; Enter at its edge starts the line outside it.
      const old = caretContext(oldState)
      const was = old?.inside
      const sameBlock = was && mapPos(transactions, oldState.selection.$head.start()) === newState.selection.$head.start()
      if (was && (sameBlock || old.within) && (edited || old.head === context.head)) {
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
        const element = event.target?.closest?.(TOKEN_ELEMENTS)
        if (!element || !view.dom.contains(element)) return false
        const { state } = view
        const $pos = state.doc.resolve(pos)
        // The token that was clicked (two adjacent tokens share the boundary).
        const range = tokenRanges($pos).find((r) => r.from <= pos && pos <= r.to && element.contains(view.domAtPos(r.from, 1).node))
        if (!range || (pos !== range.from && pos !== range.to)) return false
        view.dispatch(setSide(state, pos, range))
        view.focus()
        return true
      },

      handleDOMEvents: {
        // After an IME composition the browser's caret is where the text went:
        // a token edge inside the token's element means the caret is inside.
        compositionend(view) {
          setTimeout(() => { if (!view.isDestroyed && !view.composing) alignSideWithDom(view) }, 0)
          // and once more after ProseMirror's late read of the last change
          setTimeout(() => { if (!view.isDestroyed && !view.composing) alignSideWithDom(view) }, 200)
          return false
        },
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

      // Inside a token at its edge: type into it and stay inside (the stored
      // marks are cleared by every edit). A backtick typed at the end of
      // inline code leaves it (the closing delimiter), as when it was made.
      handleTextInput(view, from, to, text, deflt) {
        const { state } = view
        const context = caretContext(state)
        // IME text (or text read from the DOM while the selection is the
        // composition range): ProseMirror's own transaction, marked right.
        if (fromComposition(view) || !context) return composedIntoToken(view, from, to, text, deflt)
        if (from !== to) return false
        const range = context?.inside
        if (!range || context.within) return false
        if (range.kind === 'code' && text === '`' && range === context.before) {
          view.dispatch(setSide(state, from, null))
          return true
        }
        const marks = state.storedMarks || []
        const tr = state.tr.replaceWith(from, to, state.schema.text(text, marks))
        tr.setSelection(TextSelection.create(tr.doc, from + text.length))
        tr.setStoredMarks(marks)
        tr.setMeta(INSIDE, 'in')
        dispatchEdit(view, tr)
        return true
      }
    },
    view: (view) => {
      pluginView = view
      return {
        update: (current) => placeDomCaret(current),
        destroy: () => { pluginView = null }
      }
    }
  })
}
