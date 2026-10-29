import { useCallback, useEffect, useRef, useState } from 'react'
import { fireToast } from '../ui.js'

export const keyOf = (rootPath) => String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const nameOf = (entry) => entry.name || String(entry.rootPath || '').split(/[\\/]/).filter(Boolean).pop() || entry.rootPath
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')

// The mass-deletion brake (same rule as main's automatic runs): more than half
// of the tracked files and at least 10, or 100+. Manual「双向同步」asks first
// only then.
export const isMassDelete = (summary = {}) => {
  const deletes = summary.delete || 0
  const total = (summary.unchanged || 0) + (summary.upload || 0) + (summary.download || 0) + deletes + (summary.conflict || 0)
  return deletes >= 100 || (deletes >= 10 && deletes > total / 2)
}

// One folder's last result as a line (Settings › 云同步 rows, status-bar
// tooltip): "14:32 已同步：上传 2，下载 1，自动合并 1".
export function autoSyncText(status, t) {
  if (!status) return ''
  const time = new Date(status.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const summary = status.summary || {}
  let text = ''
  if (status.kind === 'done') {
    const parts = [
      t('sync.auto.partUpload', { n: summary.upload || 0 }),
      t('sync.auto.partDownload', { n: summary.download || 0 }),
      summary.delete ? t('sync.auto.partDelete', { n: summary.delete }) : '',
      status.merged ? t('sync.auto.partMerged', { n: status.merged }) : '',
      status.conflicts ? t('sync.auto.partConflict', { n: status.conflicts }) : ''
    ].filter(Boolean)
    text = t('sync.auto.done', { time, parts: parts.join(t('sync.auto.partJoin')) })
  } else if (status.kind === 'idle') text = t('sync.auto.idle', { time })
  else if (status.kind === 'confirm') text = status.reason === 'mass-delete'
    ? t('sync.auto.massDelete', { time, n: summary.delete || 0 })
    : t('sync.auto.remoteReset', { time })
  else if (status.kind === 'stopped') text = t('sync.auto.stopped', { time })
  else if (status.kind === 'error') text = t('sync.auto.failed', { time, msg: status.message })
  if (text && status.deferred) text += ' ' + t('sync.deferredNotice', { n: status.deferred })
  return text
}

const SAVE_DELAY = 30000 // after the last save
const SAVE_MAX_WAIT = 120000 // after the first unsynced save, while saves keep coming
const STARTUP_DELAY = 10000
const FOCUS_MIN_GAP = 60000

// 无感同步 (settings.syncAuto, default on; docs/cloud-sync-review.md P2): each
// folder bound to a cloud connection runs a two-way sync in main's
// `automatic` mode —
//   - ~30 s after the last save of a file inside it (at most 2 min after the
//     first unsynced save while saves keep coming; useFileOps dispatches
//     `hm:file-saved`);
//   - ~10 s after start, and when the window comes back if the folder last
//     ran more than a minute ago;
//   - every `minutes` as a fallback.
// Deletions and conflicts run too (recoverable in 历史版本 / 最近删除; main
// merges edits from two devices or writes a conflict copy). Main pauses only
// for a cloud that was emptied / replaced or a mass deletion
// ({ needsConfirmation }) — one toast per distinct situation. Errors toast
// only the first of a streak per folder (later ones show in the status bar).
// Never two runs at once: a run is skipped while another sync runs, and a
// skipped save run retries once that sync ends.
// The result of every run is kept per folder (`byFolder`) for Settings and
// the status bar; `recordResult` lets a manual run update it too.
export function useAutoSync({ sync, enabled: on, minutes, tRef }) {
  const enabled = sync.supported && on
  const [status, setStatus] = useState({})
  const [nextAt, setNextAt] = useState(null)
  const syncRef = useRef(sync)
  syncRef.current = sync
  const passRef = useRef(null) // promise of the running pass
  const retryRef = useRef(new Set()) // save-triggered folders skipped while busy
  const savesRef = useRef(new Map()) // folder key → { firstAt, timer }
  const lastRunRef = useRef(new Map()) // folder key → time its last run started
  const noticeRef = useRef(new Map()) // folder key → last notice signature
  const errorRef = useRef(new Set()) // folders in an error streak

  const record = useCallback((key, value) => setStatus((current) => ({ ...current, [key]: { at: Date.now(), ...value } })), [])

  const recordResult = useCallback((rootPath, result) => {
    if (!result || result.stopped || result.needsConfirmation) return
    const key = keyOf(rootPath)
    noticeRef.current.delete(key)
    errorRef.current.delete(key)
    record(key, result.idle
      ? { kind: 'idle' }
      : { kind: 'done', summary: result.summary, merged: result.merged || 0, conflicts: result.conflicts || 0, deferred: result.deferred?.length || 0 })
  }, [record])

  const runOne = async (entry) => {
    const key = keyOf(entry.rootPath)
    const t = tRef.current
    const noticeOnce = (signature, message) => {
      if (noticeRef.current.get(key) === signature) return
      noticeRef.current.set(key, signature)
      fireToast(message, { duration: 8000 })
    }
    lastRunRef.current.set(key, Date.now())
    // This run covers every save made so far.
    const pending = savesRef.current.get(key)
    if (pending) clearTimeout(pending.timer)
    savesRef.current.delete(key)
    try {
      const result = await syncRef.current.run(entry.rootPath, 'merge', { automatic: true })
      if (result?.needsConfirmation) {
        errorRef.current.delete(key)
        const summary = result.summary || {}
        record(key, { kind: 'confirm', reason: result.reason, summary })
        noticeOnce(`confirm:${result.reason}:${summary.delete || 0}`, result.reason === 'mass-delete'
          ? t('sync.auto.massDeleteToast', { name: nameOf(entry), n: summary.delete || 0 })
          : t('sync.auto.remoteResetToast', { name: nameOf(entry) }))
      } else if (result?.stopped) {
        record(key, { kind: 'stopped' })
      } else if (result) {
        recordResult(entry.rootPath, result)
        const merged = result.merged || 0
        const conflicts = result.conflicts || 0
        const message = [
          merged ? t('sync.auto.mergedToast', { n: merged }) : '',
          conflicts ? t('sync.auto.conflictToast', { n: conflicts }) : ''
        ].filter(Boolean).join(t('sync.auto.toastJoin'))
        if (message) fireToast(message, { duration: 6000 })
      }
    } catch (error) {
      const message = errorText(error)
      record(key, { kind: 'error', message })
      if (!errorRef.current.has(key)) {
        errorRef.current.add(key)
        fireToast(t('sync.auto.failedToast', { name: nameOf(entry), msg: message }), { duration: 8000 })
      }
    }
  }

  // Read synchronously: `busyRoot` in syncRef lags one render behind.
  const busy = () => syncRef.current.isBusy?.() ?? Boolean(syncRef.current.busyRoot)

  // Runs the folders in `keys` (null = every bound folder) one after another.
  // `retry`: remember them if they cannot run now. `wait`: wait for a running
  // pass first (tests).
  const runFolders = async (keys, { retry = false, wait = false } = {}) => {
    const skip = () => {
      if (retry) for (const key of keys || []) retryRef.current.add(key)
    }
    while (passRef.current) {
      if (!wait) return skip()
      await passRef.current
    }
    if (busy()) return skip()
    let finish
    passRef.current = new Promise((resolve) => { finish = resolve })
    try {
      const entries = (syncRef.current.registered || []).filter((entry) => entry.connectionId && (!keys || keys.includes(keyOf(entry.rootPath))))
      for (const entry of entries) {
        if (busy()) {
          if (retry) retryRef.current.add(keyOf(entry.rootPath))
          continue
        }
        await runOne(entry)
      }
    } finally {
      passRef.current = null
      finish()
      retryLater()
    }
  }

  const retryLater = () => {
    if (!retryRef.current.size || passRef.current || busy()) return
    setTimeout(() => {
      const keys = [...retryRef.current]
      retryRef.current.clear()
      if (keys.length && enabledRef.current) runFolders(keys)
    }, 1500)
  }

  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const runRef = useRef(null)
  runRef.current = { runFolders, retryLater }

  // A manual sync (or one started by another window) ended: retry what it blocked.
  useEffect(() => {
    if (enabled && !sync.busyRoot) runRef.current.retryLater()
  }, [enabled, sync.busyRoot])

  // Saves of files inside a bound folder.
  const foldersOf = (path) => {
    const file = keyOf(path)
    return (syncRef.current.registered || [])
      .filter((entry) => entry.connectionId)
      .map((entry) => keyOf(entry.rootPath))
      .filter((root) => root && file.startsWith(root + '/'))
  }

  useEffect(() => {
    const saves = savesRef.current
    if (!enabled) {
      setNextAt(null)
      for (const pending of saves.values()) clearTimeout(pending.timer)
      saves.clear()
      retryRef.current.clear()
      return undefined
    }
    const enabledAt = Date.now()
    const run = (keys, options) => runRef.current.runFolders(keys, options)
    const onSaved = (event) => {
      const now = Date.now()
      for (const key of foldersOf(event.detail?.path)) {
        const pending = saves.get(key) || { firstAt: now, timer: 0 }
        clearTimeout(pending.timer)
        const delay = Math.max(0, Math.min(SAVE_DELAY, pending.firstAt + SAVE_MAX_WAIT - now))
        pending.timer = setTimeout(() => {
          saves.delete(key)
          run([key], { retry: true })
        }, delay)
        saves.set(key, pending)
      }
    }
    const onBack = () => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      const keys = (syncRef.current.registered || [])
        .filter((entry) => entry.connectionId)
        .map((entry) => keyOf(entry.rootPath))
        .filter((key) => now - (lastRunRef.current.get(key) ?? enabledAt) > FOCUS_MIN_GAP)
      if (keys.length) run(keys)
    }
    const interval = minutes * 60000
    const tick = () => {
      setNextAt(Date.now() + interval)
      run(null)
    }
    setNextAt(Date.now() + interval)
    const startup = setTimeout(() => run(null), STARTUP_DELAY)
    const timer = setInterval(tick, interval)
    window.addEventListener('hm:file-saved', onSaved)
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    // Tests: a round of every folder now / what a save triggers, without the wait.
    const testTick = () => run(null, { wait: true })
    const testSaved = (path) => {
      const keys = foldersOf(path)
      for (const key of keys) {
        clearTimeout(saves.get(key)?.timer)
        saves.delete(key)
      }
      return keys.length ? run(keys, { wait: true }) : Promise.resolve()
    }
    globalThis.__hmAutoSyncTick = testTick
    globalThis.__hmAutoSyncSaved = testSaved
    return () => {
      clearTimeout(startup)
      clearInterval(timer)
      window.removeEventListener('hm:file-saved', onSaved)
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
      if (globalThis.__hmAutoSyncTick === testTick) delete globalThis.__hmAutoSyncTick
      if (globalThis.__hmAutoSyncSaved === testSaved) delete globalThis.__hmAutoSyncSaved
    }
  }, [enabled, minutes])

  useEffect(() => () => {
    for (const pending of savesRef.current.values()) clearTimeout(pending.timer)
  }, [])

  return { byFolder: status, nextAt, recordResult }
}
