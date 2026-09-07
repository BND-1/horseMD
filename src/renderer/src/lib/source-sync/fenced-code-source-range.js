const markdownLines = (markdown) => {
  const lines = []
  let start = 0
  while (start < markdown.length) {
    let end = start
    while (end < markdown.length && markdown[end] !== '\n' && markdown[end] !== '\r') end += 1
    let next = end
    if (markdown[next] === '\r' && markdown[next + 1] === '\n') next += 2
    else if (markdown[next] === '\r' || markdown[next] === '\n') next += 1
    lines.push({
      start,
      end,
      next,
      text: markdown.slice(start, end),
      eol: markdown.slice(end, next)
    })
    start = next
  }
  if (!markdown.length || start === markdown.length) {
    lines.push({ start, end: start, next: start, text: '', eol: '' })
  }
  return lines
}

export const scanFencedCodeSourceRanges = (markdown) => {
  const value = String(markdown || '')
  const lines = markdownLines(value)
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]
    const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(opening.text)
    if (!match) continue
    const marker = match[2][0]
    const markerSize = match[2].length
    let closingIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(lines[cursor].text)
      if (close && close[2][0] === marker && close[2].length >= markerSize) {
        closingIndex = cursor
        break
      }
    }
    if (closingIndex < 0) continue
    const closing = lines[closingIndex]
    let nextNonblankIndex = closingIndex + 1
    while (
      nextNonblankIndex < lines.length &&
      lines[nextNonblankIndex].text.trim() === ''
    ) nextNonblankIndex += 1
    const nextNonblank = lines[nextNonblankIndex] || null
    blocks.push(Object.freeze({
      start: opening.start,
      end: closing.end,
      endWithEol: closing.next,
      contentStart: opening.next,
      contentEnd: closing.start,
      openingIndex: index,
      closingIndex,
      opening,
      closing,
      nextLine: lines[closingIndex + 1] || null,
      nextNonblank,
      marker,
      markerSize,
      info: match[3] || ''
    }))
    index = closingIndex
  }
  return Object.freeze(blocks)
}

const rangeAtOffset = (markdown, offset, { requireEmpty = null } = {}) => {
  if (!Number.isFinite(offset)) return null
  const matches = scanFencedCodeSourceRanges(markdown).filter((block) => {
    if (offset < block.start || offset > block.endWithEol) return false
    const empty = markdown.slice(block.contentStart, block.contentEnd) === ''
    return requireEmpty == null || empty === requireEmpty
  })
  return matches.length === 1 ? matches[0] : null
}

export const resolveFencedCodeSourceRange = ({
  markdown,
  pmPos,
  doc,
  resolveMarkdownOffset,
  requireEmpty = null
} = {}) => {
  if (typeof resolveMarkdownOffset !== 'function') return null
  const attempts = [pmPos + 1, pmPos]
  const matches = []
  for (const position of attempts) {
    let offset = null
    try {
      offset = resolveMarkdownOffset({ markdown, pmPos: position, doc })
    } catch {
      offset = null
    }
    const range = rangeAtOffset(markdown, offset, { requireEmpty })
    if (range && !matches.some((entry) => entry.start === range.start && entry.end === range.end)) {
      matches.push(range)
    }
  }
  if (matches.length === 1) return matches[0]

  const candidates = scanFencedCodeSourceRanges(markdown).filter((block) => {
    const empty = markdown.slice(block.contentStart, block.contentEnd) === ''
    return requireEmpty == null || empty === requireEmpty
  })
  return candidates.length === 1 ? candidates[0] : null
}

export const lineEndingForFencedCodeRange = (markdown, range) => {
  if (range?.closing?.eol) return range.closing.eol
  if (range?.opening?.eol) return range.opening.eol
  const value = String(markdown || '')
  const crlf = value.indexOf('\r\n')
  const lf = value.indexOf('\n')
  const cr = value.indexOf('\r')
  if (crlf >= 0 && (lf < 0 || crlf <= lf) && (cr < 0 || crlf <= cr)) return '\r\n'
  if (lf >= 0 && (cr < 0 || lf < cr)) return '\n'
  if (cr >= 0) return '\r'
  return '\n'
}
