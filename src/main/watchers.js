import fs from 'node:fs/promises'
import chokidar from 'chokidar'

const WATCH_IGNORE_RE = /(^|[\\/])(\.(git|obsidian|horsemd)|node_modules)([\\/]|$)/

export function isAbsoluteWatchPath(path) {
  return /^\//.test(path) || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path)
}

export function isRestrictedWatchRoot(path) {
  const normalized = (path || '').replace(/[\\/]+$/, '')
  if (normalized === '' || normalized === '/' || normalized === '.' || normalized === '..') return true
  if (!isAbsoluteWatchPath(normalized)) return true
  return /^\/(dev|proc|System\/Volumes|private\/var\/(db|folders)|\.vol)(\/|$)/.test(normalized)
}

export function registerWatcherIpc(ipcMain, { sendToRenderer, watcherFactory = chokidar }) {
  const folderWatchers = new Map()
  const fileWatchers = new Map()

  ipcMain.handle('watch:start', async (_event, dir) => {
    if (folderWatchers.has(dir)) return true
    if (isRestrictedWatchRoot(dir)) return false

    const watcher = watcherFactory.watch(dir, {
      ignored: (path) => WATCH_IGNORE_RE.test(path) || isRestrictedWatchRoot(path),
      ignoreInitial: true,
      depth: 12,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    })
    const entry = { watcher, timer: null }
    watcher.on('error', (error) => console.error('watch:start error (ignored):', error?.message || error))
    const ping = () => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => sendToRenderer('watch:changed', dir), 120)
    }
    watcher.on('add', ping).on('unlink', ping).on('addDir', ping).on('unlinkDir', ping)
    folderWatchers.set(dir, entry)
    return true
  })

  ipcMain.handle('watch:stop', async (_event, dir) => {
    const entry = folderWatchers.get(dir)
    if (entry) {
      clearTimeout(entry.timer)
      await entry.watcher.close()
      folderWatchers.delete(dir)
    }
    return true
  })

  ipcMain.handle('watch:file', async (_event, path) => {
    if (fileWatchers.has(path)) return true
    const watcher = watcherFactory.watch(path, {
      ignoreInitial: true,
      usePolling: true,
      interval: 1000,
      binaryInterval: 1200,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    })
    const entry = { watcher, timer: null }
    const notify = () => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(async () => {
        let mtimeMs = 0
        try {
          mtimeMs = (await fs.stat(path)).mtimeMs
        } catch {
          /* file may have been removed */
        }
        sendToRenderer('file:changed', { path, mtimeMs })
      }, 80)
    }
    watcher.on('change', notify).on('add', notify)
    watcher.on('error', (error) => console.error('watch:file error (ignored):', error?.message || error))
    fileWatchers.set(path, entry)
    return true
  })

  ipcMain.handle('watch:unfile', async (_event, path) => {
    const entry = fileWatchers.get(path)
    if (entry) {
      clearTimeout(entry.timer)
      await entry.watcher.close()
      fileWatchers.delete(path)
    }
    return true
  })
}
