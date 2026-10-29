import { useCallback, useEffect, useRef, useState } from 'react'
import { fireToast } from '../ui.js'
import { isTabDirty } from '../lib/tab-state.js'

// Auto-save (#136): once a saved-to-disk document has been idle for
// `delaySec` seconds after an edit — or the window loses focus — write it in
// place through the SAME saveTab path as Cmd/Ctrl+S (live markdown resolution,
// source-sync integrity gate), in its silent `auto` mode.
//
// Safety boundaries live in saveTab/writeTab/fs:writeFile, not here:
// untitled tabs and unmappable rich edits are skipped, pasted images awaiting
// relocation wait for an explicit save, and a file changed or removed on disk
// since HorseMD last read/wrote it is never overwritten. This hook only
// schedules, de-duplicates feedback, and pauses a conflicted tab until its
// mtime changes (explicit save or reload).
//
// Returns { active, isAutoSaved(tab) }: whether this tab's edits will be
// written without the user (a path, auto-save on, not paused by a conflict /
// pending images / an error / a source-sync pause). The floating Save button
// is hidden for those (VS Code / Office: no save button under auto-save).
export function useAutoSave({ tabs, delaySec, saveTab, isMobile, tRef }) {
  const enabled = !isMobile && delaySec > 0
  const saveRef = useRef(saveTab)
  saveRef.current = saveTab
  const timersRef = useRef(new Map()) // tab id → timeout
  const seenRef = useRef(new Map()) // tab id → last tab object scheduled for
  const savingRef = useRef(new Set())
  const blockedRef = useRef(new Map()) // tab id → tab.mtimeMs at conflict time
  const noticeRef = useRef(new Set()) // one-shot notices already shown
  // Tabs whose auto-save is paused (they need an explicit save): the Save
  // button shows for them again.
  const [paused, setPaused] = useState(() => new Set())
  const setPausedFor = useCallback((id, on) => {
    setPaused((prev) => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const eligible = (tab) =>
    !!tab && !!tab.path && tab.kind !== 'settings' && isTabDirty(tab) &&
    !(blockedRef.current.has(tab.id) && blockedRef.current.get(tab.id) === tab.mtimeMs)

  const noticeOnce = (key, message, options) => {
    if (noticeRef.current.has(key)) return
    noticeRef.current.add(key)
    fireToast(message, options)
  }

  const tabsLatest = useRef(tabs)
  tabsLatest.current = tabs

  const runRef = useRef(null)
  runRef.current = async (scheduled) => {
    const id = scheduled.id
    const tab = tabsLatest.current.find((item) => item.id === id) || scheduled
    timersRef.current.delete(id)
    if (savingRef.current.has(id)) return
    savingRef.current.add(id)
    try {
      const result = await saveRef.current(id, false, { auto: true })
      const stuck = !!(result?.conflict || result?.error || result?.skipped === 'pending-images' || result?.skipped === 'source-sync')
      if (stuck || result?.ok) setPausedFor(id, stuck)
      if (result?.conflict) {
        blockedRef.current.set(id, tab.mtimeMs)
        noticeOnce(
          `conflict:${id}:${tab.mtimeMs}`,
          tRef.current(result.conflict === 'missing' ? 'autosave.missing' : 'autosave.conflict', { name: tab.title }),
          { sticky: true }
        )
      } else if (result?.error) {
        noticeOnce(`error:${result.error}`, tRef.current('autosave.failed', { msg: result.error }), { sticky: true })
      } else if (result?.skipped === 'pending-images') {
        noticeOnce(`images:${id}`, tRef.current('autosave.pendingImages', { name: tab.title }), { duration: 4000 })
      } else if (result?.ok) {
        noticeRef.current.delete(`images:${id}`)
      }
    } finally {
      savingRef.current.delete(id)
    }
  }

  // (Re)arm one debounce timer per edited, eligible tab whenever its tab
  // object changes (content, pending-rich marker, saved baseline, mtime).
  useEffect(() => {
    const timers = timersRef.current
    if (!enabled) {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      seenRef.current.clear()
      return
    }
    const live = new Set()
    for (const tab of tabs) {
      live.add(tab.id)
      // Saved some other way (explicit save, reload): nothing is waiting.
      if (!isTabDirty(tab)) setPausedFor(tab.id, false)
      const blockedAt = blockedRef.current.get(tab.id)
      if (blockedRef.current.has(tab.id) && blockedAt !== tab.mtimeMs) blockedRef.current.delete(tab.id)
      if (seenRef.current.get(tab.id) === tab) continue
      seenRef.current.set(tab.id, tab)
      const pending = timers.get(tab.id)
      if (pending) clearTimeout(pending)
      timers.delete(tab.id)
      if (!eligible(tab)) continue
      timers.set(tab.id, setTimeout(() => runRef.current(tab), delaySec * 1000))
    }
    for (const id of [...timers.keys()]) {
      if (live.has(id)) continue
      clearTimeout(timers.get(id))
      timers.delete(id)
    }
    for (const id of [...seenRef.current.keys()]) if (!live.has(id)) seenRef.current.delete(id)
    for (const id of paused) if (!live.has(id)) setPausedFor(id, false)
  }, [tabs, enabled, delaySec])

  // Leaving the window is a natural checkpoint: flush every eligible tab now.
  useEffect(() => {
    if (!enabled) return undefined
    const onBlur = () => {
      for (const tab of tabsLatest.current) {
        if (!eligible(tab)) continue
        const pending = timersRef.current.get(tab.id)
        if (pending) clearTimeout(pending)
        runRef.current(tab)
      }
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [enabled])

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer)
    timersRef.current.clear()
  }, [])

  const isAutoSaved = useCallback(
    (tab) => enabled && !!tab?.path && tab.kind !== 'settings' && !paused.has(tab.id),
    [enabled, paused]
  )
  return { active: enabled, isAutoSaved }
}
