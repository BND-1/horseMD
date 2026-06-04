import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from './components/Editor.jsx'
import Sidebar from './components/Sidebar.jsx'
import Tabs from './components/Tabs.jsx'
import Outline from './components/Outline.jsx'
import StatusBar from './components/StatusBar.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { Icon } from './components/icons.jsx'

const baseName = (p) => (p ? p.split(/[\\/]/).pop() : 'Untitled')
let idCounter = 0
const genId = () => `t${++idCounter}_${Date.now()}`

const LS = 'minimd.session.v1'
const loadSession = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {}
  } catch {
    return {}
  }
}

export default function App() {
  const session = useRef(loadSession()).current
  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [workspace, setWorkspace] = useState(session.workspace || null)
  const [sidebarOpen, setSidebarOpen] = useState(session.sidebarOpen ?? true)
  const [sidebarMode, setSidebarMode] = useState(session.sidebarMode || 'files') // 'files' or 'outline'
  const [theme, setTheme] = useState(session.theme || 'light')
  const [sourceMode, setSourceMode] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [files, setFiles] = useState([])
  const [find, setFind] = useState({ open: false, query: '' })

  const editorHostRef = useRef(null)
  const findInputRef = useRef(null)

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) || null, [tabs, activeId])
  const activePath = activeTab?.path || null

  // ----------------------------- theme -----------------------------
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark')
    document.body.classList.toggle('light', theme !== 'dark')
  }, [theme])

  // --------------------------- open files --------------------------
  const openPaths = useCallback(async (paths) => {
    if (!paths || !paths.length) return
    let lastId = null
    for (const path of paths) {
      const norm = path.replace(/\\/g, '/')
      let existing = null
      setTabs((prev) => {
        existing = prev.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
        return prev
      })
      if (existing) {
        lastId = existing.id
        continue
      }
      try {
        const { content, mtimeMs } = await window.api.readFile(path)
        const id = genId()
        lastId = id
        setTabs((prev) => [
          ...prev,
          {
            id,
            path,
            title: baseName(path),
            content,
            savedContent: content,
            mtimeMs,
            reloadNonce: 0
          }
        ])
      } catch (e) {
        window.alert('Could not open file: ' + e.message)
      }
    }
    if (lastId) setActiveId(lastId)
  }, [])

  const newTab = useCallback(() => {
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: 'Untitled', content: '', savedContent: '', mtimeMs: null, reloadNonce: 0 }
    ])
    setActiveId(id)
  }, [])

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
      setTabs((prev) => {
        const t = prev.find((x) => x.id === id)
        if (t && t.content !== t.savedContent) {
          if (!window.confirm(`"${t.title}" has unsaved changes. Close anyway?`)) return prev
        }
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
    []
  )

  const writeTab = useCallback(async (tab, targetPath) => {
    const { mtimeMs } = await window.api.writeFile(targetPath, tab.content)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tab.id
          ? { ...t, path: targetPath, title: baseName(targetPath), savedContent: t.content, mtimeMs }
          : t
      )
    )
    setRefreshNonce((n) => n + 1)
  }, [])

  const saveTab = useCallback(
    async (id, forceDialog = false) => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab) return
      let target = tab.path
      if (!target || forceDialog) {
        target = await window.api.saveAs(tab.title.endsWith('.md') ? tab.title : tab.title + '.md')
        if (!target) return
      }
      await writeTab(tab, target)
    },
    [tabs, writeTab]
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

  // --------------------------- outline jump ------------------------
  const jumpToHeading = useCallback((index) => {
    const host = editorHostRef.current
    if (!host) return
    const hs = host.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6')
    hs[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // ------------------------- menu / shortcuts ----------------------
  const handlers = useRef({})
  handlers.current = {
    new: newTab,
    open: async () => openPaths(await window.api.openFiles()),
    openFolder,
    save: () => activeId && saveTab(activeId),
    saveAs: () => activeId && saveTab(activeId, true),
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
    toggleSource: () => setSourceMode((v) => !v),
    toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    find: () => {
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => findInputRef.current?.focus(), 0)
    }
  }

  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => handlers.current[cmd]?.())
    const offOpen = window.api.onOpenPaths((paths) => openPaths(paths))
    const onOpenFolderEvt = () => openFolder()
    window.addEventListener('mm:openFolder', onOpenFolderEvt)
    return () => {
      offMenu()
      offOpen()
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
          return prev
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId])

  useEffect(() => {
    const paths = (session.openPaths || []).filter(Boolean)
    if (paths.length) openPaths(paths).then(() => {
      if (session.activePath) {
        setTabs((prev) => {
          const t = prev.find((x) => x.path === session.activePath)
          if (t) setActiveId(t.id)
          return prev
        })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- persistence -------------------------
  useEffect(() => {
    const data = {
      workspace,
      theme,
      sidebarOpen,
      sidebarMode,
      openPaths: tabs.map((t) => t.path).filter(Boolean),
      activePath
    }
    localStorage.setItem(LS, JSON.stringify(data))
  }, [workspace, theme, sidebarOpen, sidebarMode, tabs, activePath])

  // --------------------------- commands ----------------------------
  const commands = useMemo(
    () => [
      { id: 'cmd.new', title: 'New File', icon: 'file-plus', run: () => handlers.current.new() },
      { id: 'cmd.open', title: 'Open File…', icon: 'file', run: () => handlers.current.open() },
      { id: 'cmd.openFolder', title: 'Open Folder…', icon: 'folder', run: () => handlers.current.openFolder() },
      { id: 'cmd.save', title: 'Save', icon: 'save', run: () => handlers.current.save() },
      { id: 'cmd.saveAs', title: 'Save As…', icon: 'save', run: () => handlers.current.saveAs() },
      { id: 'cmd.sidebar', title: 'Toggle Sidebar', icon: 'sidebar', run: () => handlers.current.toggleSidebar() },
      { id: 'cmd.files', title: 'Show File Explorer', icon: 'folder', run: () => handlers.current.toggleFiles() },
      { id: 'cmd.outline', title: 'Show Outline', icon: 'outline', run: () => handlers.current.toggleOutline() },
      { id: 'cmd.source', title: 'Toggle Source Mode', icon: 'code', run: () => handlers.current.toggleSource() },
      { id: 'cmd.theme', title: 'Toggle Theme', icon: 'moon', run: () => handlers.current.toggleTheme() },
      { id: 'cmd.find', title: 'Find in File', icon: 'search', run: () => handlers.current.find() }
    ],
    []
  )

  const runFind = (backwards = false) => {
    if (!find.query) return
    // eslint-disable-next-line no-undef
    window.find(find.query, false, backwards, true, false, true, false)
  }

  const winClass = window.api.platform === 'win32' ? ' is-win' : ''

  return (
    <div className={`app${winClass}`}>
      <div className="activity-bar">
        <button
          className={`activity-item${sidebarMode === 'files' ? ' active' : ''}`}
          title="Explorer"
          onClick={() => handlers.current.toggleFiles()}
        >
          <Icon name="folder" size={20} />
        </button>
        <button
          className={`activity-item${sidebarMode === 'outline' ? ' active' : ''}`}
          title="Outline"
          onClick={() => handlers.current.toggleOutline()}
        >
          <Icon name="outline" size={20} />
        </button>
      </div>

      <div className="topbar">
        <Tabs
          tabs={tabs}
          activeId={activeId}
          onActivate={setActiveId}
          onClose={closeTab}
          onNew={newTab}
        />
        <div className="topbar-spacer" />
        <button className="icon-btn drag-no" title="Command palette (Ctrl+P)" onClick={() => setPaletteOpen(true)}>
          <Icon name="command" size={16} />
        </button>
      </div>

      <div className="body">
        {sidebarOpen && (
          <aside className="pane-left">
            {sidebarMode === 'files' ? (
              <Sidebar
                workspace={workspace}
                activePath={activePath}
                onOpenFile={(p) => openPaths([p])}
                refreshNonce={refreshNonce}
              />
            ) : (
              <Outline content={activeTab?.content || ''} onJump={jumpToHeading} />
            )}
          </aside>
        )}

        <main className="pane-center">
          {find.open && (
            <div className="findbar">
              <Icon name="search" size={14} />
              <input
                ref={findInputRef}
                value={find.query}
                placeholder="Find in document"
                onChange={(e) => setFind((f) => ({ ...f, query: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runFind(e.shiftKey)
                  if (e.key === 'Escape') setFind({ open: false, query: '' })
                }}
              />
              <button onClick={() => runFind(false)}>Next</button>
              <button onClick={() => runFind(true)}>Prev</button>
              <button onClick={() => setFind({ open: false, query: '' })}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}

          {activeTab ? (
            sourceMode ? (
              <textarea
                className="source-editor"
                value={activeTab.content}
                spellCheck={false}
                onChange={(e) => updateContent(activeTab.id, e.target.value, false)}
              />
            ) : (
              <div className="editor-scroll" ref={editorHostRef}>
                <Editor
                  key={`${activeTab.id}:${activeTab.reloadNonce}`}
                  initialContent={activeTab.content}
                  onChange={(md, isInitial) => updateContent(activeTab.id, md, isInitial)}
                  onReady={() => {}}
                />
              </div>
            )
          ) : (
            <Welcome onNew={newTab} onOpen={() => handlers.current.open()} onOpenFolder={openFolder} />
          )}
        </main>
      </div>

      <StatusBar
        tab={activeTab}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        sourceMode={sourceMode}
        onToggleSource={() => setSourceMode((v) => !v)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        files={files}
        onOpenFile={(p) => openPaths([p])}
      />
    </div>
  )
}

function Welcome({ onNew, onOpen, onOpenFolder }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>horse</h1>
        <p>A calmer place to write Markdown — many files, one window.</p>
        <div className="welcome-actions">
          <button className="btn-primary" onClick={onNew}>
            <Icon name="file-plus" size={16} /> New File
          </button>
          <button onClick={onOpen}>
            <Icon name="file" size={16} /> Open File
          </button>
          <button onClick={onOpenFolder}>
            <Icon name="folder" size={16} /> Open Folder
          </button>
        </div>
        <div className="welcome-hints">
          <span><kbd>Ctrl</kbd><kbd>P</kbd> Palette</span>
          <span><kbd>Ctrl</kbd><kbd>B</kbd> Sidebar</span>
          <span><kbd>Ctrl</kbd><kbd>N</kbd> New</span>
          <span><kbd>Ctrl</kbd><kbd>S</kbd> Save</span>
        </div>
      </div>
    </div>
  )
}
