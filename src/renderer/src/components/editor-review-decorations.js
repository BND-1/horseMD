import { Decoration } from '@milkdown/prose/view'
import {
  groupReviewAnnotationParts,
  makeReviewTextblockGroupKey,
  normalizeReviewPluginState,
  parseParsedHighlightCommentClose,
  resolveReviewGroupActiveIndex
} from './editor-review-model.js'
import {
  REVIEW_KINDS,
  getReviewMarkupDisplayParts,
  makeHighlightCommentMarkup
} from '../reviewMarkup.js'

const REVIEW_COMMENT_META = 'hm-review-comment'

const REVIEW_CLASS_BY_ROLE = {
  syntax: 'hm-review-syntax',
  [REVIEW_KINDS.addition]: 'hm-review-mark hm-review-add',
  [REVIEW_KINDS.deletion]: 'hm-review-mark hm-review-del',
  'substitution-old': 'hm-review-mark hm-review-del hm-review-sub-old',
  'substitution-new': 'hm-review-mark hm-review-add hm-review-sub-new',
  [REVIEW_KINDS.highlight]: 'hm-review-mark hm-review-highlight'
}

function createHighlightCommentMarker(raw, start, text, comment) {
  return {
    kind: REVIEW_KINDS.highlight,
    raw,
    start,
    end: start + raw.length,
    content: { text, comment }
  }
}

function scanHighlightCommentMarkers(text) {
  const markers = []
  const regex = /\{==([\s\S]*?)==\}\{>>([\s\S]*?)<<\}/g
  let match

  while ((match = regex.exec(text))) {
    if (!match[1] || !match[2]) continue
    markers.push(createHighlightCommentMarker(match[0], match.index, match[1], match[2]))
  }

  return markers
}

function annotationKey(annotation) {
  return [
    REVIEW_COMMENT_META,
    annotation.source,
    annotation.from,
    annotation.to,
    annotation.raw
  ].join(':')
}

function ensureAnnotation(annotation) {
  // Empty comments are valid while the toolbar-created marker is being edited.
  if (!annotation?.text) return null
  try {
    const raw = annotation.raw || makeHighlightCommentMarkup(annotation.text, annotation.comment)
    return {
      ...annotation,
      raw,
      key: annotation.key || annotationKey({ ...annotation, raw })
    }
  } catch {
    return null
  }
}

function applyReviewGroupState(widgetParts, pluginState) {
  const state = normalizeReviewPluginState(pluginState)

  return widgetParts.map(({ pos, part }) => {
    if (part?.role !== 'comment-margin') return { pos, part }

    const annotations = Array.isArray(part.annotations)
      ? part.annotations
      : part.annotation
        ? [part.annotation]
        : []
    const open = Boolean(part.groupKey && part.groupKey === state.openGroupKey)
    const activeIndex = open
      ? resolveReviewGroupActiveIndex(annotations, state.activeKey, state.activeIndex)
      : 0
    const annotation = annotations[activeIndex >= 0 ? activeIndex : 0] || null

    return {
      pos,
      part: {
        ...part,
        annotations,
        annotation,
        activeIndex,
        activeKey: annotation?.key || null,
        indexLabel: annotation ? `${activeIndex + 1} / ${annotations.length}` : '',
        title: annotation?.comment || part.title || '',
        open
      }
    }
  })
}

function getTextblockGroupKey(state, pos) {
  try {
    const $pos = state.doc.resolve(pos)
    const start = $pos.depth > 0 ? $pos.start($pos.depth) : 0
    return makeReviewTextblockGroupKey(start)
  } catch {
    return null
  }
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
  decorations.push(Decoration.inline(from, to, { class: className }))
}

function addWidgetPart(widgetParts, pos, part) {
  widgetParts.push({ pos, part })
}

function addTextNodeReviewParts(node, pos, state, decorations, widgetParts, groupKey) {
  const revealRange = getRevealRange(state, pos, node.text.length)
  const rawHighlightMarkers = scanHighlightCommentMarkers(node.text)

  for (const part of getReviewMarkupDisplayParts(node.text, { revealRange })) {
    if (part.type === 'widget') {
      const rawMarkerIndex =
        part.role === 'comment-margin'
          ? rawHighlightMarkers.findIndex(
              (marker) =>
                marker.start + 3 + marker.content.text.length === part.pos &&
                marker.content.comment === part.title
            )
          : -1
      const rawMarker = rawMarkerIndex >= 0 ? rawHighlightMarkers.splice(rawMarkerIndex, 1)[0] : null
      const annotation = rawMarker
        ? ensureAnnotation({
            source: 'raw',
            from: pos + rawMarker.start,
            to: pos + rawMarker.end,
            raw: rawMarker.raw,
            text: rawMarker.content.text,
            comment: rawMarker.content.comment,
            groupKey
          })
        : null
      addWidgetPart(
        widgetParts,
        pos + part.pos,
        annotation ? { ...part, annotation, groupKey: annotation.key || groupKey } : part
      )
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
  let highlightedText = ''
  while (entries[cursor] && hasMark(entries[cursor].node, /^highlight$/)) {
    highlightedText += entries[cursor].text
    highlightEnd = entries[cursor].pos + entries[cursor].text.length
    cursor += 1
  }

  const closeEntry = entries[cursor]
  const close = parseParsedHighlightCommentClose(closeEntry?.text)
  const annotationText = highlightedText + (close?.leadingText || '')
  if (!close || !annotationText) return 0

  const from = openEntry.pos + openIndex
  const to = closeEntry.pos + close.length
  if (selectionIntersects(state, from, to)) return 0
  const annotation = ensureAnnotation({
    source: 'parsed',
    from,
    to,
    text: annotationText,
    comment: close.comment,
    groupKey: openEntry.groupKey
  })
  if (!annotation) return 0

  addInlineDecoration(decorations, from, from + 1, 'syntax')
  for (let i = index + 1; i < cursor; i += 1) {
    addInlineDecoration(decorations, entries[i].pos, entries[i].pos + entries[i].text.length, REVIEW_KINDS.highlight)
  }
  if (close.leadingText) {
    addInlineDecoration(
      decorations,
      closeEntry.pos,
      closeEntry.pos + close.leadingText.length,
      REVIEW_KINDS.highlight
    )
    highlightEnd = closeEntry.pos + close.leadingText.length
  }
  addWidgetPart(widgetParts, highlightEnd, {
    type: 'widget',
    role: 'comment-margin',
    title: close.comment,
    annotation,
    groupKey: annotation.key || openEntry.groupKey
  })
  addInlineDecoration(
    decorations,
    closeEntry.pos + close.syntaxStart,
    closeEntry.pos + close.length,
    'syntax'
  )
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
    separator + 2 > strikeEntry.text.length ||
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
  // Re-examine the close entry so adjacent substitutions sharing a text node
  // are both discovered.
  return 1
}

function addParsedReviewParts(parentEntries, state, decorations, widgetParts) {
  for (const entries of parentEntries.values()) {
    for (let i = 0; i < entries.length; i += 1) {
      const highlightConsumed = addParsedHighlightCommentParts(entries, i, state, decorations, widgetParts)
      if (highlightConsumed) {
        i += highlightConsumed
        continue
      }

      const substitutionConsumed = addParsedSubstitutionParts(entries, i, state, decorations, widgetParts)
      if (substitutionConsumed) i += substitutionConsumed
    }
  }
}

export function collectReviewDecorations(state, pluginState) {
  const decorations = []
  const widgetParts = []
  const parentEntries = new Map()

  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return true
    const groupKey = getTextblockGroupKey(state, pos)

    if (parent) {
      const entries = parentEntries.get(parent) || []
      entries.push({ node, pos, text: node.text, groupKey })
      parentEntries.set(parent, entries)
    }

    addTextNodeReviewParts(node, pos, state, decorations, widgetParts, groupKey)
    return true
  })

  addParsedReviewParts(parentEntries, state, decorations, widgetParts)

  const widgetList = applyReviewGroupState(
    groupReviewAnnotationParts(widgetParts),
    pluginState
  ).sort((a, b) => a.pos - b.pos)

  return { decorations, widgetList }
}
