import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import Sidebar from './Sidebar.jsx'

// The file pane: 工作区 above 云空间 (docs/cloud-sync-review.md, 云空间),
// like the collapsible sections of VS Code's explorer. Each is the same file
// tree with its own expanded folders; a folder can be in both (☁ in the
// workspace marks the ones in 云空间). A folded section is just its title
// and the other takes the height; with both open the line between them is
// dragged. Folds and the split are remembered (localStorage, per device).
// Without cloud sync (mobile) only the workspace tree is shown, as before.

const LAYOUT_KEY = 'horsemd.sidebarPanes.v1'
const DEFAULT_LAYOUT = { workspaceCollapsed: false, cloudCollapsed: false, cloudRatio: 0.38 }
const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null')
    if (!saved || typeof saved !== 'object') return DEFAULT_LAYOUT
    const ratio = Number(saved.cloudRatio)
    return {
      workspaceCollapsed: saved.workspaceCollapsed === true,
      cloudCollapsed: saved.cloudCollapsed === true,
      cloudRatio: Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : DEFAULT_LAYOUT.cloudRatio
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export default function SidebarPanes({
  cloudEnabled = false,
  // Every folder in cloud sync: [{ rootPath, connectionId, name }].
  cloudEntries = [],
  // syncSummary() of the bound folders (or null).
  syncStatus = null,
  onAddCloudFolder,
  onAddToWorkspace,
  onOpenSyncSettings,
  onStopSync,
  apiRef,
  ...shared
}) {
  const { t } = useI18n()
  const [layout, setLayout] = useState(loadLayout)
  const update = useCallback((patch) => {
    setLayout((current) => {
      const next = { ...current, ...patch }
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [])

  const cloudRoots = cloudEntries.map((entry) => entry.rootPath)
  const unconnected = cloudEntries.filter((entry) => !entry.connectionId).map((entry) => entry.rootPath)

  // F2 renames in the tree that has focus, else the first that shows the row.
  const workspaceApi = useRef(null)
  const cloudApi = useRef(null)
  useEffect(() => {
    if (!apiRef) return undefined
    apiRef.current = {
      startRename: (path) => {
        const focused = document.activeElement?.closest?.('.sidebar')?.dataset?.variant
        const order = focused === 'cloud' ? [cloudApi, workspaceApi] : [workspaceApi, cloudApi]
        return order.some((ref) => ref.current?.startRename(path))
      }
    }
    return () => { apiRef.current = null }
  }, [apiRef])

  // Drag the line between the sections (pointer capture: keeps tracking
  // outside the line, no stray text selection).
  const containerRef = useRef(null)
  const onSplitDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const box = containerRef.current?.getBoundingClientRect()
    if (!box?.height) return
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    document.body.classList.add('hm-row-resizing')
    const move = (e) => {
      const ratio = (box.bottom - e.clientY) / box.height
      setLayout((current) => ({ ...current, cloudRatio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) }))
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      document.body.classList.remove('hm-row-resizing')
      setLayout((current) => {
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(current)) } catch { /* private mode */ }
        return current
      })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  if (!cloudEnabled) return <Sidebar {...shared} apiRef={apiRef} cloudRootPaths={[]} />

  const workspaceOpen = !layout.workspaceCollapsed
  const cloudOpen = !layout.cloudCollapsed
  const bothOpen = workspaceOpen && cloudOpen
  // With no folder yet, 云空间 is one line (sized to its content).
  const cloudSized = bothOpen && cloudRoots.length > 0
  const status = syncStatus && (
    <button
      type="button"
      className={`sidebar-cloud-status ${syncStatus.state}`}
      title={syncStatus.title}
      onClick={() => onOpenSyncSettings?.()}
    >
      <Icon name={syncStatus.state === 'busy' ? 'refresh' : 'cloud'} size={12} />
      <span>{syncStatus.text}</span>
    </button>
  )

  return (
    <div
      ref={containerRef}
      className={`sidebar-panes${workspaceOpen ? '' : ' workspace-collapsed'}${cloudOpen ? '' : ' cloud-collapsed'}`}
    >
      <div className="sidebar-pane sidebar-pane-workspace">
        <Sidebar
          {...shared}
          apiRef={workspaceApi}
          variant="workspace"
          collapsible
          collapsed={!workspaceOpen}
          onToggleCollapsed={() => update({ workspaceCollapsed: workspaceOpen })}
          cloudRootPaths={cloudRoots}
        />
      </div>
      {bothOpen && cloudRoots.length > 0 && (
        <div
          className="sidebar-panes-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('cloud.resize')}
          onPointerDown={onSplitDown}
          onDoubleClick={() => update({ cloudRatio: DEFAULT_LAYOUT.cloudRatio })}
        />
      )}
      <div
        className="sidebar-pane sidebar-pane-cloud"
        style={cloudSized ? { flexBasis: `${(layout.cloudRatio * 100).toFixed(2)}%` } : undefined}
      >
        <Sidebar
          {...shared}
          syncFolderPaths={shared.syncFolderPaths}
          folderRoots={cloudRoots}
          apiRef={cloudApi}
          variant="cloud"
          collapsible
          collapsed={!cloudOpen}
          onToggleCollapsed={() => update({ cloudCollapsed: cloudOpen })}
          cloudRootPaths={cloudRoots}
          unconnectedPaths={unconnected}
          workspaceRootPaths={shared.folderRoots}
          headStatus={status}
          onAddCloudFolder={onAddCloudFolder}
          onAddToWorkspace={onAddToWorkspace}
          onOpenSyncSettings={onOpenSyncSettings}
          onStopSync={onStopSync}
          // Removing a 云空间 root from the workspace makes no sense here.
          onRemoveFolder={undefined}
        />
      </div>
    </div>
  )
}
