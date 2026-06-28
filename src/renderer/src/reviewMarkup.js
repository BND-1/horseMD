export const REVIEW_KINDS = Object.freeze({
  addition: 'addition',
  deletion: 'deletion',
  substitution: 'substitution',
  comment: 'comment',
  highlight: 'highlight'
})

const KIND_PRIORITY = {
  [REVIEW_KINDS.highlight]: 0,
  [REVIEW_KINDS.substitution]: 1,
  [REVIEW_KINDS.addition]: 2,
  [REVIEW_KINDS.deletion]: 3,
  [REVIEW_KINDS.comment]: 4
}

function collectMatches(markdown, regex, kind, contentFromMatch) {
  const markers = []
  let match

  while ((match = regex.exec(markdown))) {
    markers.push({
      kind,
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      content: contentFromMatch(match)
    })
  }

  return markers
}

export function scanReviewMarkup(markdown) {
  const candidates = [
    ...collectMatches(markdown, /\{==([\s\S]*?)==\}\{>>([\s\S]*?)<<\}/g, REVIEW_KINDS.highlight, (match) => ({
      text: match[1],
      comment: match[2]
    })),
    ...collectMatches(markdown, /\{\+\+([\s\S]*?)\+\+\}/g, REVIEW_KINDS.addition, (match) => ({
      text: match[1]
    })),
    ...collectMatches(markdown, /\{--([\s\S]*?)--\}/g, REVIEW_KINDS.deletion, (match) => ({
      text: match[1]
    })),
    ...collectMatches(
      markdown,
      /\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g,
      REVIEW_KINDS.substitution,
      (match) => ({
        oldText: match[1],
        newText: match[2]
      })
    ),
    ...collectMatches(markdown, /\{>>([\s\S]*?)<<\}/g, REVIEW_KINDS.comment, (match) => ({
      text: match[1]
    }))
  ]

  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      b.end - a.end
  )

  const markers = []
  let previousEnd = 0

  for (const candidate of candidates) {
    if (candidate.start >= previousEnd) {
      markers.push(candidate)
      previousEnd = candidate.end
    }
  }

  return markers
}

function spliceText(text, start, end, replacement) {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`
}

function hasLineBreak(text) {
  return /[\r\n]/.test(text)
}

export function wrapReviewSelection(text, start, end, kind) {
  const selected = text.slice(start, end)

  if (
    [
      REVIEW_KINDS.addition,
      REVIEW_KINDS.deletion,
      REVIEW_KINDS.substitution,
      REVIEW_KINDS.highlight
    ].includes(kind) &&
    hasLineBreak(selected)
  ) {
    return { error: 'multiline' }
  }

  if (kind === REVIEW_KINDS.addition) {
    const marker = `{++${selected}++}`
    const selectionStart = start + '{++'.length
    return {
      text: spliceText(text, start, end, marker),
      selectionStart,
      selectionEnd: selectionStart + selected.length
    }
  }

  if (kind === REVIEW_KINDS.deletion) {
    const marker = `{--${selected}--}`
    const selectionStart = start + '{--'.length
    return {
      text: spliceText(text, start, end, marker),
      selectionStart,
      selectionEnd: selectionStart + selected.length
    }
  }

  if (kind === REVIEW_KINDS.substitution) {
    const marker = `{~~${selected}~>~~}`
    const selectionStart = start + '{~~'.length + selected.length + '~>'.length
    return {
      text: spliceText(text, start, end, marker),
      selectionStart,
      selectionEnd: selectionStart
    }
  }

  if (kind === REVIEW_KINDS.highlight) {
    const marker = `{==${selected}==}{>><<}`
    const selectionStart = start + '{=='.length + selected.length + '==}{>>'.length
    return {
      text: spliceText(text, start, end, marker),
      selectionStart,
      selectionEnd: selectionStart
    }
  }

  if (kind === REVIEW_KINDS.comment) {
    const marker = '{>><<}'
    const selectionStart = start + '{>>'.length
    return {
      text: spliceText(text, start, start, marker),
      selectionStart,
      selectionEnd: selectionStart
    }
  }

  return { error: 'kind' }
}

function replacementForMarker(marker, decision) {
  if (marker.kind === REVIEW_KINDS.addition) {
    return decision === 'accept' ? marker.content.text : ''
  }

  if (marker.kind === REVIEW_KINDS.deletion) {
    return decision === 'accept' ? '' : marker.content.text
  }

  if (marker.kind === REVIEW_KINDS.substitution) {
    return decision === 'accept' ? marker.content.newText : marker.content.oldText
  }

  if (marker.kind === REVIEW_KINDS.highlight) {
    return marker.content.text
  }

  if (marker.kind === REVIEW_KINDS.comment) {
    return ''
  }

  return marker.raw
}

export function applyReviewDecision(markdown, decision) {
  if (decision !== 'accept' && decision !== 'reject') {
    throw new Error(`Unsupported review decision: ${decision}`)
  }

  let resolved = ''
  let cursor = 0

  for (const marker of scanReviewMarkup(markdown)) {
    resolved += markdown.slice(cursor, marker.start)
    resolved += replacementForMarker(marker, decision)
    cursor = marker.end
  }

  return resolved + markdown.slice(cursor)
}

export function buildReviewAiPrompt(markdown) {
  return [
    'You are reviewing Markdown that uses source-readable review markers.',
    'Review marker meanings:',
    '- {++new text++}: addition proposed by the reviewer.',
    '- {--old text--}: deletion proposed by the reviewer.',
    '- {~~old text~>new text~~}: substitution from old text to new text.',
    '- {>>comment<<}: reviewer comment.',
    '- {==highlighted text==}{>>comment<<}: highlighted text with a reviewer comment.',
    'Read the annotated Markdown and respond using these marker meanings.',
    '--- Annotated Markdown ---',
    markdown
  ].join('\n')
}
