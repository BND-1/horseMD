// Per-document caret/viewport persistence (issue #111). Stores a tiny record
// per absolute path so reopening a long document can return to the same spot
// instead of landing at the top. Keyed by normalized absolute path and
// validated against the content length at restore time, so an externally
// changed file never maps a stale offset onto new text.
//
// The record is { offset, len, scrollTop }:
//   offset    — caret as a raw Markdown character index (rich editors) or the
//               textarea selection start (source/heavy editors); the two
//               surfaces agree on raw source offsets.
//   len       — tab.content.length at save time, used as a cheap fingerprint.
//   scrollTop — the scroll container's scrollTop for exact viewport restore.

const DOC_POS_KEY = 'horsemd.docpos.v1'
const DOC_POS_MAX = 300

let pending = null
let writeTimer = 0

const readAll = () => {
  try {
    const raw = localStorage.getItem(DOC_POS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const getSavedDocPosition = (path) => {
  if (!path) return null
  return readAll()[path.replace(/\\/g, '/')] || null
}

// Debounced batch write: position capture runs on tab switches and close, and
// never on the per-keystroke hot path.
export const queueDocPositionSave = (positions) => {
  if (!positions || !Object.keys(positions).length) return
  pending = { ...pending, ...positions }
  if (writeTimer) return
  writeTimer = setTimeout(flushDocPositionSave, 300)
}

export const flushDocPositionSave = () => {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = 0
  }
  if (!pending) return
  const all = readAll()
  for (const [path, pos] of Object.entries(pending)) {
    if (pos) all[path] = pos
    else delete all[path]
  }
  pending = null
  const keys = Object.keys(all)
  if (keys.length > DOC_POS_MAX) {
    for (const key of keys.slice(0, keys.length - DOC_POS_MAX)) delete all[key]
  }
  try {
    localStorage.setItem(DOC_POS_KEY, JSON.stringify(all))
  } catch {
    // Quota / private mode — the live session still restores tabs.
  }
}
