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

function pushDisplayRange(parts, type, role, start, end) {
  if (end <= start) return
  parts.push({ type, role, start, end })
}

function pushSyntaxPart(parts, start, end) {
  pushDisplayRange(parts, 'syntax', 'syntax', start, end)
}

function pushContentPart(parts, role, start, end) {
  pushDisplayRange(parts, 'content', role, start, end)
}

function pushWidgetPart(parts, role, pos, label, title) {
  parts.push({ type: 'widget', role, pos, label, title })
}

function shouldRevealMarker(marker, revealRange) {
  if (!revealRange) return false

  if (revealRange.start === revealRange.end) {
    return marker.start < revealRange.start && revealRange.start < marker.end
  }

  return marker.start < revealRange.end && revealRange.start < marker.end
}

export function getReviewMarkupDisplayParts(markdown, options = {}) {
  const parts = []

  for (const marker of scanReviewMarkup(markdown)) {
    if (shouldRevealMarker(marker, options.revealRange)) continue

    if (
      marker.kind === REVIEW_KINDS.addition ||
      marker.kind === REVIEW_KINDS.deletion
    ) {
      if (!marker.content.text) continue

      const openerEnd = marker.start + 3
      const closerStart = marker.end - 3

      pushSyntaxPart(parts, marker.start, openerEnd)
      pushContentPart(parts, marker.kind, openerEnd, closerStart)
      pushSyntaxPart(parts, closerStart, marker.end)
      continue
    }

    if (marker.kind === REVIEW_KINDS.substitution) {
      // Allow an EMPTY new text: the review command inserts `{~~selected~>~~}`
      // (cursor after ~>), so the substitution must render immediately (showing
      // "selected -> ") for the user to type the new text into. Rejecting empty
      // new left the just-inserted marker invisible, which led users to type the
      // closing `~~` themselves — triggering the strikethrough input rule and
      // garbling the marker (the `~~>` corruption only substitution suffers).
      if (!marker.content.oldText) continue

      const oldStart = marker.start + 3
      const oldEnd = oldStart + marker.content.oldText.length
      const newStart = oldEnd + 2
      const newEnd = newStart + marker.content.newText.length

      pushSyntaxPart(parts, marker.start, oldStart)
      pushContentPart(parts, 'substitution-old', oldStart, oldEnd)
      pushSyntaxPart(parts, oldEnd, newStart)
      pushWidgetPart(parts, 'substitution-arrow', newStart, '->')
      pushContentPart(parts, 'substitution-new', newStart, newEnd)
      pushSyntaxPart(parts, newEnd, marker.end)
      continue
    }

    if (marker.kind === REVIEW_KINDS.highlight) {
      if (!marker.content.text || !marker.content.comment) continue

      const textStart = marker.start + 3
      const textEnd = textStart + marker.content.text.length
      const commentStart = textEnd + '==}{>>'.length

      pushSyntaxPart(parts, marker.start, textStart)
      pushContentPart(parts, 'highlight', textStart, textEnd)
      pushSyntaxPart(parts, textEnd, commentStart)
      pushWidgetPart(parts, 'comment-margin', textEnd, undefined, marker.content.comment)
      pushSyntaxPart(parts, commentStart, marker.end)
    }
  }

  return parts
}

function spliceText(text, start, end, replacement) {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`
}

function hasLineBreak(text) {
  return /[\r\n]/.test(text)
}

function assertSafeHighlightCommentField(name, value) {
  const stringValue = String(value)

  if (
    hasLineBreak(stringValue) ||
    (name === 'text' && stringValue.includes('==}{>>')) ||
    (name === 'comment' && stringValue.includes('<<}'))
  ) {
    throw new Error(`Unsafe highlight-comment field: ${name}`)
  }

  return stringValue
}

function splitEdgeSpaces(text) {
  const leading = text.match(/^[ \t]*/)?.[0] || ''
  const trailing = text.match(/[ \t]*$/)?.[0] || ''
  const core = text.slice(leading.length, text.length - trailing.length)
  return { leading, core, trailing }
}

export function makeHighlightCommentMarkup(text, comment) {
  const safeText = assertSafeHighlightCommentField('text', text)
  const safeComment = assertSafeHighlightCommentField('comment', comment)
  const { leading, core, trailing } = splitEdgeSpaces(safeText)
  if (core) return `${leading}{==${core}==}{>>${safeComment}<<}${trailing}`

  return `{==${safeText}==}{>>${safeComment}<<}`
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
    const { leading, core, trailing } = splitEdgeSpaces(selected)
    const marker = core
      ? `${leading}{==${core}==}{>><<}${trailing}`
      : `{==${selected}==}{>><<}`
    const selectionStart = core
      ? start + leading.length + '{=='.length + core.length + '==}{>>'.length
      : start + '{=='.length + selected.length + '==}{>>'.length
    return {
      text: spliceText(text, start, end, marker),
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

function markerMatchesMarkdown(markdown, marker) {
  return Boolean(marker?.raw && markdown.slice(marker.start, marker.end) === marker.raw)
}

export function replaceReviewMarker(markdown, marker, replacement) {
  if (marker?.kind !== REVIEW_KINDS.highlight) return markdown
  if (!markerMatchesMarkdown(markdown, marker)) return markdown

  return spliceText(
    markdown,
    marker.start,
    marker.end,
    makeHighlightCommentMarkup(replacement.text, replacement.comment)
  )
}

export function removeReviewMarker(markdown, marker) {
  if (!marker) return markdown
  if (!markerMatchesMarkdown(markdown, marker)) return markdown

  const replacement =
    marker.kind === REVIEW_KINDS.highlight
      ? marker.content.text
      : replacementForMarker(marker, 'accept')

  return spliceText(markdown, marker.start, marker.end, replacement)
}

export function normalizeReviewMarkupMarkdown(markdown) {
  return markdown
    .replace(/\{==([\s\S]*?)==\}\{>>([\s\S]*?)<<\}/g, (raw, text, comment) => {
      const { leading, core, trailing } = splitEdgeSpaces(text)
      if (!core) return raw
      return `${leading}{==${core}==}{>>${comment}<<}${trailing}`
    })
    // Substitution `{~~old~>new~~}` collides with GFM strikethrough (`~~`), so
    // remark escapes the tildes on serialize (`\~`). A file saved by a build
    // without review-markup (or any round-trip) can end up with the marker
    // backslash-escaped, which then won't parse back into the strike mark the
    // renderer looks for → the substitution stops rendering (while {++}/{--}
    // are fine — no GFM collision). Restore ALL escaped forms:
    //   {\~\~old\~>new\~\~}  → {~~old~>new~~}   (fully escaped)
    //   {~~old\~>new~~}      → {~~old~>new~~}   (only the separator escaped)
    .replace(/\{\\~\\~([\s\S]*?)\\~>([\s\S]*?)\\~\\~\}/g, '{~~$1~>$2~~}')
    .replace(/\{~~([\s\S]*?)\\~>([\s\S]*?)~~\}/g, '{~~$1~>$2~~}')
}

const REVIEW_AI_PROMPT_LEGEND = [
  'Review marker meanings:',
  '- {++new text++}: addition proposed by the reviewer.',
  '- {--old text--}: deletion proposed by the reviewer.',
  '- {~~old text~>new text~~}: substitution from old text to new text.',
  '- {==highlighted text==}{>>comment<<}: highlighted text with a reviewer comment.',
]

export function buildReviewAiPrompt(markdown) {
  return [
    'You are reviewing Markdown that uses source-readable review markers.',
    ...REVIEW_AI_PROMPT_LEGEND,
    'Read the annotated Markdown and respond using these marker meanings.',
    '--- Annotated Markdown ---',
    markdown
  ].join('\n')
}

export function buildReviewAiPromptForSnippet(snippet, scope) {
  return [
    'You are reviewing a scoped Markdown snippet that uses source-readable review markers.',
    ...REVIEW_AI_PROMPT_LEGEND,
    'Read the scoped snippet and respond using these marker meanings.',
    `--- Scoped Snippet (${scope}) ---`,
    snippet
  ].join('\n')
}
