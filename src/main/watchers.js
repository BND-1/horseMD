import fs from 'node:fs/promises'
import chokidar from 'chokidar'
import { createWorkspaceWatcher } from './workspace-watcher.js'
import { DEFAULT_WATCH_EXTENSIONS, isRestrictedWatchRoot, workspaceWatchOptions } from './workspace-watch-policy.js'

export { isAbsoluteWatchPath, isRestrictedWatchRoot } from './workspace-watch-policy.js'

export function registerWatcherIpc(ipcMain, {
  sendToRenderer,
  watcherFactory,
  markdownExtensions = DEFAULT_WATCH_EXTENSIONS
}) {
  const folderWatchers = new Map()
  const fileWatchers = new Map()
  const fileWatcherFactory = watcherFactory || chokidar

  // A folder can be watched for several owners — the workspace and 云空间
  // (same folder in both trees). It closes when the last owner stops, so
  // taking a folder out of the workspace never leaves a gap in which a new
  // file goes unnoticed. Owners are names, not counts: a reloaded renderer
  // starting again for the same owner is a no-op, as before.
  ipcMain.handle('watch:start', async (_event, dir, owner = 'workspace') => {
    const existing = folderWatchers.get(dir)
    if (existing) {
      existing.owners.add(String(owner))
      return true
    }
    if (isRestrictedWatchRoot(dir)) return false

    const watcher = watcherFactory
      ? watcherFactory.watch(dir, workspaceWatchOptions(markdownExtensions))
      : createWorkspaceWatcher(dir, markdownExtensions)
    const entry = { watcher, timer: null, owners: new Set([String(owner)]) }
    watcher.on('error', (error) => console.error('watch:start error (ignored):', error?.message || error))
    const ping = () => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => sendToRenderer('watch:changed', dir), 120)
    }
    watcher.on('add', ping).on('unlink', ping).on('addDir', ping).on('unlinkDir', ping)
    folderWatchers.set(dir, entry)
    return true
  })

  ipcMain.handle('watch:stop', async (_event, dir, owner = 'workspace') => {
    const entry = folderWatchers.get(dir)
    if (entry) {
      entry.owners.delete(String(owner))
      if (entry.owners.size) return true
      folderWatchers.delete(dir)
      clearTimeout(entry.timer)
      await entry.watcher.close()
    }
    return true
  })

  ipcMain.handle('watch:file', async (_event, path) => {
    if (fileWatchers.has(path)) return true
    const watcher = fileWatcherFactory.watch(path, {
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
