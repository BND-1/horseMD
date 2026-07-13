// Command dispatch + global menu/keyboard wiring + command palette data.
// Extracted verbatim in behavior from App.jsx (phase-2 refactor, US-6).
//
// Three pieces:
//   createMenuHandlers({...actions}) — the command-name → action map stored in
//     a ref and invoked by the menu IPC, the keyboard shortcuts, and the palette.
//     pickEditableId lives here (only save/saveAs/exportPdf use it).
//   useGlobalKeys({...}) — registers onMenu/onOpenPaths/onOpenFolderPath/
//     onAppCloseRequest + the Ctrl+Tab, Ctrl+B, Ctrl+F keydowns.
//   useCommands({t, handlers}) — the command-palette list (useMemo on [t]).
import { useEffect, useMemo } from 'react'
import { REVIEW_KINDS } from '../reviewMarkup.js'

export function createMenuHandlers({
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
  openFind,
  replaceInputRef,
  review,
  requestPdfExport
}) {
  return {
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
    attachFile: attachFiles,
    exportPdf: async () => {
      const id = pickEditableId()
      const html = editorApis.current[id]?.getDocHTML?.()
      if (!html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const tab = tabs.find((x) => x.id === id)
      const base = (tab?.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
      requestPdfExport(html, base + '.pdf')
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
      // openFind pre-fills the search with the current selection (if any).
      setHome(false)
      openFind()
    },
    replace: () => {
      // Open the find bar and focus the replace field (Mod+Alt+F / palette).
      setHome(false)
      openFind(true)
    },
    reviewAdd: () => review.applyReviewMarkupToActive(REVIEW_KINDS.addition),
    reviewDelete: () => review.applyReviewMarkupToActive(REVIEW_KINDS.deletion),
    reviewSubstitute: () => review.applyReviewMarkupToActive(REVIEW_KINDS.substitution),
    reviewHighlight: () => review.applyReviewMarkupToActive(REVIEW_KINDS.highlight),
    reviewCopyPrompt: () => review.copyReviewPrompt(),
    reviewAcceptAll: () => review.applyReviewDecisionToActive('accept'),
    reviewRejectAll: () => review.applyReviewDecisionToActive('reject')
  }
}

// Global menu IPC + keyboard shortcuts. `handlers` is the ref returned by
// createMenuHandlers (read at event time, so it always sees the latest actions).
export function useGlobalKeys({
  handlers,
  openPaths,
  openFolder,
  isAbsolutePath,
  addFolderByPath,
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
}) {
  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => handlers.current[cmd]?.())
    const offOpen = window.api.onOpenPaths((paths) => openPaths(paths))
    // A folder arriving from Explorer's "Open with HorseMD" folder menu: add it
    // to the active workspace (multi-root). Never open a relative path.
    const offFolder = window.api.onOpenFolderPath?.((dir) => {
      if (!dir || !isAbsolutePath(dir)) return
      addFolderByPath(dir)
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
  }, [openPaths, openFolder, isAbsolutePath, addFolderByPath, setSidebarMode, setSidebarOpen, commitAllLive, flushSession, tabsRef, tRef, handlers])

  // Ctrl+Tab cycling
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
  }, [activeId, setTabs, setActiveId, setHome])

  // Ctrl/Cmd+B toggles the sidebar. CAPTURE phase so it fires before the
  // editor's "bold" keybinding (which would otherwise eat it and made the
  // shortcut feel unreliable). No menu accelerator, so it can't double-fire.
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
  }, [handlers])

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
  }, [handlers])
}

// Command-palette list (titles localized via t; run dispatches via handlers).
export function useCommands({ t, handlers }) {
  return useMemo(
    () => {
      const caps = window.api.capabilities || {}
      return [
        { id: 'cmd.new', title: t('cmd.new'), icon: 'file-plus', run: () => handlers.current.new() },
        { id: 'cmd.open', title: t('cmd.open'), icon: 'file', run: () => handlers.current.open() },
        { id: 'cmd.openFolder', title: t('cmd.openFolder'), icon: 'folder', run: () => handlers.current.openFolder() },
        { id: 'cmd.save', title: t('cmd.save'), icon: 'save', run: () => handlers.current.save() },
        { id: 'cmd.saveAs', title: t('cmd.saveAs'), icon: 'save', run: () => handlers.current.saveAs() },
        caps.fileAttachments && { id: 'cmd.attachFile', title: t('cmd.attachFile'), icon: 'paperclip', run: () => handlers.current.attachFile() },
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
    [t, handlers]
  )
}
