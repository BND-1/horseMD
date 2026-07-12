import { iconMarkup } from './icons.jsx'
import {
  getReviewGroupRemovalMeta,
  resolveReviewGroupActiveIndex
} from './editor-review-model.js'
import {
  REVIEW_KINDS,
  buildReviewAiPromptForSnippet,
  makeHighlightCommentMarkup,
  removeReviewMarker,
  replaceReviewMarker
} from '../reviewMarkup.js'

export function reviewText(options, key, fallback, vars) {
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

export function stopReviewWidgetMouseDown(event) {
  event.preventDefault()
  event.stopPropagation()
}

export function stopReviewWidgetEvent(event) {
  event.stopPropagation()
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

function replaceAnnotationRange(view, annotation, replacement, pluginKey, reviewMeta = null) {
  if (!validateAnnotationRange(view, annotation)) return false
  let tr = view.state.tr.insertText(replacement, annotation.from, annotation.to)
  if (reviewMeta) tr = tr.setMeta(pluginKey, reviewMeta)
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

function removeAnnotationMarkup(view, part, options, pluginKey) {
  const annotation = part.annotation
  if (!validateAnnotationRange(view, annotation)) {
    notify(options, 'review.stale', 'Review note changed')
    return false
  }

  const replacement =
    annotation.source === 'raw'
      ? removeReviewMarker(annotation.raw, markerForAnnotation(annotation))
      : annotation.text
  return replaceAnnotationRange(
    view,
    annotation,
    replacement,
    pluginKey,
    getReviewGroupRemovalMeta(part)
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

function scrollEditorToPos(view, pos) {
  try {
    const coords = view.coordsAtPos(pos)
    const scroller = view.dom.closest && view.dom.closest('.editor-scroll')
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const targetTop = (coords.top + coords.bottom) / 2 - (rect.top + rect.bottom) / 2
    scroller.scrollTop += targetTop
  } catch {
    // The position may disappear while the editor is tearing down.
  }
}

function renderReadMode(card, view, part, options, pluginKey) {
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

  const noteIndex = Number.isInteger(part.noteIndex) ? part.noteIndex : activeIndex + 1
  const noteTotal = Number.isInteger(part.noteTotal) ? part.noteTotal : annotations.length
  const header = document.createElement('div')
  header.className = 'hm-review-card-head'
  const number = document.createElement('span')
  number.className = 'hm-review-card-number'
  number.textContent = `${noteIndex} / ${noteTotal}`
  const title = document.createElement('span')
  title.className = 'hm-review-card-title'
  title.textContent = reviewText(options, 'review.cardTitle', 'Review note')
  header.append(number, title)

  if (noteTotal > 1) {
    const nav = document.createElement('span')
    nav.className = 'hm-review-card-nav'
    const addNavButton = (iconName, key, fallback, groupKey, pos) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'hm-review-card-nav-button'
      button.innerHTML = iconMarkup(iconName, { size: 14 })
      button.title = reviewText(options, key, fallback)
      button.disabled = !groupKey
      button.addEventListener('mousedown', stopReviewWidgetMouseDown)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!groupKey) return
        view?.dispatch(
          view.state.tr.setMeta(pluginKey, {
            type: 'activate',
            groupKey,
            activeKey: null,
            activeIndex: 0
          })
        )
        if (Number.isInteger(pos)) scrollEditorToPos(view, pos)
      })
      nav.appendChild(button)
    }
    addNavButton('chevron-up', 'review.previous', 'Previous', part.prevNoteKey, part.prevNotePos)
    addNavButton('chevron-down', 'review.next', 'Next', part.nextNoteKey, part.nextNotePos)
    header.appendChild(nav)
  }

  const textLabel = document.createElement('div')
  textLabel.className = 'hm-review-card-label'
  textLabel.textContent = reviewText(options, 'review.highlightedText', 'Highlighted')
  const text = document.createElement('div')
  text.className = 'hm-review-card-text'
  text.textContent = annotation.text
  const commentLabel = document.createElement('div')
  commentLabel.className = 'hm-review-card-label'
  commentLabel.textContent = reviewText(options, 'review.commentText', 'Comment')
  const comment = document.createElement('div')
  comment.className = 'hm-review-card-comment hm-review-card-comment-prominent'
  comment.textContent = annotation.comment
  const actions = document.createElement('div')
  actions.className = 'hm-review-card-actions'

  const addButton = (iconName, key, fallback, onClick, className) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `hm-review-card-action${className ? ` ${className}` : ''}`
    const label = reviewText(options, key, fallback)
    button.title = label
    if (iconName) button.innerHTML = iconMarkup(iconName, { size: 15 })
    else button.textContent = label
    button.addEventListener('mousedown', stopReviewWidgetMouseDown)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    })
    actions.appendChild(button)
  }

  addButton('pencil', 'review.editMarkup', 'Edit markup', () =>
    renderEditMode(card, view, part, options, pluginKey)
  )
  addButton('check', 'review.doneMarkup', 'Done', () =>
    removeAnnotationMarkup(view, part, options, pluginKey), 'hm-review-card-primary'
  )
  addButton('close', 'review.deleteMarkup', 'Delete', () =>
    removeAnnotationMarkup(view, part, options, pluginKey), 'hm-review-card-action-danger'
  )
  addButton('copy', 'review.copyMarkup', 'Copy markup', () => {
    if (!validateAnnotationRange(view, annotation)) {
      notify(options, 'review.stale', 'Review note changed')
      return
    }
    copyText(options, makeHighlightCommentMarkup(annotation.text, annotation.comment))
  })
  addButton('sparkle', 'review.copyMarkupAi', 'Copy markup for AI', () => {
    if (!validateAnnotationRange(view, annotation)) {
      notify(options, 'review.stale', 'Review note changed')
      return
    }
    const markup = makeHighlightCommentMarkup(annotation.text, annotation.comment)
    copyText(options, buildReviewAiPromptForSnippet(markup, 'markup'), 'review.promptCopied', 'Review prompt copied')
  })
  addButton('file', 'review.copyParagraphAi', 'Copy paragraph for AI', () => {
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

function renderEditMode(card, view, part, options, pluginKey) {
  const annotation = part.annotation
  card.replaceChildren()
  const header = document.createElement('div')
  header.className = 'hm-review-card-head'
  const number = document.createElement('span')
  number.className = 'hm-review-card-number'
  number.textContent = part.indexLabel || ''
  const title = document.createElement('span')
  title.className = 'hm-review-card-title'
  title.textContent = reviewText(options, 'review.editMarkup', 'Edit markup')
  header.append(number, title)

  const textLabel = document.createElement('label')
  textLabel.className = 'hm-review-card-label'
  textLabel.textContent = reviewText(options, 'review.highlightedText', 'Highlighted')
  const textInput = document.createElement('input')
  textInput.className = 'hm-review-card-input'
  textInput.type = 'text'
  textInput.value = annotation.text
  textLabel.appendChild(textInput)
  const commentLabel = document.createElement('label')
  commentLabel.className = 'hm-review-card-label'
  commentLabel.textContent = reviewText(options, 'review.commentText', 'Comment')
  const commentInput = document.createElement('textarea')
  commentInput.className = 'hm-review-card-textarea'
  commentInput.rows = 3
  commentInput.value = annotation.comment
  commentLabel.appendChild(commentInput)

  ;[textInput, commentInput].forEach((field) => {
    field.addEventListener('mousedown', stopReviewWidgetEvent)
    field.addEventListener('click', stopReviewWidgetEvent)
    field.addEventListener('keydown', stopReviewWidgetEvent)
    field.addEventListener('input', stopReviewWidgetEvent)
  })

  const actions = document.createElement('div')
  actions.className = 'hm-review-card-actions'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'hm-review-card-action hm-review-card-primary'
  save.textContent = reviewText(options, 'review.save', 'Save')
  save.addEventListener('mousedown', stopReviewWidgetMouseDown)
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
    if (!replaceAnnotationRange(view, annotation, replacement, pluginKey)) {
      notify(options, 'review.stale', 'Review note changed')
    }
  })

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'hm-review-card-action'
  cancel.textContent = reviewText(options, 'review.cancel', 'Cancel')
  cancel.addEventListener('mousedown', stopReviewWidgetMouseDown)
  cancel.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    renderReadMode(card, view, part, options, pluginKey)
  })

  actions.append(save, cancel)
  card.append(header, textLabel, commentLabel, actions)
  textInput.focus()
  textInput.select()
}

export function renderReviewCard(card, view, part, options, pluginKey) {
  renderReadMode(card, view, part, options, pluginKey)
}
