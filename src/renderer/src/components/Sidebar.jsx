import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'

const join = (dir, name) => `${dir.replace(/[\\/]+$/, '')}/${name}`
const baseName = (p) => p.split(/[\\/]/).pop()
const parentDir = (p) => p.replace(/[\\/][^\\/]*$/, '')

export default function Sidebar({ workspace, activePath, onOpenFile, refreshNonce }) {
  const { t } = useI18n()
  const [childrenMap, setChildrenMap] = useState({}) // path -> nodes[]
  const [expanded, setExpanded] = useState(() => new Set())
  const [menu, setMenu] = useState(null) // { x, y, node }
  const [rename, setRename] = useState(null) // { path, value }
  // Inline creation: { dir, type: 'file'|'folder', value }
  const [creating, setCreating] = useState(null)
  const createInputRef = useRef(null)

  const loadDir = useCallback(async (dir) => {
    const nodes = await window.api.readDir(dir)
    setChildrenMap((m) => ({ ...m, [dir]: nodes }))
    return nodes
  }, [])

  // Initial / workspace change
  useEffect(() => {
    if (!workspace) return
    setExpanded(new Set([workspace.rootPath]))
    setChildrenMap({})
    setCreating(null)
    loadDir(workspace.rootPath)
  }, [workspace, loadDir])

  // Focus the inline input when creating state changes, and select filename
  useEffect(() => {
    if (creating) {
      setTimeout(() => {
        const input = createInputRef.current
        if (input) {
          input.focus()
          if (creating.selectRange) {
            input.setSelectionRange(creating.selectRange[0], creating.selectRange[1])
          } else {
            input.select()
          }
        }
      }, 30)
    }
  }, [creating])

  // Refresh all currently-loaded dirs when the watcher fires
  useEffect(() => {
    if (!workspace || refreshNonce === 0) return
    Object.keys(childrenMap).forEach((dir) => loadDir(dir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  const toggle = async (node) => {
    const next = new Set(expanded)
    if (next.has(node.path)) {
      next.delete(node.path)
    } else {
      next.add(node.path)
      if (!childrenMap[node.path]) await loadDir(node.path)
    }
    setExpanded(next)
  }

  const closeMenu = useCallback(() => setMenu(null), [])
  useEffect(() => {
    if (!menu) return
    window.addEventListener('click', closeMenu)
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('blur', closeMenu)
    }
  }, [menu, closeMenu])

  const refreshParentOf = async (path) => {
    const p = parentDir(path)
    if (childrenMap[p] !== undefined) await loadDir(p)
  }

  // Start inline creation for a file
  const startNewFile = (dirNode) => {
    const dir = dirNode ? dirNode.path : workspace.rootPath
    setCreating({ dir, type: 'file', value: 'untitled.md', selectRange: [0, 8] })
    // Make sure the directory is expanded
    if (dirNode) {
      setExpanded((s) => new Set(s).add(dir))
      if (!childrenMap[dir]) loadDir(dir)
    }
  }

  // Start inline creation for a folder
  const startNewFolder = (dirNode) => {
    const dir = dirNode ? dirNode.path : workspace.rootPath
    setCreating({ dir, type: 'folder', value: t('prompt.newFolderDefault') })
    if (dirNode) {
      setExpanded((s) => new Set(s).add(dir))
      if (!childrenMap[dir]) loadDir(dir)
    }
  }

  // Commit the inline creation
  const commitCreate = async () => {
    if (!creating) return
    const { dir, type, value } = creating
    const name = value.trim()
    setCreating(null)
    if (!name) return

    try {
      if (type === 'file') {
        let fileName = name
        if (!/\.[a-z0-9]+$/i.test(fileName)) fileName += '.md'
        const path = join(dir, fileName)
        await window.api.createFile(path, '')
        await loadDir(dir)
        onOpenFile(path)
      } else {
        await window.api.createDir(join(dir, name))
        await loadDir(dir)
        setExpanded((s) => new Set(s).add(dir))
      }
    } catch (e) {
      window.alert((type === 'file' ? t('err.createFile') : 'Could not create folder: ') + e.message)
    }
  }

  const doDelete = async (node) => {
    if (!window.confirm(t('confirm.trash', { name: node.name }))) return
    await window.api.deleteItem(node.path)
    await refreshParentOf(node.path)
  }

  const commitRename = async () => {
    if (!rename) return
    const { path, value } = rename
    setRename(null)
    const clean = value.trim()
    if (!clean || clean === baseName(path)) return
    const newPath = join(parentDir(path), clean)
    await window.api.rename(path, newPath)
    await refreshParentOf(path)
  }

  if (!workspace) {
    return (
      <div className="sidebar-empty">
        <Icon name="folder" size={26} />
        <p>{t('side.noFolder')}</p>
        <button className="btn-primary" onClick={() => window.dispatchEvent(new Event('mm:openFolder'))}>
          {t('side.openFolder')}
        </button>
      </div>
    )
  }

  const rootNodes = childrenMap[workspace.rootPath] || []

  // Render the inline creation input
  const renderCreatingInput = (depth) => (
    <div className="tree-row creating-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chevron" />
      <Icon name={creating.type === 'file' ? 'file' : 'folder'} size={15} className="tree-icon" />
      <input
        ref={createInputRef}
        className="tree-rename"
        autoFocus
        value={creating.value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setCreating({ ...creating, value: e.target.value })}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); commitCreate() }
          if (e.key === 'Escape') setCreating(null)
        }}
      />
    </div>
  )

  const renderNode = (node, depth) => {
    const isDir = node.type === 'dir'
    const isOpen = expanded.has(node.path)
    const isActive = node.path === activePath
    const renaming = rename && rename.path === node.path
    return (
      <div key={node.path}>
        <div
          className={`tree-row${isActive ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (isDir ? toggle(node) : onOpenFile(node.path))}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node })
          }}
          title={node.path}
        >
          {isDir ? (
            <Icon name="chevron-right" size={14} className={`tree-chevron${isOpen ? ' chevron-expanded' : ''}`} />
          ) : (
            <span className="tree-chevron" />
          )}
          <Icon name={isDir ? (isOpen ? 'folder-open' : 'folder') : 'file'} size={15} className="tree-icon" />
          {renaming ? (
            <input
              className="tree-rename"
              autoFocus
              value={rename.value}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRename({ ...rename, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRename(null)
              }}
              onBlur={commitRename}
            />
          ) : (
            <span className="tree-label">{node.name}</span>
          )}
        </div>
        {/* Inline creation input inside this directory */}
        {isDir && isOpen && creating && creating.dir === node.path && renderCreatingInput(depth + 1)}
        {isDir && isOpen && (childrenMap[node.path] || []).map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title" title={workspace.rootPath}>
          {workspace.rootName}
        </span>
        <div className="sidebar-head-actions">
          <button title={t('side.newFile')} onClick={() => startNewFile(null)}>
            <Icon name="file-plus" size={15} />
          </button>
          <button title={t('side.newFolder')} onClick={() => startNewFolder(null)}>
            <Icon name="folder-plus" size={15} />
          </button>
          <button title={t('side.collapseAll')} onClick={() => setExpanded(new Set([workspace.rootPath]))}>
            <Icon name="collapse" size={15} />
          </button>
        </div>
      </div>
      <div className="tree" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }) }}>
        {/* Inline creation at root level */}
        {creating && creating.dir === workspace.rootPath && renderCreatingInput(0)}
        {rootNodes.length === 0 && !creating ? (
          <div className="tree-empty">{t('side.empty')}</div>
        ) : (
          rootNodes.map((n) => renderNode(n, 0))
        )}
      </div>

      {menu && (
        <div className="context-menu" style={{
          left: Math.min(menu.x, window.innerWidth - 210),
          top: Math.min(menu.y, window.innerHeight - 260)
        }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { startNewFile(menu.node?.type === 'dir' ? menu.node : null); setMenu(null) }}>{t('side.ctxNewFile')}</button>
          <button onClick={() => { startNewFolder(menu.node?.type === 'dir' ? menu.node : null); setMenu(null) }}>{t('side.ctxNewFolder')}</button>
          {menu.node && <div className="menu-sep" />}
          {menu.node && <button onClick={() => { setRename({ path: menu.node.path, value: menu.node.name }); setMenu(null) }}>{t('side.rename')}</button>}
          {menu.node && <button onClick={() => { window.api.showInFolder(menu.node.path); setMenu(null) }}>{t('side.reveal')}</button>}
          {menu.node && <button className="danger" onClick={() => { doDelete(menu.node); setMenu(null) }}>{t('side.delete')}</button>}
        </div>
      )}
    </div>
  )
}
