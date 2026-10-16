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

  ipcMain.handle('watch:start', async (_event, dir) => {
    if (folderWatchers.has(dir)) return true
    if (isRestrictedWatchRoot(dir)) return false

    const watcher = watcherFactory
      ? watcherFactory.watch(dir, workspaceWatchOptions(markdownExtensions))
      : createWorkspaceWatcher(dir, markdownExtensions)
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
