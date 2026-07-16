// Command dispatch + global menu/keyboard wiring + command palette data.
// Extracted verbatim in behavior from App.jsx (phase-2 refactor, US-6).
//
// Three pieces:
//   createMenuHandlers({...actions}) — the command-name → action map stored in
//     a ref and invoked by the menu IPC, the keyboard shortcuts, and the palette.
//     pickEditableId lives here (only save/saveAs/exportPdf use it).
//   useGlobalKeys({...}) — registers onMenu/onOpenPaths/onOpenFolderPath/
//     onAppCloseRequest + the Ctrl+Tab, Ctrl+Shift+B, Ctrl+F keydowns.
//   useCommands({t, handlers}) — the command-palette list (useMemo on [t]).
import { useEffect, useMemo } from 'react'
import { REVIEW_KINDS } from '../reviewMarkup.js'
import { COMMAND_DEFINITIONS, getCommandHandler, getCommandTitle, isCommandAvailable } from './commands/command-definitions.js'
import { keybindingMatchesEvent } from './commands/keybinding-normalize.js'
import { getEffectiveKeybindingMap } from './commands/keybinding-store.js'
import { getCommandShortcut } from './commands/shortcut-labels.js'

const COMMAND_PALETTE_ICONS = {
  'file.new': 'file-plus',
  'file.open': 'file',
  'workspace.openFolder': 'folder',
  'file.save': 'save',
  'file.saveAs': 'save',
  'file.attach': 'paperclip',
  'file.exportPdf': 'file',
  'view.toggleSidebar': 'sidebar',
  'view.showFiles': 'folder',
  'view.showOutline': 'outline',
  'view.toggleSource': 'code',
  'view.cycleTheme': 'moon',
  'editor.find': 'search',
  'editor.replace': 'replace',
  'review.add': 'review',
  'review.delete': 'review',
  'review.substitute': 'review',
  'review.highlight': 'review',
  'review.copyPrompt': 'review',
  'review.acceptAll': 'review',
  'review.rejectAll': 'review'
}

export const SETTINGS_BACKGROUND_HANDLERS = new Set([
  'save',
  'saveAs',
  'attachFile',
  'exportPdf',
  'toggleSidebar',
  'toggleOutline',
  'toggleFiles',
  'toggleSource',
  'find',
  'replace',
  'reviewAdd',
  'reviewDelete',
  'reviewSubstitute',
  'reviewHighlight',
  'reviewCopyPrompt',
  'reviewAcceptAll',
  'reviewRejectAll'
])

export function shouldBlockForSettings(handler, activeTabKind) {
  return activeTabKind === 'settings' && SETTINGS_BACKGROUND_HANDLERS.has(handler)
}

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
  getPdfSourceForTab,
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
      const source = getPdfSourceForTab(id)
      if (!source?.html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const tab = tabs.find((x) => x.id === id)
      const base = (tab?.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
      requestPdfExport({ ...source, title: base }, base + '.pdf')
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
  activeTabKind,
  setActiveId,
  setHome,
  effectiveKeybindings
}) {
  const keybindings = effectiveKeybindings || getEffectiveKeybindingMap()
  const platform = window.api?.platform || (navigator.platform?.toLowerCase().includes('mac') ? 'darwin' : 'win32')

  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => {
      const handler = getCommandHandler(cmd) || cmd
      if (shouldBlockForSettings(handler, activeTabKind)) return
      handlers.current[handler]?.()
    })
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
  }, [openPaths, openFolder, isAbsolutePath, addFolderByPath, setSidebarMode, setSidebarOpen, commitAllLive, flushSession, tabsRef, tRef, handlers, activeTabKind])

  // Tab cycling uses the user keybinding map. The defaults intentionally remain
  // Ctrl+Tab / Ctrl+Shift+Tab on macOS to preserve the historical behavior.
  useEffect(() => {
    const onKey = (e) => {
      const previous = keybindingMatchesEvent(keybindings['tab.previous']?.[0], e, platform)
      const next = keybindingMatchesEvent(keybindings['tab.next']?.[0], e, platform)
      if (previous || next) {
        e.preventDefault()
        setTabs((prev) => {
          if (prev.length < 2) return prev
          const i = prev.findIndex((t) => t.id === activeId)
          const ni = (i + (previous ? -1 : 1) + prev.length) % prev.length
          setActiveId(prev[ni].id)
          setHome(false)
          return prev
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, keybindings, platform, setTabs, setActiveId, setHome])

  // Ctrl/Cmd+Shift+B toggles the sidebar. Plain Mod+B is deliberately left to
  // ProseMirror's standard bold binding (#67). No menu accelerator, so this
  // renderer shortcut cannot double-fire with an Electron menu command.
  useEffect(() => {
    const onKey = (e) => {
      if (shouldBlockForSettings('toggleSidebar', activeTabKind)) return
      if (keybindingMatchesEvent(keybindings['view.toggleSidebar']?.[0], e, platform)) {
        e.preventDefault()
        e.stopPropagation()
        handlers.current.toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handlers, keybindings, platform, activeTabKind])

  // Mod+F = find, Mod+Alt+F = replace (opens the bar and focuses the replace
  // field). Capture phase so it beats any editor binding.
  useEffect(() => {
    const onKey = (e) => {
      if (activeTabKind === 'settings') return
      const replace = keybindingMatchesEvent(keybindings['editor.replace']?.[0], e, platform)
      const find = keybindingMatchesEvent(keybindings['editor.find']?.[0], e, platform)
      if (replace || find) {
        e.preventDefault()
        e.stopPropagation()
        if (replace) handlers.current.replace()
        else handlers.current.find()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handlers, keybindings, platform, activeTabKind])
}

// Command-palette list (titles localized via t; run dispatches via handlers).
export function useCommands({ t, handlers, effectiveKeybindings }) {
  return useMemo(
    () => {
      const caps = window.api.capabilities || {}
      return COMMAND_DEFINITIONS
        .filter((command) => command.palette && command.handler && isCommandAvailable(command, caps))
        .map((command) => ({
          id: command.titleKey || command.id,
          title: getCommandTitle(command, t),
          hint: getCommandShortcut(command.id, effectiveKeybindings),
          icon: COMMAND_PALETTE_ICONS[command.id] || 'command',
          run: () => handlers.current[command.handler]?.()
        }))
    },
    [t, handlers, effectiveKeybindings]
  )
}
