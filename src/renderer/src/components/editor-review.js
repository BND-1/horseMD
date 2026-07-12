import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import {
  closeReviewGroupState,
  mapReviewTextblockGroupState,
  normalizeReviewPluginState
} from './editor-review-model.js'
import { collectReviewDecorations } from './editor-review-decorations.js'
import {
  renderReviewCard,
  reviewText,
  stopReviewWidgetEvent,
  stopReviewWidgetMouseDown
} from './editor-review-card.js'
import {
  REVIEW_KINDS,
  wrapReviewSelection
} from '../reviewMarkup.js'

export { REVIEW_KINDS }
export {
  cycleReviewGroupActiveIndex,
  getReviewGroupRemovalMeta,
  groupReviewAnnotationParts,
  mapReviewTextblockGroupState,
  parseParsedHighlightCommentClose,
  resolveReviewGroupActiveIndex
} from './editor-review-model.js'
export { buildReviewParagraphSnippet } from './editor-review-card.js'

const REVIEW_PLUGIN_KEY = new PluginKey('hm-review-markup')

function createReviewWidget(part, options = {}, view) {
  const widget = document.createElement('span')
  widget.contentEditable = 'false'

  if (part.role === 'comment-stack') {
    // A stack of all the comment-margin notes on one line, anchored to the
    // right margin. Badges fan (overlap) when collapsed; CSS spreads them on
    // hover. Hovering/clicking a badge opens that note's card.
    widget.className = `hm-review-widget hm-review-margin-note hm-review-stack${part.openNote ? ' hm-review-margin-note-open' : ''}`
    const badges = document.createElement('span')
    badges.className = 'hm-review-stack-badges'
    part.notes.forEach((note, i) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'hm-review-note-button'
      btn.textContent = String(note.noteIndex || i + 1)
      btn.style.setProperty('--i', i)
      const open = () =>
        view?.dispatch(
          view.state.tr.setMeta(REVIEW_PLUGIN_KEY, {
            type: 'activate',
            groupKey: note.groupKey,
            activeKey: note.annotation?.key,
            activeIndex: 0
          })
        )
      btn.addEventListener('mousedown', stopReviewWidgetMouseDown)
      btn.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        open()
      })
      badges.appendChild(btn)
    })
    widget.appendChild(badges)

    // Card for the open note (if any) — reuses the shared card renderer (number X/Y,
    // nav, icon actions, prominent comment).
    if (part.openNote) {
      const card = document.createElement('span')
      card.className = 'hm-review-card'
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-label', reviewText(options, 'review.cardTitle', 'Review note'))
      card.addEventListener('mousedown', stopReviewWidgetEvent)
      card.addEventListener('click', stopReviewWidgetEvent)
      renderReviewCard(card, view, part.openNote, options, REVIEW_PLUGIN_KEY)
      widget.appendChild(card)
    }

    // Keep the card open while the pointer is over the stack/card; close on leave.
    // Also toggle an "expanded" class (not CSS :hover) to spread the badges —
    // :hover flickered when the pointer crossed gaps between circular badges.
    let closeTimer = 0
    widget.addEventListener('mouseenter', () => {
      window.clearTimeout(closeTimer)
      widget.classList.add('hm-review-stack-expanded')
    })
    widget.addEventListener('mouseleave', () => {
      widget.classList.remove('hm-review-stack-expanded')
      closeTimer = window.setTimeout(() => {
        view?.dispatch(view.state.tr.setMeta(REVIEW_PLUGIN_KEY, { type: 'close' }))
      }, 220)
    })
    return widget
  }

  if (part.role === 'comment-margin') {
    widget.className = `hm-review-widget hm-review-margin-note${part.crowded ? ' hm-review-margin-crowded' : ''}${part.open ? ' hm-review-margin-note-open' : ''}`
    widget.title = part.title || ''
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'hm-review-note-button'
    button.textContent = part.label || ''
    const noteCount = Array.isArray(part.annotations)
      ? part.annotations.length
      : Number(part.label) || 1
    button.setAttribute('aria-expanded', part.open ? 'true' : 'false')
    button.setAttribute(
      'aria-label',
        reviewText(
        options,
        noteCount === 1 ? 'review.groupAriaLabelOne' : 'review.groupAriaLabelMany',
        noteCount === 1 ? 'Open 1 review comment' : 'Open {count} review comments',
        { count: noteCount }
      )
    )
    button.addEventListener('mousedown', stopReviewWidgetMouseDown)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view?.dispatch(
        view.state.tr.setMeta(REVIEW_PLUGIN_KEY, {
          type: 'toggle',
          groupKey: part.groupKey,
          activeKey: part.annotation?.key,
          activeIndex: Number.isInteger(part.activeIndex) ? part.activeIndex : 0
        })
      )
    })
    // Hover to expand (desktop): enter the widget (button or card) opens it
    // after a short delay; leaving closes it after a delay. Timers tolerate the
    // visual gap between button and card. Click (above) still works for touch.
    let openTimer = 0
    let closeTimer = 0
    widget.addEventListener('mouseenter', () => {
      window.clearTimeout(closeTimer)
      if (part.open) return
      openTimer = window.setTimeout(() => {
        view?.dispatch(
          view.state.tr.setMeta(REVIEW_PLUGIN_KEY, {
            type: 'toggle',
            groupKey: part.groupKey,
            activeKey: part.annotation?.key,
            activeIndex: Number.isInteger(part.activeIndex) ? part.activeIndex : 0
          })
        )
      }, 120)
    })
    widget.addEventListener('mouseleave', () => {
      window.clearTimeout(openTimer)
      closeTimer = window.setTimeout(() => {
        view?.dispatch(view.state.tr.setMeta(REVIEW_PLUGIN_KEY, { type: 'close' }))
      }, 220)
    })
    widget.appendChild(button)

    if (part.open && part.annotation) {
      const card = document.createElement('span')
      card.className = 'hm-review-card'
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-label', reviewText(options, 'review.cardTitle', 'Review note'))
      card.addEventListener('mousedown', stopReviewWidgetEvent)
      card.addEventListener('click', stopReviewWidgetEvent)
      renderReviewCard(card, view, part, options, REVIEW_PLUGIN_KEY)
      widget.appendChild(card)
    }
    return widget
  }

  if (part.role === 'substitution-replacement') {
    widget.className = 'hm-review-widget hm-review-sub-replacement'

    const oldText = document.createElement('span')
    oldText.className = 'hm-review-mark hm-review-del hm-review-sub-render-old'
    oldText.textContent = part.oldText || ''

    const arrow = document.createElement('span')
    arrow.className = 'hm-review-sub-arrow'
    arrow.textContent = '->'
    arrow.setAttribute('aria-hidden', 'true')

    const newText = document.createElement('span')
    newText.className = 'hm-review-mark hm-review-add hm-review-sub-render-new'
    newText.textContent = part.newText || ''

    widget.append(oldText, arrow, newText)
    widget.setAttribute(
      'aria-label',
      `Review substitution: ${part.oldText || ''} to ${part.newText || ''}`
    )
    return widget
  }

  widget.className = 'hm-review-widget hm-review-sub-arrow'
  widget.textContent = part.label || '->'
  widget.setAttribute('aria-hidden', 'true')
  return widget
}

function addActiveAnnotationDecoration(decorations, annotation) {
  if (!annotation?.text) return
  const from = annotation.source === 'raw' ? annotation.from + 3 : annotation.from + 1
  const to = from + annotation.text.length
  if (to <= from) return
  decorations.push(
    Decoration.inline(from, to, {
      class: 'hm-review-mark-active'
    })
  )
}

export function createReviewDecorationPlugin(options = {}) {
  return new Plugin({
    key: REVIEW_PLUGIN_KEY,
    state: {
      init() {
        return closeReviewGroupState()
      },
      apply(tr, pluginState) {
        const meta = tr.getMeta(REVIEW_PLUGIN_KEY)
        const state = normalizeReviewPluginState(pluginState)
        if (meta?.type === 'toggle') {
          if (state.openGroupKey === meta.groupKey) {
            return closeReviewGroupState()
          }

          return {
            openGroupKey: meta.groupKey || null,
            activeKey: meta.activeKey || null,
            activeIndex: Number.isInteger(meta.activeIndex) ? meta.activeIndex : 0
          }
        }
        if (meta?.type === 'activate') {
          return {
            openGroupKey: meta.groupKey || state.openGroupKey,
            activeKey: meta.activeKey || null,
            activeIndex: Number.isInteger(meta.activeIndex) ? meta.activeIndex : state.activeIndex
          }
        }
        if (meta?.type === 'close') return closeReviewGroupState()
        if (meta) return state
        if (tr.docChanged) {
          return mapReviewTextblockGroupState(state, tr.mapping, tr.doc.content.size)
        }
        return state
      }
    },
    props: {
      // A mousedown anywhere in the editor that isn't on the margin-note button
      // or the card itself closes any open review card. Using handleDOMEvents
      // (not handleClick) so it fires reliably for every editor click — headings,
      // paragraphs, code, etc. — not just position-mapped text clicks.
      handleDOMEvents: {
        mousedown(view, event) {
          if (event?.target?.closest?.('.hm-review-note-button, .hm-review-card')) return false
          const st = REVIEW_PLUGIN_KEY.getState(view.state)
          if (st?.openGroupKey) {
            view.dispatch(view.state.tr.setMeta(REVIEW_PLUGIN_KEY, { type: 'close' }))
          }
          return false
        }
      },
      decorations(state) {
        const pluginState = REVIEW_PLUGIN_KEY.getState(state) || closeReviewGroupState()
        const { decorations, widgetList } = collectReviewDecorations(state, pluginState)

        // Global note list (for X/Y numbering + cross-note prev/next nav).
        // widgetList is already sorted by pos, so comment-margin widgets here
        // are in document order.
        const notes = widgetList.filter((w) => w.part?.role === 'comment-margin' && w.part.groupKey)
        const noteTotal = notes.length
        notes.forEach((w, i) => {
          const prev = i > 0 ? notes[i - 1] : null
          const next = i < notes.length - 1 ? notes[i + 1] : null
          w.part.noteIndex = i + 1
          w.part.noteTotal = noteTotal
          w.part.prevNoteKey = prev ? prev.part.groupKey : null
          w.part.nextNoteKey = next ? next.part.groupKey : null
          w.part.prevNotePos = prev ? prev.pos : null
          w.part.nextNotePos = next ? next.pos : null
        })

        // Group comment-margin notes by paragraph (textblock) → render ONE
        // stack widget per paragraph (all the line's badges in one container,
        // fanned + hover-expandable) instead of one widget per note. A single
        // note is just a stack of 1 (same right-margin look as before).
        const stacksByParent = new Map()
        for (const item of widgetList) {
          if (item.part?.role !== 'comment-margin') continue
          let parentStart = item.pos
          try {
            const $pos = state.doc.resolve(item.pos)
            parentStart = $pos.start($pos.depth)
          } catch { /* fallback to pos */ }
          if (!stacksByParent.has(parentStart)) stacksByParent.set(parentStart, [])
          stacksByParent.get(parentStart).push(item)
        }

        // Non-comment-margin parts (substitution etc.): one widget each, unchanged.
        widgetList.forEach(({ pos, part }) => {
          if (part.role === 'comment-margin') return // rendered as a stack below
          decorations.push(
            Decoration.widget(pos, (view) => createReviewWidget(part, options, view), {
              key: `${part.role}:${pos}:${part.groupKey || part.title || ''}`,
              side: -1,
              marks: [],
              stopEvent: (event) => Boolean(event.target?.closest?.('.hm-review-card, .hm-review-note-button'))
            })
          )
        })

        // One stack widget per paragraph (positioned at the paragraph's last note).
        for (const [parentStart, items] of stacksByParent) {
          const last = items[items.length - 1]
          const stackNotes = items.map((it) => it.part)
          const openNote = stackNotes.find((n) => n.open) || null
          if (openNote?.annotation) addActiveAnnotationDecoration(decorations, openNote.annotation)
          const stackPart = { role: 'comment-stack', notes: stackNotes, openNote, groupKey: stackNotes[0]?.groupKey }
          decorations.push(
            Decoration.widget(last.pos, (view) => createReviewWidget(stackPart, options, view), {
              key:
                `comment-stack:${parentStart}:${stackNotes.length}:` +
                `${openNote?.groupKey || 'closed'}:${stackNotes.map((n) => n.noteIndex ?? '').join(',')}`,
              side: 1,
              marks: [],
              stopEvent: (event) =>
                Boolean(event.target?.closest?.('.hm-review-card, .hm-review-note-button, .hm-review-stack'))
            })
          )
        }

        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
}

export function applyReviewMarkupInView(view, kind) {
  if (!view) return { ok: false, reason: 'no-view' }

  const { from, to } = view.state.selection
  const selected = view.state.doc.textBetween(from, to, '\n')
  const result = wrapReviewSelection(selected, 0, selected.length, kind)
  if (result.error) return { ok: false, reason: result.error }

  let tr = view.state.tr.insertText(result.text, from, to)
  tr = tr.setSelection(
    TextSelection.create(
      tr.doc,
      from + result.selectionStart,
      from + result.selectionEnd
    )
  )
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return { ok: true }
}
