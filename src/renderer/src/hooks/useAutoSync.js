import { useEffect, useRef, useState } from 'react'
import { fireToast } from '../ui.js'

// "2 项删除、1 项冲突" — only the kinds that are there.
export const pendingChanges = (summary = {}, t) => [
  summary.delete ? t('sync.auto.partDelete', { n: summary.delete }) : '',
  summary.conflict ? t('sync.auto.partConflict', { n: summary.conflict }) : ''
].filter(Boolean).join(t('sync.auto.partJoin'))

const keyOf = (rootPath) => String(rootPath || '').replace(/[\\/]+$/, '').toLowerCase()
const nameOf = (entry) => entry.name || String(entry.rootPath || '').split(/[\\/]/).filter(Boolean).pop() || entry.rootPath

// Automatic sync (settings.syncAutoMinutes, Settings › Sync; 0 = off): every
// N minutes each folder bound to a cloud connection runs a two-way sync in
// main's `safeOnly` mode — the same rule as「双向同步」without a click:
// uploads and downloads run; a plan with deletions or conflicts (or a cloud
// workspace that was emptied / replaced) is NOT run and waits for the user to
// confirm it in Settings › Sync. Main computes that plan right before
// running, so a file deleted a moment ago is never removed unattended.
// Folders run one after another; a tick is skipped while any sync runs
// (a manual one, or a long throttling wait). Toasts only for something the
// user must act on, once per distinct situation; the result of every run is
// kept per folder (`byFolder`) for the Settings rows, and `nextAt` is when the
// next round starts (null when off).
export function useAutoSync({ sync, minutes, tRef }) {
  const enabled = sync.supported && minutes > 0
  const [status, setStatus] = useState({})
  const [nextAt, setNextAt] = useState(null)
  const syncRef = useRef(sync)
  syncRef.current = sync
  const passRef = useRef(false)
  const noticeRef = useRef(new Map()) // folder key → last notice signature

  useEffect(() => {
    if (!enabled) {
      setNextAt(null)
      return undefined
    }
    const interval = minutes * 60000
    setNextAt(Date.now() + interval)
    const record = (key, value) => setStatus((current) => ({ ...current, [key]: { at: Date.now(), ...value } }))
    const noticeOnce = (key, signature, message) => {
      if (noticeRef.current.get(key) === signature) return
      noticeRef.current.set(key, signature)
      fireToast(message, { duration: 8000 })
    }
    const tick = async () => {
      setNextAt(Date.now() + interval)
      if (passRef.current) return
      passRef.current = true
      try {
        const entries = (syncRef.current.registered || []).filter((entry) => entry.connectionId)
        for (const entry of entries) {
          const current = syncRef.current
          if (current.busyRoot) break
          const key = keyOf(entry.rootPath)
          try {
            const result = await current.run(entry.rootPath, 'merge', { safeOnly: true })
            if (result?.needsConfirmation) {
              record(key, { kind: 'confirm', reason: result.reason, summary: result.summary })
              const summary = result.summary || {}
              noticeOnce(key, `confirm:${result.reason}:${summary.delete}:${summary.conflict}`, result.reason === 'changes'
                ? tRef.current('sync.auto.needsConfirmToast', { name: nameOf(entry), changes: pendingChanges(summary, tRef.current) })
                : tRef.current('sync.auto.remoteResetToast', { name: nameOf(entry) }))
            } else if (result?.stopped) {
              record(key, { kind: 'stopped' })
            } else if (result?.idle) {
              record(key, { kind: 'idle' })
              noticeRef.current.delete(key)
            } else if (result) {
              record(key, { kind: 'done', summary: result.summary })
              noticeRef.current.delete(key)
            }
          } catch (error) {
            const message = String(error?.message || error).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
            record(key, { kind: 'error', message })
            noticeOnce(key, `error:${message}`, tRef.current('sync.auto.failedToast', { name: nameOf(entry), msg: message }))
          }
        }
      } finally {
        passRef.current = false
      }
    }
    const timer = setInterval(tick, interval)
    // Tests run a tick without waiting minutes (test:auto-sync-ui).
    globalThis.__hmAutoSyncTick = tick
    return () => {
      clearInterval(timer)
      if (globalThis.__hmAutoSyncTick === tick) delete globalThis.__hmAutoSyncTick
    }
  }, [enabled, minutes, tRef])

  return { byFolder: status, nextAt }
}
