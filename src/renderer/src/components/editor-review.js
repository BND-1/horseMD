import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import {
  REVIEW_KINDS,
  buildReviewAiPromptForSnippet,
  getReviewMarkupDisplayParts,
  makeHighlightCommentMarkup,
  removeReviewMarker,
  replaceReviewMarker,
  wrapReviewSelection
} from '../reviewMarkup.js'

export { REVIEW_KINDS }

const REVIEW_PLUGIN_KEY = new PluginKey('hm-review-markup')
const REVIEW_COMMENT_META = 'hm-review-comment'

const REVIEW_CLASS_BY_ROLE = {
  syntax: 'hm-review-syntax',
  [REVIEW_KINDS.addition]: 'hm-review-mark hm-review-add',
  [REVIEW_KINDS.deletion]: 'hm-review-mark hm-review-del',
  'substitution-old': 'hm-review-mark hm-review-del hm-review-sub-old',
  'substitution-new': 'hm-review-mark hm-review-add hm-review-sub-new',
  [REVIEW_KINDS.highlight]: 'hm-review-mark hm-review-highlight'
}

function t(options, key, fallback, vars) {
  const getT = options?.getT
  let value = getT ? getT(key, fallback) : fallback
  value = !value || value === key ? fallback : value
  if (vars) {
    for (const name of Object.keys(vars)) {
      value = String(value).split(`{${name}}`).join(String(vars[name]))
    }
  }
  return value
}

function notify(options, key, fallback) {
  options?.notify?.(key, fallback)
}

function copyText(options, text, doneKey = 'review.copied', doneFallback = 'Copied') {
  options?.copyText?.(text, doneKey, doneFallback)
}

function stopWidgetMouseDown(event) {
  event.preventDefault()
  event.stopPropagation()
}

function stopWidgetEvent(event) {
  event.stopPropagation()
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

function markerForAnnotation(annotation, start = 0) {
  return {
    kind: REVIEW_KINDS.highlight,
    raw: annotation.raw,
    start,
    end: start + annotation.raw.length,
    content: {
      text: annotation.text,
      comment: annotation.comment
    }
  }
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

function closeReviewGroupState() {
  return { openGroupKey: null, activeKey: null, activeIndex: 0 }
}

function makeReviewTextblockGroupKey(start) {
  return `textblock:${start}`
}

function parseReviewTextblockGroupStart(groupKey) {
  const match = String(groupKey || '').match(/^textblock:(\d+)$/)
  return match ? Number(match[1]) : null
}

function ensureAnnotation(annotation) {
  if (!annotation?.text || !annotation?.comment) return null
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

function compareReviewAnnotations(a, b) {
  return (
    (a?.from ?? 0) - (b?.from ?? 0) ||
    (a?.to ?? 0) - (b?.to ?? 0) ||
    String(a?.key || '').localeCompare(String(b?.key || ''))
  )
}

export function groupReviewAnnotationParts(widgetParts) {
  const passthrough = []
  const groups = new Map()

  for (const item of widgetParts || []) {
    const part = item?.part
    if (part?.role !== 'comment-margin' || !part.annotation || !part.groupKey) {
      passthrough.push(item)
      continue
    }

    const existing = groups.get(part.groupKey) || {
      pos: item.pos,
      part: {
        type: 'widget',
        role: 'comment-margin',
        groupKey: part.groupKey,
        annotations: []
      }
    }

    existing.pos = Math.min(existing.pos, item.pos)
    existing.part.annotations.push(part.annotation)
    groups.set(part.groupKey, existing)
  }

  const grouped = [...groups.values()].map((group) => {
    const annotations = [...group.part.annotations].sort(compareReviewAnnotations)
    return {
      pos: group.pos,
      part: {
        ...group.part,
        annotations,
        annotation: annotations[0] || null,
        label: String(annotations.length),
        title: annotations[0]?.comment || ''
      }
    }
  })

  return [...passthrough, ...grouped].sort((a, b) => {
    const posDelta = (a?.pos ?? 0) - (b?.pos ?? 0)
    if (posDelta) return posDelta
    return String(a?.part?.role || '').localeCompare(String(b?.part?.role || ''))
  })
}

export function resolveReviewGroupActiveIndex(annotations, activeKey, preferredIndex = 0) {
  const list = Array.isArray(annotations) ? annotations : []
  if (!list.length) return -1

  if (activeKey) {
    const keyedIndex = list.findIndex((annotation) => annotation?.key === activeKey)
    if (keyedIndex >= 0) return keyedIndex
  }

  if (!Number.isInteger(preferredIndex)) return 0
  return Math.max(0, Math.min(preferredIndex, list.length - 1))
}

export function cycleReviewGroupActiveIndex(currentIndex, count, direction) {
  if (!Number.isInteger(count) || count <= 0) return -1
  const step = direction < 0 ? -1 : 1
  const index = Number.isInteger(currentIndex) ? currentIndex : 0
  return ((index + step) % count + count) % count
}

export function mapReviewTextblockGroupState(pluginState, mapping, docSize) {
  const state = normalizeReviewPluginState(pluginState)
  const start = parseReviewTextblockGroupStart(state.openGroupKey)
  if (!Number.isInteger(start)) return closeReviewGroupState()

  const result = mapping?.mapResult?.(start, -1)
  if (!result || result.deleted) return closeReviewGroupState()

  const mappedPos = result.pos
  if (
    !Number.isInteger(mappedPos) ||
    mappedPos < 0 ||
    (Number.isInteger(docSize) && mappedPos > docSize)
  ) {
    return closeReviewGroupState()
  }

  return {
    ...state,
    openGroupKey: makeReviewTextblockGroupKey(mappedPos)
  }
}

export function getReviewGroupRemovalMeta(part) {
  const annotations = Array.isArray(part?.annotations)
    ? part.annotations
    : part?.annotation
      ? [part.annotation]
      : []
  if (!part?.groupKey || annotations.length <= 1) return { type: 'close' }

  const currentIndex = Number.isInteger(part.activeIndex)
    ? Math.max(0, Math.min(part.activeIndex, annotations.length - 1))
    : 0

  return {
    type: 'activate',
    groupKey: part.groupKey,
    activeKey: null,
    activeIndex: Math.min(currentIndex, annotations.length - 2)
  }
}

export function parseParsedHighlightCommentClose(text) {
  const match = String(text || '').match(/^([ \t]*)\}\{>>([\s\S]*?)<<\}/)
  if (!match || !match[2]) return null
  return {
    leadingText: match[1],
    comment: match[2],
    length: match[0].length,
    syntaxStart: match[1].length
  }
}

function normalizeReviewPluginState(pluginState) {
  return {
    openGroupKey: pluginState?.openGroupKey || null,
    activeKey: pluginState?.activeKey || null,
    activeIndex: Number.isInteger(pluginState?.activeIndex) ? pluginState.activeIndex : 0
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

function getCurrentRangeText(view, annotation) {
  if (!view || !annotation) return null
  const { doc } = view.state
  if (annotation.from < 0 || annotation.to > doc.content.size || annotation.to <= annotation.from) {
    return null
  }
  return doc.textBetween(annotation.from, annotation.to, '\n')
}

function validateAnnotationRange(view, annotation) {
  const current = getCurrentRangeText(view, annotation)
  if (current == null) return false
  if (annotation.source === 'raw') return current === annotation.raw
  return current === `{${annotation.text}}{>>${annotation.comment}<<}`
}

function replaceAnnotationRange(view, annotation, replacement, reviewMeta = null) {
  if (!validateAnnotationRange(view, annotation)) return false
  let tr = view.state.tr.insertText(replacement, annotation.from, annotation.to)
  if (reviewMeta) tr = tr.setMeta(REVIEW_PLUGIN_KEY, reviewMeta)
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

function removeAnnotationMarkup(view, part, options) {
  const annotation = part.annotation
  if (!validateAnnotationRange(view, annotation)) {
    notify(options, 'review.stale', 'Review note changed')
    return false
  }

  const replacement =
    annotation.source === 'raw'
      ? removeReviewMarker(annotation.raw, markerForAnnotation(annotation))
      : annotation.text
  return replaceAnnotationRange(view, annotation, replacement, getReviewGroupRemovalMeta(part))
}

function activateReviewGroupIndex(view, part, activeIndex) {
  const annotation = part.annotations?.[activeIndex]
  if (!annotation) return

  view?.dispatch(
    view.state.tr.setMeta(REVIEW_PLUGIN_KEY, {
      type: 'activate',
      groupKey: part.groupKey,
      activeKey: annotation.key,
      activeIndex
    })
  )
}

export function buildReviewParagraphSnippet(parentText, localFrom, localTo, markup) {
  if (
    typeof parentText !== 'string' ||
    typeof markup !== 'string' ||
    !Number.isInteger(localFrom) ||
    !Number.isInteger(localTo) ||
    localFrom < 0 ||
    localTo < localFrom ||
    localTo > parentText.length
  ) {
    return null
  }

  return `${parentText.slice(0, localFrom)}${markup}${parentText.slice(localTo)}`
}

function buildParagraphSnippetFromAnnotation(view, annotation, markup) {
  try {
    const $from = view.state.doc.resolve(annotation.from)
    if (annotation.to > $from.end()) return null

    const parentText = $from.parent.textBetween(0, $from.parent.content.size, '\n')
    return buildReviewParagraphSnippet(
      parentText,
      annotation.from - $from.start(),
      annotation.to - $from.start(),
      markup
    )
  } catch {
    return null
  }
}

function renderReadMode(card, view, part, options) {
  const annotation = part.annotation
  const annotations = Array.isArray(part.annotations)
    ? part.annotations
    : annotation
      ? [annotation]
      : []
  const activeIndex = Number.isInteger(part.activeIndex)
    ? part.activeIndex
    : resolveReviewGroupActiveIndex(annotations, annotation?.key, 0)
  card.replaceChildren()

  const header = document.createElement('div')
  header.className = 'hm-review-card-head'
  const number = document.createElement('span')
  number.className = 'hm-review-card-number'
  number.textContent = part.indexLabel || (annotation ? `${activeIndex + 1} / ${annotations.length}` : '')
  const title = document.createElement('span')
  title.className = 'hm-review-card-title'
  title.textContent = t(options, 'review.cardTitle', 'Review note')
  header.append(number, title)

  if (annotations.length > 1) {
    const nav = document.createElement('span')
    nav.className = 'hm-review-card-nav'

    const addNavButton = (key, fallback, direction) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'hm-review-card-nav-button'
      button.textContent = t(options, key, fallback)
      button.title = button.textContent
      button.addEventListener('mousedown', stopWidgetMouseDown)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        activateReviewGroupIndex(
          view,
          part,
          cycleReviewGroupActiveIndex(activeIndex, annotations.length, direction)
        )
      })
      nav.appendChild(button)
    }

    addNavButton('review.previous', 'Previous', -1)
    addNavButton('review.next', 'Next', 1)
    header.appendChild(nav)
  }

  const textLabel = document.createElement('div')
  textLabel.className = 'hm-review-card-label'
  textLabel.textContent = t(options, 'review.highlightedText', 'Highlighted')
  const text = document.createElement('div')
  text.className = 'hm-review-card-text'
  text.textContent = annotation.text

  const commentLabel = document.createElement('div')
  commentLabel.className = 'hm-review-card-label'
  commentLabel.textContent = t(options, 'review.commentText', 'Comment')
  const comment = document.createElement('div')
  comment.className = 'hm-review-card-comment'
  comment.textContent = annotation.comment

  const actions = document.createElement('div')
  actions.className = 'hm-review-card-actions'

  const addButton = (key, fallback, onClick, className) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `hm-review-card-action${className ? ` ${className}` : ''}`
    button.textContent = t(options, key, fallback)
    button.title = button.textContent
    button.addEventListener('mousedown', stopWidgetMouseDown)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    })
    actions.appendChild(button)
  }

  addButton('review.editMarkup', 'Edit markup', () => renderEditMode(card, view, part, options))
  addButton(
    'review.doneMarkup',
    'Done',
    () => removeAnnotationMarkup(view, part, options),
    'hm-review-card-primary'
  )
  addButton(
    'review.deleteMarkup',
    'Delete',
    () => removeAnnotationMarkup(view, part, options),
    'hm-review-card-action-danger'
  )
  addButton('review.copyMarkup', 'Copy markup', () => {
    if (!validateAnnotationRange(view, annotation)) {
      notify(options, 'review.stale', 'Review note changed')
      return
    }
    copyText(options, makeHighlightCommentMarkup(annotation.text, annotation.comment))
  })
  addButton('review.copyMarkupAi', 'Copy markup for AI', () => {
    if (!validateAnnotationRange(view, annotation)) {
      notify(options, 'review.stale', 'Review note changed')
      return
    }
    const markup = makeHighlightCommentMarkup(annotation.text, annotation.comment)
    copyText(options, buildReviewAiPromptForSnippet(markup, 'markup'), 'review.promptCopied', 'Review prompt copied')
  })
  addButton('review.copyParagraphAi', 'Copy paragraph for AI', () => {
    if (!validateAnnotationRange(view, annotation)) {
      notify(options, 'review.stale', 'Review note changed')
      return
    }
    const markup = makeHighlightCommentMarkup(annotation.text, annotation.comment)
    const snippet = buildParagraphSnippetFromAnnotation(view, annotation, markup)
    if (!snippet) {
      notify(options, 'review.stale', 'Review note changed')
      return
    }
    copyText(
      options,
      buildReviewAiPromptForSnippet(snippet, 'paragraph'),
      'review.promptCopied',
      'Review prompt copied'
    )
  })

  card.append(header, textLabel, text, commentLabel, comment, actions)
}

function renderEditMode(card, view, part, options) {
  const annotation = part.annotation
  card.replaceChildren()

  const header = document.createElement('div')
  header.className = 'hm-review-card-head'
  const number = document.createElement('span')
  number.className = 'hm-review-card-number'
  number.textContent = part.indexLabel || ''
  const title = document.createElement('span')
  title.className = 'hm-review-card-title'
  title.textContent = t(options, 'review.editMarkup', 'Edit markup')
  header.append(number, title)

  const textLabel = document.createElement('label')
  textLabel.className = 'hm-review-card-label'
  textLabel.textContent = t(options, 'review.highlightedText', 'Highlighted')
  const textInput = document.createElement('input')
  textInput.className = 'hm-review-card-input'
  textInput.type = 'text'
  textInput.value = annotation.text
  textLabel.appendChild(textInput)

  const commentLabel = document.createElement('label')
  commentLabel.className = 'hm-review-card-label'
  commentLabel.textContent = t(options, 'review.commentText', 'Comment')
  const commentInput = document.createElement('textarea')
  commentInput.className = 'hm-review-card-textarea'
  commentInput.rows = 3
  commentInput.value = annotation.comment
  commentLabel.appendChild(commentInput)

  ;[textInput, commentInput].forEach((field) => {
    field.addEventListener('mousedown', stopWidgetEvent)
    field.addEventListener('click', stopWidgetEvent)
    field.addEventListener('keydown', stopWidgetEvent)
    field.addEventListener('input', stopWidgetEvent)
  })

  const actions = document.createElement('div')
  actions.className = 'hm-review-card-actions'

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'hm-review-card-action hm-review-card-primary'
  save.textContent = t(options, 'review.save', 'Save')
  save.addEventListener('mousedown', stopWidgetMouseDown)
  save.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    let replacement
    try {
      if (!textInput.value || !commentInput.value) throw new Error('empty')
      replacement =
        annotation.source === 'raw'
          ? replaceReviewMarker(
              annotation.raw,
              markerForAnnotation(annotation),
              { text: textInput.value, comment: commentInput.value }
            )
          : makeHighlightCommentMarkup(textInput.value, commentInput.value)
    } catch {
      notify(options, 'review.invalid', 'Invalid markup fields')
      return
    }
    if (!replacement) {
      notify(options, 'review.invalid', 'Invalid markup fields')
      return
    }
    if (!replaceAnnotationRange(view, annotation, replacement)) {
      notify(options, 'review.stale', 'Review note changed')
    }
  })

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'hm-review-card-action'
  cancel.textContent = t(options, 'review.cancel', 'Cancel')
  cancel.addEventListener('mousedown', stopWidgetMouseDown)
  cancel.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    renderReadMode(card, view, part, options)
  })

  actions.append(save, cancel)
  card.append(header, textLabel, commentLabel, actions)
  textInput.focus()
  textInput.select()
}

function createReviewWidget(part, options = {}, view) {
  const widget = document.createElement('span')
  widget.contentEditable = 'false'

  if (part.role === 'comment-margin') {
    widget.className = `hm-review-widget hm-review-margin-note${part.open ? ' hm-review-margin-note-open' : ''}`
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
      t(
        options,
        noteCount === 1 ? 'review.groupAriaLabelOne' : 'review.groupAriaLabelMany',
        noteCount === 1 ? 'Open 1 review comment' : 'Open {count} review comments',
        { count: noteCount }
      )
    )
    button.addEventListener('mousedown', stopWidgetMouseDown)
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
    widget.appendChild(button)

    if (part.open && part.annotation) {
      const card = document.createElement('span')
      card.className = 'hm-review-card'
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-label', t(options, 'review.cardTitle', 'Review note'))
      card.addEventListener('mousedown', stopWidgetEvent)
      card.addEventListener('click', stopWidgetEvent)
      renderReadMode(card, view, part, options)
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
      addWidgetPart(widgetParts, pos + part.pos, annotation ? { ...part, annotation, groupKey } : part)
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
  if (!close || !close.comment || !annotationText) return 0

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
    addInlineDecoration(
      decorations,
      entries[i].pos,
      entries[i].pos + entries[i].text.length,
      REVIEW_KINDS.highlight
    )
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
    groupKey: openEntry.groupKey
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
      decorations(state) {
        const decorations = []
        const widgetParts = []
        const parentEntries = new Map()
        const pluginState = REVIEW_PLUGIN_KEY.getState(state) || closeReviewGroupState()

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

        applyReviewGroupState(groupReviewAnnotationParts(widgetParts), pluginState)
          .sort((a, b) => a.pos - b.pos)
          .forEach(({ pos, part }) => {
            const widgetPart = part
            if (widgetPart.role === 'comment-margin' && widgetPart.open && widgetPart.annotation) {
              addActiveAnnotationDecoration(decorations, widgetPart.annotation)
            }
            decorations.push(
              Decoration.widget(pos, (view) => createReviewWidget(widgetPart, options, view), {
                key:
                  `${widgetPart.role}:${pos}:${widgetPart.groupKey || widgetPart.title || ''}:` +
                  `${widgetPart.label || ''}:${widgetPart.open ? 'open' : 'closed'}:` +
                  `${widgetPart.activeKey || ''}:${widgetPart.activeIndex ?? ''}:` +
                  `${widgetPart.annotations?.length || ''}`,
                side: widgetPart.role === 'comment-margin' ? 1 : -1,
                marks: [],
                stopEvent: (event) =>
                  Boolean(
                    event.target?.closest?.(
                      '.hm-review-card, .hm-review-note-button'
                    )
                  )
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
