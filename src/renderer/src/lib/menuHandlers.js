// Command dispatch + global menu/keyboard wiring + command palette data.
// Extracted verbatim in behavior from App.jsx (phase-2 refactor, US-6).
//
// Three pieces:
//   createMenuHandlers({...actions}) — the command-name → action map stored in
//     a ref and invoked by the menu IPC, the keyboard shortcuts, and the palette.
//     pickEditableId lives here (only save/saveAs/exportPdf use it).
//   useGlobalKeys({...}) — registers onMenu/onOpenFolderPath/
//     onAppCloseRequest + the Ctrl+Tab, Ctrl+Shift+B, Ctrl+F keydowns.
//   useCommands({t, handlers}) — the command-palette list (useMemo on [t]).
import { useEffect, useMemo } from 'react'
import { isTabDirty } from './tab-state.js'
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
  'file.rename': 'pencil',
  'file.history': 'history',
  'file.deleted': 'trash',
  'file.attach': 'paperclip',
  'file.exportPdf': 'file',
  'file.exportHtml': 'globe',
  'file.exportPandocDocx': 'file',
  'file.exportPandocEpub': 'file',
  'file.exportPandocLatex': 'file',
  'file.exportPandocOdt': 'file',
  'file.exportPandocRtf': 'file',
  'file.exportPandocMediawiki': 'file',
  'file.exportPandocTxt': 'file',
  'view.toggleSidebar': 'sidebar',
  'view.immersive': 'expand',
  'view.showFiles': 'folder',
  'view.showOutline': 'outline',
  'outline.expandAll': 'expand',
  'outline.collapseAll': 'collapse',
  'editor.fold.toggle': 'collapse',
  'editor.fold.all': 'collapse',
  'editor.fold.none': 'expand',
  'view.globalSearch': 'search',
  'view.toggleSource': 'code',
  'view.cycleTheme': 'moon',
  'window.toggleVisibility': 'monitor',
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
  'exportHtml',
  'exportPandocDocx',
  'exportPandocEpub',
  'exportPandocLatex',
  'exportPandocOdt',
  'exportPandocRtf',
  'exportPandocMediawiki',
  'exportPandocTxt',
  'toggleSidebar',
  'toggleOutline',
  'outlineExpandAll',
  'outlineCollapseAll',
  'headingFoldToggle',
  'headingFoldAll',
  'headingUnfoldAll',
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

// Commands that change a document. While the document is read-only (desktop
// reading mode #163, the mobile lock) they show a hint instead of running;
// menu, palette and shortcuts all dispatch through createMenuHandlers.
export const READ_ONLY_BLOCKED_HANDLERS = new Set([
  'attachFile',
  'replace',
  'reviewAdd',
  'reviewDelete',
  'reviewSubstitute',
  'reviewHighlight',
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
  toggleImmersive,
  toggleReadingMode,
  isReadOnly,
  onReadOnlyBlocked,
  outlineFolds,
  outlineDocId,
  headingFold,
  renameFile,
  fileHistory,
  deletedFiles,
  newTab,
  openPaths,
  openFolder,
  saveTab,
  attachFiles,
  closeTab,
  toggleSource,
  cycleTheme,
  getPdfSourceForTab,
  getExportSourceForTab,
  getMarkdownForTab,
  tabs,
  tRef,
  setFind,
  findInputRef,
  openFind,
  replaceInputRef,
  review,
  requestPdfExport,
  requestHtmlExport,
  requestPandocExport
}) {
  const exportRendered = async (kind) => {
    const id = pickEditableId()
    const source = await (getExportSourceForTab || getPdfSourceForTab)(id)
    if (!source?.html) {
      window.alert(tRef.current(`error.export${kind === 'html' ? 'Html' : 'Pdf'}Unavailable`))
      return
    }
    const tab = tabs.find((x) => x.id === id)
    const base = (tab?.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
    if (kind === 'html') requestHtmlExport({ ...source, title: base }, base + '.html', tab?.path || null)
    else requestPdfExport({ ...source, title: base }, base + '.pdf', tab?.path || null)
  }
  const exportPandoc = (format) => {
    const id = pickEditableId()
    if (!id) return
    const tab = tabs.find((candidate) => candidate.id === id)
    requestPandocExport({
      markdown: getMarkdownForTab(id),
      format,
      defaultName: tab?.title || 'Untitled',
      sourcePath: tab?.path || null
    })
  }
  const handlers = {
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
    renameFile: () => renameFile?.(),
    fileHistory: () => fileHistory?.(),
    deletedFiles: () => deletedFiles?.(),
    exportPdf: () => exportRendered('pdf'),
    exportHtml: () => exportRendered('html'),
    exportPandocDocx: () => exportPandoc('docx'),
    exportPandocEpub: () => exportPandoc('epub'),
    exportPandocLatex: () => exportPandoc('latex'),
    exportPandocOdt: () => exportPandoc('odt'),
    exportPandocRtf: () => exportPandoc('rtf'),
    exportPandocMediawiki: () => exportPandoc('mediawiki'),
    exportPandocTxt: () => exportPandoc('txt'),
    closeTab: () => activeId && closeTab(activeId),
    palette: () => setPaletteOpen((v) => !v),
    toggleSidebar: () => setSidebarOpen((v) => !v),
    toggleImmersive: () => toggleImmersive?.(),
    toggleOutline: () => {
      setSidebarMode('outline')
      setSidebarOpen(true)
    },
    // Fold memory of the document the outline follows (#122); the Outline
    // panel re-reads it, so this works whether or not the panel is shown.
    outlineExpandAll: () => outlineFolds?.expandAll(outlineDocId),
    outlineCollapseAll: () => outlineFolds?.collapseAll(outlineDocId),
    headingFoldToggle: () => headingFold?.('toggle'),
    headingFoldAll: () => headingFold?.('foldAll'),
    headingUnfoldAll: () => headingFold?.('unfoldAll'),
    toggleFiles: () => {
      setSidebarMode('files')
      setSidebarOpen(true)
    },
    globalSearch: () => {
      setSidebarMode('search')
      setSidebarOpen(true)
    },
    toggleSource,
    toggleTheme: cycleTheme,
    // Main owns the window: hiding/showing it from the renderer is a round trip
    // through the preload bridge (also used by the command palette).
    toggleWindowVisibility: () => window.api.toggleWindowVisibility?.(),
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
    reviewRejectAll: () => review.applyReviewDecisionToActive('reject'),
    toggleReadingMode: () => toggleReadingMode?.()
  }
  for (const name of READ_ONLY_BLOCKED_HANDLERS) {
    const run = handlers[name]
    handlers[name] = (...args) => {
      if (isReadOnly?.()) {
        onReadOnlyBlocked?.()
        return undefined
      }
      return run(...args)
    }
  }
  return handlers
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
  flushPendingRichEdits,
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
    const offClose = window.api.onAppCloseRequest?.((payload) => {
      // Flush textarea edits still inside the per-tab debounce window, then write
      // the session — so a recent keystroke isn't lost on quit.
      commitAllLive()
      flushPendingRichEdits?.()
      flushSession()
      const dirty = tabsRef.current.some(isTabDirty)
      // Closing to the tray only hides the window: every tab stays alive, so
      // there is nothing to lose and no confirm is needed.
      if (payload?.closeToTray || !dirty || window.confirm(tRef.current('confirm.quitUnsaved'))) {
        window.api.confirmAppClose()
      } else {
        window.api.cancelAppClose?.()
      }
    })
    return () => {
      offMenu()
      offFolder?.()
      offClose?.()
      window.removeEventListener('mm:openFolder', onOpenFolderEvt)
    }
  }, [openFolder, isAbsolutePath, addFolderByPath, setSidebarMode, setSidebarOpen, commitAllLive, flushPendingRichEdits, flushSession, tabsRef, tRef, handlers, activeTabKind])

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

  // Outline expand / collapse all (#122): capture phase so the shortcut works
  // with the caret in the editor; renderer-only (no menu accelerator).
  useEffect(() => {
    const onKey = (e) => {
      if (activeTabKind === 'settings') return
      const expand = keybindingMatchesEvent(keybindings['outline.expandAll']?.[0], e, platform)
      const collapse = !expand && keybindingMatchesEvent(keybindings['outline.collapseAll']?.[0], e, platform)
      if (!expand && !collapse) return
      e.preventDefault()
      e.stopPropagation()
      if (expand) handlers.current.outlineExpandAll?.()
      else handlers.current.outlineCollapseAll?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handlers, keybindings, platform, activeTabKind])
  // Heading folds in the document: capture phase too (works in reading mode).
  useEffect(() => {
    const bindings = [
      ['editor.fold.toggle', 'headingFoldToggle'],
      ['editor.fold.all', 'headingFoldAll'],
      ['editor.fold.none', 'headingUnfoldAll']
    ]
    const onKey = (e) => {
      if (activeTabKind === 'settings') return
      const hit = bindings.find(([id]) => keybindingMatchesEvent(keybindings[id]?.[0], e, platform))
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      handlers.current[hit[1]]?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handlers, keybindings, platform, activeTabKind])
  // Rename (F2 by default, #156). Not while typing in a field (the tree's
  // own rename input, the find bar, dialogs); the source textarea is the
  // document, so it counts as the editor.
  useEffect(() => {
    const onKey = (e) => {
      if (!keybindingMatchesEvent(keybindings['file.rename']?.[0], e, platform)) return
      const target = e.target
      if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return
      if (target?.tagName === 'TEXTAREA' && !target.classList?.contains('source-editor')) return
      if (document.querySelector('.hm-rename-modal')) return
      e.preventDefault()
      e.stopPropagation()
      handlers.current.renameFile?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handlers, keybindings, platform])

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
