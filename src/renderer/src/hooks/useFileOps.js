// Document file operations extracted from App.jsx. Renderer-side multi-root
// workspace state and directory watchers live in useWorkspace.js; this hook
// keeps open-document operations and their per-file external-change watchers.
//
// Split-view ops (openRight/toggleSplit/startSplitDrag/openFileRight) and split
// state stay in App — they're consumed heavily by the editor-area JSX and are
// kept cohesive there. closeOthers resets the split, so setSplitId is passed in.
//
// Options:
//   tabs/setTabs/tabsRef  — the tab store (open/close/save mutate it)
//   setActiveId/setHome/setSplitId/setRecents — tab/split/recents setters
//   commitAllLive/liveContentRef/liveTimersRef — uncontrolled-textarea contract
//   getPdfSourceForTab/waitForPdfSourceForTab — resolves structured PDF source
//   getMarkdownForTab/getSettledMarkdownForTab — sync exports + settled saves
//   isMobile/t/tRef — i18n + mobile save-dialog branch
//   setRenameState/setSaveNameState — rename / mobile-save modal triggers
//   setSidebarOpen/initialFolderRoots — forwarded to useWorkspace
import { useCallback, useEffect, useRef } from 'react'
import { isTabDirty } from '../lib/tab-state.js'
import {
  baseName,
  dirName,
  joinPath,
  genId,
  isHeavyDoc
} from '../paths.js'
import { fireToast } from '../ui.js'
import { getSavedDocPosition } from '../lib/doc-positions.js'
import { saveSourceSyncRecovery } from '../lib/source-sync-recovery.js'
import { useWorkspace } from './useWorkspace.js'

export function useFileOps({
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
  getMarkdownForTab,
  getSettledMarkdownForTab,
  getRecoveryMarkdownForTab,
  waitForPdfSourceForTab,
  isMobile,
  t,
  tRef,
  setRenameState,
  setSaveNameState,
  requestPdfExport,
  requestHtmlExport,
  requestPandocExport,
  setSidebarOpen,
  initialFolderRoots
}) {
  const workspace = useWorkspace({ initialFolderRoots, setSidebarOpen })
  const { bumpRefresh } = workspace

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
        // Restore the last caret/viewport (issue #111) only when the file's
        // length still matches the saved snapshot — an externally changed file
        // must never map a stale offset onto new text.
        const savedPosition = getSavedDocPosition(norm)
        const positionMatches = savedPosition && savedPosition.len === content.length
        const newTab = {
          id,
          kind: 'doc',
          path,
          title: baseName(path),
          content,
          savedContent: content,
          mtimeMs,
          reloadNonce: 0,
          heavy: isHeavyDoc(content),
          restoreOffset: positionMatches ? savedPosition.offset : null,
          restoreScrollTop: positionMatches ? savedPosition.scrollTop || null : null
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
  }, [tabsRef, setTabs, setActiveId, setHome, setRecents, tRef])

  const newTab = useCallback(() => {
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, kind: 'doc', path: null, title: t('tab.untitled'), content: '', savedContent: '', mtimeMs: null, reloadNonce: 0 }
    ])
    setActiveId(id)
    setHome(false)
  }, [t, setTabs, setActiveId, setHome])

  // Open the Settings page as a real tab. Idempotent: if a Settings tab already
  // exists, just focus it (never open a second one). Settings tabs are transient
  // — useAppLifecycle filters `kind!=='doc'` out of session persistence, so they
  // don't survive a restart.
  const openSettingsTab = useCallback(() => {
    const existing = tabsRef.current.find((tb) => tb.kind === 'settings')
    if (existing) {
      setActiveId(existing.id)
      setHome(false)
      return
    }
    const id = genId()
    const tab = {
      id,
      kind: 'settings',
      path: null,
      title: t('nav.settings'),
      content: '',
      savedContent: '',
      mtimeMs: null,
      reloadNonce: 0
    }
    tabsRef.current = [...tabsRef.current, tab]
    setTabs((prev) => [...prev, tab])
    setActiveId(id)
    setHome(false)
  }, [t, setTabs, setActiveId, setHome, tabsRef])

  // Reorder tabs by dragging (issue #31). Moves a tab from `from` to `to` in the
  // array; session persistence (useAppLifecycle) already saves tabs in order.
  const reorderTabs = useCallback((from, to) => {
    if (from === to || from < 0 || to < 0 || from >= tabsRef.current.length) return
    setTabs((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [setTabs, tabsRef])

  const updateContent = useCallback((id, md, isInitial) => {
    if (!isInitial) {
      // Keep the shared uncontrolled-source mirror current for rich edits too.
      // EditorArea intentionally prefers this mirror when mounting a textarea;
      // leaving it populated with an older source-mode value lets a rich
      // callback update tabsRef while source mode still mounts stale bytes.
      liveContentRef.current.set(id, md)
      // `markdownUpdated` is also the source-mode handoff boundary. Mirror the
      // committed source synchronously before React renders the textarea;
      // otherwise a rapid structural input-rule callback can leave `tabsRef`
      // one snapshot behind and source mode mounts that older Markdown even
      // though Editor's byte-preserving mapper already produced the right
      // result.
      tabsRef.current = tabsRef.current.map((tab) =>
        tab.id === id && (tab.content !== md || tab.pendingRichEdit)
          ? { ...tab, content: md, pendingRichEdit: false }
          : tab
      )
    }
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        if (isInitial) {
          // Parsing is a view concern. Never adopt Crepe's serializer output as
          // the source baseline during initialization: that would silently add
          // escapes/blank lines or normalize line endings before any user edit.
          return t
        }
        // A delayed Milkdown serializer result is now authoritative. Clear the
        // immediate UI hint whether the user changed content or changed it back
        // to the saved source before the debounce elapsed.
        if (t.content === md && !t.pendingRichEdit) return t
        return { ...t, content: md, pendingRichEdit: false }
      })
    )
  }, [liveContentRef, setTabs, tabsRef])

  // Milkdown batches `markdownUpdated` for 200ms. Rich text must nevertheless
  // show its unsaved indicator immediately after a real DOM input event. This
  // hint never writes to disk and is cleared by the next serializer result.
  const markRichEditPending = useCallback((id) => {
    const current = tabsRef.current.find((tab) => tab.id === id)
    if (!current || current.kind === 'settings' || current.pendingRichEdit) return
    const next = { ...current, pendingRichEdit: true }
    tabsRef.current = tabsRef.current.map((tab) => tab.id === id ? next : tab)
    setTabs((prev) => prev.map((tab) =>
      tab.id === id && !tab.pendingRichEdit ? { ...tab, pendingRichEdit: true } : tab
    ))
  }, [setTabs, tabsRef])

  const closeTab = useCallback(
    (id) => {
      commitAllLive() // flush textarea edits so the unsaved-check below is accurate
      setTabs((prev) => {
        const tab = prev.find((x) => x.id === id)
        if (isTabDirty(tab)) {
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
    [commitAllLive, setTabs, setActiveId, liveTimersRef, liveContentRef, tRef]
  )

  // --- File operations shared by the tab menu and the sidebar menu, so both
  //     right-click menus offer the same actions on a file. ---
  // Open the rename dialog for a tab's file (Electron has no window.prompt).
  const renameTabFile = useCallback((id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    setRenameState({ id, value: baseName(tab.path) })
  }, [tabsRef, setRenameState])

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
      bumpRefresh()
    } catch (e) {
      window.alert(
        /eexist|already exists/i.test(e.message)
          ? tRef.current('err.nameExists')
          : tRef.current('err.rename') + e.message
      )
    }
  }, [tabsRef, setRenameState, setTabs, bumpRefresh, tRef])

  const duplicateTabFile = useCallback(async (id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    try {
      await window.api.duplicate(tab.path)
      bumpRefresh()
    } catch (e) {
      window.alert(
        /eexist|already exists/i.test(e.message)
          ? tRef.current('err.nameExists')
          : tRef.current('err.duplicate') + e.message
      )
    }
  }, [tabsRef, bumpRefresh, tRef])

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
      bumpRefresh()
    } catch (e) {
      window.alert(tRef.current('err.delete') + e.message)
    }
  }, [tabsRef, setTabs, setActiveId, bumpRefresh, tRef])

  // Close every tab except `keepId` (from the tab right-click menu).
  const closeOthers = useCallback((keepId) => {
    commitAllLive()
    setTabs((prev) => {
      const others = prev.filter((t) => t.id !== keepId)
      const firstDirty = others.find(isTabDirty)
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
  }, [commitAllLive, setTabs, setActiveId, setSplitId, liveTimersRef, liveContentRef, tRef])

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
                  pendingRichEdit: false,
                  reloadNonce: t.reloadNonce + 1
                }
              : { ...t, path: targetPath, title: baseName(targetPath), savedContent: t.content, mtimeMs, pendingRichEdit: false }
            : t
        )
      )
      bumpRefresh()
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
  }, [isMobile, setTabs, bumpRefresh, tRef])

  const saveTab = useCallback(
    async (id, forceDialog = false) => {
      commitAllLive() // flush any textarea edits in the debounce window before reading
      let tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      // A rich ProseMirror transaction can already be visible while Milkdown's
      // markdownUpdated callback and React state are still one task behind.
      // Resolve the editor's current document before writing so an immediate
      // save cannot persist the previous tab.content snapshot.
      let currentMarkdown = getSettledMarkdownForTab
        ? await getSettledMarkdownForTab(id)
        : getMarkdownForTab(id)
      if (currentMarkdown == null) {
        const recoveryMarkdown = getRecoveryMarkdownForTab?.(id)
        if (typeof recoveryMarkdown !== 'string') {
          fireToast(tRef.current('save.sourceSyncFailed'), { sticky: true })
          return
        }
        fireToast(tRef.current('save.sourceSyncRecoveryPrompt'), { sticky: true })
        try {
          const recovery = await saveSourceSyncRecovery({
            api: window.api,
            title: tab.title,
            markdown: recoveryMarkdown
          })
          if (!recovery.ok) return
          fireToast(tRef.current('save.sourceSyncRecoverySaved', { path: recovery.path }), { sticky: true })
        } catch (error) {
          fireToast(tRef.current('save.failed', { msg: error?.message || String(error) }), { sticky: true })
        }
        return
      }
      if (typeof currentMarkdown === 'string' && currentMarkdown !== tab.content) {
        tab = { ...tab, content: currentMarkdown }
        tabsRef.current = tabsRef.current.map((item) => item.id === id ? tab : item)
        setTabs((prev) => prev.map((item) => item.id === id ? { ...item, content: currentMarkdown } : item))
      }
      // Settings tabs aren't documents — ⌘S / the save button must never try to
      // write one to disk (it has no path and no real content).
      if (tab.kind === 'settings') return
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
    [
      commitAllLive,
      getMarkdownForTab,
      getRecoveryMarkdownForTab,
      getSettledMarkdownForTab,
      writeTab,
      isMobile,
      setTabs,
      tabsRef,
      setSaveNameState,
      tRef
    ]
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
    [commitAllLive, writeTab, tabsRef, setSaveNameState, tRef]
  )

  // A file-tree or tab-menu export may target a document that has never mounted
  // an editor. Focus it and wait for the shared rendered snapshot before opening
  // a PDF/HTML studio. Pandoc consumes the current Markdown instead.
  const resolveExportTab = useCallback(async (path) => {
    await openPaths([path])
    const norm = (path || '').replace(/\\/g, '/')
    return tabsRef.current.find((tab) => (tab.path || '').replace(/\\/g, '/') === norm) || null
  }, [openPaths, tabsRef])

  const exportPathAsRendered = useCallback(async (path, kind) => {
    const tab = await resolveExportTab(path)
    if (!tab) return
    const source = await getPdfSourceForTab(tab.id) || await waitForPdfSourceForTab(tab.id)
    if (!source?.html) {
      window.alert(tRef.current(kind === 'html' ? 'error.exportHtmlUnavailable' : 'error.exportPdfUnavailable'))
      return
    }
    const base = (tab.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
    const payload = { ...source, title: base }
    if (kind === 'html') requestHtmlExport(payload, base + '.html', tab.path || null)
    else requestPdfExport(payload, base + '.pdf', tab.path || null)
  }, [resolveExportTab, getPdfSourceForTab, waitForPdfSourceForTab, tRef, requestHtmlExport, requestPdfExport])

  const exportPathToPdf = useCallback(
    (path) => exportPathAsRendered(path, 'pdf'),
    [exportPathAsRendered]
  )

  const exportPathToHtml = useCallback(
    (path) => exportPathAsRendered(path, 'html'),
    [exportPathAsRendered]
  )

  const exportPathWithPandoc = useCallback(async (path, format) => {
    const tab = await resolveExportTab(path)
    if (!tab) return
    requestPandocExport({
      markdown: getMarkdownForTab(tab.id),
      format,
      defaultName: tab.title || 'Untitled',
      sourcePath: tab.path || null
    })
  }, [resolveExportTab, getMarkdownForTab, requestPandocExport])

  // --------- auto-reload open files edited by external programs ----------
  const watchedRef = useRef(new Set())
  // A watcher can report one external save more than once (notably on Windows
  // atomic-save editors). Remember the disk version already disclosed so a
  // dirty document gets one actionable warning instead of an alert loop.
  const externalWarningRef = useRef(new Map())

  // Keep a per-file watcher in sync with the set of open file paths.
  useEffect(() => {
    const want = new Set(tabs.map((t) => t.path).filter(Boolean))
    for (const p of want) if (!watchedRef.current.has(p)) window.api.watchFile(p)
    for (const p of watchedRef.current) {
      if (want.has(p)) continue
      window.api.unwatchFile(p)
      externalWarningRef.current.delete(p.replace(/\\/g, '/'))
    }
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
          if (isTabDirty(t)) return t
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
  }, [commitAllLive, setTabs, liveContentRef])

  useEffect(() => {
    const off = window.api.onFileChanged(({ path, mtimeMs }) => {
      // A source textarea can still be inside its debounce window when an
      // external editor saves. Commit it before deciding whether this tab is
      // dirty; otherwise its local change could be mistaken for a clean tab.
      commitAllLive()
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (!tab) return
      // Ignore the echo from our own save (same or older mtime).
      if (tab.mtimeMs && mtimeMs && mtimeMs <= tab.mtimeMs) return
      // Don't overwrite unsaved local edits. Make the conflict explicit rather
      // than silently leaving the user with an out-of-date on-disk version.
      if (isTabDirty(tab)) {
        const warnedVersion = externalWarningRef.current.get(norm)
        if (warnedVersion === mtimeMs) return
        externalWarningRef.current.set(norm, mtimeMs)
        window.alert(tRef.current('warning.externalChangedUnsaved', { name: tab.title }))
        return
      }
      reloadTabFromDisk(tab.id, tab.path)
    })
    return off
  }, [commitAllLive, reloadTabFromDisk, tabsRef, tRef])

  return {
    openPaths,
    newTab,
    openSettingsTab,
    reorderTabs,
    updateContent,
    markRichEditPending,
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
    exportPathToHtml,
    exportPathWithPandoc,
    ...workspace,
    reloadTabFromDisk
  }
}
