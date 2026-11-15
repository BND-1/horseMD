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

  // One polling watcher per file, shared by every window that has it open
  // (multi-window: the same file can be watched by the main window and a
  // secondary window for a moment while a tab moves). Owners are webContents
  // ids — watching twice from one window is a no-op and one unwatch stops it,
  // as before. `file:changed` goes to each owner; a window that goes away
  // drops its watches. A call without a sender (tests) is owner 0 and is
  // answered through sendToRenderer.
  const trackedSenders = new WeakSet()
  const ownerOf = (event) => {
    const sender = event?.sender
    return sender && typeof sender.id === 'number' ? { key: sender.id, sender } : { key: 0, sender: null }
  }
  const closeFileWatcher = (path, entry) => {
    clearTimeout(entry.timer)
    fileWatchers.delete(path)
    return Promise.resolve(entry.watcher.close()).catch(() => {})
  }
  const dropOwner = (key) => {
    for (const [path, entry] of [...fileWatchers]) {
      if (!entry.owners.delete(key)) continue
      if (!entry.owners.size) void closeFileWatcher(path, entry)
    }
  }
  const trackSender = (sender) => {
    if (!sender || typeof sender.once !== 'function' || trackedSenders.has(sender)) return
    trackedSenders.add(sender)
    const key = sender.id
    sender.once('destroyed', () => dropOwner(key))
  }
  const deliver = (sender, channel, payload) => {
    if (!sender) {
      sendToRenderer(channel, payload)
      return
    }
    try {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    } catch {
      /* window closing */
    }
  }

  ipcMain.handle('watch:file', async (event, path) => {
    const { key, sender } = ownerOf(event)
    trackSender(sender)
    const existing = fileWatchers.get(path)
    if (existing) {
      existing.owners.set(key, sender)
      return true
    }
    const watcher = fileWatcherFactory.watch(path, {
      ignoreInitial: true,
      usePolling: true,
      interval: 1000,
      binaryInterval: 1200,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    })
    const entry = { watcher, timer: null, owners: new Map([[key, sender]]) }
    const notify = () => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(async () => {
        let mtimeMs = 0
        try {
          mtimeMs = (await fs.stat(path)).mtimeMs
        } catch {
          /* file may have been removed */
        }
        for (const owner of entry.owners.values()) deliver(owner, 'file:changed', { path, mtimeMs })
      }, 80)
    }
    watcher.on('change', notify).on('add', notify)
    watcher.on('error', (error) => console.error('watch:file error (ignored):', error?.message || error))
    fileWatchers.set(path, entry)
    return true
  })

  ipcMain.handle('watch:unfile', async (event, path) => {
    const entry = fileWatchers.get(path)
    if (entry) {
      entry.owners.delete(ownerOf(event).key)
      if (!entry.owners.size) await closeFileWatcher(path, entry)
    }
    return true
  })
}
