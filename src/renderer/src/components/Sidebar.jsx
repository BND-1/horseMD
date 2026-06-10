import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { baseName, dirName as parentDir, joinPath as join, isMarkdownName, isValidName, isExistsError } from '../paths.js'
import { copyToClipboard } from '../ui.js'

export default function Sidebar({ workspace, activePath, onOpenFile, onOpenRight, onExportPdf, refreshNonce }) {
  const { t } = useI18n()
  const copyText = (text) => copyToClipboard(text, t('code.copied'))
  const [childrenMap, setChildrenMap] = useState({}) // path -> nodes[]
  const [expanded, setExpanded] = useState(() => new Set())
  const [menu, setMenu] = useState(null) // { x, y, node }
  const [rename, setRename] = useState(null) // { path, value }
  // Inline creation: { dir, type: 'file'|'folder', value }
  const [creating, setCreating] = useState(null)
  // Guards against committing a creation twice (e.g. Enter immediately followed
  // by the input's blur, or a click on the confirm button + blur).
  const committingRef = useRef(false)
  // Drag-and-drop: path being dragged, and the folder currently hovered as a
  // drop target (for highlighting).
  const dragPathRef = useRef(null)
  const [dragOver, setDragOver] = useState(null)

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
    setCreating({ dir, type: 'file', value: 'untitled.md' })
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
    if (!creating || committingRef.current) return
    committingRef.current = true
    const { dir, type, value } = creating
    const name = value.trim()
    setCreating(null)
    if (!name) {
      committingRef.current = false
      return
    }
    if (!isValidName(name)) {
      committingRef.current = false
      window.alert((t('err.invalidName') || 'Invalid name: ') + name)
      return
    }

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
      window.alert(
        isExistsError(e)
          ? t('err.nameExists')
          : (type === 'file' ? t('err.createFile') : t('err.createFolder')) + e.message
      )
    } finally {
      committingRef.current = false
    }
  }

  const doDelete = async (node) => {
    if (!window.confirm(t('confirm.trash', { name: node.name }))) return
    try {
      await window.api.deleteItem(node.path)
      await refreshParentOf(node.path)
    } catch (e) {
      window.alert((t('err.delete') || 'Could not delete: ') + e.message)
    }
  }

  const doDuplicate = async (node) => {
    try {
      await window.api.duplicate(node.path)
      await refreshParentOf(node.path)
    } catch (e) {
      window.alert(isExistsError(e) ? t('err.nameExists') : (t('err.duplicate') || 'Could not duplicate: ') + e.message)
    }
  }

  // Recursively load every subfolder and expand them all. Depth-capped and
  // visited-guarded so a symlink cycle or a pathologically deep tree can't spin
  // into unbounded IPC recursion.
  const expandAll = async () => {
    if (!workspace) return
    const dirs = new Set([workspace.rootPath])
    const seen = new Set()
    const walk = async (dir, depth) => {
      if (depth > 30 || seen.has(dir)) return
      seen.add(dir)
      let nodes = childrenMap[dir]
      if (nodes === undefined) nodes = await loadDir(dir)
      for (const n of nodes || []) {
        if (n.type === 'dir') {
          dirs.add(n.path)
          await walk(n.path, depth + 1)
        }
      }
    }
    await walk(workspace.rootPath, 0)
    setExpanded(dirs)
  }

  // Move a dragged file/folder into a destination directory.
  const moveInto = async (srcPath, destDir) => {
    if (!srcPath || !destDir) return
    const src = srcPath.replace(/\\/g, '/')
    const dest = destDir.replace(/\\/g, '/')
    // No-op if it's already in that folder; never move a folder into itself or
    // one of its own descendants.
    if (parentDir(src) === dest) return
    if (dest === src || dest.startsWith(src + '/')) return
    try {
      await window.api.rename(srcPath, join(destDir, baseName(srcPath)))
    } catch (e) {
      window.alert(isExistsError(e) ? t('err.nameExists') : (t('err.move') || 'Could not move: ') + e.message)
      return
    }
    await refreshParentOf(srcPath)
    if (childrenMap[destDir] !== undefined) await loadDir(destDir)
    setExpanded((s) => new Set(s).add(destDir))
  }

  // Drop handlers wired onto folder rows (and the root area).
  const dropProps = (destDir) => ({
    onDragOver: (e) => {
      if (!dragPathRef.current) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dragOver !== destDir) setDragOver(destDir)
    },
    onDragLeave: () => setDragOver((d) => (d === destDir ? null : d)),
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      const src = dragPathRef.current
      dragPathRef.current = null
      setDragOver(null)
      moveInto(src, destDir)
    }
  })

  const commitRename = async () => {
    if (!rename || committingRef.current) return
    const { path, value } = rename
    const clean = value.trim()
    setRename(null)
    if (!clean || clean === baseName(path)) return
    if (!isValidName(clean)) {
      window.alert((t('err.invalidName') || 'Invalid name: ') + clean)
      return
    }
    committingRef.current = true
    try {
      await window.api.rename(path, join(parentDir(path), clean))
      await refreshParentOf(path)
    } catch (e) {
      window.alert(isExistsError(e) ? t('err.nameExists') : (t('err.rename') || 'Could not rename: ') + e.message)
    } finally {
      committingRef.current = false
    }
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

  // Inline confirm (✓) / cancel (✗) buttons shown while creating or renaming.
  // onMouseDown preventDefault keeps the input focused so clicking a button
  // doesn't first fire the input's blur-to-commit.
  const editActions = (onConfirm, onCancel) => (
    <span className="tree-edit-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="tree-edit-btn confirm"
        title={t('edit.confirm')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onConfirm() }}
      >
        <Icon name="check" size={13} />
      </button>
      <button
        type="button"
        className="tree-edit-btn cancel"
        title={t('edit.cancel')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onCancel() }}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  )

  // Render the inline creation input
  const renderCreatingInput = (depth) => (
    <div className="tree-row creating-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chevron" />
      <Icon name={creating.type === 'file' ? 'file' : 'folder'} size={15} className="tree-icon" />
      <input
        className="tree-rename"
        autoFocus
        value={creating.value}
        onFocus={(e) => {
          // Preselect the name without its extension — once, on mount. (Doing
          // this in an effect keyed on `creating` reselected on every keystroke,
          // so each new character overwrote the last.)
          const dot = creating.value.lastIndexOf('.')
          if (dot > 0) e.target.setSelectionRange(0, dot)
          else e.target.select()
        }}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setCreating({ ...creating, value: e.target.value })}
        // Commit when focus leaves the input (clicking elsewhere), matching the
        // rename field — so a typed name is never silently lost.
        onBlur={commitCreate}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); commitCreate() }
          if (e.key === 'Escape') setCreating(null)
        }}
      />
      {editActions(commitCreate, () => setCreating(null))}
    </div>
  )

  const renderNode = (node, depth) => {
    const isDir = node.type === 'dir'
    const isOpen = expanded.has(node.path)
    const isActive = node.path === activePath
    const renaming = rename && rename.path === node.path
    const isDropTarget = isDir && dragOver === node.path
    return (
      <div key={node.path}>
        <div
          className={`tree-row${isActive ? ' active' : ''}${isDropTarget ? ' drag-over' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!renaming}
          onDragStart={(e) => {
            dragPathRef.current = node.path
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.path)
          }}
          onDragEnd={() => {
            dragPathRef.current = null
            setDragOver(null)
          }}
          {...(isDir ? dropProps(node.path) : {})}
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
            <>
              <input
                className="tree-rename"
                autoFocus
                value={rename.value}
                onFocus={(e) => {
                  // Preselect the name (without extension), like the new-file input.
                  const dot = rename.value.lastIndexOf('.')
                  if (dot > 0) e.target.setSelectionRange(0, dot)
                  else e.target.select()
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRename({ ...rename, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRename(null)
                }}
                onBlur={commitRename}
              />
              {editActions(commitRename, () => setRename(null))}
            </>
          ) : (
            <span className="tree-label">{node.name}</span>
          )}
        </div>
        {/* Inline creation input inside this directory */}
        {isDir && isOpen && creating && creating.dir === node.path && renderCreatingInput(depth + 1)}
        {isDir && isOpen && (childrenMap[node.path] || []).map((c) => renderNode(c, depth + 1))}
        {/* Expanded but nothing to show (the tree only lists Markdown/text and
            subfolders) — say so instead of looking like the click did nothing. */}
        {isDir && isOpen && childrenMap[node.path]?.length === 0 &&
          !(creating && creating.dir === node.path) && (
            <div className="tree-empty tree-empty-nested" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              {t('side.emptyFolder')}
            </div>
          )}
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
          {(() => {
            // Toggle: when everything's collapsed (only root open), expand all;
            // otherwise collapse back to just the root. Icon reflects the action.
            const collapsed = expanded.size <= 1
            return (
              <button
                title={collapsed ? t('side.expandAll') : t('side.collapseAll')}
                onClick={collapsed ? expandAll : () => setExpanded(new Set([workspace.rootPath]))}
              >
                <Icon name={collapsed ? 'expand' : 'collapse'} size={15} />
              </button>
            )
          })()}
        </div>
      </div>
      <div
        className={`tree${dragOver === workspace.rootPath ? ' drag-over-root' : ''}`}
        {...dropProps(workspace.rootPath)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }) }}
      >
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
          top: Math.min(menu.y, window.innerHeight - 340)
        }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { startNewFile(menu.node?.type === 'dir' ? menu.node : null); setMenu(null) }}>{t('side.ctxNewFile')}</button>
          <button onClick={() => { startNewFolder(menu.node?.type === 'dir' ? menu.node : null); setMenu(null) }}>{t('side.ctxNewFolder')}</button>
          {menu.node?.type === 'file' && onOpenRight && (
            <>
              <div className="menu-sep" />
              <button onClick={() => { onOpenRight(menu.node.path); setMenu(null) }}>{t('tab.openRight')}</button>
            </>
          )}
          {menu.node && <div className="menu-sep" />}
          {menu.node && <button onClick={() => { copyText(menu.node.path); setMenu(null) }}>{t('tab.copyPath')}</button>}
          {menu.node && <button onClick={() => { copyText(menu.node.name); setMenu(null) }}>{t('tab.copyName')}</button>}
          {menu.node && <button onClick={() => { window.api.showInFolder(menu.node.path); setMenu(null) }}>{t('side.reveal')}</button>}
          {menu.node && <div className="menu-sep" />}
          {menu.node && <button onClick={() => { setRename({ path: menu.node.path, value: menu.node.name }); setMenu(null) }}>{t('side.rename')}</button>}
          {menu.node?.type === 'file' && <button onClick={() => { doDuplicate(menu.node); setMenu(null) }}>{t('side.duplicate')}</button>}
          {menu.node?.type === 'file' && isMarkdownName(menu.node.name) && (
            <button onClick={() => { onExportPdf?.(menu.node.path); setMenu(null) }}>{t('side.exportPdf')}</button>
          )}
          {menu.node && <div className="menu-sep" />}
          {menu.node && <button className="danger" onClick={() => { doDelete(menu.node); setMenu(null) }}>{t('side.delete')}</button>}
        </div>
      )}
    </div>
  )
}
