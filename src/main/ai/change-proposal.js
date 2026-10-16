import { randomUUID } from 'node:crypto'
import { revisionHash } from './context-snapshot.js'

const validOffset = (value) => Number.isInteger(value) && value >= 0

export function createChangeProposal({ markdown, start, end, after, source = 'ai' } = {}) {
  const base = String(markdown || '')
  if (!validOffset(start) || !validOffset(end) || end < start || end > base.length) {
    throw new Error('invalid-proposal-range')
  }
  return {
    id: randomUUID(),
    source,
    baseRevision: revisionHash(base),
    range: { start, end },
    before: base.slice(start, end),
    after: String(after || ''),
    createdAt: Date.now()
  }
}

export function validateChangeProposal(markdown, proposal) {
  const current = String(markdown || '')
  if (!proposal?.baseRevision || revisionHash(current) !== proposal.baseRevision) {
    return { ok: false, reason: 'stale-revision' }
  }
  const { start, end } = proposal.range || {}
  if (!validOffset(start) || !validOffset(end) || end < start || end > current.length) {
    return { ok: false, reason: 'invalid-range' }
  }
  if (current.slice(start, end) !== proposal.before) return { ok: false, reason: 'before-mismatch' }
  return { ok: true }
}

export function applyChangeProposal(markdown, proposal) {
  const validation = validateChangeProposal(markdown, proposal)
  if (!validation.ok) return { ...validation, markdown: String(markdown || '') }
  const current = String(markdown || '')
  return {
    ok: true,
    markdown: current.slice(0, proposal.range.start) + proposal.after + current.slice(proposal.range.end)
  }
}

