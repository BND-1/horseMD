import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Editor from './components/Editor.jsx'
import Sidebar from './components/Sidebar.jsx'
import Tabs from './components/Tabs.jsx'
import Outline from './components/Outline.jsx'
import StatusBar from './components/StatusBar.jsx'
import SaveFab from './components/SaveFab.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { Icon } from './components/icons.jsx'
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js'
import { I18nProvider, translate, DEFAULT_LANG } from './i18n.jsx'
import { welcomeDoc } from './onboarding.js'
import Welcome from './components/Welcome.jsx'
import WindowControls from './components/WindowControls.jsx'
import UpdateToast from './components/UpdateToast.jsx'
import RenameModal from './components/RenameModal.jsx'
import ImageHostButton from './components/ImageHostButton.jsx'
import {
  loadSettings,
  saveSettings,
  applyPageWidth,
  applyFontSize,
  applyLineHeight,
  applyParagraphSpacing
} from './settings.js'
import { applyCustomTheme } from './customThemes.js'
import { fireToast, copyToClipboard, HM_TOAST_EVENT } from './ui.js'
import logoUrl from './assets/logo.png'
import { clearFindHighlights, findRangesInEl, paintFindHighlights, scrollRangeIntoView, matchIndices } from './find.js'
import {
  isNewerVersion, isAbsolutePath, sanitizeWorkspace, baseName, dirName, joinPath,
  isPlainTextDoc, isHeavyDoc, genId, LS, loadSession
} from './paths.js'
import {
  REVIEW_KINDS,
  wrapReviewSelection,
  applyReviewDecision,
  buildReviewAiPrompt,
  normalizeReviewMarkupMarkdown
} from './reviewMarkup.js'

const ONBOARDED_KEY = 'horsemd.onboarded.v1'
const UPDATE_DISMISS_KEY = 'horsemd.update.dismissed'

export default function App() {
  const session = useRef(loadSession()).current
  // Mobile (Capacitor) builds run the same renderer; a few affordances differ
  // (drawer sidebar, no split/image-host buttons). Desktop is unaffected.
  const isMobile = window.api.platform === 'ios' || window.api.platform === 'android'
  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [workspace, setWorkspace] = useState(sanitizeWorkspace(session.workspace))
  // On phones the sidebar overlays the editor, so it starts closed to keep the
  // writing surface front-and-center (desktop keeps its previous default).
  const [sidebarOpen, setSidebarOpen] = useState(session.sidebarOpen ?? !isMobile)
  const [sidebarMode, setSidebarMode] = useState(session.sidebarMode || 'files') // 'files' or 'outline'
  const [theme, setTheme] = useState(session.theme || DEFAULT_THEME)
  // Active custom CSS theme (filename in userData/themes), or null. Overlays the
  // built-in base theme. `customThemes` is the list scanned from that folder.
  const [customTheme, setCustomTheme] = useState(session.customTheme || null)
  const [customThemes, setCustomThemes] = useState([])
  const [lang, setLang] = useState(session.lang || DEFAULT_LANG)
  const [recents, setRecents] = useState(session.recents || [])
  const [sourceMode, setSourceMode] = useState(false)
  // Live mirror of sourceMode for ref-based reads inside stable callbacks.
  const sourceModeRef = useRef(sourceMode)
  sourceModeRef.current = sourceMode
  const [paletteOpen, setPaletteOpen] = useState(false)
  // "Home" shows the welcome/landing page while keeping open tabs mounted (so
  // returning to a document doesn't re-create its editor). Cleared whenever a
  // tab is activated or a file is opened.
  const [home, setHome] = useState(false)
  // Split view: id of the tab shown in the right pane (null = no split). The left
  // pane always shows the active tab; the right pane shows this one. A second,
  // independent editor — both panes are fully editable. Driven by the tab
  // right-click menu ("Open in Split") and the top-bar toggle.
  const [splitId, setSplitId] = useState(null)
  // Fraction of the editor area given to the left pane (0..1), dragged via the
  // divider between the two panes.
  const [splitRatio, setSplitRatio] = useState(0.5)
  // Which split pane is focused ('left' = active tab, 'right' = split tab). A tab
  // click loads into the focused pane, so both panes are switchable from the one
  // tab strip. Always 'left' when not split.
  const [focusedPane, setFocusedPane] = useState('left')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [files, setFiles] = useState([])
  const [find, setFind] = useState({ open: false, query: '', matches: 0, active: 0, replace: '' })
  // Current match set: Range objects (rich editor) or character offsets (source
  // textarea). Held in a ref so next/prev don't trigger re-renders.
  const findRangesRef = useRef([])
  // "New version available" toast — populated by the startup update check below.
  const [update, setUpdate] = useState(null)
  // Transient bottom-center toast (e.g. "Copied"), fired via a `hm:toast` event.
  const [toast, setToast] = useState(null)
  // Rename-from-tab-menu modal: { id, value } or null. (Electron has no
  // window.prompt, so renaming a tab's file uses this small inline dialog.)
  const [renameState, setRenameState] = useState(null)
  // Mobile "save as": prompt for a filename before writing an untitled doc into
  // the local library (desktop uses the native save dialog instead).
  const [saveNameState, setSaveNameState] = useState(null)
  // User preferences (page width, image-host command). Persisted separately from
  // the session; see settings.js.
  const [settings, setSettings] = useState(loadSettings)

  const editorHostRef = useRef(null) // active rich editor's scroll container
  const editorAreaRef = useRef(null) // flex row holding the editor panes (for split-drag math)
  const sourceRef = useRef(null) // active source-mode <textarea>
  const sourceTextareas = useRef({}) // textarea-backed editors by tab id
  const scrollRatioRef = useRef(null) // pending scroll position to restore across a mode switch
  const findInputRef = useRef(null)
  const replaceInputRef = useRef(null)
  // Registry of each tab's editor API (by tab id). Several markdown editors can
  // be mounted at once (a tab stays mounted after its first activation), so a
  // single ref would get stuck on whichever editor mounted last; keying by tab
  // id lets commands act on the *currently active* document.
  const editorApis = useRef({})
  // The tab id of whichever editor pane last had focus — so Save / Export target
  // the pane you're actually editing in split view, not always the left one.
  const focusedTabRef = useRef(null)
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
        .filter((t) => !t.path && t.content !== t.savedContent && (t.content || '').trim())
        .map((t) => ({ title: t.title, content: t.content }))
      localStorage.setItem(LS, JSON.stringify({ ...sessionRef.current, untitled }))
    } catch {
      /* quota / serialization failure — skip this snapshot */
    }
  }, [])
  const [activeBlock, setActiveBlock] = useState('paragraph')
  // Lazy mounting: a rich (Crepe) editor is only created once its tab has been
  // activated, then kept mounted so later tab switches stay instant. This keeps
  // startup/session-restore fast — only the active tab spins up an editor
  // instead of every restored tab parsing its whole document at once.
  const [mountedIds, setMountedIds] = useState(() => new Set())
  // Tab ids the user explicitly chose to render richly despite being "heavy"
  // (would otherwise open in the fast plain-text editor to avoid a long freeze).
  const [richForced, setRichForced] = useState(() => new Set())

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) || null, [tabs, activeId])
  const activePath = activeTab?.path || null
  // Split is "live" only when the right-pane tab exists and differs from the
  // active (left) one. Hidden on the welcome/home screen.
  const splitTab = useMemo(
    () => (splitId != null ? tabs.find((t) => t.id === splitId) || null : null),
    [tabs, splitId]
  )
  const split = !home && !!splitTab && splitId !== activeId
  // Always-current activeId for callbacks that fire after a tab switch.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  // Always-current snapshot of tabs for use inside async callbacks / event
  // handlers that must not capture a stale `tabs` closure.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  // Uncontrolled-textarea live edits. The heavy/plain-doc <textarea> is rendered
  // with defaultValue (not value) so typing doesn't re-render App and re-set a
  // multi-MB value each keystroke — that was the ~218ms/keystroke lag on a 1.28MB
  // file. Edits land in liveContentRef and are committed to tab.content on a 400ms
  // debounce, OR synchronously via commitAllLive() before any critical read (save /
  // close / session / external-reload) — so edits inside the debounce window are
  // never lost. Only the textarea path uses this; rich editors still call
  // updateContent() directly (they have no per-keystroke value re-set cost).
  const liveContentRef = useRef(new Map()) // tab id → latest textarea value (uncommitted)
  const liveTimersRef = useRef(new Map()) // tab id → debounce timer
  // Commit one tab's pending textarea edit. Updates the synchronous tabsRef
  // mirror FIRST (confirmAppClose / saveTab read it), then queues setTabs so
  // render-time readers (StatusBar, SaveFab) catch up on the next paint.
  const commitLive = useCallback((id) => {
    if (!liveContentRef.current.has(id)) return
    const content = liveContentRef.current.get(id)
    const timer = liveTimersRef.current.get(id)
    if (timer) clearTimeout(timer)
    liveTimersRef.current.delete(id)
    liveContentRef.current.delete(id)
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, content } : t))
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content } : t)))
  }, [])
  const commitAllLive = useCallback(() => {
    for (const id of [...liveContentRef.current.keys()]) commitLive(id)
  }, [commitLive])

  // Drop editor APIs for tabs that have closed.
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id))
    for (const id of Object.keys(editorApis.current)) {
      if (!live.has(id)) delete editorApis.current[id]
    }
    for (const id of Object.keys(sourceTextareas.current)) {
      if (!live.has(id)) delete sourceTextareas.current[id]
    }
    // Forget mount records for closed tabs (so the Set doesn't grow unbounded).
    setMountedIds((prev) => {
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
    setRichForced((prev) => {
      if (!prev.size) return prev
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tabs])

  // Mark the active tab as mounted (and keep it mounted thereafter).
  useEffect(() => {
    if (activeId == null) return
    setMountedIds((prev) => (prev.has(activeId) ? prev : new Set(prev).add(activeId)))
  }, [activeId])

  // The right-pane tab must be mounted too (it's a second visible editor).
  useEffect(() => {
    if (splitId == null) return
    setMountedIds((prev) => (prev.has(splitId) ? prev : new Set(prev).add(splitId)))
  }, [splitId])

  // Drop the split when its tab is gone, or it collapsed onto the active tab
  // (e.g. the user clicked the right-pane's tab in the strip).
  useEffect(() => {
    if (splitId != null && (splitId === activeId || !tabs.some((t) => t.id === splitId))) {
      setSplitId(null)
    }
  }, [tabs, splitId, activeId])

  // Once there's no right pane, tab clicks must target the left pane again.
  useEffect(() => {
    if (splitId == null && focusedPane !== 'left') setFocusedPane('left')
  }, [splitId, focusedPane])

  // ----------------------------- theme / i18n -----------------------------
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // ----------------------------- settings ---------------------------------
  // Apply the editor page width live, and persist any settings change.
  useEffect(() => {
    applyPageWidth(settings.pageWidth)
  }, [settings.pageWidth])
  useEffect(() => {
    applyFontSize(settings.fontSize)
  }, [settings.fontSize])
  useEffect(() => {
    applyLineHeight(settings.lineHeight)
  }, [settings.lineHeight])
  useEffect(() => {
    applyParagraphSpacing(settings.paragraphSpacing)
  }, [settings.paragraphSpacing])
  useEffect(() => {
    saveSettings(settings)
  }, [settings])
  // Merge a partial settings change (from the Settings modal).
  const updateSettings = useCallback((partial) => {
    setSettings((prev) => ({ ...prev, ...partial }))
  }, [])

  // ----------------------------- custom themes ----------------------------
  const refreshThemes = useCallback(() => {
    window.api.themesList?.().then(setCustomThemes).catch(() => {})
  }, [])
  useEffect(() => {
    refreshThemes()
  }, [refreshThemes])
  // Inject the selected custom theme's CSS (or clear it). If its file vanished,
  // fall back to no custom theme.
  useEffect(() => {
    if (!customTheme) {
      applyCustomTheme(null)
      return
    }
    let alive = true
    window.api
      .themeRead(customTheme)
      .then((css) => alive && applyCustomTheme(css))
      .catch(() => {
        if (!alive) return
        applyCustomTheme(null)
        setCustomTheme(null)
      })
    return () => {
      alive = false
    }
  }, [customTheme])
  // Picking a built-in theme clears any custom overlay; picking a custom one
  // keeps the built-in as the base (chrome + light/dark).
  const pickBuiltinTheme = useCallback((id) => {
    setTheme(id)
    setCustomTheme(null)
  }, [])

  const t = useCallback((key, vars) => translate(lang, key, vars), [lang])
  // Always-current translator for stable callbacks (e.g. openPaths) that must
  // not be recreated on every language change.
  const tRef = useRef(t)
  tRef.current = t
  const cycleTheme = useCallback(() => {
    setTheme((cur) => {
      const i = THEMES.findIndex((x) => x.id === cur)
      return THEMES[(i + 1) % THEMES.length].id
    })
    setCustomTheme(null)
  }, [])

  // Toggle source/rich mode while keeping the reading position. The two modes
  // use different DOM (a <textarea> vs. the Crepe editor) with different content
  // heights, so we preserve a *scroll ratio* (0…1) rather than a pixel offset:
  // capture it from the outgoing view here, restore it onto the incoming view in
  // the layout effect below once it has rendered.
  const toggleSource = useCallback(() => {
    commitAllLive() // flush textarea edits so the rich editor picks them up on switch
    const el = sourceModeRef.current ? sourceRef.current : editorHostRef.current
    if (el) {
      const denom = el.scrollHeight - el.clientHeight
      scrollRatioRef.current = denom > 0 ? el.scrollTop / denom : 0
    } else {
      scrollRatioRef.current = null
    }
    setSourceMode((v) => !v)
  }, [commitAllLive])

  useLayoutEffect(() => {
    const ratio = scrollRatioRef.current
    if (ratio == null) return
    scrollRatioRef.current = null
    const apply = () => {
      const el = sourceMode ? sourceRef.current : editorHostRef.current
      if (!el) return
      const denom = el.scrollHeight - el.clientHeight
      if (denom > 0) el.scrollTop = ratio * denom
    }
    // Apply immediately, then again as async layout settles — the rich editor
    // (Crepe) fills its content over a few frames after it remounts, growing
    // scrollHeight, so a single pass would land short.
    const raf = requestAnimationFrame(apply)
    const t1 = setTimeout(apply, 90)
    const t2 = setTimeout(apply, 220)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [sourceMode])

  // --------------------------- open files --------------------------
  const openPaths = useCallback(async (paths, silent = false) => {
    if (!paths || !paths.length) return
    let lastId = null
    const seen = new Set()
    const remember = (fp) => {
      const n = fp.replace(/\\/g, '/')
      setRecents((prev) =>
        [
          { path: fp, name: baseName(fp), dir: dirName(fp), openedAt: Date.now() },
          ...prev.filter((r) => (r.path || '').replace(/\\/g, '/') !== n)
        ].slice(0, 8)
      )
    }
    for (const path of paths) {
      const norm = path.replace(/\\/g, '/')
      if (seen.has(norm)) continue // dedupe within this call
      seen.add(norm)
      // Synchronous check against the live tab list (no setState race).
      const existing = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (existing) {
        lastId = existing.id
        remember(path)
        continue
      }
      try {
        const { content, mtimeMs } = await window.api.readFile(path)
        // Re-check after the await in case a concurrent open added this path.
        const concurrent = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
        if (concurrent) {
          lastId = concurrent.id
          remember(path)
          continue
        }
        const id = genId()
        lastId = id
        const newTab = {
          id,
          path,
          title: baseName(path),
          content,
          savedContent: content,
          mtimeMs,
          reloadNonce: 0,
          heavy: isHeavyDoc(content)
        }
        tabsRef.current = [...tabsRef.current, newTab] // keep snapshot current for the next iteration
        setTabs((prev) => [...prev, newTab])
        remember(path)
      } catch (e) {
        // File was moved/deleted (e.g. a stale "recent" entry). Drop it from the
        // recents list so the dead link disappears, and show a friendly message
        // instead of the raw IPC error.
        const missing = e?.message?.includes('ENOENT')
        setRecents((prev) => prev.filter((r) => (r.path || '').replace(/\\/g, '/') !== norm))
        // Startup restore skips missing files quietly; an explicit open (clicking
        // a Recent, File > Open) still tells the user what happened.
        if (!silent) {
          window.alert(
            tRef.current(missing ? 'error.fileMissing' : 'error.openFailed', { name: baseName(path) })
          )
        }
      }
    }
    if (lastId) {
      setActiveId(lastId)
      setHome(false)
    }
  }, [])

  const newTab = useCallback(() => {
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: t('tab.untitled'), content: '', savedContent: '', mtimeMs: null, reloadNonce: 0 }
    ])
    setActiveId(id)
    setHome(false)
  }, [t])

  const updateContent = useCallback((id, md, isInitial) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        if (isInitial) {
          // Rebaseline a clean doc against Crepe's normalized output; keep the
          // existing baseline if the doc already had unsaved edits.
          if (t.content === t.savedContent) return { ...t, content: md, savedContent: md }
          return { ...t, content: md }
        }
        return { ...t, content: md }
      })
    )
  }, [])

  const closeTab = useCallback(
    (id) => {
      commitAllLive() // flush textarea edits so the unsaved-check below is accurate
      setTabs((prev) => {
        const tab = prev.find((x) => x.id === id)
        if (tab && tab.content !== tab.savedContent) {
          if (!window.confirm(tRef.current('confirm.closeUnsaved', { name: tab.title }))) return prev
        }
        // Drop the closing tab's live-edit bookkeeping.
        const timer = liveTimersRef.current.get(id)
        if (timer) clearTimeout(timer)
        liveTimersRef.current.delete(id)
        liveContentRef.current.delete(id)
        const idx = prev.findIndex((x) => x.id === id)
        const next = prev.filter((x) => x.id !== id)
        setActiveId((cur) => {
          if (cur !== id) return cur
          if (next.length === 0) return null
          return next[Math.min(idx, next.length - 1)].id
        })
        return next
      })
    },
    [commitAllLive]
  )

  // Show a tab in the right (split) pane. If it's currently the active tab, move
  // the left pane to a different tab so the two panes differ.
  const openRight = useCallback((id) => {
    setHome(false)
    if (id === activeIdRef.current) {
      const others = tabsRef.current.filter((t) => t.id !== id)
      if (!others.length) return // only one tab — nothing to split against
      setActiveId(others[others.length - 1].id)
    }
    setSplitId(id)
  }, [])

  // Toggle split: off → on picks the next tab as the right pane; on → off closes it.
  const toggleSplit = useCallback(() => {
    setSplitId((cur) => {
      if (cur != null) return null
      const list = tabsRef.current
      if (list.length < 2) {
        fireToast(tRef.current('split.needTwo'))
        return null
      }
      const i = list.findIndex((t) => t.id === activeIdRef.current)
      return list[(i + 1) % list.length].id
    })
    setHome(false)
  }, [])

  // Drag the divider between the two split panes to change their ratio.
  const startSplitDrag = useCallback((e) => {
    e.preventDefault()
    const area = editorAreaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    const onMove = (ev) => {
      const r = (ev.clientX - rect.left) / rect.width
      setSplitRatio(Math.min(0.8, Math.max(0.2, r)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('hm-col-resizing')
    }
    document.body.classList.add('hm-col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Open a file (by path) directly into the right split pane — used by the
  // sidebar's "Open in Split" so it works even if the file isn't open yet.
  const openFileRight = useCallback(
    async (path) => {
      await openPaths([path])
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (tab) openRight(tab.id)
    },
    [openPaths, openRight]
  )

  // --- File operations shared by the tab menu and the sidebar menu, so both
  //     right-click menus offer the same actions on a file. ---
  // Open the rename dialog for a tab's file (Electron has no window.prompt).
  const renameTabFile = useCallback((id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    setRenameState({ id, value: baseName(tab.path) })
  }, [])

  // Commit a tab-file rename from the dialog.
  const commitTabRename = useCallback(async (id, rawName) => {
    setRenameState(null)
    const tab = tabsRef.current.find((t) => t.id === id)
    const name = (rawName || '').trim()
    if (!tab?.path || !name) return
    if (name === baseName(tab.path)) return
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      window.alert(tRef.current('err.invalidName') + name)
      return
    }
    const newPath = joinPath(dirName(tab.path), name)
    try {
      await window.api.rename(tab.path, newPath)
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, path: newPath, title: name } : t)))
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      window.alert(
        /eexist|already exists/i.test(e.message)
          ? tRef.current('err.nameExists')
          : tRef.current('err.rename') + e.message
      )
    }
  }, [])

  const duplicateTabFile = useCallback(async (id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    try {
      await window.api.duplicate(tab.path)
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      window.alert(
        /eexist|already exists/i.test(e.message)
          ? tRef.current('err.nameExists')
          : tRef.current('err.duplicate') + e.message
      )
    }
  }, [])

  const deleteTabFile = useCallback(async (id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    if (!window.confirm(tRef.current('confirm.trash', { name: tab.title }))) return
    try {
      await window.api.deleteItem(tab.path)
      // Remove the tab outright (the file is gone; don't re-prompt about unsaved edits).
      setTabs((prev) => {
        const idx = prev.findIndex((x) => x.id === id)
        const next = prev.filter((x) => x.id !== id)
        setActiveId((cur) => (cur !== id ? cur : next.length ? next[Math.min(idx, next.length - 1)].id : null))
        return next
      })
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      window.alert(tRef.current('err.delete') + e.message)
    }
  }, [])

  // Close every tab except `keepId` (from the tab right-click menu).
  const closeOthers = useCallback((keepId) => {
    commitAllLive()
    setTabs((prev) => {
      const others = prev.filter((t) => t.id !== keepId)
      const firstDirty = others.find((t) => t.content !== t.savedContent)
      if (firstDirty && !window.confirm(tRef.current('confirm.closeUnsaved', { name: firstDirty.title }))) {
        return prev
      }
      for (const t of others) {
        const timer = liveTimersRef.current.get(t.id)
        if (timer) clearTimeout(timer)
        liveTimersRef.current.delete(t.id)
        liveContentRef.current.delete(t.id)
      }
      setActiveId(keepId)
      setSplitId(null)
      return prev.filter((t) => t.id === keepId)
    })
  }, [commitAllLive])

  const writeTab = useCallback(async (tab, targetPath) => {
    try {
      // Move pasted images (base64 blobs / global paste-folder files) into the
      // doc's ./assets and rewrite links to relative paths, so the saved file is
      // clean and portable (Typora-style). No-op when there are none / on mobile.
      const { content: written, changed } = window.api.inlineForSave
        ? await window.api.inlineForSave(tab.content, targetPath)
        : { content: tab.content, changed: false }
      const { mtimeMs } = await window.api.writeFile(targetPath, written)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? changed
              ? // Images were moved to assets/: adopt the rewritten content and
                // remount the editor so it shows the relative-path images.
                {
                  ...t,
                  path: targetPath,
                  title: baseName(targetPath),
                  content: written,
                  savedContent: written,
                  mtimeMs,
                  reloadNonce: t.reloadNonce + 1
                }
              : { ...t, path: targetPath, title: baseName(targetPath), savedContent: t.content, mtimeMs }
            : t
        )
      )
      setRefreshNonce((n) => n + 1)
      // On mobile, where files land in a system folder, confirm what + where —
      // sticky so the user can read the location before dismissing it.
      if (isMobile) {
        const loc =
          window.api.platform === 'ios' ? tRef.current('save.locIos') : tRef.current('save.locAndroid')
        fireToast(tRef.current('save.savedTo', { name: baseName(targetPath), loc }), {
          sticky: true,
          duration: 5000
        })
      } else {
        // Desktop: a brief "Saved ✓" so Ctrl+S / the save button give feedback
        // (Typora-style). Short-lived so it doesn't linger over writing.
        fireToast(tRef.current('save.saved'), { duration: 1500 })
      }
    } catch (e) {
      // Never fail silently — surface the real error so saving is debuggable.
      fireToast(tRef.current('save.failed', { msg: e?.message || String(e) }), { sticky: true })
    }
  }, [isMobile])

  const saveTab = useCallback(
    async (id, forceDialog = false) => {
      commitAllLive() // flush any textarea edits in the debounce window before reading
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      let target = tab.path
      if (!target || forceDialog) {
        // Mobile has no native save dialog: ask for a filename, then write into
        // the local library (see commitMobileSave). Desktop keeps the dialog.
        if (isMobile) {
          const base = (tab.title || 'Untitled').replace(/\.(md|markdown|mdx)$/i, '')
          setSaveNameState({ id, value: base + '.md' })
          return
        }
        target = await window.api.saveAs(tab.title.endsWith('.md') ? tab.title : tab.title + '.md')
        if (!target) return
      }
      await writeTab(tab, target)
    },
    [commitAllLive, writeTab, isMobile]
  )

  // Commit a mobile "save as": let the platform layer place the named file in
  // the local library (it returns a de-duplicated path), then write it.
  const commitMobileSave = useCallback(
    async (id, rawName) => {
      setSaveNameState(null)
      commitAllLive()
      const tab = tabsRef.current.find((t) => t.id === id)
      let name = (rawName || '').trim()
      if (!tab || !name) return
      if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
        window.alert(tRef.current('err.invalidName') + name)
        return
      }
      if (!/\.(md|markdown|mdx)$/i.test(name)) name += '.md'
      const target = await window.api.saveAs(name)
      if (!target) return
      await writeTab(tab, target)
    },
    [commitAllLive, writeTab]
  )

  // Export a file (by path) to PDF: open/focus it, wait for its editor to mount,
  // then reuse the same HTML→PDF pipeline as the menu command. Driven from the
  // sidebar's right-click menu, where the file may not be open yet.
  const exportPathToPdf = useCallback(
    async (path) => {
      await openPaths([path])
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (!tab) return
      let html = null
      for (let i = 0; i < 40 && !html; i++) {
        html = editorApis.current[tab.id]?.getDocHTML?.()
        if (!html) await new Promise((r) => setTimeout(r, 75))
      }
      if (!html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const base = (tab.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
      await window.api.exportPDF(html, base + '.pdf')
    },
    [openPaths]
  )

  // --------------------------- workspace ---------------------------
  const openFolder = useCallback(async () => {
    const dir = await window.api.openFolder()
    if (!dir) return
    const rootName = baseName(dir)
    setWorkspace({ rootPath: dir, rootName })
    setSidebarOpen(true)
  }, [])

  useEffect(() => {
    if (!workspace) {
      setFiles([])
      return
    }
    window.api.watchStart(workspace.rootPath)
    window.api.listFiles(workspace.rootPath).then(setFiles)
    return () => window.api.watchStop(workspace.rootPath)
  }, [workspace])

  useEffect(() => {
    const off = window.api.onWatchChanged(() => {
      setRefreshNonce((n) => n + 1)
      if (workspace) window.api.listFiles(workspace.rootPath).then(setFiles)
    })
    return off
  }, [workspace])

  // --------- auto-reload open files edited by external programs ----------
  const watchedRef = useRef(new Set())

  // Keep a per-file watcher in sync with the set of open file paths.
  useEffect(() => {
    const want = new Set(tabs.map((t) => t.path).filter(Boolean))
    for (const p of want) if (!watchedRef.current.has(p)) window.api.watchFile(p)
    for (const p of watchedRef.current) if (!want.has(p)) window.api.unwatchFile(p)
    watchedRef.current = want
  }, [tabs])

  const reloadTabFromDisk = useCallback(async (id, path) => {
    commitAllLive() // so the "don't clobber unsaved" check below sees live edits
    try {
      const { content, mtimeMs } = await window.api.readFile(path)
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          // Bail if the user has started editing since the change fired —
          // never clobber unsaved work.
          if (t.content !== t.savedContent) return t
          if (t.content === content) return { ...t, mtimeMs }
          // Adopt the on-disk content: drop any stale live-edit entry so the
          // textarea (keyed by reloadNonce) remounts with the new defaultValue.
          liveContentRef.current.delete(id)
          return {
            ...t,
            content,
            savedContent: content,
            mtimeMs,
            reloadNonce: t.reloadNonce + 1,
            heavy: isHeavyDoc(content)
          }
        })
      )
    } catch {
      /* file vanished mid-reload; leave the tab as-is */
    }
  }, [commitAllLive])

  useEffect(() => {
    const off = window.api.onFileChanged(({ path, mtimeMs }) => {
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (!tab) return
      // Ignore the echo from our own save (same or older mtime).
      if (tab.mtimeMs && mtimeMs && mtimeMs <= tab.mtimeMs) return
      // Don't overwrite unsaved local edits.
      if (tab.content !== tab.savedContent) return
      reloadTabFromDisk(tab.id, tab.path)
    })
    return off
  }, [reloadTabFromDisk])

  // --------------------------- outline jump ------------------------
  const jumpToHeading = useCallback((index) => {
    // Make sure the document (not the Home page) is showing — otherwise the
    // active editor is hidden and editorHostRef isn't attached, so the jump
    // would silently do nothing. setHome(false) is a no-op when already not home.
    setHome(false)
    // On mobile the outline lives in the drawer; close it so the jumped-to
    // content is actually visible instead of hidden behind the drawer.
    if (isMobile) setSidebarOpen(false)
    const doJump = () => {
      const host = editorHostRef.current
      if (!host) return false
      const hs = host.querySelectorAll(
        '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
      )
      const el = hs[index]
      if (!el) return false
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }
    // Works synchronously in the normal case; if we just left Home, the editor
    // needs a frame to re-render and re-attach the ref before we can scroll it.
    if (doJump()) return
    requestAnimationFrame(() => {
      if (!doJump()) requestAnimationFrame(doJump)
    })
  }, [])

  // Outline scrollspy: highlight the heading you're currently viewing (the last
  // one scrolled past the top), mirroring how the file tree marks the open file.
  // Rich editor only — editorHostRef is the active pane's .editor-scroll; in
  // source mode it isn't attached, so the outline shows no active item there.
  // On large docs the per-scroll querySelectorAll + getBoundingClientRect chain
  // is a forced reflow that freezes the main thread → scroll "chase" (#17).
  // Throttle to at most once per 300ms (not per frame) and skip entirely while
  // the user is actively scrolling fast (resume on settle).
  const [activeHeading, setActiveHeading] = useState(-1)
  // Bumped when a chunked-loaded rich doc finishes streaming in (Editor's
  // onStructureChange) so the outline list + scrollspy refresh against the now-
  // complete DOM — during load onChange is suppressed, so they can't track the
  // growing doc via content alone. richLoading drives the outline skeleton.
  const [richDocVersion, setRichDocVersion] = useState(0)
  const [richLoading, setRichLoading] = useState(false)
  useEffect(() => {
    if (home || !sidebarOpen || sidebarMode !== 'outline' || sourceMode) {
      setActiveHeading(-1)
      return
    }
    const scroller = editorHostRef.current
    if (!scroller) return

    // Reflow-free scrollspy. The previous version re-queried and called
    // getBoundingClientRect() on EVERY heading on every throttle tick. On a
    // large doc each call forces a full-document layout recalc, which
    // (a) froze the main thread during scroll (#17 "chase" lag) and (b) used a
    // leading-edge-only throttle with no trailing update — so when scrolling
    // stopped the last compute was up to 300ms stale and the outline landed on
    // the WRONG heading. Fix: measure each heading's content-offset ONCE (a
    // single layout pass, rebuilt every 2s / on resize), then compare against
    // the cheap scrollTop on scroll. No layout read per frame, so it can update
    // every frame and always reflects the exact current position.
    let tops = null // heading content-offsets (px from content top); stable across scroll
    let builtAt = 0
    let raf = 0
    let lastIdx = -1
    let tries = 0

    const build = () => {
      const els = scroller.querySelectorAll(
        '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
      )
      if (!els.length) {
        tops = null
        return
      }
      // Read every rect in one synchronous block = ONE reflow, not N. Convert
      // each to a content-offset (Y = rect.top − scroller.top + scrollTop); Y is
      // invariant under scrolling, so the cache stays valid while scrolling.
      const base = scroller.getBoundingClientRect().top
      const top0 = scroller.scrollTop
      tops = new Array(els.length)
      for (let i = 0; i < els.length; i++) tops[i] = els[i].getBoundingClientRect().top - base + top0
      builtAt = Date.now()
    }
    const compute = () => {
      raf = 0
      const now = Date.now()
      if (!tops || now - builtAt > 2000) {
        build()
        if (!tops) {
          // Editor still mounting (no headings yet) — retry briefly.
          if (tries++ < 30) raf = requestAnimationFrame(compute)
          return
        }
        tries = 0
      }
      // scrollTop is a cheap scroll-offset read — no layout, no reflow — so this
      // can run every frame without freezing and lands on the exact heading.
      const limit = scroller.scrollTop + 90
      let idx = 0
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= limit) idx = i
        else break
      }
      if (idx !== lastIdx) {
        lastIdx = idx
        setActiveHeading(idx) // only re-render the outline when the active row actually changes
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute) // coalesce to ≤ once per frame
    }
    compute()
    scroller.addEventListener('scroll', schedule, { passive: true })
    // Resize (and the layout-settings popover) reflow heading offsets → rebuild.
    const invalidate = () => {
      tops = null
      schedule()
    }
    window.addEventListener('resize', invalidate, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', invalidate)
    }
  }, [home, sidebarOpen, sidebarMode, sourceMode, activeId, richDocVersion])

  // Outline heading list, taken from the RENDERED document (the editor's actual
  // h1…h6 elements) — not regex'd from the markdown string. This matches how
  // jumpToHeading finds them, so the two stay in sync, and it recognizes every
  // heading the editor renders (ATX `#`, Setext, and HTML <h1>) regardless of
  // how the source wrote it.
  const [outlineHeadings, setOutlineHeadings] = useState([])
  useEffect(() => {
    if (home || !activeTab) {
      setOutlineHeadings([])
      return
    }
    // Debounce: the effect re-runs on every content change (every keystroke).
    // On large docs the querySelectorAll scan is expensive. Wait 500ms after the
    // last edit before scanning — headings don't change mid-word.
    let timer = 0
    const read = () => {
      timer = 0
      const pm = editorHostRef.current?.querySelector('.ProseMirror')
      // No editor mounted (e.g. just closed the file) → clear instead of
      // leaving the previous document's outline hanging (issue #20).
      if (!pm) {
        setOutlineHeadings([])
        return
      }
      const els = pm.querySelectorAll('h1, h2, h3, h4, h5, h6')
      setOutlineHeadings(
        [...els].map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim() }))
      )
    }
    timer = setTimeout(read, 500)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [home, activeId, activeTab?.content, sourceMode, richDocVersion])

  // ------------------------- menu / shortcuts ----------------------
  // In split view, target the pane you're actually editing (last focused), as
  // long as it's one of the two visible panes; otherwise the active (left) tab.
  const pickEditableId = () => {
    const f = focusedTabRef.current
    if (f && (f === activeId || f === splitId)) return f
    return activeId
  }

  const getEditableTab = () => {
    const id = pickEditableId()
    return tabsRef.current.find((tab) => tab.id === id) || null
  }

  const applyReviewMarkupToActive = (kind) => {
    const tab = getEditableTab()
    if (!tab) {
      fireToast(tRef.current('review.noDocument'))
      return
    }

    setHome(false)
    const sourceEl = sourceTextareas.current[tab.id]
    if (sourceEl) {
      const result = wrapReviewSelection(tab.content, sourceEl.selectionStart, sourceEl.selectionEnd, kind)
      if (result.error === 'multiline') {
        fireToast(tRef.current('review.inlineOnly'))
        return
      }
      const editedEl = sourceEl
      updateContent(tab.id, normalizeReviewMarkupMarkdown(result.text), false)
      requestAnimationFrame(() => {
        if (sourceTextareas.current[tab.id] === editedEl) {
          editedEl.focus()
          editedEl.setSelectionRange(result.selectionStart, result.selectionEnd)
        }
      })
      return
    }

    const applied = editorApis.current[tab.id]?.applyReviewMarkup?.(kind)
    if (applied == null) fireToast(tRef.current('review.noDocument'))
  }

  const applyReviewDecisionToActive = (decision) => {
    const tab = getEditableTab()
    if (!tab) {
      fireToast(tRef.current('review.noDocument'))
      return
    }

    const next = applyReviewDecision(tab.content, decision)
    if (next === tab.content) {
      fireToast(tRef.current('review.noMarks'))
      return
    }

    setHome(false)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tab.id
          ? { ...t, content: next, reloadNonce: t.reloadNonce + 1, heavy: isHeavyDoc(next) }
          : t
      )
    )
    fireToast(tRef.current(decision === 'accept' ? 'review.acceptedAll' : 'review.rejectedAll'))
  }

  const copyReviewPrompt = () => {
    const tab = getEditableTab()
    if (!tab) {
      fireToast(tRef.current('review.noDocument'))
      return
    }
    copyToClipboard(buildReviewAiPrompt(tab.content), tRef.current('review.promptCopied'))
  }

  const handlers = useRef({})
  handlers.current = {
    home: () => {
      setHome(true)
      if (isMobile) setSidebarOpen(false) // jump straight to Home, don't leave the drawer over it
    },
    new: newTab,
    open: async () => openPaths(await window.api.openFiles()),
    openFolder,
    save: () => {
      const id = pickEditableId()
      if (id) saveTab(id)
    },
    saveAs: () => {
      const id = pickEditableId()
      if (id) saveTab(id, true)
    },
    exportPdf: async () => {
      const id = pickEditableId()
      const html = editorApis.current[id]?.getDocHTML?.()
      if (!html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const tab = tabs.find((x) => x.id === id)
      const base = (tab?.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
      await window.api.exportPDF(html, base + '.pdf')
    },
    closeTab: () => activeId && closeTab(activeId),
    palette: () => setPaletteOpen((v) => !v),
    toggleSidebar: () => setSidebarOpen((v) => !v),
    toggleOutline: () => {
      setSidebarMode('outline')
      setSidebarOpen(true)
    },
    toggleFiles: () => {
      setSidebarMode('files')
      setSidebarOpen(true)
    },
    toggleSource,
    toggleTheme: cycleTheme,
    find: () => {
      // Leave the Home page so find acts on the visible document, not a hidden one.
      setHome(false)
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => findInputRef.current?.focus(), 0)
    },
    replace: () => {
      // Open the find bar and focus the replace field (Mod+Alt+F / palette).
      setHome(false)
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => replaceInputRef.current?.focus(), 0)
    },
    reviewAdd: () => applyReviewMarkupToActive(REVIEW_KINDS.addition),
    reviewDelete: () => applyReviewMarkupToActive(REVIEW_KINDS.deletion),
    reviewSubstitute: () => applyReviewMarkupToActive(REVIEW_KINDS.substitution),
    reviewHighlight: () => applyReviewMarkupToActive(REVIEW_KINDS.highlight),
    reviewCopyPrompt: copyReviewPrompt,
    reviewAcceptAll: () => applyReviewDecisionToActive('accept'),
    reviewRejectAll: () => applyReviewDecisionToActive('reject')
  }

  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => handlers.current[cmd]?.())
    const offOpen = window.api.onOpenPaths((paths) => openPaths(paths))
    // A folder path arriving from Explorer's "Open with HorseMD" folder menu.
    const offFolder = window.api.onOpenFolderPath?.((dir) => {
      if (!dir || !isAbsolutePath(dir)) return // never open a relative path as a workspace
      setWorkspace({ rootPath: dir, rootName: baseName(dir) })
      setSidebarMode('files')
      setSidebarOpen(true)
    })
    const onOpenFolderEvt = () => openFolder()
    window.addEventListener('mm:openFolder', onOpenFolderEvt)
    // Main asks before the window closes so we can warn about unsaved changes.
    const offClose = window.api.onAppCloseRequest?.(() => {
      // Flush textarea edits still inside the per-tab debounce window, then write
      // the session — so a recent keystroke isn't lost on quit.
      commitAllLive()
      flushSession()
      const dirty = tabsRef.current.some((t) => t.content !== t.savedContent)
      if (!dirty || window.confirm(tRef.current('confirm.quitUnsaved'))) {
        window.api.confirmAppClose()
      } else {
        window.api.cancelAppClose?.()
      }
    })
    return () => {
      offMenu()
      offOpen()
      offFolder?.()
      offClose?.()
      window.removeEventListener('mm:openFolder', onOpenFolderEvt)
    }
  }, [openPaths, openFolder])

  // Ctrl+Tab cycling + restore session tabs on first mount
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        setTabs((prev) => {
          if (prev.length < 2) return prev
          const i = prev.findIndex((t) => t.id === activeId)
          const ni = (i + (e.shiftKey ? -1 : 1) + prev.length) % prev.length
          setActiveId(prev[ni].id)
          setHome(false)
          return prev
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId])

  // Ctrl/Cmd+B toggles the sidebar. Handled here in the CAPTURE phase so it
  // fires before the editor's "bold" keybinding (which would otherwise eat it
  // and made the shortcut feel unreliable). No menu accelerator, so it can't
  // double-fire either.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        e.stopPropagation()
        handlers.current.toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Mod+F = find, Mod+Alt+F = replace (opens the bar and focuses the replace
  // field). Capture phase so it beats any editor binding, like Mod+B above.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyF') {
        e.preventDefault()
        e.stopPropagation()
        if (e.altKey) handlers.current.replace()
        else handlers.current.find()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

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
      })
    } else {
      const created = addUntitled()
      if (created && created.length) setActiveId(created[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- persistence -------------------------
  useEffect(() => {
    const data = {
      workspace,
      theme,
      customTheme,
      lang,
      recents,
      sidebarOpen,
      sidebarMode,
      openPaths: tabs.map((t) => t.path).filter(Boolean),
      // Persist unsaved scratch/new tabs (no path, with edited content) so they
      // survive a restart — closing the app no longer silently loses them. Only
      // dirty tabs are stored, so the untouched welcome doc / empty new tabs
      // don't keep coming back. Saved files are reopened from disk instead.
      untitled: tabs
        .filter((t) => !t.path && t.content !== t.savedContent && (t.content || '').trim())
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
  }, [workspace, theme, customTheme, lang, recents, sidebarOpen, sidebarMode, tabs, activePath, flushSession])

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

  // --------------------------- commands ----------------------------
  const commands = useMemo(
    () => {
      const caps = window.api.capabilities || {}
      return [
        { id: 'cmd.new', title: t('cmd.new'), icon: 'file-plus', run: () => handlers.current.new() },
        { id: 'cmd.open', title: t('cmd.open'), icon: 'file', run: () => handlers.current.open() },
        { id: 'cmd.openFolder', title: t('cmd.openFolder'), icon: 'folder', run: () => handlers.current.openFolder() },
        { id: 'cmd.save', title: t('cmd.save'), icon: 'save', run: () => handlers.current.save() },
        { id: 'cmd.saveAs', title: t('cmd.saveAs'), icon: 'save', run: () => handlers.current.saveAs() },
        // Export-to-PDF needs a save dialog / print pipeline that doesn't exist on mobile.
        caps.pdfExport && { id: 'cmd.exportPdf', title: t('cmd.exportPdf'), icon: 'file', run: () => handlers.current.exportPdf() },
        { id: 'cmd.sidebar', title: t('cmd.sidebar'), icon: 'sidebar', run: () => handlers.current.toggleSidebar() },
        { id: 'cmd.files', title: t('cmd.files'), icon: 'folder', run: () => handlers.current.toggleFiles() },
        { id: 'cmd.outline', title: t('cmd.outline'), icon: 'outline', run: () => handlers.current.toggleOutline() },
        { id: 'cmd.source', title: t('cmd.source'), icon: 'code', run: () => handlers.current.toggleSource() },
        { id: 'cmd.theme', title: t('cmd.theme'), icon: 'moon', run: () => handlers.current.toggleTheme() },
        { id: 'cmd.find', title: t('cmd.find'), icon: 'search', run: () => handlers.current.find() },
        { id: 'cmd.replace', title: t('cmd.replace'), icon: 'replace', run: () => handlers.current.replace() },
        { id: 'cmd.reviewAdd', title: t('cmd.reviewAdd'), icon: 'review', run: () => handlers.current.reviewAdd() },
        { id: 'cmd.reviewDelete', title: t('cmd.reviewDelete'), icon: 'review', run: () => handlers.current.reviewDelete() },
        {
          id: 'cmd.reviewSubstitute',
          title: t('cmd.reviewSubstitute'),
          icon: 'review',
          run: () => handlers.current.reviewSubstitute()
        },
        { id: 'cmd.reviewHighlight', title: t('cmd.reviewHighlight'), icon: 'review', run: () => handlers.current.reviewHighlight() },
        { id: 'cmd.reviewCopyPrompt', title: t('cmd.reviewCopyPrompt'), icon: 'review', run: () => handlers.current.reviewCopyPrompt() },
        { id: 'cmd.reviewAcceptAll', title: t('cmd.reviewAcceptAll'), icon: 'review', run: () => handlers.current.reviewAcceptAll() },
        { id: 'cmd.reviewRejectAll', title: t('cmd.reviewRejectAll'), icon: 'review', run: () => handlers.current.reviewRejectAll() }
      ].filter(Boolean)
    },
    [t]
  )

  // Discriminate the active view: the source <textarea> sets sourceRef only when
  // it's mounted (source mode or a .txt doc); otherwise we're in the rich editor.
  const richRoot = () => editorHostRef.current?.querySelector('.ProseMirror') || null
  const findQueryRef = useRef('')
  const replaceRef = useRef('')
  const activeIdxRef = useRef(-1)

  // Run a fresh search for `query`, scoped to the editor content. `preferActive`
  // is the 0-based match index to land on (clamped) — used after a replace to
  // stay on the next match instead of jumping back to the first.
  const runFind = useCallback((query, preferActive = 0) => {
    const q = query ?? ''
    findQueryRef.current = q
    clearFindHighlights()
    findRangesRef.current = []
    if (sourceRef.current) {
      // Source textarea: live-count only (selecting would steal the find input's
      // focus); Enter / next / prev jump to a match.
      const hits = matchIndices(sourceRef.current.value, q)
      findRangesRef.current = hits
      const i = hits.length ? Math.min(preferActive, hits.length - 1) : -1
      activeIdxRef.current = i
      setFind((f) => ({ ...f, matches: hits.length, active: i + 1 }))
      return
    }
    const root = richRoot()
    const ranges = q ? findRangesInEl(root, q) : []
    findRangesRef.current = ranges
    const i = ranges.length ? Math.min(preferActive, ranges.length - 1) : -1
    activeIdxRef.current = i
    if (ranges.length) {
      paintFindHighlights(ranges, i)
      scrollRangeIntoView(ranges[i], root.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, matches: ranges.length, active: i + 1 }))
  }, [])

  // Move to the next / previous match (wrapping around).
  const stepFind = useCallback((backwards = false) => {
    const items = findRangesRef.current
    if (!items.length) return
    let i = activeIdxRef.current + (backwards ? -1 : 1)
    if (i < 0) i = items.length - 1
    if (i >= items.length) i = 0
    activeIdxRef.current = i
    if (sourceRef.current) {
      const el = sourceRef.current
      el.focus()
      el.setSelectionRange(items[i], items[i] + findQueryRef.current.length)
    } else {
      paintFindHighlights(items, i)
      scrollRangeIntoView(items[i], richRoot()?.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, active: i + 1 }))
  }, [])

  const closeFind = useCallback(() => {
    clearFindHighlights()
    findRangesRef.current = []
    activeIdxRef.current = -1
    findQueryRef.current = ''
    // Keep the replace text across open/close (mirrors editors like VSCode).
    setFind((f) => ({ open: false, query: '', matches: 0, active: 0, replace: f.replace }))
  }, [])

  // The active rich editor's ProseMirror view (null in source/plain-text mode).
  // Used to turn a find DOM Range into document positions for replacement.
  const richView = () => editorApis.current[activeId]?.getView?.() || null

  // Replace the active match (then land on the next), or every match. Works in
  // both the rich editor (DOM Range → ProseMirror positions, one transaction)
  // and the source textarea (offsets). Re-runs the search afterwards so counts
  // stay correct; for a single replace it keeps the cursor on the next match.
  const applyReplace = useCallback(
    (all = false) => {
      const q = findQueryRef.current
      const repl = replaceRef.current
      if (!q) return
      const i = Math.max(0, activeIdxRef.current)

      if (sourceRef.current) {
        const el = sourceRef.current
        const val = el.value
        const offsets = findRangesRef.current // number[] of match starts
        if (!offsets.length) return
        let next
        if (all) {
          // Bottom-up so earlier offsets stay valid as the string shifts.
          next = val
          for (const start of [...offsets].sort((a, b) => b - a)) {
            next = next.slice(0, start) + repl + next.slice(start + q.length)
          }
        } else {
          const start = offsets[i]
          next = val.slice(0, start) + repl + val.slice(start + q.length)
        }
        // Uncontrolled textarea: write the DOM directly + stash the value so
        // the debounced commit (and commitAllLive before save/close) persists
        // it. updateContent() alone wouldn't touch the DOM here, so the
        // replace would vanish and runFind would re-read the old value.
        el.value = next
        liveContentRef.current.set(activeId, next)
        commitLive(activeId)
        runFind(q, all ? 0 : i)
        return
      }

      const view = richView()
      const ranges = findRangesRef.current // Range[]
      if (!view || !ranges.length) return
      const tr = view.state.tr
      if (all) {
        // Convert every range to positions, then replace bottom-up in ONE
        // transaction so earlier positions don't shift mid-loop.
        const spans = ranges
          .map((r) => [view.posAtDOM(r.startContainer, r.startOffset), view.posAtDOM(r.endContainer, r.endOffset)])
          .sort((a, b) => b[0] - a[0])
        for (const [from, to] of spans) tr.insertText(repl, from, to)
      } else {
        const r = ranges[i]
        const from = view.posAtDOM(r.startContainer, r.startOffset)
        const to = view.posAtDOM(r.endContainer, r.endOffset)
        tr.insertText(repl, from, to)
      }
      view.dispatch(tr)
      view.focus()
      requestAnimationFrame(() => runFind(q, all ? 0 : i))
    },
    [activeId, runFind, commitLive]
  )

  // Re-run the search when switching tabs while the find bar is open, so ranges
  // point at the newly-visible document.
  useEffect(() => {
    if (find.open) runFind(findQueryRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const platformClass =
    ({ win32: ' is-win', darwin: ' is-mac', ios: ' is-ios is-mobile', android: ' is-android is-mobile' }[
      window.api.platform
    ] || '')

  return (
    <I18nProvider lang={lang} setLang={setLang}>
    <div className={`app${platformClass}${isMobile && sidebarOpen ? ' drawer-open' : ''}`}>
      <div className="activity-bar">
        <button
          className={`activity-item activity-home${home ? ' active' : ''}`}
          title={t('nav.home')}
          onClick={() => handlers.current.home()}
        >
          <img className="activity-logo" src={logoUrl} alt="HorseMD" />
        </button>
        <button
          className={`activity-item${sidebarMode === 'files' ? ' active' : ''}`}
          title={t('cmd.files')}
          onClick={() => handlers.current.toggleFiles()}
        >
          <Icon name="folder" size={20} />
        </button>
        <button
          className={`activity-item${sidebarMode === 'outline' ? ' active' : ''}`}
          title={t('outline.title')}
          onClick={() => handlers.current.toggleOutline()}
        >
          <Icon name="outline" size={20} />
        </button>
        <div className="activity-spacer" />
        <button
          className="activity-item"
          title={sidebarOpen ? t('side.collapsePane') : t('side.expandPane')}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <Icon name={sidebarOpen ? 'panel-left-close' : 'panel-left-open'} size={20} />
        </button>
      </div>

      <div className="topbar">
        {isMobile && (
          <button
            className="icon-btn drag-no hm-menu-btn"
            title={t('cmd.files')}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <Icon name="menu" size={20} />
          </button>
        )}
        <Tabs
          tabs={tabs}
          activeId={home ? null : activeId}
          splitId={home ? null : splitId}
          focusedPane={focusedPane}
          onActivate={(id) => {
            setHome(false)
            // Load into whichever pane is focused, so both panes are switchable.
            if (split && focusedPane === 'right' && id !== activeId) {
              setSplitId(id)
            } else {
              setActiveId(id)
            }
          }}
          onClose={closeTab}
          onNew={newTab}
          onCloseOthers={closeOthers}
          onOpenRight={openRight}
          onRename={renameTabFile}
          onDuplicate={duplicateTabFile}
          onDelete={deleteTabFile}
          onExportPdf={exportPathToPdf}
        />
        <div className="topbar-spacer" />
        <button className="icon-btn drag-no" title={`${t('welcome.newFile')} (Ctrl+N)`} onClick={newTab}>
          <Icon name="plus" size={18} />
        </button>
        {!isMobile && (
          <button
            className={`icon-btn drag-no${split ? ' active' : ''}`}
            title={split ? t('split.close') : t('split.toggle')}
            onClick={toggleSplit}
          >
            <Icon name="columns" size={16} />
          </button>
        )}
        {!isMobile && (
          <ImageHostButton
            t={t}
            command={settings.imageUploadCommand}
            onChange={(cmd) => updateSettings({ imageUploadCommand: cmd })}
          />
        )}
        <button className="icon-btn drag-no" title="Command palette (Ctrl+P)" onClick={() => setPaletteOpen(true)}>
          <Icon name="command" size={16} />
        </button>
        {window.api.platform === 'win32' && <WindowControls t={t} />}
      </div>

      {isMobile && sidebarOpen && (
        <div className="hm-scrim" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="body">
        <aside className={`pane-left${sidebarOpen ? '' : ' collapsed'}`}>
          {sidebarOpen && (
            sidebarMode === 'files' ? (
              <Sidebar
                workspace={workspace}
                activePath={activePath}
                onOpenFile={(p) => { openPaths([p]); if (isMobile) setSidebarOpen(false) }}
                onOpenRight={openFileRight}
                onExportPdf={exportPathToPdf}
                refreshNonce={refreshNonce}
              />
            ) : (
              <Outline headings={outlineHeadings} activeIndex={activeHeading} loading={richLoading} onJump={jumpToHeading} />
            )
          )}
        </aside>

        <main className="pane-center">
          {find.open && (
            <div className="findbar">
              <div className="findbar-row">
                <Icon name="search" size={14} />
                <input
                  ref={findInputRef}
                  value={find.query}
                  placeholder={t('find.placeholder')}
                  onChange={(e) => {
                    const q = e.target.value
                    setFind((f) => ({ ...f, query: q }))
                    runFind(q) // live: highlight as you type
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey) }
                    if (e.key === 'Escape') closeFind()
                  }}
                />
                <span className="findbar-count">
                  {find.query ? `${find.active}/${find.matches}` : ''}
                </span>
                <button title={t('find.prev')} onClick={() => stepFind(true)}>
                  <Icon name="chevron-up" size={14} />
                </button>
                <button title={t('find.next')} onClick={() => stepFind(false)}>
                  <Icon name="chevron-down" size={14} />
                </button>
                <button title={t('find.close')} onClick={closeFind}>
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="findbar-row">
                <Icon name="replace" size={14} />
                <input
                  ref={replaceInputRef}
                  value={find.replace}
                  placeholder={t('find.replace.placeholder')}
                  onChange={(e) => {
                    replaceRef.current = e.target.value
                    setFind((f) => ({ ...f, replace: e.target.value }))
                  }}
                  onKeyDown={(e) => {
                    // Enter = replace this one; Shift+Enter = replace all.
                    if (e.key === 'Enter') { e.preventDefault(); applyReplace(e.shiftKey) }
                    if (e.key === 'Escape') closeFind()
                  }}
                />
                <span className="findbar-spacer" />
                <button
                  className="findbar-textbtn"
                  title={t('find.replace')}
                  disabled={!find.query}
                  onClick={() => applyReplace(false)}
                >
                  {t('find.replace')}
                </button>
                <button
                  className="findbar-textbtn"
                  title={t('find.replaceAll')}
                  disabled={!find.query}
                  onClick={() => applyReplace(true)}
                >
                  {t('find.replaceAll')}
                </button>
              </div>
            </div>
          )}

          {/* Editor area — a flex row so the active (left) and split (right) tabs
              can sit side by side. Editors are siblings here; only the one(s) in
              view are shown (the rest are display:none but stay mounted, so tab
              switches / toggling split never re-create an editor). Hidden as a
              whole on the welcome/home screen so it doesn't fight Welcome for space. */}
          <div
            ref={editorAreaRef}
            className={`editor-area${split ? ' is-split' : ''}`}
            style={{ display: home || !activeTab ? 'none' : undefined }}
          >
            {tabs.map((tab) => {
              // Which pane (if any) this tab occupies. `split` already excludes
              // home and the case where the two ids are equal.
              const isLeft = !home && tab.id === activeId
              const isRight = split && tab.id === splitId
              const inView = isLeft || isRight
              // Flex order: left pane (1) · divider (2) · right pane (3).
              // Irrelevant for hidden tabs (display:none removes them from layout).
              const order = isRight ? 3 : 1
              // Mark the focused pane (only meaningful while split) so the user
              // can see which pane a tab click will load into.
              const isFocusedPane = split && ((isRight && focusedPane === 'right') || (isLeft && focusedPane === 'left'))
              const paneClass =
                (isRight ? ' hm-pane-right' : isLeft ? ' hm-pane-left' : '') + (isFocusedPane ? ' hm-focused' : '')
              const onPaneFocus = () => {
                focusedTabRef.current = tab.id
                if (split) setFocusedPane(isRight ? 'right' : 'left')
              }
              // In split view the left pane holds a fixed fraction; the right pane
              // grows to fill the rest. Outside split, panes fill the row.
              const paneFlex = split && isLeft ? `0 0 calc(${(splitRatio * 100).toFixed(2)}% - 3px)` : undefined

              // Plain-text docs always use the textarea; "heavy" Markdown docs do
              // too until the user opts into rich (avoids a multi-second freeze);
              // the active pane also uses it in global source mode. The right pane
              // never shows global source mode.
              const heavyAsSource = tab.heavy && !richForced.has(tab.id)
              const usesTextarea = isPlainTextDoc(tab) || heavyAsSource || (sourceMode && isLeft)
              // content-visibility virtualization (see .hm-cv in app.css) kicks in
              // only for genuinely large RICH documents — small docs and the
              // textarea path are untouched. ~20k chars ≈ hundreds of blocks,
              // the range where software-composited scrolling starts to struggle.
              const largeRich = !usesTextarea && (tab.content?.length || 0) >= 20000
              if (usesTextarea) {
                if (!inView) return null
                const setSourceTextareaRef = (el) => {
                  if (el) {
                    sourceTextareas.current[tab.id] = el
                    if (isLeft) sourceRef.current = el
                    return
                  }
                  const existing = sourceTextareas.current[tab.id]
                  delete sourceTextareas.current[tab.id]
                  if (isLeft && (!existing || sourceRef.current === existing)) sourceRef.current = null
                }
                return (
                  <textarea
                    key={`${tab.id}:${tab.reloadNonce}`}
                    ref={setSourceTextareaRef}
                    className={`source-editor${paneClass}`}
                    defaultValue={tab.content}
                    spellCheck={false}
                    style={{ order, flex: paneFlex }}
                    onFocus={onPaneFocus}
                    onMouseDown={onPaneFocus}
                    onChange={(e) => {
                      // Uncontrolled: stash the edit and debounce-commit it, so
                      // typing never re-renders App or re-sets a multi-MB value per
                      // keystroke. commitAllLive() flushes before save/close/etc.
                      const v = e.target.value
                      liveContentRef.current.set(tab.id, v)
                      const prev = liveTimersRef.current.get(tab.id)
                      if (prev) clearTimeout(prev)
                      liveTimersRef.current.set(tab.id, setTimeout(() => commitLive(tab.id), 400))
                    }}
                  />
                )
              }
              // Lazy mount: don't create a Crepe editor for a tab the user hasn't
              // opened yet (keeps session-restore of many tabs fast). Panes in
              // view always mount; visited tabs stay mounted.
              if (!inView && !mountedIds.has(tab.id)) return null
              return (
                <div
                  // Include reloadNonce so an external-edit reload remounts the
                  // Crepe editor with the new content (the create effect only
                  // runs on mount). tab switches keep the same key → stay mounted.
                  key={`${tab.id}:${tab.reloadNonce}`}
                  className={`editor-scroll${paneClass}${largeRich ? ' hm-cv' : ''}`}
                  ref={isLeft && !sourceMode ? editorHostRef : undefined}
                  style={{ display: inView ? undefined : 'none', order, flex: paneFlex }}
                  onFocusCapture={onPaneFocus}
                  onMouseDownCapture={onPaneFocus}
                >
                  <Editor
                    tabId={`${tab.id}:${tab.reloadNonce}`}
                    initialContent={tab.content}
                    docPath={tab.path}
                    imageUploadCommand={settings.imageUploadCommand}
                    onChange={(md, isInitial) => updateContent(tab.id, md, isInitial)}
                    onReady={(api) => {
                      editorApis.current[tab.id] = api
                    }}
                    onActiveBlock={(id) => {
                      if (tab.id === activeIdRef.current) setActiveBlock(id)
                    }}
                    onStructureChange={() => setRichDocVersion((v) => v + 1)}
                    onLoadingChange={setRichLoading}
                  />
                </div>
              )
            })}

            {/* Heavy-doc notice: this Markdown file is shown as plain source to
                stay responsive; offer a one-click switch to the rich editor. */}
            {!home && activeTab && activeTab.heavy && !richForced.has(activeTab.id) && (
              <div className="hm-heavy-banner">
                <span>{t('heavy.notice')}</span>
                <button onClick={() => setRichForced((s) => new Set(s).add(activeTab.id))}>
                  {t('heavy.loadRich')}
                </button>
              </div>
            )}

            {split && (
              <div
                className="hm-split-divider"
                style={{ order: 2 }}
                onMouseDown={startSplitDrag}
                title={t('split.drag')}
              />
            )}

            {split && (
              <button className="hm-split-close" title={t('split.close')} onClick={() => setSplitId(null)}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          {(home || !activeTab) && (
            <Welcome
              t={t}
              lang={lang}
              recents={recents}
              onNew={newTab}
              onOpen={() => handlers.current.open()}
              onOpenFolder={openFolder}
              onOpenRecent={(p) => openPaths([p])}
              onRemoveRecent={(p) =>
                setRecents((prev) => prev.filter((r) => r.path !== p))
              }
            />
          )}
        </main>
      </div>

      <StatusBar
        tab={home ? null : activeTab}
        isMobile={isMobile}
        onSave={() => handlers.current.save()}
        onShare={() => {
          if (!activeTab) return
          if (!activeTab.path) {
            fireToast(tRef.current('save.shareNeedsSave'), { sticky: true })
            return
          }
          window.api.shareFile?.(activeTab.path)
        }}
        theme={theme}
        setTheme={pickBuiltinTheme}
        cycleTheme={cycleTheme}
        customThemes={customThemes}
        customTheme={customTheme}
        onPickCustom={setCustomTheme}
        onRefreshThemes={refreshThemes}
        onOpenThemesFolder={() => window.api.themesReveal?.()}
        onGetMoreThemes={() => window.api.openExternal('https://theme.typora.io/')}
        lang={lang}
        setLang={setLang}
        sourceMode={sourceMode}
        onToggleSource={toggleSource}
        activeBlock={activeBlock}
        onPickBlock={(id) => editorApis.current[activeId]?.setBlock(id)}
        pageWidth={settings.pageWidth}
        onSetPageWidth={(w) => updateSettings({ pageWidth: w })}
        fontSize={settings.fontSize}
        onSetFontSize={(s) => updateSettings({ fontSize: s })}
        lineHeight={settings.lineHeight}
        onSetLineHeight={(v) => updateSettings({ lineHeight: v })}
        paragraphSpacing={settings.paragraphSpacing}
        onSetParagraphSpacing={(v) => updateSettings({ paragraphSpacing: v })}
      />

      <SaveFab
        visible={!home && !!activeTab && activeTab.content !== activeTab.savedContent}
        onSave={() => handlers.current.save()}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        files={files}
        onOpenFile={(p) => { openPaths([p]); if (isMobile) setSidebarOpen(false) }}
      />

      {toast && (
        <div className={`hm-toast${toast.sticky ? ' sticky' : ''}`} role="status" key={toast.key}>
          <span className="hm-toast-msg">{toast.msg}</span>
          {toast.sticky && (
            <button className="hm-toast-close" onClick={() => setToast(null)} aria-label="Close">
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
      )}

      {renameState && (
        <RenameModal
          t={t}
          initial={renameState.value}
          onConfirm={(name) => commitTabRename(renameState.id, name)}
          onCancel={() => setRenameState(null)}
        />
      )}

      {saveNameState && (
        <RenameModal
          t={t}
          title={t('save.nameTitle')}
          initial={saveNameState.value}
          onConfirm={(name) => commitMobileSave(saveNameState.id, name)}
          onCancel={() => setSaveNameState(null)}
        />
      )}

      {update && (
        <UpdateToast
          t={t}
          latest={update.latest}
          current={update.current}
          notes={update.notes}
          onDownload={() => {
            window.api.openExternal(update.url)
            dismissUpdate()
          }}
          onDismiss={dismissUpdate}
        />
      )}
    </div>
    </I18nProvider>
  )
}
