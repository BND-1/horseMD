// Electron-coupled persistence wrapper around the pure logic in
// export-prefs-logic.js. Stores cross-export save-folder prefs in userData.

import fs from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { resolveSaveDir, withRecordedSaveDir } from './export-prefs-logic.js'

const FILE = 'export-prefs.json'

let cache = null
let loadPromise = null
let writeQueue = Promise.resolve()

const filePath = () => join(app.getPath('userData'), FILE)

async function load() {
  if (cache) return cache
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(filePath(), 'utf8'))
        const saveDirs = parsed?.saveDirs && typeof parsed.saveDirs === 'object'
          ? Object.fromEntries(Object.entries(parsed.saveDirs).filter(([, value]) => typeof value === 'string'))
          : {}
        cache = {
          saveDirs,
          lastSaveDir: typeof parsed?.lastSaveDir === 'string' ? parsed.lastSaveDir : ''
        }
      } catch {
        // First run or corrupt file -> start empty.
        cache = { saveDirs: {}, lastSaveDir: '' }
      }
      return cache
    })()
  }
  return loadPromise
}

function persist(state) {
  const serialized = JSON.stringify(state, null, 2)
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.writeFile(filePath(), serialized, 'utf8')
    } catch {
      // Preferences are non-critical: a write failure (read-only userData,
      // full disk) must not abort the user's export.
    }
  })
  return writeQueue
}

export async function getSaveDirFor(sourcePath) {
  return resolveSaveDir(await load(), sourcePath)
}

export async function recordSaveDir(sourcePath, chosenDir) {
  cache = withRecordedSaveDir(await load(), sourcePath, chosenDir)
  await persist(cache)
}
