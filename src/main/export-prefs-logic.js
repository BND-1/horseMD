import { dirname } from 'node:path'

export const MAX_SAVE_DIR_ENTRIES = 200

// Pure decision logic for cross-export save-folder preferences. The
// Electron-coupled persistence lives in export-prefs.js; these functions are
// deterministic and unit-tested in scripts/test-export-prefs.mjs.
//
// Per-source-file remembering (user request 2026-07-31):
//   - Same file: once the user picks a different folder, that file keeps
//     defaulting to the remembered folder.
//   - Different file: defaults to ITS OWN Markdown folder, not the folder some
//     other file was saved to.
//   - Untitled (no path): falls back to a single global last save dir.
export function resolveSaveDir(state, sourcePath) {
  if (sourcePath) {
    const remembered = state.saveDirs?.[sourcePath]
    if (remembered) return remembered
    return dirname(sourcePath)
  }
  return state.lastSaveDir || ''
}

export function withRecordedSaveDir(state, sourcePath, chosenDir) {
  if (!chosenDir) return state
  const next = { saveDirs: { ...(state.saveDirs || {}) }, lastSaveDir: chosenDir }
  if (!sourcePath) return next
  const entries = Object.entries(next.saveDirs).filter(([key]) => key !== sourcePath)
  entries.push([sourcePath, chosenDir])
  while (entries.length > MAX_SAVE_DIR_ENTRIES) entries.shift()
  next.saveDirs = Object.fromEntries(entries)
  return next
}
