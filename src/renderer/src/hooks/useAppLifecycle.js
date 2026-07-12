// App lifecycle: session restore + debounced persistence + close-time flush,
// plus the startup update check, the global toast listener, and first-run
// onboarding. Extracted verbatim in behavior from App.jsx (phase-2, US-4).
//
// `flushSession` is returned because the window-close guard (still in App)
// calls it synchronously before quitting, so a keystroke inside the per-tab
// debounce window isn't lost. `update`/`toast`/`dismissUpdate`/`setToast` feed
// the UpdateToast and transient-toast JSX.
//
// Settings/theme apply-effects stay in App (co-located with the theme action
// callbacks passed to StatusBar); this hook is pure lifecycle.
//
// Options:
//   session        — the loaded session snapshot (loadSession(), stable)
//   tabs/activePath/workspace/theme/customTheme/lang/recents/sidebarOpen/
//   sidebarMode    — read by the persistence effect to build the snapshot
//   openPaths      — used by the restore effect to reopen saved files
//   isMobile       — onboarding sidebar affordance
//   tabsRef        — live tabs mirror (restore adds scratch tabs; flush reads it)
//   setActiveId/setTabs/setSidebarMode/setSidebarOpen/setHome/tRef — restore + onboarding
import { useCallback, useEffect, useRef, useState } from 'react'
import { LS, genId, isHeavyDoc, isNewerVersion } from '../paths.js'
import { HM_TOAST_EVENT } from '../ui.js'
import { welcomeDoc } from '../onboarding.js'
import { DEFAULT_LANG } from '../i18n.jsx'

const ONBOARDED_KEY = 'horsemd.onboarded.v1'
const UPDATE_DISMISS_KEY = 'horsemd.update.dismissed'

export function useAppLifecycle({
  session,
  tabs,
  activePath,
  folderRoots,
  theme,
  customTheme,
  lang,
  recents,
  sidebarOpen,
  sidebarMode,
  paneWidth,
  openPaths,
  isMobile,
  tabsRef,
  setActiveId,
  setTabs,
  setSidebarMode,
  setSidebarOpen,
  setHome,
  tRef
}) {
  const [update, setUpdate] = useState(null)
  // Transient bottom-center toast (e.g. "Copied"), fired via a `hm:toast` event.
  const [toast, setToast] = useState(null)
  // Latest session snapshot, kept in a ref so the close/flush path can persist it
  // synchronously without waiting on the debounced write.
  const sessionRef = useRef(null)
  // Write the latest snapshot now (close / pagehide / debounce all funnel here,
  // so the persisted shape lives in exactly one place).
  const flushSession = useCallback(() => {
    if (!sessionRef.current) return
    try {
      // Patch unsaved-scratch content from the live mirror so a close-time write
      // captures edits still inside a tab's debounce window. (commitAllLive, run
      // before this on the close path, already synced tabsRef.current.)
      const untitled = tabsRef.current
        .filter((t) => t.kind !== 'settings' && !t.path && t.content !== t.savedContent && (t.content || '').trim())
        .map((t) => ({ title: t.title, content: t.content }))
      localStorage.setItem(LS, JSON.stringify({ ...sessionRef.current, untitled }))
    } catch {
      /* quota / serialization failure — skip this snapshot */
    }
  }, [tabsRef])

  // Restore session tabs on first mount
  useEffect(() => {
    const paths = (session.openPaths || []).filter(Boolean)
    const untitled = (session.untitled || []).filter((u) => u && (u.content || '').trim())
    // Recreate unsaved scratch tabs (no path) from the last session.
    const addUntitled = () => {
      if (!untitled.length) return null
      const created = untitled.map((u) => ({
        id: genId(),
        path: null,
        title: u.title || tRef.current('tab.untitled'),
        content: u.content,
        // No prior save, so the baseline is empty → the tab shows as unsaved.
        savedContent: '',
        mtimeMs: null,
        reloadNonce: 0,
        heavy: isHeavyDoc(u.content)
      }))
      tabsRef.current = [...tabsRef.current, ...created]
      setTabs((prev) => [...prev, ...created])
      return created
    }
    // Restore silently: skip files that were deleted/moved since last session
    // without popping an error for each one.
    if (paths.length) {
      openPaths(paths, true).then(() => {
        addUntitled()
        if (session.activePath) {
          setTabs((prev) => {
            const t = prev.find((x) => x.path === session.activePath)
            if (t) setActiveId(t.id)
            return prev
          })
        }
        // Restore done — tell main to deliver any argv / open-file queued at
        // launch LAST, so the freshly opened file wins active tab over the
        // restored session (#36).
        window.api.appReady?.()
      })
    } else {
      const created = addUntitled()
      if (created && created.length) setActiveId(created[0].id)
      window.api.appReady?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- persistence -------------------------
  useEffect(() => {
    const data = {
      folderRoots,
      theme,
      customTheme,
      lang,
      recents,
      sidebarOpen,
      sidebarMode,
      paneWidth,
      openPaths: tabs.map((t) => t.path).filter(Boolean),
      // Persist unsaved scratch/new tabs (no path, with edited content) so they
      // survive a restart — closing the app no longer silently loses them. Only
      // dirty tabs are stored, so the untouched welcome doc / empty new tabs
      // don't keep coming back. Saved files are reopened from disk instead.
      untitled: tabs
        .filter((t) => t.kind !== 'settings' && !t.path && t.content !== t.savedContent && (t.content || '').trim())
        .map((t) => ({ title: t.title, content: t.content })),
      activePath
    }
    sessionRef.current = data
    // Debounce the write: this effect runs on every keystroke (tabs/content
    // change), and JSON.stringify-ing the whole session — including the full
    // text of large unsaved scratch docs — plus a synchronous localStorage write
    // on every keypress is enough to make typing in big documents stutter. Wait
    // for a brief pause, then write once. The close path flushes the last edit.
    const id = setTimeout(flushSession, 400)
    return () => clearTimeout(id)
  }, [folderRoots, theme, customTheme, lang, recents, sidebarOpen, sidebarMode, paneWidth, tabs, activePath, flushSession])

  // Flush the pending session snapshot immediately when the window is closing,
  // so the debounce above never drops the user's last few keystrokes.
  useEffect(() => {
    window.addEventListener('pagehide', flushSession)
    window.addEventListener('beforeunload', flushSession)
    return () => {
      window.removeEventListener('pagehide', flushSession)
      window.removeEventListener('beforeunload', flushSession)
    }
  }, [flushSession])

  // ------------------------- update check (notify-only) ------------
  useEffect(() => {
    let alive = true
    window.api.checkUpdate?.().then((r) => {
      if (!alive || !r?.ok || !r.latest) return
      const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY)
      if (isNewerVersion(r.latest, r.current) && r.latest !== dismissed) {
        setUpdate({ latest: r.latest, current: r.current, url: r.url, notes: r.notes, name: r.name })
      }
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Lightweight transient toast (copy feedback, etc.). Any component can fire one
  // via `fireToast(msg)` from ui.js.
  useEffect(() => {
    let timer = null
    const onToast = (e) => {
      const d = e?.detail
      const msg = typeof d === 'string' ? d : d?.msg
      const sticky = typeof d === 'object' && !!d?.sticky
      const duration = typeof d === 'object' ? d?.duration : undefined
      if (!msg) return
      setToast({ msg, key: Date.now() + Math.random(), sticky })
      clearTimeout(timer)
      // duration wins; otherwise sticky stays until ✕, plain toasts hide quickly.
      const ms = duration || (sticky ? 0 : 1600)
      if (ms) timer = setTimeout(() => setToast(null), ms)
    }
    window.addEventListener(HM_TOAST_EVENT, onToast)
    return () => {
      window.removeEventListener(HM_TOAST_EVENT, onToast)
      clearTimeout(timer)
    }
  }, [])

  const dismissUpdate = useCallback(() => {
    setUpdate((u) => {
      if (u) localStorage.setItem(UPDATE_DISMISS_KEY, u.latest)
      return null
    })
  }, [])

  // ------------------------- first-run onboarding ------------------
  useEffect(() => {
    if (localStorage.getItem(ONBOARDED_KEY)) return
    localStorage.setItem(ONBOARDED_KEY, '1')
    // Only greet on a genuinely fresh start (no restored session — neither saved
    // files nor unsaved scratch tabs).
    if ((session.openPaths || []).filter(Boolean).length || (session.untitled || []).length) return
    const doc = welcomeDoc(session.lang || DEFAULT_LANG)
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: doc.title, content: doc.content, savedContent: doc.content, mtimeMs: null, reloadNonce: 0 }
    ])
    setActiveId(id)
    // Land on the Outline (导航条) so the welcome doc's heading hierarchy is
    // visible right away — the doc is written with a clear H1→H2→H3 structure
    // to demo the outline (click-to-jump + cursor-follow).
    setHome(false)
    setSidebarMode('outline')
    if (!isMobile) setSidebarOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { update, dismissUpdate, toast, setToast, flushSession }
}
