import fs from 'node:fs/promises'
import { constants as fsConstants, existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '.obsidian', 'out', 'dist'])

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

export function registerFileSystemIpc(ipcMain, { shell, markdownPattern }) {
  let showHidden = false

  ipcMain.handle('fs:readFile', async (_event, path) => {
    const content = await fs.readFile(path, 'utf8')
    const stat = await fs.stat(path)
    return { content, mtimeMs: stat.mtimeMs }
  })

  ipcMain.handle('fs:writeFile', async (_event, path, content) => {
    await fs.writeFile(path, content, 'utf8')
    const stat = await fs.stat(path)
    return { mtimeMs: stat.mtimeMs }
  })

  ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    if (existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
      throw new Error('A file or folder with that name already exists.')
    }
    await fs.rename(oldPath, newPath)
    return true
  })

  ipcMain.handle('fs:delete', async (_event, path) => {
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

  ipcMain.handle('fs:duplicate', async (_event, path) => {
    const target = nextDuplicatePath(path)
    // Fail rather than overwrite if the target appears after name selection.
    await fs.copyFile(path, target, fsConstants.COPYFILE_EXCL)
    return target
  })
}
