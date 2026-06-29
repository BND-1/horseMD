import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import {
  REVIEW_KINDS,
  getReviewMarkupDisplayParts,
  wrapReviewSelection
} from '../reviewMarkup.js'

export { REVIEW_KINDS }

const REVIEW_PLUGIN_KEY = new PluginKey('hm-review-markup')

const REVIEW_CLASS_BY_ROLE = {
  syntax: 'hm-review-syntax',
  [REVIEW_KINDS.addition]: 'hm-review-mark hm-review-add',
  [REVIEW_KINDS.deletion]: 'hm-review-mark hm-review-del',
  'substitution-old': 'hm-review-mark hm-review-del hm-review-sub-old',
  'substitution-new': 'hm-review-mark hm-review-add hm-review-sub-new',
  [REVIEW_KINDS.highlight]: 'hm-review-mark hm-review-highlight'
}

function createReviewWidget(part) {
  const widget = document.createElement('span')
  widget.contentEditable = 'false'

  if (part.role === 'comment-margin') {
    widget.className = 'hm-review-widget hm-review-margin-note'
    widget.textContent = part.label || ''
    widget.title = part.title || ''
    widget.setAttribute(
      'aria-label',
      part.title
        ? `Review comment ${part.label}: ${part.title}`
        : `Review comment ${part.label}`
    )
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

function getRevealRange(state, pos, textLength) {
  const nodeStart = pos
  const nodeEnd = pos + textLength
  const { from, to } = state.selection

  if (to < nodeStart || from > nodeEnd) return undefined

  const start = Math.max(0, Math.min(textLength, from - nodeStart))
  const end = Math.max(start, Math.min(textLength, to - nodeStart))
  return { start, end }
}

function selectionIntersects(state, from, to) {
  const { from: selFrom, to: selTo } = state.selection
  if (selFrom === selTo) return from < selFrom && selFrom < to
  return from < selTo && selFrom < to
}

function hasMark(node, pattern) {
  return node.marks.some((mark) => pattern.test(mark.type.name))
}

function addInlineDecoration(decorations, from, to, role) {
  const className = REVIEW_CLASS_BY_ROLE[role]
  if (!className || to <= from) return
  decorations.push(
    Decoration.inline(from, to, {
      class: className
    })
  )
}

function addWidgetPart(widgetParts, pos, part) {
  widgetParts.push({ pos, part })
}

function addTextNodeReviewParts(node, pos, state, decorations, widgetParts) {
  const revealRange = getRevealRange(state, pos, node.text.length)

  for (const part of getReviewMarkupDisplayParts(node.text, { revealRange })) {
    if (part.type === 'widget') {
      addWidgetPart(widgetParts, pos + part.pos, part)
      continue
    }

    addInlineDecoration(decorations, pos + part.start, pos + part.end, part.role)
  }
}

function addParsedHighlightCommentParts(entries, index, state, decorations, widgetParts) {
  const openEntry = entries[index]
  const firstHighlight = entries[index + 1]
  if (!firstHighlight || !hasMark(firstHighlight.node, /^highlight$/)) return 0

  const openIndex = openEntry.text.lastIndexOf('{')
  if (openIndex !== openEntry.text.length - 1) return 0

  let cursor = index + 1
  let highlightEnd = firstHighlight.pos
  while (entries[cursor] && hasMark(entries[cursor].node, /^highlight$/)) {
    highlightEnd = entries[cursor].pos + entries[cursor].text.length
    cursor += 1
  }

  const closeEntry = entries[cursor]
  const match = closeEntry?.text.match(/^\}\{>>([\s\S]*?)<<\}/)
  if (!match || !match[1]) return 0

  const from = openEntry.pos + openIndex
  const to = closeEntry.pos + match[0].length
  if (selectionIntersects(state, from, to)) return 0

  addInlineDecoration(decorations, from, from + 1, 'syntax')
  for (let i = index + 1; i < cursor; i += 1) {
    addInlineDecoration(
      decorations,
      entries[i].pos,
      entries[i].pos + entries[i].text.length,
      REVIEW_KINDS.highlight
    )
  }
  addWidgetPart(widgetParts, highlightEnd, {
    type: 'widget',
    role: 'comment-margin',
    title: match[1]
  })
  addInlineDecoration(decorations, closeEntry.pos, closeEntry.pos + match[0].length, 'syntax')
  return cursor - index
}

function addParsedSubstitutionParts(entries, index, state, decorations, widgetParts) {
  const openEntry = entries[index]
  const strikeEntry = entries[index + 1]
  const closeEntry = entries[index + 2]
  if (!strikeEntry || !closeEntry || !hasMark(strikeEntry.node, /strike|del/i)) return 0

  const openIndex = openEntry.text.lastIndexOf('{')
  const separator = strikeEntry.text.indexOf('~>')
  if (
    openIndex !== openEntry.text.length - 1 ||
    separator <= 0 ||
    separator + 2 >= strikeEntry.text.length ||
    !closeEntry.text.startsWith('}')
  ) {
    return 0
  }

  const from = openEntry.pos + openIndex
  const to = closeEntry.pos + 1
  if (selectionIntersects(state, from, to)) return 0

  addInlineDecoration(decorations, from, from + 1, 'syntax')
  addInlineDecoration(decorations, strikeEntry.pos, strikeEntry.pos + strikeEntry.text.length, 'syntax')
  addInlineDecoration(decorations, closeEntry.pos, closeEntry.pos + 1, 'syntax')
  addWidgetPart(widgetParts, strikeEntry.pos, {
    type: 'widget',
    role: 'substitution-replacement',
    oldText: strikeEntry.text.slice(0, separator),
    newText: strikeEntry.text.slice(separator + 2)
  })
  return 2
}

function addParsedReviewParts(parentEntries, state, decorations, widgetParts) {
  for (const entries of parentEntries.values()) {
    for (let i = 0; i < entries.length; i += 1) {
      const highlightConsumed = addParsedHighlightCommentParts(
        entries,
        i,
        state,
        decorations,
        widgetParts
      )
      if (highlightConsumed) {
        i += highlightConsumed
        continue
      }

      const substitutionConsumed = addParsedSubstitutionParts(
        entries,
        i,
        state,
        decorations,
        widgetParts
      )
      if (substitutionConsumed) i += substitutionConsumed
    }
  }
}

export function createReviewDecorationPlugin() {
  return new Plugin({
    key: REVIEW_PLUGIN_KEY,
    props: {
      decorations(state) {
        const decorations = []
        const widgetParts = []
        const parentEntries = new Map()

        state.doc.descendants((node, pos, parent) => {
          if (!node.isText || !node.text) return true

          if (parent) {
            const entries = parentEntries.get(parent) || []
            entries.push({ node, pos, text: node.text })
            parentEntries.set(parent, entries)
          }

          addTextNodeReviewParts(node, pos, state, decorations, widgetParts)
          return true
        })

        addParsedReviewParts(parentEntries, state, decorations, widgetParts)

        let commentNumber = 0
        widgetParts
          .sort((a, b) => a.pos - b.pos)
          .forEach(({ pos, part }) => {
            const widgetPart =
              part.role === 'comment-margin'
                ? { ...part, label: String(++commentNumber) }
                : part
            decorations.push(
              Decoration.widget(pos, () => createReviewWidget(widgetPart), {
                key: `${widgetPart.role}:${pos}:${widgetPart.title || ''}:${widgetPart.label || ''}`,
                side: widgetPart.role === 'comment-margin' ? 1 : -1,
                marks: []
              })
            )
          })

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
