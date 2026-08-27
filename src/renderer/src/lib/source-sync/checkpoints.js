import { sourceSyncDigest } from './snapshot.js'

export function createSourceSyncCheckpointStore({ limit = 4 } = {}) {
  const maxEntries = Math.max(1, Number.isInteger(limit) ? limit : 4)
  let sequence = 0
  let entries = []

  const trust = (source, canonical, metadata = {}) => {
    if (typeof source !== 'string' || typeof canonical !== 'string') return null
    const sourceDigest = sourceSyncDigest(source)
    const canonicalDigest = sourceSyncDigest(canonical)
    entries = entries.filter((entry) => !(
      entry.source === source && entry.canonical === canonical
    ))
    const entry = Object.freeze({
      sequence: ++sequence,
      source,
      canonical,
      sourceDigest,
      canonicalDigest,
      revision: Number.isInteger(metadata.revision) ? metadata.revision : null,
      owner: metadata.owner || null,
      reason: metadata.reason || null
    })
    entries.unshift(entry)
    if (entries.length > maxEntries) entries.length = maxEntries
    return entry
  }

  const has = (source, canonical) =>
    typeof source === 'string' &&
    typeof canonical === 'string' &&
    entries.some((entry) => entry.source === source && entry.canonical === canonical)

  return Object.freeze({
    trust,
    has,
    latest: () => entries[0] || null,
    list: () => entries.slice(),
    size: () => entries.length,
    clear: () => { entries = [] }
  })
}
