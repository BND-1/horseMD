import { fencedCodeBlockAt } from '../markdown-preservation/regions.js'

export const isPlainCodeBlock = (node) => {
  if (!node?.isTextblock || node.type?.name !== 'code_block') return false
  let plain = true
  node.forEach?.((child) => {
    if (!child?.isText || (child.marks?.length || 0) > 0) plain = false
  })
  return plain
}

export const normalizeCodeBlockText = (value) =>
  String(value || '').replace(/\r\n|\r/g, '\n')

export const fencedCodeBlockContent = (markdown, block) => {
  if (!block) return null
  let text = normalizeCodeBlockText(
    String(markdown || '').slice(block.contentStart, block.closeStart)
  )
  if (text.endsWith('\n')) text = text.slice(0, -1)
  return text
}

export const normalizedFenceLine = (line) => String(line || '').replace(/\r$/, '')

export const codeBlockAttrsWithoutLanguage = (attrs) => Object.fromEntries(
  Object.entries(attrs || {})
    .filter(([key, value]) => key !== 'language' && value != null)
    .sort(([left], [right]) => left.localeCompare(right))
)

export const codeBlockNonLanguageAttrsEqual = (left, right) =>
  JSON.stringify(codeBlockAttrsWithoutLanguage(left)) ===
  JSON.stringify(codeBlockAttrsWithoutLanguage(right))

export const codeBlockLanguage = (node) => String(node?.attrs?.language ?? '')

export const parseLanguageOnlyFenceInfo = (markdown, block) => {
  if (!block || !Number.isInteger(block.infoStart) || !Number.isInteger(block.infoEnd)) return null
  const raw = String(markdown || '').slice(block.infoStart, block.infoEnd)
  if (/\r|\n/.test(raw)) return null
  let first = 0
  while (first < raw.length && /[ \t]/.test(raw[first])) first += 1
  if (first === raw.length) {
    return Object.freeze({ raw, leading: raw, language: '', trailing: '' })
  }
  let end = raw.length
  while (end > first && /[ \t]/.test(raw[end - 1])) end -= 1
  const language = raw.slice(first, end)
  if (/[ \t]/.test(language)) return null
  return Object.freeze({
    raw,
    leading: raw.slice(0, first),
    language,
    trailing: raw.slice(end)
  })
}

export const validCodeBlockLanguage = (value) => {
  if (typeof value !== 'string') return false
  if (value && /\s/.test(value)) return false
  if (value.includes('`')) return false
  return true
}

export const resolveFencedCodeBlockRange = ({
  markdown,
  doc,
  entry,
  topLevelIndex,
  side,
  resolveMarkdownOffset
}) => {
  if (!entry || typeof resolveMarkdownOffset !== 'function') return null
  const pmPos = entry.offset + 1
  let rawOffset
  try {
    rawOffset = resolveMarkdownOffset({
      markdown,
      pmPos,
      doc,
      topLevelIndex,
      side
    })
  } catch {
    return null
  }
  if (!Number.isFinite(rawOffset)) return null
  const block = fencedCodeBlockAt(markdown, rawOffset)
  if (!block) return null
  return Object.freeze({
    ...block,
    start: block.openStart,
    end: block.closeEnd,
    pmPos,
    rawOffset
  })
}
