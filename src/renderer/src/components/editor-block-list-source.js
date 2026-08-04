// Source-side counterpart of a paragraph → list ProseMirror transaction.
//
// The normal source-preservation mapper handles arbitrary text deltas. A list
// wrapper only inserts structural syntax, however, and some authored Markdown
// has a different list marker/spacing from Crepe's canonical form. In that
// case there is no safe whole-document replacement. This helper performs the
// smallest possible edit: prefix the exact authored paragraph line that was
// right-clicked before the transaction.

const markerFor = (targetType) => ({
  bullet_list: '- ',
  ordered_list: '1. ',
  task_list: '- [ ] '
}[targetType] || null)

export function convertSourceParagraphLineToList(source, rawOffset, targetType) {
  const markdown = String(source || '')
  const marker = markerFor(targetType)
  if (!marker || !Number.isFinite(rawOffset)) return null

  const offset = Math.max(0, Math.min(Math.trunc(rawOffset), markdown.length))
  const start = markdown.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const nextNewline = markdown.indexOf('\n', offset)
  const end = nextNewline < 0 ? markdown.length : nextNewline
  const line = markdown.slice(start, end)
  const prefix = line.match(/^[ \t]*/)?.[0] || ''
  const body = line.slice(prefix.length)

  // The block control only advertises this action for ordinary paragraphs.
  // Keep the helper defensive so a stale menu can never corrupt headings,
  // quotes, existing lists, or blank lines.
  if (!body.trim() || /^(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d{1,9}[.)][ \t]+)/.test(body)) {
    return null
  }

  return markdown.slice(0, start) + prefix + marker + body + markdown.slice(end)
}
