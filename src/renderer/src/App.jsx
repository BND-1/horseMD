import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  applySourceFontOffset,
  applyLineHeight,
  applyParagraphSpacing,
  fontStack,
  DEFAULT_FONT_WRITE,
  DEFAULT_FONT_MONO
} from './settings.js'
import { applyCustomTheme, applyUserCss } from './customThemes.js'
import { fireToast } from './ui.js'
import { useFindReplace } from './hooks/useFindReplace.js'
import { useOutline } from './hooks/useOutline.js'
import { useAppLifecycle } from './hooks/useAppLifecycle.js'
import { useColDrag } from './hooks/useColDrag.js'
import { useFileOps } from './hooks/useFileOps.js'
import { useSourceModeSwitch } from './hooks/useSourceModeSwitch.js'
import { useAttachments } from './hooks/useAttachments.js'
import { usePdfExport } from './hooks/usePdfExport.js'
import { useKeybindings } from './hooks/useKeybindings.js'
import { buildElectronAcceleratorPayload } from './lib/commands/electron-accelerators.js'
import { createMenuHandlers, useGlobalKeys, useCommands } from './lib/menuHandlers.js'
import { isAbsolutePath, isPlainTextDoc, loadSession, loadFolderRootsFromSession } from './paths.js'
import { createReviewActions } from './lib/reviewActions.js'
import { createEditorApiRegistry } from './lib/editor-api-registry.js'
import { moveHeadingSection } from './outline-reorder.js'

// Outline / file-tree pane drag bounds (px) — single source for the state init,
// the drag clamp, and the double-click reset. CSS max-width on .pane-left must
// stay >= PANE_MAX.
const PANE_MIN = 160
const PANE_MAX = 560
const PANE_DEFAULT = 260

const PdfExportStudio = __MOBILE_BUILD__
  ? null
  : lazy(() => import('./components/pdf-export/PdfExportStudio.jsx'))

export default function App() {
  const session = useRef(loadSession()).current
  // Migrate + sanitize the session's workspace folder roots once (stable session).
  // Legacy single-folder and short-lived multi-workspace sessions are flattened.
  const initialFolderRoots = useRef(loadFolderRootsFromSession(session)).current
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
  // Every mounted rich editor's scroll container, keyed by tab id. Split-view
  // outline navigation uses this without repointing editorHostRef, which remains
  // the source/find/mode-switch contract for the active left tab.
  const editorHosts = useRef({})
  const editorAreaRef = useRef(null) // flex row holding the editor panes (for split-drag math)
  const richLoadingRef = useRef(false) // live mirror of richLoading (chunked large-doc load) for the mode-switch effect
  const findStateRef = useRef({ open: false, query: '' }) // find owns navigation while an active query survives a mode switch
  // Registry of each tab's editor API (by tab id). Several markdown editors can
  // be mounted at once (a tab stays mounted after its first activation), so a
  // single ref would get stuck on whichever editor mounted last; keying by tab
  // id lets commands act on the *currently active* document.
  const editorApiRegistryRef = useRef(null)
  if (!editorApiRegistryRef.current) editorApiRegistryRef.current = createEditorApiRegistry()
  const editorApiRegistry = editorApiRegistryRef.current
  const editorApis = editorApiRegistry.ref
  const registerEditorApi = editorApiRegistry.register
  const waitForEditorApi = editorApiRegistry.waitFor
  // The tab id of whichever editor pane last had focus — so Save / Export target
  // the pane you're actually editing in split view, not always the left one.
  const focusedTabRef = useRef(null)
  const [activeBlock, setActiveBlock] = useState('paragraph')
  // Lazy mounting: a rich (Crepe) editor is only created once its tab has been
  // activated, then kept mounted so later tab switches stay instant. This keeps
  // startup/session-restore fast — only the active tab spins up an editor
  // instead of every restored tab parsing its whole document at once.
  const [mountedIds, setMountedIds] = useState(() => new Set())
  // Chunked rich-document loading is tracked per tab. Hidden editors stay
  // mounted, so a single boolean lets one tab incorrectly mask another.
  const [richLoadingIds, setRichLoadingIds] = useState(() => new Set())
  const setTabRichLoading = useCallback((id, loading) => {
    setRichLoadingIds((prev) => {
      const has = prev.has(id)
      if (has === loading) return prev
      const next = new Set(prev)
      if (loading) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
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

  const {
    sourceMode,
    sourceRef,
    sourceTextareas,
    sourceEditedIds,
    toggleSource
  } = useSourceModeSwitch({
    tabs,
    activeId,
    setTabs,
    tabsRef,
    activeIdRef,
    editorApis,
    editorHostRef,
    focusedTabRef,
    commitAllLive,
    findStateRef,
    richLoadingRef
  })

  // Drop editor APIs for tabs that have closed.
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id))
    editorApiRegistry.prune(live)
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
    setRichLoadingIds((prev) => {
      if (!prev.size) return prev
      const next = new Set([...prev].filter((id) => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [tabs, editorApiRegistry])

  useEffect(() => () => editorApiRegistry.dispose(), [editorApiRegistry])

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
    applySourceFontOffset(settings.sourceFontOffset)
  }, [settings.sourceFontOffset])
  useEffect(() => {
    applyLineHeight(settings.lineHeight)
  }, [settings.lineHeight])
  useEffect(() => {
    applyParagraphSpacing(settings.paragraphSpacing)
  }, [settings.paragraphSpacing])
  useEffect(() => {
    applyUserCss(settings.userCss)
  }, [settings.userCss])
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

  const {
    pdfExportState,
    requestPdfExport,
    cancelPdfExport,
    savePdfExport
  } = usePdfExport({ tRef })

  const getPdfSourceForTab = useCallback((id) => {
    const api = editorApis.current[id]
    if (!api) return null
    const sourceElement = sourceTextareas.current[id]
    if (sourceElement && api.getMarkdown?.() !== sourceElement.value) {
      api.replaceMarkdown?.(sourceElement.value)
    }
    return api.getPdfSource?.() || null
  }, [editorApis, sourceTextareas])

  const waitForPdfSourceForTab = useCallback(async (id) => {
    const api = await waitForEditorApi(id)
    if (!api) return null
    return getPdfSourceForTab(id)
  }, [getPdfSourceForTab, waitForEditorApi])

  // Source/rich view state and anchor restoration live in useSourceModeSwitch.

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
    folderRoots,
    addFolder,
    removeFolder,
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
    getPdfSourceForTab,
    waitForPdfSourceForTab,
    isMobile,
    t,
    tRef,
    setRenameState,
    setSaveNameState,
    requestPdfExport,
    setSidebarOpen,
    initialFolderRoots: initialFolderRoots
  })

  // Sync the show-hidden-files setting to main (readTree filter) + refresh the
  // file tree when it changes (#29).
  useEffect(() => {
    window.api.setShowHidden?.(settings.showHiddenFiles)
    if (folderRoots.length) bumpRefresh()
  }, [settings.showHiddenFiles, bumpRefresh, folderRoots])

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
  const outlineId = split && focusedPane === 'right' ? splitId : activeId
  const outlineTab = tabs.find((tab) => tab.id === outlineId) || null
  const outlineSourceMode = !!outlineTab && (
    isPlainTextDoc(outlineTab) ||
    (outlineTab.heavy && !richForced.has(outlineId)) ||
    (sourceMode && outlineId === activeId)
  )
  const richLoading = !!outlineId && richLoadingIds.has(outlineId)
  const getOutlineEditorHost = useCallback(
    () => {
      const host = editorHosts.current[outlineId]
      if (host?.offsetParent) return host
      // Mounted background tabs keep their Crepe DOM alive. A stale ref must
      // never make the outline read a hidden tab instead of the visible pane.
      return [...document.querySelectorAll('.editor-scroll')].find((node) => node.offsetParent) || null
    },
    [outlineId, editorHosts]
  )
  const getOutlineSourceTextarea = useCallback(
    () => sourceTextareas.current[outlineId] || null,
    [outlineId, sourceTextareas]
  )
  const {
    activeHeading,
    outlineHeadings,
    setRichDocVersion,
    refreshOutline,
    jumpToHeading
  } = useOutline({
    getEditorHost: getOutlineEditorHost,
    getSourceTextarea: getOutlineSourceTextarea,
    home,
    sidebarOpen,
    sidebarMode,
    sourceMode: outlineSourceMode,
    activeId: outlineId,
    activeTab: outlineTab,
    richLoading,
    isMobile,
    setSidebarOpen,
    setHome
  })
  richLoadingRef.current = !!activeId && richLoadingIds.has(activeId)

  // Issue #82: move a sibling heading together with all of its descendants.
  // The move operates on raw Markdown ranges, so unsupported node views and
  // untouched source spelling travel intact instead of being serializer output.
  const moveOutlineHeading = useCallback((fromIndex, targetIndex, placement) => {
    if (!outlineId) return false
    commitLive(outlineId)
    const tab = tabsRef.current.find((item) => item.id === outlineId)
    const next = moveHeadingSection(tab?.content, fromIndex, targetIndex, placement)
    if (!next || !tab) return false

    if (outlineSourceMode) {
      const textarea = sourceTextareas.current[outlineId]
      if (!textarea) return false
      textarea.value = next
      sourceEditedIds.current.add(outlineId)
    } else if (!editorApis.current[outlineId]?.replaceMarkdown?.(next)) {
      return false
    }

    const apply = (items) => items.map((item) => item.id === outlineId ? { ...item, content: next } : item)
    tabsRef.current = apply(tabsRef.current)
    setTabs((items) => apply(items))
    refreshOutline()
    return true
  }, [outlineId, outlineSourceMode, commitLive, editorApis, refreshOutline, setTabs, sourceEditedIds, sourceTextareas, tabsRef])

  // ------------------------- menu / shortcuts ----------------------
  // Find & replace (issue #19) — hoisted above the handlers so createMenuHandlers
  // (US-6) can close over setFind/findInputRef/replaceInputRef. Returns the same
  // names the findbar JSX uses.
  const { find, setFind, findInputRef, replaceInputRef, replaceRef, runFind, stepFind, closeFind, applyReplace, openFind } =
    useFindReplace({
      editorHostRef,
      sourceRef,
      editorApis,
      activeId,
      viewModeKey: sourceMode,
      commitLive,
      liveContentRef
    })
  findStateRef.current = { open: find.open, query: find.query }

  // In split view, target the pane you're actually editing (last focused), as
  // long as it's one of the two visible panes; otherwise the active (left) tab.
  const pickEditableId = () => {
    const f = focusedTabRef.current
    if (f && (f === activeId || f === splitId)) return f
    return activeId
  }

  const { attachFiles } = useAttachments({
    pickEditableId,
    tabsRef,
    setTabs,
    sourceTextareas,
    sourceEditedIds,
    liveContentRef,
    commitLive,
    commitAllLive,
    editorApis,
    tRef
  })

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
  const {
    keybindingState,
    effectiveKeybindings,
    setKeybindings,
    resetCommand: resetCommandKeybindings,
    resetAll: resetAllKeybindings
  } = useKeybindings()
  useEffect(() => {
    window.api.setMenuKeybindings?.(buildElectronAcceleratorPayload(effectiveKeybindings))
  }, [effectiveKeybindings])
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
    getPdfSourceForTab,
    tabs,
    tRef,
    setFind,
    findInputRef,
    replaceInputRef,
    openFind,
    review,
    requestPdfExport
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
  })

  // Global menu IPC + keyboard shortcuts (US-6) — flushSession comes from
  // useAppLifecycle just above, so this call sits after it.
  useGlobalKeys({
    handlers,
    openPaths,
    openFolder,
    isAbsolutePath,
    addFolderByPath: addFolder,
    setSidebarMode,
    setSidebarOpen,
    commitAllLive,
    flushSession,
    tabsRef,
    tRef,
    setTabs,
    activeId,
    activeTabKind: !home ? activeTab?.kind || null : null,
    setActiveId,
    setHome,
    effectiveKeybindings
  })
  // --------------------------- commands ----------------------------
  const commands = useCommands({ t, handlers, effectiveKeybindings })

  const platformClass =
    ({ win32: ' is-win', linux: ' is-linux', darwin: ' is-mac', ios: ' is-ios is-mobile', android: ' is-android is-mobile' }[
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
        effectiveKeybindings={effectiveKeybindings}
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
                folderRoots={folderRoots}
                onAddFolder={openFolder}
                onRemoveFolder={removeFolder}
                activePath={activePath}
                onOpenFile={(p) => { openPaths([p]); if (isMobile) setSidebarOpen(false) }}
                onOpenRight={openFileRight}
                onExportPdf={exportPathToPdf}
                refreshNonce={refreshNonce}
              />
            ) : (
              <Outline
                headings={outlineHeadings}
                activeIndex={activeHeading}
                loading={richLoading}
                onJump={jumpToHeading}
                onMoveHeading={isMobile ? undefined : moveOutlineHeading}
              />
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
            inlineMathDeleteMode={settings.inlineMathDeleteMode}
            effectiveKeybindings={effectiveKeybindings}
            editorAreaRef={editorAreaRef}
            editorHostRef={editorHostRef}
            editorHosts={editorHosts}
            sourceRef={sourceRef}
            sourceTextareas={sourceTextareas}
            sourceEditedIds={sourceEditedIds}
            liveContentRef={liveContentRef}
            liveTimersRef={liveTimersRef}
            commitLive={commitLive}
            editorApis={editorApis}
            registerEditorApi={registerEditorApi}
            activeIdRef={activeIdRef}
            focusedTabRef={focusedTabRef}
            setRichForced={setRichForced}
            setSplitId={setSplitId}
            setFocusedPane={setFocusedPane}
            setActiveBlock={setActiveBlock}
            setRichDocVersion={setRichDocVersion}
            setTabRichLoading={setTabRichLoading}
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
              effectiveKeybindings={effectiveKeybindings}
              keybindingState={keybindingState}
              onSetKeybindings={setKeybindings}
              onResetCommandKeybindings={resetCommandKeybindings}
              onResetAllKeybindings={resetAllKeybindings}
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
              effectiveKeybindings={effectiveKeybindings}
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
        effectiveKeybindings={effectiveKeybindings}
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
        effectiveKeybindings={effectiveKeybindings}
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

      {pdfExportState && PdfExportStudio && (
        <Suspense fallback={<div role="status" style={{ position: 'fixed', inset: 0, zIndex: 1500, display: 'grid', placeItems: 'center', color: 'var(--text)', background: 'var(--bg-elevated)' }}>{t('pdf.previewWaiting')}</div>}>
          <PdfExportStudio
            t={t}
            request={pdfExportState}
            saving={pdfExportState.status === 'saving'}
            saveError={pdfExportState.error}
            onCancel={cancelPdfExport}
            onSave={savePdfExport}
          />
        </Suspense>
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
