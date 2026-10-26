// Heading folding: a folded heading hides the rest of its section — every
// top-level block after it up to the next heading of the same or a higher
// level (so an H2 hides its paragraphs and its H3/H4 sub-sections).
//
// View-only. The folds are plugin state + node decorations (a class on the
// hidden blocks); nothing is written to the Markdown, the document never turns
// dirty, and the folds are not saved (like code folds in an editor).
//
// Nothing is ever typed into hidden content: when the selection lands inside
// a folded section (arrow keys, find, outline jump, undo, search result), the
// folds around it open. A fold command that would hide the caret moves it to
// the end of the folded heading first.
//
// The toggle buttons live in an overlay next to the editor DOM (never inside
// the contenteditable), right after the heading text, so they never collide
// with the block handle in the leading gutter.
import { AllSelection, NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

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

// One pass over the top-level blocks. For every folded heading that hides at
// least one block: its section range and hidden count. `hidden` lists each
// hidden block once (nested folds hide the same blocks).
export function computeFolds(doc, foldedPositions) {
  const folded = new Set(foldedPositions)
  const sections = new Map() // heading pos -> { from, to, level, count }
  const hidden = []
  const stack = [] // open sections: { pos, level, folded }
  let openFolded = 0
  const close = (entry, at) => {
    const info = sections.get(entry.pos)
    if (info) info.to = at
  }
  doc.forEach((child, offset) => {
    if (isHeading(child)) {
      const level = levelOf(child)
      while (stack.length && stack[stack.length - 1].level >= level) {
        const entry = stack.pop()
        if (entry.folded) openFolded -= 1
        close(entry, offset)
      }
    }
    if (openFolded > 0) {
      hidden.push({ from: offset, to: offset + child.nodeSize })
      for (const entry of stack) if (entry.folded) sections.get(entry.pos).count += 1
    }
    if (isHeading(child)) {
      const isFolded = folded.has(offset)
      stack.push({ pos: offset, level: levelOf(child), folded: isFolded })
      if (isFolded) {
        openFolded += 1
        sections.set(offset, { from: offset + child.nodeSize, to: doc.content.size, level: levelOf(child), count: 0 })
      }
    }
  })
  for (const [pos, info] of sections) if (!info.count) sections.delete(pos)
  return { positions: [...sections.keys()], sections, hidden }
}

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

const applyAction = (meta, folded, doc) => {
  const set = new Set(folded)
  switch (meta.action) {
    case 'toggle':
      if (set.has(meta.pos)) set.delete(meta.pos)
      else set.add(meta.pos)
      break
    case 'fold':
      set.add(meta.pos)
      break
    case 'unfold':
      set.delete(meta.pos)
      break
    case 'level': {
      const positions = topLevelHeadingPositions(doc, meta.level)
      positions.forEach((pos) => (meta.fold ? set.add(pos) : set.delete(pos)))
      break
    }
    case 'foldAll':
      topLevelHeadingPositions(doc).forEach((pos) => set.add(pos))
      break
    case 'unfoldAll':
      set.clear()
      break
    case 'reveal':
      for (const pos of meta.positions || []) set.delete(pos)
      break
    default:
      break
  }
  return [...set]
}

// Actions that may hide the caret on purpose (it is moved, not unfolded).
const FOLDING_ACTIONS = new Set(['toggle', 'fold', 'level', 'foldAll'])

export function createHeadingFoldPlugin(getT) {
  const t = (key, fallback, vars = {}) => {
    const value = getT?.(key)
    let text = String(!value || value === key ? fallback : value)
    for (const [name, v] of Object.entries(vars)) text = text.replace(`{${name}}`, String(v))
    return text
  }

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
          const info = computeFolds(state.doc, prev.folded.filter((pos) => !around.includes(pos)))
          if (!info.positions.length) return EMPTY
          return { folded: info.positions, info, decorations: buildDecorations(state.doc, info), suspended: false }
        }
        let folded = prev.folded
        if (tr.docChanged && folded.length) {
          folded = folded.map((pos) => tr.mapping.map(pos, 1))
            .filter((pos) => {
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
          if (around.length) info = computeFolds(state.doc, info.positions.filter((pos) => !around.includes(pos)))
        }
        if (!info.positions.length && !prev.folded.length && !suspended && !prev.suspended) return EMPTY
        return {
          folded: info.positions,
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
      decorations: (state) => headingFoldKey.getState(state)?.decorations
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
