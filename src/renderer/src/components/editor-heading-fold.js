// Heading folding: a folded heading hides the rest of its section — every
// top-level block after it up to the next heading of the same or a higher
// level (so an H2 hides its paragraphs and its H3/H4 sub-sections).
//
// View-only. The folds are plugin state + node decorations (a class on the
// hidden blocks); nothing is written to the Markdown, the document never turns
// dirty, and the folds are not saved (like code folds in an editor).
//
// A fold remembers where its section ended when it was folded (`end`,
// mapped through edits so that text inserted exactly there stays outside):
// blocks added right after the folded content stay visible, as in Obsidian /
// Feishu. A fold never reaches past the next heading of the same or a higher
// level.
//
// Nothing is ever typed into hidden content: when the selection lands inside
// a folded section (arrow keys, find, outline jump, undo, search result), the
// folds around it open. A fold command that would hide the caret moves it to
// the end of the folded heading first. Enter at the end of a folded heading
// starts a new paragraph after the folded content (the next visible line) and
// keeps the fold; Backspace in that still-empty paragraph removes it and goes
// back to the heading's end. A folded heading carries its section: copying
// or cutting a selection that covers the whole heading takes the folded
// content too (`foldedSelectionRange`, used by the copy/cut handlers), and
// dragging it by the block handle moves (Alt/Ctrl: copies) the whole section,
// still folded at the drop point.
//
// The toggle buttons live in an overlay next to the editor DOM (never inside
// the contenteditable), right after the heading text, so they never collide
// with the block handle in the leading gutter.
import { AllSelection, NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import { dropPoint } from '@milkdown/prose/transform'

export const headingFoldKey = new PluginKey('hm-heading-fold')
// CustomEvent dispatched on (or inside) the editor DOM by the app:
//   detail.action: 'toggle' (heading around the caret) | 'foldAll' | 'unfoldAll'
//                | 'reveal' (open the folds around the event target)
export const HEADING_FOLD_EVENT = 'hm-heading-fold'
export const FOLD_HIDDEN_CLASS = 'hm-fold-hidden'

const FOLDED_CLASS = 'hm-heading-folded'
const BUTTON_CLASS = 'hm-fold-toggle'
const TOUCH = () => ['ios', 'android'].includes(globalThis.window?.api?.platform)

const isHeading = (node) => node?.type?.name === 'heading'
const levelOf = (node) => Number(node.attrs.level) || 1

// `folds`: [{ pos, end }] (or bare heading positions = fold to the natural
// end). For every folded heading that hides at least one block: its section
// range and hidden count. `hidden` lists each hidden block once (nested folds
// hide the same blocks).
export function computeFolds(doc, folds) {
  const wanted = new Map()
  for (const fold of folds) {
    if (typeof fold === 'number') wanted.set(fold, null)
    else if (fold && Number.isFinite(fold.pos)) wanted.set(fold.pos, Number.isFinite(fold.end) ? fold.end : null)
  }
  const starts = [] // top-level block offsets, then the document end
  const naturalEnd = new Map() // heading pos -> next same-or-higher heading (or doc end)
  const stack = []
  doc.forEach((child, offset) => {
    starts.push(offset)
    if (!isHeading(child)) return
    const level = levelOf(child)
    while (stack.length && stack[stack.length - 1].level >= level) naturalEnd.set(stack.pop().pos, offset)
    stack.push({ pos: offset, level })
  })
  for (const entry of stack) naturalEnd.set(entry.pos, doc.content.size)
  starts.push(doc.content.size)
  const indexOf = new Map(starts.map((offset, index) => [offset, index]))
  // A remembered end that no longer falls between top-level blocks (an edit
  // joined across it) snaps to the start of the block it falls in.
  const snap = (pos) => {
    const clamped = Math.max(0, Math.min(pos, doc.content.size))
    const $pos = doc.resolve(clamped)
    return $pos.depth === 0 ? clamped : $pos.before(1)
  }
  const sections = new Map() // heading pos -> { from, to, level, count }
  const ranges = []
  for (const [pos, remembered] of wanted) {
    if (!naturalEnd.has(pos)) continue
    const node = doc.nodeAt(pos)
    const from = pos + node.nodeSize
    const natural = naturalEnd.get(pos)
    const to = remembered == null ? natural : Math.max(from, Math.min(snap(remembered), natural))
    const count = indexOf.get(to) - indexOf.get(from)
    if (!(count > 0)) continue
    sections.set(pos, { from, to, level: levelOf(node), count })
    ranges.push({ from, to })
  }
  const hidden = []
  if (ranges.length) {
    ranges.sort((a, b) => a.from - b.from)
    let r = 0
    let reach = -1
    doc.forEach((child, offset) => {
      while (r < ranges.length && ranges[r].from <= offset) reach = Math.max(reach, ranges[r++].to)
      if (offset + child.nodeSize <= reach) hidden.push({ from: offset, to: offset + child.nodeSize })
    })
  }
  const positions = [...sections.keys()].sort((a, b) => a - b)
  return { positions, sections, hidden }
}

// The folds to keep in plugin state: every section's heading and its end.
const foldsOf = (info) => info.positions.map((pos) => ({ pos, end: info.sections.get(pos).to }))

// Does the top-level heading at `pos` have anything to fold?
export function headingHasSection(doc, pos) {
  const node = doc.nodeAt(pos)
  if (!isHeading(node) || doc.resolve(pos).depth !== 0) return false
  const next = doc.resolve(pos + node.nodeSize)
  const after = next.index(0) < doc.childCount ? doc.child(next.index(0)) : null
  return !!after && !(isHeading(after) && levelOf(after) <= levelOf(node))
}

const topLevelHeadingPositions = (doc, level = null) => {
  const out = []
  doc.forEach((child, offset) => {
    if (isHeading(child) && (level == null || levelOf(child) === level)) out.push(offset)
  })
  return out
}

// The top-level heading whose section holds `pos` (the heading itself when
// `pos` is in it), or -1.
export function headingAround(doc, pos) {
  const index = doc.resolve(Math.max(0, Math.min(pos, doc.content.size))).index(0)
  let offset = 0
  let found = -1
  for (let i = 0; i < doc.childCount && i <= index; i += 1) {
    const child = doc.child(i)
    if (isHeading(child)) found = offset
    offset += child.nodeSize
  }
  return found
}

const selectionPoint = (selection) => (
  selection instanceof NodeSelection ? selection.from : selection.head
)

// Is `pos` inside hidden content of `info`? Positions on the boundary in
// front of a hidden block belong to the visible block before it.
const hiddenSectionsAt = (info, pos, nodeSelection) => {
  const out = []
  for (const [headingPos, section] of info.sections) {
    const inside = nodeSelection
      ? pos >= section.from && pos < section.to
      : pos > section.from && pos < section.to
    if (inside) out.push(headingPos)
  }
  return out
}

const buildDecorations = (doc, info) => {
  if (!info.sections.size) return DecorationSet.empty
  const decos = []
  for (const pos of info.positions) {
    const node = doc.nodeAt(pos)
    if (node) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: FOLDED_CLASS }))
  }
  for (const range of info.hidden) decos.push(Decoration.node(range.from, range.to, { class: FOLD_HIDDEN_CLASS }))
  return DecorationSet.create(doc, decos)
}

const EMPTY = { folded: [], info: { positions: [], sections: new Map(), hidden: [] }, decorations: DecorationSet.empty, suspended: false }

const applyAction = (meta, folds, doc) => {
  const map = new Map(folds.map((fold) => [fold.pos, fold]))
  const add = (pos) => { if (!map.has(pos)) map.set(pos, { pos, end: null }) }
  switch (meta.action) {
    case 'toggle':
      if (map.has(meta.pos)) map.delete(meta.pos)
      else add(meta.pos)
      break
    case 'fold':
      add(meta.pos)
      break
    case 'unfold':
      map.delete(meta.pos)
      break
    case 'level': {
      const positions = topLevelHeadingPositions(doc, meta.level)
      positions.forEach((pos) => (meta.fold ? add(pos) : map.delete(pos)))
      break
    }
    case 'foldAll':
      topLevelHeadingPositions(doc).forEach(add)
      break
    case 'unfoldAll':
      map.clear()
      break
    case 'reveal':
      for (const pos of meta.positions || []) map.delete(pos)
      break
    case 'foldRange':
      map.set(meta.pos, { pos: meta.pos, end: meta.end })
      break
    default:
      break
  }
  return [...map.values()]
}

const plainKey = (event, key) => event.key === key && !event.shiftKey && !event.altKey &&
  !event.ctrlKey && !event.metaKey && !event.isComposing && event.keyCode !== 229

// The visible folded heading the caret sits at the end of, or -1.
const foldedHeadingAtCaret = (state, plugin) => {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return -1
  const { $from } = selection
  if ($from.depth !== 1 || !isHeading($from.parent) || $from.parentOffset !== $from.parent.content.size) return -1
  const pos = $from.before(1)
  if (!plugin.info.sections.has(pos) || plugin.info.hidden.some((range) => range.from === pos)) return -1
  return pos
}

// Enter at the end of a folded heading: a new paragraph after the folded
// content (the next visible line); the fold stays.
export function enterAfterFoldedHeading(view) {
  const { state } = view
  const plugin = headingFoldKey.getState(state)
  const paragraph = state.schema.nodes.paragraph
  if (!plugin || plugin.suspended || !paragraph) return false
  const pos = foldedHeadingAtCaret(state, plugin)
  if (pos < 0) return false
  const at = plugin.info.sections.get(pos).to
  const tr = state.tr.insert(at, paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView()
  view.dispatch(tr)
  return true
}

// Backspace in an empty paragraph right after folded content (the line Enter
// above made): remove it and go back to the end of the folded heading,
// instead of joining into the hidden block (which would open the fold).
export function backspaceAfterFold(view) {
  const { state } = view
  const plugin = headingFoldKey.getState(state)
  if (!plugin || plugin.suspended || !plugin.info.sections.size) return false
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const { $from } = selection
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size) return false
  const start = $from.before(1)
  const hiddenFrom = new Set(plugin.info.hidden.map((range) => range.from))
  let heading = -1
  for (const [pos, section] of plugin.info.sections) if (section.to === start && !hiddenFrom.has(pos)) heading = pos
  if (heading < 0) return false
  const node = state.doc.nodeAt(heading)
  const tr = state.tr.delete(start, start + $from.parent.nodeSize)
  tr.setSelection(TextSelection.create(tr.doc, heading + node.nodeSize - 1)).scrollIntoView()
  view.dispatch(tr)
  return true
}

// The range to copy / cut for the current selection when it covers the whole
// text of a visible folded heading whose section it does not reach: from the
// selection (a heading start → the heading node) to the section end. Null
// otherwise (a partial heading, no folds, empty selection).
export function foldedSelectionRange(state) {
  const plugin = headingFoldKey.getState(state)
  if (!plugin || plugin.suspended || !plugin.info.sections.size || state.selection.empty) return null
  let { from } = state.selection
  const { to } = state.selection
  const hiddenFrom = new Set(plugin.info.hidden.map((range) => range.from))
  let end = to
  for (const [pos, section] of plugin.info.sections) {
    if (hiddenFrom.has(pos) || section.to <= to) continue
    const node = state.doc.nodeAt(pos)
    if (from <= pos + 1 && to >= pos + node.nodeSize - 1) end = Math.max(end, section.to)
  }
  if (end === to) return null
  const $from = state.doc.resolve(from)
  if ($from.depth === 1 && $from.parentOffset === 0) from = $from.before(1)
  return { from, to: end }
}

const foldKeyDown = (view, event) => {
  if (!view.editable) return false
  let handled = false
  if (plainKey(event, 'Enter')) handled = enterAfterFoldedHeading(view)
  else if (plainKey(event, 'Backspace')) handled = backspaceAfterFold(view)
  if (handled) event.preventDefault?.()
  return handled
}

// Actions that may hide the caret on purpose (it is moved, not unfolded).
const FOLDING_ACTIONS = new Set(['toggle', 'fold', 'level', 'foldAll', 'foldRange'])

export function createHeadingFoldPlugin(getT) {
  const t = (key, fallback, vars = {}) => {
    const value = getT?.(key)
    let text = String(!value || value === key ? fallback : value)
    for (const [name, v] of Object.entries(vars)) text = text.replace(`{${name}}`, String(v))
    return text
  }

  // A block-handle drag of a folded heading: { slice, from, to }.
  let sectionDrag = null

  return new Plugin({
    key: headingFoldKey,
    state: {
      init: () => EMPTY,
      apply(tr, prev, _oldState, state) {
        const meta = tr.getMeta(headingFoldKey)
        if (!meta && !prev.folded.length) return prev
        if (!meta && !tr.docChanged && !tr.selectionSet) return prev
        // A caret move only matters when it lands in hidden content.
        if (!meta && !tr.docChanged) {
          if (prev.suspended || state.selection instanceof AllSelection) return prev
          const around = hiddenSectionsAt(prev.info, selectionPoint(state.selection), state.selection instanceof NodeSelection)
          if (!around.length) return prev
          const info = computeFolds(state.doc, prev.folded.filter((fold) => !around.includes(fold.pos)))
          if (!info.positions.length) return EMPTY
          return { folded: foldsOf(info), info, decorations: buildDecorations(state.doc, info), suspended: false }
        }
        let folded = prev.folded
        if (tr.docChanged && folded.length) {
          // The heading moves with text inserted in front of it; the end stays
          // in front of text inserted exactly there (that text is visible).
          // A deleted heading's fold goes (it used to land on the next heading).
          folded = folded.filter((fold) => !tr.mapping.mapResult(fold.pos, 1).deleted)
            .map((fold) => ({ pos: tr.mapping.map(fold.pos, 1), end: fold.end == null ? null : tr.mapping.map(fold.end, -1) }))
            .filter(({ pos }) => {
              if (pos < 0 || pos >= state.doc.content.size) return false
              return isHeading(state.doc.nodeAt(pos)) && state.doc.resolve(pos).depth === 0
            })
        }
        let suspended = prev.suspended
        if (meta?.action === 'suspend') suspended = meta.value === true
        else if (meta) folded = applyAction(meta, folded, state.doc)
        let info = computeFolds(state.doc, folded)
        // The caret never sits in hidden content: open what hides it, unless
        // this transaction folds on purpose (appendTransaction moves the caret).
        if (!suspended && !FOLDING_ACTIONS.has(meta?.action) && (tr.selectionSet || tr.docChanged) &&
          !(state.selection instanceof AllSelection) && info.sections.size) {
          const around = hiddenSectionsAt(info, selectionPoint(state.selection), state.selection instanceof NodeSelection)
          if (around.length) info = computeFolds(state.doc, foldsOf(info).filter((fold) => !around.includes(fold.pos)))
        }
        if (!info.positions.length && !prev.folded.length && !suspended && !prev.suspended) return EMPTY
        return {
          folded: foldsOf(info),
          info,
          decorations: suspended ? DecorationSet.empty : buildDecorations(state.doc, info),
          suspended
        }
      }
    },
    appendTransaction(trs, _oldState, state) {
      if (!trs.some((tr) => FOLDING_ACTIONS.has(tr.getMeta(headingFoldKey)?.action))) return null
      const { info } = headingFoldKey.getState(state)
      if (!info.sections.size || state.selection instanceof AllSelection) return null
      const around = hiddenSectionsAt(info, selectionPoint(state.selection), state.selection instanceof NodeSelection)
      if (!around.length) return null
      // The outermost fold is the visible heading.
      const outer = Math.min(...around)
      const heading = state.doc.nodeAt(outer)
      if (!heading) return null
      return state.tr
        .setSelection(TextSelection.create(state.doc, outer + heading.nodeSize - 1))
        .setMeta('addToHistory', false)
    },
    props: {
      decorations: (state) => headingFoldKey.getState(state)?.decorations,
      // DOM keydown runs before every plugin's keymap (Milkdown's Enter would
      // split the heading first); handleKeyDown covers the synthetic Enter
      // ProseMirror sends on Android.
      handleDOMEvents: { keydown: foldKeyDown },
      handleKeyDown: foldKeyDown,
      // Drop of a dragged folded section: move (or copy) the whole section
      // and keep it folded where it lands.
      handleDrop(view, event, _slice, moved) {
        const drag = sectionDrag
        sectionDrag = null
        if (!drag || view.dragging?.slice !== drag.slice || !view.editable) return false
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (!at) return false
        const { state } = view
        let insertPos = dropPoint(state.doc, at.pos, drag.slice)
        if (insertPos == null) insertPos = at.pos
        event.preventDefault()
        if (moved && insertPos >= drag.from && insertPos <= drag.to) return true // onto itself
        const tr = state.tr
        if (moved) tr.delete(drag.from, drag.to)
        const pos = tr.mapping.map(insertPos)
        tr.replaceRange(pos, pos, drag.slice)
        let start = pos
        let end = pos
        tr.mapping.maps[tr.mapping.maps.length - 1].forEach((_from, _to, newFrom, newTo) => { start = newFrom; end = newTo })
        const heading = tr.doc.nodeAt(start)
        if (isHeading(heading) && tr.doc.resolve(start).depth === 0) {
          tr.setSelection(NodeSelection.create(tr.doc, start))
          tr.setMeta(headingFoldKey, { action: 'foldRange', pos: start, end })
        } else {
          tr.setSelection(TextSelection.near(tr.doc.resolve(start)))
        }
        view.focus()
        view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView())
        return true
      }
    },
    view(editorView) {
      const root = editorView.dom.parentElement
      const layer = document.createElement('div')
      layer.className = 'hm-fold-layer'
      layer.setAttribute('aria-hidden', 'false')
      root?.appendChild(layer)
      const buttons = new Map() // heading pos -> button
      let hoverEl = null
      let raf = 0
      let destroyed = false

      const dispatchFold = (meta) => {
        if (destroyed) return
        editorView.dispatch(editorView.state.tr.setMeta(headingFoldKey, meta).setMeta('addToHistory', false))
      }

      const headingPosOf = (el) => {
        try {
          const pos = editorView.posAtDOM(el, 0) - 1
          const node = editorView.state.doc.nodeAt(pos)
          return isHeading(node) && editorView.state.doc.resolve(pos).depth === 0 ? pos : -1
        } catch {
          return -1
        }
      }

      const altName = () => (globalThis.window?.api?.platform === 'darwin' ? '⌥' : 'Alt')

      const makeButton = () => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = BUTTON_CLASS
        button.tabIndex = -1
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const pos = Number(button.dataset.pos)
          const node = editorView.state.doc.nodeAt(pos)
          if (!isHeading(node)) return
          if (event.altKey) {
            dispatchFold({ action: 'level', level: levelOf(node), fold: button.dataset.folded !== 'true' })
          } else {
            dispatchFold({ action: 'toggle', pos })
          }
        })
        return button
      }

      const render = () => {
        raf = 0
        if (destroyed || !root) return
        const { state } = editorView
        const { info } = headingFoldKey.getState(state)
        const targets = new Map() // pos -> folded?
        const hiddenSet = new Set(info.hidden.map((range) => range.from))
        for (const pos of info.positions) if (!hiddenSet.has(pos)) targets.set(pos, true)
        const extra = []
        if (hoverEl?.isConnected) extra.push(headingPosOf(hoverEl))
        if (TOUCH() && state.selection.empty) {
          const pos = headingAround(state.doc, state.selection.from)
          if (pos >= 0 && state.doc.resolve(state.selection.from).index(0) === state.doc.resolve(pos).index(0)) extra.push(pos)
        }
        for (const pos of extra) {
          if (pos >= 0 && !targets.has(pos) && !hiddenSet.has(pos) && headingHasSection(state.doc, pos)) targets.set(pos, false)
        }
        for (const [pos, button] of buttons) {
          if (!targets.has(pos)) {
            button.remove()
            buttons.delete(pos)
          }
        }
        if (!targets.size) return
        const layerRect = layer.getBoundingClientRect()
        for (const [pos, folded] of targets) {
          const el = editorView.nodeDOM(pos)
          if (!(el instanceof HTMLElement)) continue
          let button = buttons.get(pos)
          if (!button) {
            button = makeButton()
            buttons.set(pos, button)
            layer.appendChild(button)
          }
          const node = state.doc.nodeAt(pos)
          const level = levelOf(node)
          const count = info.sections.get(pos)?.count || 0
          const label = folded
            ? t('fold.heading.unfold', 'Expand ({n} blocks folded)', { n: count })
            : t('fold.heading.fold', 'Fold this section')
          const title = `${label}\n${t(folded ? 'fold.heading.altUnfold' : 'fold.heading.altFold', `${altName()}-click: all H{level}`, { alt: altName(), level })}`
          if (button.dataset.pos !== String(pos)) button.dataset.pos = String(pos)
          if (button.dataset.folded !== String(folded)) {
            button.dataset.folded = String(folded)
            button.setAttribute('aria-expanded', folded ? 'false' : 'true')
            button.innerHTML = folded
              ? '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg><span class="hm-fold-dots">⋯</span>'
              : '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>'
          }
          if (button.title !== title) {
            button.title = title
            button.setAttribute('aria-label', label)
          }
          // Right after the heading text, centred on its last line.
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height)
          const last = rects[rects.length - 1]
          const box = el.getBoundingClientRect()
          const anchorRight = last ? last.right : box.left
          const midY = last ? last.top + last.height / 2 : box.top + box.height / 2
          const left = `${Math.round(anchorRight - layerRect.left + 8)}px`
          const top = `${Math.round(midY - layerRect.top - 11)}px`
          if (button.style.left !== left) button.style.left = left
          if (button.style.top !== top) button.style.top = top
        }
      }
      const schedule = () => {
        if (!raf && !destroyed) raf = requestAnimationFrame(render)
      }

      const headingFromTarget = (target) => {
        const el = target instanceof Element ? target.closest('h1, h2, h3, h4, h5, h6') : null
        return el && el.parentElement === editorView.dom ? el : null
      }
      const onMove = (event) => {
        if (event.target instanceof Element && event.target.closest(`.${BUTTON_CLASS}`)) return
        const el = headingFromTarget(event.target)
        if (el !== hoverEl) {
          hoverEl = el
          schedule()
        }
      }
      const onLeave = () => {
        if (!hoverEl) return
        hoverEl = null
        schedule()
      }
      const onFoldEvent = (event) => {
        const action = event.detail?.action
        const { state } = editorView
        if (action === 'reveal') {
          const { info } = headingFoldKey.getState(state)
          if (!info.sections.size) return
          let pos
          try {
            pos = editorView.posAtDOM(event.target, 0)
          } catch {
            return
          }
          const around = hiddenSectionsAt(info, pos, true)
          if (around.length) dispatchFold({ action: 'reveal', positions: around })
        } else if (action === 'toggle') {
          const pos = headingAround(state.doc, selectionPoint(state.selection))
          if (pos < 0) return
          const { info } = headingFoldKey.getState(state)
          if (!info.sections.has(pos) && !headingHasSection(state.doc, pos)) return
          dispatchFold({ action: 'toggle', pos })
        } else if (action === 'foldAll' || action === 'unfoldAll') {
          dispatchFold({ action })
        } else if (action === 'suspend') {
          dispatchFold({ action: 'suspend', value: event.detail?.value === true })
        }
        if (event.detail) event.detail.handled = true
      }

      // After the block handle's dragstart (Milkdown selected the heading
      // node and set view.dragging to it alone): drag the whole section.
      const onDragStart = (event) => {
        sectionDrag = null
        const dragging = editorView.dragging
        const sel = editorView.state.selection
        if (!dragging || !(sel instanceof NodeSelection) || !isHeading(sel.node) || sel.$from.depth !== 0) return
        const { info, suspended } = headingFoldKey.getState(editorView.state)
        const section = info.sections.get(sel.from)
        if (suspended || !section || info.hidden.some((range) => range.from === sel.from)) return
        const slice = editorView.state.doc.slice(sel.from, section.to)
        editorView.dragging = { slice, move: dragging.move }
        sectionDrag = { slice, from: sel.from, to: section.to }
        if (event.dataTransfer) {
          const { dom, text } = editorView.serializeForClipboard(slice)
          event.dataTransfer.setData('text/html', dom.innerHTML)
          event.dataTransfer.setData('text/plain', text)
        }
      }
      const onDragEnd = () => { sectionDrag = null }
      document.addEventListener('dragstart', onDragStart)
      document.addEventListener('dragend', onDragEnd)
      root?.addEventListener('pointermove', onMove, true)
      root?.addEventListener('pointerleave', onLeave)
      editorView.dom.addEventListener(HEADING_FOLD_EVENT, onFoldEvent)
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
      resize?.observe(editorView.dom)

      return {
        update(view, prevState) {
          const now = headingFoldKey.getState(view.state)
          const before = headingFoldKey.getState(prevState)
          if (now !== before || buttons.size || (view.state.selection !== prevState.selection && TOUCH())) schedule()
        },
        destroy() {
          destroyed = true
          if (raf) cancelAnimationFrame(raf)
          resize?.disconnect()
          document.removeEventListener('dragstart', onDragStart)
          document.removeEventListener('dragend', onDragEnd)
          root?.removeEventListener('pointermove', onMove, true)
          root?.removeEventListener('pointerleave', onLeave)
          editorView.dom.removeEventListener(HEADING_FOLD_EVENT, onFoldEvent)
          layer.remove()
        }
      }
    }
  })
}

// Context-menu info for the top-level heading at `pos` (null elsewhere).
export function headingFoldContext(state, pos) {
  if (!Number.isFinite(pos)) return null
  const at = headingAround(state.doc, pos)
  if (at < 0) return null
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)))
  if ($pos.index(0) !== state.doc.resolve(at).index(0)) return null
  const { info } = headingFoldKey.getState(state) || EMPTY
  const folded = info.sections.has(at)
  return {
    pos: at,
    level: levelOf(state.doc.nodeAt(at)),
    folded,
    foldable: folded || headingHasSection(state.doc, at),
    anyFolded: info.sections.size > 0
  }
}

export function runHeadingFold(view, meta) {
  if (!view) return false
  view.dispatch(view.state.tr.setMeta(headingFoldKey, meta).setMeta('addToHistory', false))
  return true
}

// Export snapshots measure the live DOM (table widths…): show everything for
// the snapshot, then fold again.
export function suspendHeadingFolds(view) {
  const state = view && headingFoldKey.getState(view.state)
  if (!state?.folded.length || state.suspended) return () => {}
  runHeadingFold(view, { action: 'suspend', value: true })
  return () => runHeadingFold(view, { action: 'suspend', value: false })
}

export { FOLDED_CLASS as HEADING_FOLDED_CLASS }
