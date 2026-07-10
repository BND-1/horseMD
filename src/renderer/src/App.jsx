import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Outline from './components/Outline.jsx'
import StatusBar from './components/StatusBar.jsx'
import SaveFab from './components/SaveFab.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { Icon } from './components/icons.jsx'
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js'
import { I18nProvider, translate, DEFAULT_LANG } from './i18n.jsx'
import Welcome from './components/Welcome.jsx'
import SettingsView from './components/SettingsView.jsx'
import ActivityBar from './components/shell/ActivityBar.jsx'
import Topbar from './components/shell/Topbar.jsx'
import FindBar from './components/shell/FindBar.jsx'
import EditorArea from './components/shell/EditorArea.jsx'
import UpdateToast from './components/UpdateToast.jsx'
import RenameModal from './components/RenameModal.jsx'
import {
  loadSettings,
  saveSettings,
  applyPageWidth,
  applyFontSize,
  applyLineHeight,
  applyParagraphSpacing,
  fontStack,
  DEFAULT_FONT_WRITE,
  DEFAULT_FONT_MONO
} from './settings.js'
import { applyCustomTheme } from './customThemes.js'
import { fireToast } from './ui.js'
import { useFindReplace } from './hooks/useFindReplace.js'
import { useOutline } from './hooks/useOutline.js'
import { useAppLifecycle } from './hooks/useAppLifecycle.js'
import { useColDrag } from './hooks/useColDrag.js'
import {
  captureRichCaret, captureSourceCaret, restoreRichCaret, restoreSourceCaret,
  captureRichViewport, captureSourceViewport, restoreRichViewport, restoreSourceViewport,
  isRichCaretVisible, isSourceCaretVisible
} from './scrollAnchor.js'
import { useFileOps } from './hooks/useFileOps.js'
import { createMenuHandlers, useGlobalKeys, useCommands } from './lib/menuHandlers.js'
import {
  baseName, isAbsolutePath, isHeavyDoc, loadSession
} from './paths.js'
import { createReviewActions } from './lib/reviewActions.js'

// Outline / file-tree pane drag bounds (px) — single source for the state init,
// the drag clamp, and the double-click reset. CSS max-width on .pane-left must
// stay >= PANE_MAX.
const PANE_MIN = 160
const PANE_MAX = 560
const PANE_DEFAULT = 260

const escapeLinkLabel = (text) =>
  String(text || 'attachment').replace(/([\\[\]])/g, '\\$1')
const markdownLinkTarget = (path) =>
  `<${String(path || '').replace(/[<>]/g, (ch) => (ch === '<' ? '%3C' : '%3E'))}>`
const attachmentLinkMarkdown = (name, path) =>
  `[${escapeLinkLabel(name)}](${markdownLinkTarget(path)})`

export default function App() {
  const session = useRef(loadSession()).current
  // Mobile (Capacitor) builds run the same renderer; a few affordances differ
  // (drawer sidebar, no split/image-host buttons). Desktop is unaffected.
  const isMobile = window.api.platform === 'ios' || window.api.platform === 'android'
  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  // On phones the sidebar overlays the editor, so it starts closed to keep the
  // writing surface front-and-center (desktop keeps its previous default).
  const [sidebarOpen, setSidebarOpen] = useState(session.sidebarOpen ?? !isMobile)
  const [sidebarMode, setSidebarMode] = useState(session.sidebarMode || 'files') // 'files' or 'outline'
  // Left-pane (outline / file-tree) width — draggable on hover (#resizable-pane).
  // Persisted in session; .pane-left reads it via the --pane-left-w CSS var.
  const [paneWidth, setPaneWidth] = useState(
    Math.max(PANE_MIN, Math.min(PANE_MAX, session.paneWidth ?? PANE_DEFAULT))
  )
  const [theme, setTheme] = useState(session.theme || DEFAULT_THEME)
  // Active custom CSS theme (filename in userData/themes), or null. Overlays the
  // built-in base theme. `customThemes` is the list scanned from that folder.
  const [customTheme, setCustomTheme] = useState(session.customTheme || null)
  const [customThemes, setCustomThemes] = useState([])
  const [lang, setLang] = useState(session.lang || DEFAULT_LANG)
  const [recents, setRecents] = useState(session.recents || [])
  // Source/rich mode is a per-tab view state (#42). A tab keeps its current
  // mode while you switch to another tab, but the state is intentionally not
  // persisted into the document or session.
  const [sourceModeIds, setSourceModeIds] = useState(() => new Set())
  const sourceMode = !!activeId && sourceModeIds.has(activeId)
  // Source textareas are uncontrolled and can unmount on tab switches. Track
  // which source buffers were edited so a later source→rich toggle still syncs
  // the edited Markdown into the still-mounted rich editor.
  const sourceEditedIds = useRef(new Set())
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
  const caretAnchorRef = useRef(null) // caret anchor (snippet/heading/ratio) to restore across a mode switch
  const viewportAnchorRef = useRef(null) // viewport-top text anchor (the reading position, separate from the caret)
  const richCaretAnchorRef = useRef(null) // rich-side caret anchor retained while source is open, so unchanged source returns through the more precise rich mapping
  const richViewportAnchorRef = useRef(null) // rich viewport anchor stashed across source mode, so the return-to-rich restore reuses the precise (content-stable) rich anchor instead of the lossy source one
  const caretFollowRef = useRef(false) // was the caret visible at toggle time? visible = editing (follow caret), off-screen = reading (keep viewport)
  const preserveRichCaretFollowRef = useRef(false) // source was not edited/moved, so keep the still-mounted rich selection exactly
  const sourceEnteredWithCaretFollowRef = useRef(false) // rich→source editing/reading intent; reused when source was not touched
  const richLoadingRef = useRef(false) // live mirror of richLoading (chunked large-doc load) for the mode-switch effect
  // Registry of each tab's editor API (by tab id). Several markdown editors can
  // be mounted at once (a tab stays mounted after its first activation), so a
  // single ref would get stuck on whichever editor mounted last; keying by tab
  // id lets commands act on the *currently active* document.
  const editorApis = useRef({})
  // The tab id of whichever editor pane last had focus — so Save / Export target
  // the pane you're actually editing in split view, not always the left one.
  const focusedTabRef = useRef(null)
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
  // Opening the Settings tab auto-closes the sidebar (outline/files) so the
  // settings page gets full width — the settings page has its own section jump-bar.
  useEffect(() => {
    if (!home && activeTab?.kind === 'settings') setSidebarOpen(false)
  }, [home, activeTab, setSidebarOpen])
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
    const current = tabsRef.current.find((t) => t.id === id)
    if (current?.content === content) return
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, content } : t))
    setTabs((prev) => prev.map((t) => (t.id === id && t.content !== content ? { ...t, content } : t)))
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
    for (const id of [...sourceEditedIds.current]) {
      if (!live.has(id)) sourceEditedIds.current.delete(id)
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
    setSourceModeIds((prev) => {
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

  const syncSourceToRich = useCallback((id) => {
    const sourceEl = sourceTextareas.current[id]
    if (!sourceEl) return false
    const next = sourceEl.value || ''
    const baseline = sourceEl.__horsemdSourceBaseline ?? ''
    const sourceEdited = sourceEditedIds.current.has(id)
    if (next === baseline && !sourceEdited) return false

    const api = editorApis.current[id]
    if (api?.replaceMarkdown?.(next)) {
      sourceEl.__horsemdSourceBaseline = next
      sourceEditedIds.current.delete(id)
      return true
    }

    // If the rich editor has not finished creating yet, force the next rich
    // mount to consume the already-committed source text instead of keeping the
    // stale initialContent captured before source editing.
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, reloadNonce: t.reloadNonce + 1, heavy: isHeavyDoc(next) }
          : t
      )
    )
    sourceEl.__horsemdSourceBaseline = next
    sourceEditedIds.current.delete(id)
    return true
  }, [setTabs])

  // Toggle source/rich mode. Two strategies, picked by whether the caret was
  // VISIBLE at toggle time (caretFollowRef):
  //   - caret VISIBLE   (user was editing): the caret stays where it was AND the
  //     viewport follows it (scrollIntoView / focus). The caret is in-viewport
  //     here, so following it can't drift.
  //   - caret OFF-SCREEN (user was reading): the caret selection is still set, but
  //     the VIEWPORT is restored to its own anchor and the caret is NOT followed
  //     (no focus) — so reading doesn't jump. (Following an off-screen caret is
  //     exactly the v0.5.25 "content drift" bug.)
  const toggleSource = useCallback(() => {
    commitAllLive() // flush textarea edits so the rich editor picks them up on switch
    const id = activeIdRef.current
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!id || tab?.kind === 'settings') return
    const view = editorApis.current[id]?.getView?.()
    if (sourceModeRef.current) {
      // Leaving SOURCE → RICH.
      const sourceEl = sourceRef.current
      const sourceTextChanged = !!sourceEl && (sourceEl.value || '') !== (sourceEl.__horsemdSourceBaseline ?? '')
      const sourceSelection = sourceEl ? `${sourceEl.selectionStart}:${sourceEl.selectionEnd}` : ''
      const sourceSelectionChanged = !!sourceEl && !!sourceEl.__horsemdSourceSelectionBaseline && sourceSelection !== sourceEl.__horsemdSourceSelectionBaseline
      const sourceSelectionUser = !!sourceEl && sourceEl.__horsemdSourceSelectionUser === true
      const sourceViewportMoved = !!sourceEl && sourceEl.__horsemdSourceViewportMoved === true
      const preserveRichCaret = !sourceTextChanged && !sourceSelectionChanged && !sourceSelectionUser && !sourceViewportMoved
      const hasSourceCaretIntent = sourceTextChanged || sourceSelectionChanged || sourceSelectionUser
      const followSourceCaret = hasSourceCaretIntent && (sourceSelectionUser && !sourceViewportMoved ? true : isSourceCaretVisible(sourceEl))
      caretFollowRef.current = preserveRichCaret ? sourceEnteredWithCaretFollowRef.current : followSourceCaret
      preserveRichCaretFollowRef.current = preserveRichCaret
      if (preserveRichCaret) {
        // Source was only viewed. The rich editor stayed mounted the whole time,
        // so its PM selection and scrollTop are already the exact source of
        // truth. Restoring a text anchor here can only introduce drift at table
        // or heading boundaries.
        caretAnchorRef.current = null
        viewportAnchorRef.current = null
      } else if (!hasSourceCaretIntent && sourceViewportMoved) {
        caretAnchorRef.current = null
        viewportAnchorRef.current = captureSourceViewport(sourceEl)
      } else {
        caretAnchorRef.current = captureSourceCaret(sourceEl)
        viewportAnchorRef.current = followSourceCaret ? null : captureSourceViewport(sourceEl)
      }
      syncSourceToRich(id)
    } else {
      // Leaving RICH → SOURCE.
      preserveRichCaretFollowRef.current = false
      caretFollowRef.current = isRichCaretVisible(view, editorHostRef.current)
      sourceEnteredWithCaretFollowRef.current = caretFollowRef.current
      const richCaret = captureRichCaret(view)
      const rawOffset = editorApis.current[id]?.markdownOffsetFromSelection?.()
      if (richCaret && Number.isFinite(rawOffset)) richCaret.rawOffset = rawOffset
      caretAnchorRef.current = richCaret
      richCaretAnchorRef.current = richCaret
      const rv = captureRichViewport(editorHostRef.current, view)
      viewportAnchorRef.current = rv
      richViewportAnchorRef.current = rv
    }
    setSourceModeIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [commitAllLive, syncSourceToRich, tabsRef])

  useLayoutEffect(() => {
    const caret = caretAnchorRef.current
    const viewport = viewportAnchorRef.current
    const follow = caretFollowRef.current
    const preserveRichCaretFollow = preserveRichCaretFollowRef.current
    if (caret == null && viewport == null && !preserveRichCaretFollow) return
    caretAnchorRef.current = null
    viewportAnchorRef.current = null
    caretFollowRef.current = false
    preserveRichCaretFollowRef.current = false
    // follow = caret was visible (user editing): restore the caret AND follow it
    //   (scrollIntoView/focus) — the viewport goes to the caret; no separate
    //   viewport restore (the caret is the target, and it's in-viewport so
    //   following can't drift).
    // !follow = caret was off-screen (user reading): set the caret selection
    //   WITHOUT following, then restore the viewport anchor — the reading
    //   position holds; no focus (a focus would async-scroll to the off-screen
    //   caret and drift).
    const apply = () => {
      const view = editorApis.current[activeIdRef.current]?.getView?.()
      if (sourceMode) {
        if (caret) {
          restoreSourceCaret(sourceRef.current, caret, follow)
          const sourceEl = sourceRef.current
          if (sourceEl) {
            sourceEl.__horsemdSourceSelectionBaseline = `${sourceEl.selectionStart}:${sourceEl.selectionEnd}`
            sourceEl.__horsemdSourceSelectionUser = false
            sourceEl.__horsemdSourceViewportMoved = false
          }
        }
        if (!follow && viewport) {
          restoreSourceViewport(sourceRef.current, viewport)
          if (sourceRef.current) sourceRef.current.__horsemdSourceViewportMoved = false
        }
      } else {
        if (caret) {
          const api = editorApis.current[activeIdRef.current]
          const restored = restoreRichCaret(view, caret, follow)
          if (!restored && Number.isFinite(caret.rawOffset)) api?.restoreMarkdownOffset?.(caret.rawOffset, follow)
        }
        else if (preserveRichCaretFollow && follow) view?.focus()
        if (!follow && viewport) restoreRichViewport(editorHostRef.current, view, viewport)
      }
    }
    // Apply immediately, then again as async layout settles — the rich editor
    // (Crepe) fills its content over a few frames after it remounts, growing
    // scrollHeight, so a single pass would land short. The 4th pass (450ms)
    // covers ordinary docs where Crepe takes longer to fill.
    const raf = requestAnimationFrame(apply)
    const t1 = setTimeout(apply, 90)
    const t2 = setTimeout(apply, 220)
    const t3 = setTimeout(apply, 450)
    // Large docs keep changing layout PAST 450ms in two ways the fixed passes
    // miss: (1) chunked text parse (richLoading), and (2) the hundreds of remote
    // <img> re-fetching + re-laying-out when the rich editor re-renders after a
    // source→rich toggle. Either shifts scrollHeight, so an apply that lands
    // mid-settle ends up off. So the tail re-applies while richLoading OR while
    // scrollHeight is still changing, AND does one final pass once the height
    // stabilizes (so the last apply is on the settled layout = the same layout
    // the user captured on → the snippet returns to its original spot). `cancelled`
    // lets cleanup short-circuit an in-flight tick. Only the rich branch needs
    // this — source mode is plain text (no async fill).
    let cancelled = false
    const tailCleans = []
    let lastSh = -1
    let stableTicks = 0
    const tail = (delay) => {
      if (cancelled) return
      const h = setTimeout(() => {
        if (cancelled) return
        apply()
        const sc = editorHostRef.current
        const curSh = sc ? sc.scrollHeight : 0
        const heightChanged = curSh > 0 && curSh !== lastSh
        if (heightChanged) stableTicks = 0; else stableTicks++
        lastSh = curSh
        const stillSettling = !sourceMode && (richLoadingRef.current || heightChanged || stableTicks < 1)
        if (stillSettling && delay < 3000) tail(delay + 300)
      }, delay)
      tailCleans.push(h)
    }
    tail(700)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
      tailCleans.forEach(clearTimeout)
    }
  }, [sourceMode])

  // Source mode uses the browser-native textarea caret. A previous custom thick
  // caret used mirror-div pixel math, but on large wrapped documents it could
  // lag behind programmatic scroll restoration and draw over unrelated text.

  // File operations (open/new/update/close/save/rename/dup/delete/export) +
  // workspace + watcher live in hooks/useFileOps.js (phase-2 US-5). Split ops
  // (openRight/toggleSplit/startSplitDrag/openFileRight) + split state stay
  // here — they're consumed by the editor-area JSX below.
  const {
    openPaths,
    newTab,
    openSettingsTab,
    reorderTabs,
    updateContent,
    closeTab,
    closeOthers,
    renameTabFile,
    commitTabRename,
    duplicateTabFile,
    deleteTabFile,
    writeTab,
    saveTab,
    commitMobileSave,
    exportPathToPdf,
    openFolder,
    workspace,
    setWorkspace,
    files,
    refreshNonce,
    bumpRefresh,
    reloadTabFromDisk
  } = useFileOps({
    tabs,
    setTabs,
    tabsRef,
    setActiveId,
    setHome,
    setSplitId,
    setRecents,
    commitAllLive,
    liveContentRef,
    liveTimersRef,
    editorApis,
    isMobile,
    t,
    tRef,
    setRenameState,
    setSaveNameState,
    setSidebarOpen,
    sessionWorkspace: session.workspace
  })

  // Sync the show-hidden-files setting to main (readTree filter) + refresh the
  // file tree when it changes (#29).
  useEffect(() => {
    window.api.setShowHidden?.(settings.showHiddenFiles)
    if (workspace) bumpRefresh()
  }, [settings.showHiddenFiles, bumpRefresh, workspace])

  // Show a tab in the right (split) pane. If it's currently the active tab, move
  // the left pane to a different tab so the two panes differ.
  const openRight = useCallback((id) => {
    // Settings tabs aren't documents — never place one in the split pane (it
    // would render an empty right pane, since EditorArea skips kind!=='doc').
    const target = tabsRef.current.find((t) => t.id === id)
    if (target?.kind !== 'doc') return
    setHome(false)
    if (id === activeIdRef.current) {
      const others = tabsRef.current.filter((t) => t.id !== id)
      if (!others.length) return // only one tab — nothing to split against
      setActiveId(others[others.length - 1].id)
    }
    setSplitId(id)
  }, [])

  // Toggle split: off → on picks the next DOC tab as the right pane; on → off closes it.
  const toggleSplit = useCallback(() => {
    setSplitId((cur) => {
      if (cur != null) return null
      const docs = tabsRef.current.filter((t) => t.kind !== 'settings')
      if (docs.length < 2) {
        fireToast(tRef.current('split.needTwo'))
        return null
      }
      const i = docs.findIndex((t) => t.id === activeIdRef.current)
      const pick = i >= 0 ? docs[(i + 1) % docs.length].id : docs[0].id
      return pick
    })
    setHome(false)
  }, [])

  // Drag the divider between the two split panes to change their ratio.
  const startSplitDrag = useColDrag({
    bodyClass: 'hm-col-resizing',
    onStart: () => {
      const area = editorAreaRef.current
      return area ? area.getBoundingClientRect() : null
    },
    onMove: (ev, rect) => {
      if (!rect) return
      setSplitRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)))
    },
  })

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

  // Outline panel (#20) — scrollspy + heading list + click-to-jump. State and
  // the reflow-free scrollspy live in hooks/useOutline.js (phase-2 US-3).
  // Returns the names the JSX already uses (Outline props + the Editor's
  // onStructureChange/onLoadingChange).
  const {
    activeHeading,
    outlineHeadings,
    richLoading,
    setRichDocVersion,
    setRichLoading,
    jumpToHeading
  } = useOutline({ editorHostRef, sourceRef, home, sidebarOpen, sidebarMode, sourceMode, activeId, activeTab, isMobile, setSidebarOpen, setHome })
  richLoadingRef.current = richLoading // mirror so the mode-switch effect can read it without a dep that re-runs it

  // ------------------------- menu / shortcuts ----------------------
  // Find & replace (issue #19) — hoisted above the handlers so createMenuHandlers
  // (US-6) can close over setFind/findInputRef/replaceInputRef. Returns the same
  // names the findbar JSX uses.
  const { find, setFind, findInputRef, replaceInputRef, replaceRef, runFind, stepFind, closeFind, applyReplace, openFind } =
    useFindReplace({ editorHostRef, sourceRef, editorApis, activeId, commitLive, liveContentRef })

  // In split view, target the pane you're actually editing (last focused), as
  // long as it's one of the two visible panes; otherwise the active (left) tab.
  const pickEditableId = () => {
    const f = focusedTabRef.current
    if (f && (f === activeId || f === splitId)) return f
    return activeId
  }

  const replaceTabContent = useCallback((id, content) => {
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, content, heavy: isHeavyDoc(content) } : t))
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content, heavy: isHeavyDoc(content) } : t)))
  }, [setTabs, tabsRef])

  const insertMarkdownIntoTab = useCallback((id, markdown) => {
    if (!id || !markdown) return false
    const sourceEl = sourceTextareas.current[id]
    if (sourceEl) {
      const start = sourceEl.selectionStart ?? sourceEl.value.length
      const end = sourceEl.selectionEnd ?? start
      sourceEl.setRangeText(markdown, start, end, 'end')
      sourceEl.__horsemdSourceSelectionUser = true
      sourceEl.__horsemdSourceViewportMoved = false
      sourceEl.__horsemdSourceSelectionAt = performance.now()
      sourceEditedIds.current.add(id)
      liveContentRef.current.set(id, sourceEl.value)
      commitLive(id)
      sourceEl.focus()
      return true
    }

    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab || tab.kind === 'settings') return false
    const api = editorApis.current[id]
    const current = api?.getMarkdown?.() || tab.content || ''
    const rawOffset = api?.markdownOffsetFromSelection?.()
    const pos = Number.isFinite(rawOffset) ? Math.max(0, Math.min(rawOffset, current.length)) : current.length
    const next = current.slice(0, pos) + markdown + current.slice(pos)
    if (api?.replaceMarkdown?.(next)) {
      replaceTabContent(id, next)
      return true
    }
    replaceTabContent(id, next)
    return true
  }, [commitLive, editorApis, liveContentRef, replaceTabContent, sourceEditedIds, sourceTextareas, tabsRef])

  const attachFiles = useCallback(async () => {
    const id = pickEditableId()
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab || tab.kind === 'settings') return
    if (!window.api.capabilities?.fileAttachments || !window.api.openAttachments || !window.api.saveAttachment) {
      fireToast(tRef.current('attach.unsupported'), { sticky: true })
      return
    }
    if (!tab.path) {
      fireToast(tRef.current('attach.needsSave'), { sticky: true })
      return
    }
    commitAllLive()
    fireToast(tRef.current('attach.picking'), { duration: 1200 })
    const picked = await window.api.openAttachments()
    if (!picked?.length) return
    const links = []
    for (const path of picked) {
      const res = await window.api.saveAttachment(tab.path, path)
      if (!res?.ok) {
        fireToast(tRef.current('attach.failed', { msg: res?.error || baseName(path) }), { sticky: true })
        return
      }
      links.push(attachmentLinkMarkdown(res.name || baseName(path), res.path))
    }
    if (!links.length) return
    insertMarkdownIntoTab(id, links.join('\n'))
    fireToast(tRef.current('attach.inserted', { n: links.length }), { duration: 1500 })
  }, [commitAllLive, insertMarkdownIntoTab, tabsRef, tRef])

  // Review actions (CriticMarkup) on the active/focused tab. pickEditableId is
  // shared with the save/export handlers, so it stays here; the rest lives in
  // lib/reviewActions.js (phase-2 US-1).
  const review = createReviewActions({
    pickEditableId,
    tabsRef,
    sourceTextareas,
    editorApis,
    setHome,
    updateContent,
    setTabs,
    tRef
  })

  // Command dispatch map (menu IPC + keyboard + palette) — built by
  // createMenuHandlers in lib/menuHandlers.js (phase-2 US-6). Stored in a ref so
  // the menu/keyboard listeners (useGlobalKeys) always read the latest actions.
  const handlers = useRef({})
  handlers.current = createMenuHandlers({
    pickEditableId,
    activeId,
    setHome,
    isMobile,
    setSidebarOpen,
    setSidebarMode,
    setPaletteOpen,
    newTab,
    openPaths,
    openFolder,
    saveTab,
    attachFiles,
    closeTab,
    toggleSource,
    cycleTheme,
    editorApis,
    tabs,
    tRef,
    setFind,
    findInputRef,
    replaceInputRef,
    openFind,
    review
  })

  // App lifecycle (session restore/persist/flush + update check + toast +
  // first-run onboarding) lives in hooks/useAppLifecycle.js (phase-2 US-4).
  // flushSession is also used by the window-close guard; update/toast/
  // dismissUpdate/setToast feed the JSX. These are read only inside effect/event
  // closures, so defining them here is safe (resolved at commit/call time).
  const { update, dismissUpdate, toast, setToast, flushSession } = useAppLifecycle({
    session,
    tabs,
    activePath,
    workspace,
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
  })

  // Global menu IPC + keyboard shortcuts (US-6) — flushSession comes from
  // useAppLifecycle just above, so this call sits after it.
  useGlobalKeys({
    handlers,
    openPaths,
    openFolder,
    isAbsolutePath,
    setWorkspace,
    setSidebarMode,
    setSidebarOpen,
    commitAllLive,
    flushSession,
    tabsRef,
    tRef,
    setTabs,
    activeId,
    setActiveId,
    setHome
  })
  // --------------------------- commands ----------------------------
  const commands = useCommands({ t, handlers })

  const platformClass =
    ({ win32: ' is-win', darwin: ' is-mac', ios: ' is-ios is-mobile', android: ' is-android is-mobile' }[
      window.api.platform
    ] || '')
  // Save targets the focused pane (pickEditableId), so the FAB must reflect
  // THAT pane's dirty state — not always the left/active tab. In split view this
  // is what makes the FAB follow whichever pane the user is editing.
  const fabId = pickEditableId()
  const fabTab = (fabId ? tabs.find((t) => t.id === fabId) : null) || activeTab

  // Drag the left-pane's right edge to resize it (outline / file-tree, #resizable-pane).
  // Reads the live width from the DOM at mousedown (via useColDrag's onStart) so a
  // stale closure can't fight the drag; clamps to PANE_MIN..PANE_MAX. The body class
  // disables the width transition (so it tracks the cursor) + text selection.
  const startResize = useColDrag({
    bodyClass: 'resizing-pane',
    onStart: (e) => {
      const aside = e.currentTarget.previousElementSibling
      return { x: e.clientX, w: aside ? aside.getBoundingClientRect().width : PANE_DEFAULT }
    },
    onMove: (ev, { x, w }) => setPaneWidth(Math.max(PANE_MIN, Math.min(PANE_MAX, w + (ev.clientX - x)))),
  })

  // User font overrides (issue #38). Applied as inline CSS vars on the .app root
  // so they win over body.light/dark AND — for the code font — the .app.is-win
  // Consolas rule. Empty font = no inline var, so the default stacks (and the
  // Windows Consolas fix) still apply. Cascades to the editor + the settings
  // preview, giving live feedback as the user types a name.
  // Hover-preview (#38): while the cursor is over a font option in the picker,
  // temporarily apply it so the preview + editor react live — no click needed.
  // Cleared on leave/close; pick writes to settings (the persistent value).
  const [hoverFont, setHoverFont] = useState({})
  const fwStack = fontStack(hoverFont.write ?? settings.fontWrite, DEFAULT_FONT_WRITE)
  const fmStack = fontStack(hoverFont.mono ?? settings.fontMono, DEFAULT_FONT_MONO)
  const appFontStyle = {
    ...(fwStack ? { '--font-write': fwStack } : {}),
    ...(fmStack ? { '--font-mono': fmStack } : {})
  }

  return (
    <I18nProvider lang={lang} setLang={setLang}>
    <div className={`app${platformClass}${isMobile && sidebarOpen ? ' drawer-open' : ''}`} style={appFontStyle}>
      <ActivityBar
        home={home}
        sidebarMode={sidebarMode}
        sidebarOpen={sidebarOpen}
        settingsActive={!home && activeTab?.kind === 'settings'}
        t={t}
        onHome={() => handlers.current.home()}
        onFiles={() => handlers.current.toggleFiles()}
        onOutline={() => handlers.current.toggleOutline()}
        onSettings={openSettingsTab}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />

      <Topbar
        isMobile={isMobile}
        t={t}
        tabs={tabs}
        activeId={home ? null : activeId}
        splitId={home ? null : splitId}
        focusedPane={focusedPane}
        split={split}
        imageUploadCommand={settings.imageUploadCommand}
        onActivate={(id) => {
          setHome(false)
          // Load into whichever pane is focused, so both panes are switchable.
          if (split && focusedPane === 'right' && id !== activeId) setSplitId(id)
          else setActiveId(id)
        }}
        onClose={closeTab}
        onNew={newTab}
        onCloseOthers={closeOthers}
        onOpenRight={openRight}
        onRename={renameTabFile}
        onDuplicate={duplicateTabFile}
        onDelete={deleteTabFile}
        onExportPdf={exportPathToPdf}
        onReorder={reorderTabs}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleSplit={toggleSplit}
        onImageHostChange={(cmd) => updateSettings({ imageUploadCommand: cmd })}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {isMobile && sidebarOpen && (
        <div className="hm-scrim" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="body">
        <aside
          className={`pane-left${sidebarOpen ? '' : ' collapsed'}`}
          style={{ '--pane-left-w': paneWidth + 'px' }}
        >
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
        {sidebarOpen && !isMobile && (
          <div
            className="pane-left-resizer"
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startResize}
            onDoubleClick={() => setPaneWidth(PANE_DEFAULT)}
            title={t('side.resize')}
          />
        )}

        <main className="pane-center">
          {find.open && (
            <FindBar
              find={find}
              findInputRef={findInputRef}
              replaceInputRef={replaceInputRef}
              t={t}
              onQuery={(q) => { setFind((f) => ({ ...f, query: q })); runFind(q) }}
              onReplaceText={(text) => { replaceRef.current = text; setFind((f) => ({ ...f, replace: text })) }}
              onPrev={stepFind}
              onNext={stepFind}
              onClose={closeFind}
              onReplace={applyReplace}
              onReplaceAll={applyReplace}
            />
          )}

          {/* Editor area — extracted to components/shell/EditorArea.jsx (US-7).
              Preserves lazy mount + uncontrolled textarea + split flex/order. */}
          <EditorArea
            tabs={tabs}
            activeId={activeId}
            splitId={splitId}
            split={split}
            splitRatio={splitRatio}
            focusedPane={focusedPane}
            home={home}
            sourceMode={sourceMode}
            richForced={richForced}
            mountedIds={mountedIds}
            activeTab={activeTab}
            imageUploadCommand={settings.imageUploadCommand}
            spellcheck={settings.spellcheck}
            editorAreaRef={editorAreaRef}
            editorHostRef={editorHostRef}
            sourceRef={sourceRef}
            sourceTextareas={sourceTextareas}
            sourceEditedIds={sourceEditedIds}
            liveContentRef={liveContentRef}
            liveTimersRef={liveTimersRef}
            commitLive={commitLive}
            editorApis={editorApis}
            activeIdRef={activeIdRef}
            focusedTabRef={focusedTabRef}
            setRichForced={setRichForced}
            setSplitId={setSplitId}
            setFocusedPane={setFocusedPane}
            setActiveBlock={setActiveBlock}
            setRichDocVersion={setRichDocVersion}
            setRichLoading={setRichLoading}
            startSplitDrag={startSplitDrag}
            updateContent={updateContent}
            t={t}
          />

          {/* Settings page — a full-tab view for kind:'settings' tabs (the
              ActivityBar gear button opens one). EditorArea skips settings
              tabs, so this sibling renders in their place. */}
          {!home && activeTab?.kind === 'settings' && (
            <SettingsView
              settings={settings}
              onUpdateSettings={updateSettings}
              onHoverFont={setHoverFont}
              theme={theme}
              setTheme={pickBuiltinTheme}
              customThemes={customThemes}
              customTheme={customTheme}
              onPickCustom={setCustomTheme}
              onOpenThemesFolder={() => window.api.themesReveal?.()}
              onGetMoreThemes={() => window.api.openExternal('https://theme.typora.io/')}
              lang={lang}
              setLang={setLang}
            />
          )}

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
        tab={home || activeTab?.kind === 'settings' ? null : activeTab}
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
        onSettings={openSettingsTab}
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
        visible={!home && activeTab?.kind !== 'settings' && !!fabTab && fabTab.content !== fabTab.savedContent}
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
