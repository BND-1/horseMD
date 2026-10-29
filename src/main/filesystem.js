import fs from 'node:fs/promises'
import { constants as fsConstants, existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { conflictCopyName, conflictSuffixFor } from './sync/conflict-name.js'
import { writeFileAtomic } from './atomic-write.js'
import { historyStore, recordBeforeSave, recordBeforeTrash, recordManualSave } from './history/history-service.js'

export { writeFileAtomic }

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '.obsidian', '.horsemd', 'out', 'dist'])

export async function readDirectoryTree(dir, { showHidden = false, markdownPattern } = {}) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !showHidden && entry.name !== '.gitignore') continue
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: full, type: 'dir', children: null })
    } else if (markdownPattern?.test(entry.name)) {
      nodes.push({ name: entry.name, path: full, type: 'file' })
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

async function collectMarkdownFiles(root, dir, acc, depth, options) {
  if (depth > 12 || acc.length > 5000) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && !options.showHidden) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await collectMarkdownFiles(root, full, acc, depth + 1, options)
    } else if (options.markdownPattern?.test(entry.name)) {
      acc.push({
        name: entry.name,
        path: full,
        rel: full.slice(root.length + 1).replace(/\\/g, '/')
      })
    }
  }
}

export async function listMarkdownFiles(root, options = {}) {
  const acc = []
  await collectMarkdownFiles(root, root, acc, 0, {
    showHidden: false,
    ...options
  })
  return acc
}

export function nextDuplicatePath(path, pathExists = existsSync) {
  const dir = dirname(path)
  const ext = extname(path)
  const stem = basename(path, ext)
  let target = join(dir, `${stem} copy${ext}`)
  let index = 2
  while (pathExists(target)) target = join(dir, `${stem} copy ${index++}${ext}`)
  return target
}

// Classify paths supplied by Electron's native drag-and-drop bridge. Keep the
// filesystem check in the main process: the isolated renderer receives only a
// bounded `{ path, type }` result and never guesses directories from a missing
// MIME type or filename suffix. Missing/special paths are ignored so one bad
// item cannot prevent the remaining dropped files from opening.
export async function classifyFileSystemPaths(paths, { stat = fs.stat } = {}) {
  if (!Array.isArray(paths)) return []
  const seen = new Set()
  const classified = []
  for (const path of paths.slice(0, 200)) {
    if (typeof path !== 'string' || !path || seen.has(path)) continue
    seen.add(path)
    try {
      const entry = await stat(path)
      if (entry.isDirectory()) classified.push({ path, type: 'dir' })
      else if (entry.isFile()) classified.push({ path, type: 'file' })
    } catch {
      // The item may have moved between drag start and drop. Ignore it and keep
      // processing the rest of the payload.
    }
  }
  return classified
}

export function registerFileSystemIpc(ipcMain, { shell, markdownPattern }) {
  let showHidden = false

  ipcMain.handle('fs:readFile', async (_event, path) => {
    const content = await fs.readFile(path, 'utf8')
    const stat = await fs.stat(path)
    return { content, mtimeMs: stat.mtimeMs }
  })

  ipcMain.handle('fs:writeFile', async (_event, path, content, options) => {
    // Auto-save passes the mtime HorseMD last read/wrote. Refuse (instead of
    // silently overwriting) when the file has since been changed by another
    // app or removed — an explicit Save is the only path allowed to clobber.
    const expected = options?.expectedMtimeMs
    if (typeof expected === 'number') {
      let current
      try {
        current = await fs.stat(path)
      } catch (error) {
        if (error?.code === 'ENOENT') return { conflict: 'missing' }
        throw error
      }
      if (current.mtimeMs > expected) return { conflict: 'modified', mtimeMs: current.mtimeMs }
    }
    // The version this save replaces goes to the local history first.
    await recordBeforeSave(path, content)
    await writeFileAtomic(path, content)
    // Cmd/Ctrl+S with auto-save on: the saved content is a version too.
    if (options?.keepVersion) await recordManualSave(path, content)
    const stat = await fs.stat(path)
    return { mtimeMs: stat.mtimeMs }
  })

  // A free "name (冲突副本 <device> <time>).md" next to `path`: the editor
  // saves the user's version there when the file was changed elsewhere in
  // the same place (docs/cloud-sync-review.md R1). Never an existing file.
  ipcMain.handle('fs:conflictCopyPath', async (_event, path) => {
    const suffix = conflictSuffixFor()
    for (let n = 1; n < 100; n += 1) {
      const candidate = conflictCopyName(path, n === 1 ? suffix : `${suffix} ${n}`)
      try {
        await fs.access(candidate)
      } catch (error) {
        if (error?.code === 'ENOENT') return candidate
        throw error
      }
    }
    throw new Error('冲突副本太多，请先整理这个文件夹。')
  })

  ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    if (existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
      throw new Error('A file or folder with that name already exists.')
    }
    await fs.rename(oldPath, newPath)
    // The file's (or folder's) history follows it.
    historyStore()?.movePath(oldPath, newPath).catch((error) => console.warn('history: move failed:', error?.message || error))
    return true
  })

  ipcMain.handle('fs:delete', async (_event, path) => {
    await recordBeforeTrash(path)
    await shell.trashItem(path)
    return true
  })

  ipcMain.handle('fs:createFile', async (_event, path, content = '') => {
    await fs.writeFile(path, content, { flag: 'wx' })
    return true
  })

  ipcMain.handle('fs:createDir', async (_event, path) => {
    await fs.mkdir(path, { recursive: true })
    return true
  })

  ipcMain.handle('settings:setShowHidden', (_event, value) => {
    showHidden = Boolean(value)
    return true
  })

  ipcMain.handle('fs:readDir', async (_event, dir) =>
    readDirectoryTree(dir, { showHidden, markdownPattern })
  )

  ipcMain.handle('fs:listFiles', async (_event, root) =>
    listMarkdownFiles(root, { showHidden, markdownPattern })
  )

  ipcMain.handle('fs:openFolderTree', async (_event, dir) => ({
    root: { name: basename(dir), path: dir, type: 'dir' },
    children: await readDirectoryTree(dir, { showHidden, markdownPattern })
  }))

  ipcMain.handle('fs:classifyPaths', async (_event, paths) =>
    classifyFileSystemPaths(paths)
  )

  ipcMain.handle('fs:duplicate', async (_event, path) => {
    const target = nextDuplicatePath(path)
    // Fail rather than overwrite if the target appears after name selection.
    await fs.copyFile(path, target, fsConstants.COPYFILE_EXCL)
    return target
  })
}
