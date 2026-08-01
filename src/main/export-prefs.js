// Electron-coupled persistence wrapper around the pure logic in
// export-prefs-logic.js. Stores cross-export save-folder prefs in userData.

import fs from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { resolveSaveDir, withRecordedSaveDir } from './export-prefs-logic.js'

const FILE = 'export-prefs.json'

let cache = null
let loaded = false

const filePath = () => join(app.getPath('userData'), FILE)

async function load() {
  if (loaded) return cache
  loaded = true
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(), 'utf8'))
    const saveDirs = parsed?.saveDirs && typeof parsed.saveDirs === 'object' ? parsed.saveDirs : {}
    cache = {
      saveDirs,
      lastSaveDir: typeof parsed?.lastSaveDir === 'string' ? parsed.lastSaveDir : ''
    }
  } catch {
    // First run or corrupt file → start empty.
    cache = { saveDirs: {}, lastSaveDir: '' }
  }
  return cache
}

async function persist() {
  // Preferences are non-critical: a write failure (read-only userData, full
  // disk) must not abort the user's save.
  await fs.writeFile(filePath(), JSON.stringify(cache, null, 2), 'utf8').catch(() => {})
}

export async function getSaveDirFor(sourcePath) {
  return resolveSaveDir(await load(), sourcePath)
}

export async function recordSaveDir(sourcePath, chosenDir) {
  cache = withRecordedSaveDir(await load(), sourcePath, chosenDir)
  await persist()
}
