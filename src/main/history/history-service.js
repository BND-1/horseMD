import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { HistoryStore } from './history-store.js'
import { writeFileAtomic } from '../atomic-write.js'
import { conflictCopyName, conflictStamp } from '../sync/conflict-name.js'

// The app's one history store (docs/cloud-sync-review.md P1) and the hooks
// the save / delete / sync paths call. A history failure never blocks the
// operation that asked for it (except sync deletions, which fall back to the
// old in-folder trash — see SyncEngine.keepLocalVersion).

const MAX_TEXT_BYTES = 5 * 1024 * 1024 // saves / in-app deletions
export const MAX_SYNC_BYTES = 100 * 1024 * 1024 // files the sync replaces / deletes
// One version per 5 minutes while saving (Obsidian's File recovery default;
// SiYuan / Joplin use 10) — auto-save writes every few seconds.
const SAVE_THROTTLE_MS = 5 * 60 * 1000

let store = null
let getRoot = null
let storeOptions = {}
let timers = []

// `root`: a path, or a function returning it — resolved on first use, so
// app.getPath('userData') is read after Electron has applied
// --user-data-dir (UI tests run with their own profile).
export function initHistory(root, options = {}) {
  getRoot = typeof root === 'function' ? root : () => root
  storeOptions = options
  store = null
  for (const timer of timers) clearInterval(timer)
  timers = [
    setTimeout(() => historyStore()?.prune().catch(() => {}), 30000),
    setInterval(() => historyStore()?.prune().catch(() => {}), 6 * 3600000)
  ]
  for (const timer of timers) timer.unref?.()
}

export const historyStore = () => {
  if (!store && getRoot) store = new HistoryStore({ root: getRoot(), ...storeOptions })
  return store
}

const looksBinary = (bytes) => bytes.subarray(0, 8000).includes(0)

// Before a save replaces `path`: keep what is on disk now. At most one
// version per 5 minutes per file — unless this save removes a large part of
// the text (an accidental select-all + delete is exactly what history is for).
export async function recordBeforeSave(path, nextContent) {
  const store = historyStore()
  if (!store) return
  try {
    const stat = await fs.stat(path).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_TEXT_BYTES || stat.size === 0) return
    const old = await fs.readFile(path)
    const oldText = old.toString('utf8')
    const next = String(nextContent ?? '')
    if (oldText === next) return
    const force = oldText.length > 200 && next.length < oldText.length * 0.7
    await store.record(path, old, 'save', { throttleMs: SAVE_THROTTLE_MS, force })
  } catch (error) {
    console.warn('history: could not keep the version before saving:', error?.message || error)
  }
}

// A Cmd/Ctrl+S while auto-save is on (Sketch: ⌘S saves a version): the
// content just written becomes a version of its own, never throttled, so a
// manual save is a point the user can come back to. Same size limit as saves.
export async function recordManualSave(path, content) {
  const store = historyStore()
  if (!store) return
  try {
    const bytes = Buffer.from(String(content ?? ''), 'utf8')
    if (!bytes.byteLength || bytes.byteLength > MAX_TEXT_BYTES) return
    await store.record(path, bytes, 'manual', { force: true })
  } catch (error) {
    console.warn('history: could not keep the manually saved version:', error?.message || error)
  }
}

// Before an in-app deletion (to the system trash): a copy in 「最近删除」.
export async function recordBeforeTrash(path) {
  const store = historyStore()
  if (!store) return
  try {
    const stat = await fs.stat(path).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_TEXT_BYTES) return
    await store.recordDeletion(path, await fs.readFile(path), 'delete')
  } catch (error) {
    console.warn('history: could not keep the deleted file:', error?.message || error)
  }
}

// For SyncEngine: true once the bytes are safely in the history.
export const syncHistory = {
  async keep(path, bytes, reason) {
    const store = historyStore()
    if (!store || bytes.byteLength > MAX_SYNC_BYTES) return false
    if (reason === 'sync-delete') await store.recordDeletion(path, bytes, reason)
    else await store.record(path, bytes, reason, { force: true })
    return true
  }
}

async function freePath(path, label) {
  try {
    await fs.access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return path
    throw error
  }
  const suffix = `${label} ${conflictStamp()}`
  for (let n = 1; n < 100; n += 1) {
    const candidate = conflictCopyName(path, n === 1 ? suffix : `${suffix} ${n}`)
    try {
      await fs.access(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('同名文件太多，请先整理这个文件夹。')
}

const toReadable = (bytes) => (looksBinary(bytes)
  ? { content: null, binary: true, size: bytes.byteLength }
  : { content: bytes.toString('utf8'), binary: false, size: bytes.byteLength })

export function registerHistoryIpc(ipcMain) {
  const need = () => {
    const store = historyStore()
    if (!store) throw new Error('历史版本还没有准备好，请稍后再试。')
    return store
  }
  ipcMain.handle('history:list', async (_event, path) => ({ versions: await need().list(path) }))
  ipcMain.handle('history:read', async (_event, path, id) => toReadable(await need().read(path, id)))
  // Restoring keeps the current file first (reason 'restore'), so a restore
  // can itself be undone. The open tab picks the change up through the
  // file watcher like any external change.
  ipcMain.handle('history:restore', async (_event, path, id) => {
    const history = need()
    const bytes = await history.read(path, id)
    try {
      const current = await fs.readFile(path)
      if (!current.equals(bytes)) await history.record(path, current, 'restore', { force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await fs.mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, bytes)
    return { ok: true }
  })
  ipcMain.handle('history:pin', async (_event, path, id, pinned) => ({ ok: await need().pin(path, id, pinned) }))
  ipcMain.handle('history:deleted', async () => ({ items: await need().listDeleted() }))
  ipcMain.handle('history:readDeleted', async (_event, id) => toReadable(await need().readDeleted(id)))
  ipcMain.handle('history:restoreDeleted', async (_event, id) => {
    const history = need()
    const item = await history.findDeleted(id)
    const bytes = await history.readDeleted(id)
    const target = await freePath(item.path, '已恢复')
    await fs.mkdir(dirname(target), { recursive: true })
    await writeFileAtomic(target, bytes)
    await history.forgetDeleted(id)
    return { ok: true, path: target }
  })
  ipcMain.handle('history:usage', async () => need().usage())
  ipcMain.handle('history:clear', async () => {
    await need().clear()
    return { ok: true }
  })
  ipcMain.handle('history:configure', async (_event, options) => {
    need().configure({ retentionDays: Number(options?.retentionDays) })
    return { ok: true }
  })
}
