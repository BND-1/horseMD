import { createHash } from 'node:crypto'
import { AI_CONTEXT_SCOPES } from '../../shared/ai-contracts.js'

const clampRange = (range, length) => {
  const start = Math.max(0, Math.min(length, Number(range?.start) || 0))
  const end = Math.max(start, Math.min(length, Number(range?.end) || start))
  return { start, end }
}

export const revisionHash = (markdown) => createHash('sha256').update(String(markdown || ''), 'utf8').digest('hex')

export function createContextSnapshot({ markdown, scope, selection, section, maxChars = 60000 } = {}) {
  const source = String(markdown || '')
  if (!AI_CONTEXT_SCOPES.includes(scope)) throw new Error('invalid-context-scope')
  const limit = Math.min(500000, Math.max(1000, Number(maxChars) || 60000))
  const range = scope === 'selection'
    ? clampRange(selection, source.length)
    : scope === 'section'
      ? clampRange(section, source.length)
      : { start: 0, end: source.length }
  if (range.end <= range.start && scope !== 'document') throw new Error('empty-context-range')
  const raw = source.slice(range.start, range.end)
  const content = raw.length > limit ? raw.slice(0, limit) : raw
  return {
    scope,
    revision: revisionHash(source),
    range,
    content,
    originalLength: raw.length,
    truncated: content.length < raw.length
  }
}

