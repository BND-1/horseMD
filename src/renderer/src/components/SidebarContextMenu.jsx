import { useLayoutEffect, useRef, useState } from 'react'
import { isMarkdownName } from '../paths.js'
import { clampFloatingRect } from '../lib/menuPosition.js'
import ExportContextSubmenu from './ExportContextSubmenu.jsx'

export default function SidebarContextMenu({
  menu,
  t,
  onClose,
  onNewFile,
  onNewFolder,
  onAddFolder,
  onOpenRight,
  onRemoveFolder,
  onEnableSyncFolder,
  onCopyText,
  onRename,
  onDuplicate,
  onExportPdf,
  onExportHtml,
  onExportPandoc,
  onShowHistory,
  onDelete,
  // 云空间 roots: add the folder to the workspace, open its sync settings,
  // stop syncing it (= remove it from 云空间; asks first, deletes nothing).
  onAddToWorkspace,
  onOpenSyncSettings,
  onStopSync
}) {
  const menuRef = useRef(null)
  const [position, setPosition] = useState(() => ({ left: menu?.x || 0, top: menu?.y || 0 }))

  useLayoutEffect(() => {
    if (!menu) return undefined
    const place = () => {
      const element = menuRef.current
      if (!element) return
      setPosition(clampFloatingRect({
        x: menu.x,
        y: menu.y,
        // Layout dimensions are stable during the scale-in animation;
        // getBoundingClientRect() would briefly under-report the menu size.
        width: element.offsetWidth,
        height: element.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      }))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menu])

  if (!menu) return null
  const { node, isRoot, syncRootPath, syncRootRegistered, variant, inWorkspace } = menu
  const cloudRoot = variant === 'cloud' && isRoot
  const run = (action) => () => {
    action?.()
    onClose()
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      style={position}
      onClick={(event) => event.stopPropagation()}
    >
      <button onClick={run(() => onNewFile(node?.type === 'dir' ? node : null))}>{t('side.ctxNewFile')}</button>
      <button onClick={run(() => onNewFolder(node?.type === 'dir' ? node : null))}>{t('side.ctxNewFolder')}</button>
      {!node && variant !== 'cloud' && (
        <>
          <div className="menu-sep" />
          <button onClick={run(onAddFolder)}>{t('workspace.addFolder')}</button>
        </>
      )}
      {node?.type === 'file' && onOpenRight && (
        <>
          <div className="menu-sep" />
          <button onClick={run(() => onOpenRight(node.path))}>{t('tab.openRight')}</button>
        </>
      )}
      {cloudRoot && (
        <>
          <div className="menu-sep" />
          {!inWorkspace && onAddToWorkspace && <button onClick={run(() => onAddToWorkspace(node.path))}>{t('cloud.addToWorkspace')}</button>}
          {onOpenSyncSettings && <button onClick={run(() => onOpenSyncSettings(node.path))}>{t('cloud.syncSettings')}</button>}
          {onStopSync && <button className="danger" onClick={run(() => onStopSync(node.path))}>{t('cloud.stopSync')}</button>}
        </>
      )}
      {isRoot && !cloudRoot && (
        <>
          <div className="menu-sep" />
          <button className="danger" onClick={run(() => onRemoveFolder?.(node.path))}>
            {t('workspace.removeFolder')}
          </button>
        </>
      )}
      {syncRootPath && (
        <>
          <div className="menu-sep" />
          {syncRootRegistered ? (
            <button type="button" disabled>{t('sync.addedFromSidebar')}</button>
          ) : (
            <button onClick={run(() => onEnableSyncFolder?.(syncRootPath))}>{t('sync.addFromSidebar')}</button>
          )}
        </>
      )}
      {node && <div className="menu-sep" />}
      {node && <button onClick={run(() => onCopyText(node.path))}>{t('tab.copyPath')}</button>}
      {node && <button onClick={run(() => onCopyText(node.name))}>{t('tab.copyName')}</button>}
      {node && window.api.capabilities?.revealInFolder !== false && (
        <button onClick={run(() => window.api.showInFolder(node.path))}>{t('side.reveal')}</button>
      )}
      {node && !isRoot && <div className="menu-sep" />}
      {node && !isRoot && <button onClick={run(() => onRename(node))}>{t('side.rename')}</button>}
      {node?.type === 'file' && <button onClick={run(() => onDuplicate(node))}>{t('side.duplicate')}</button>}
      {node?.type === 'file' && onShowHistory && (
        <button onClick={run(() => onShowHistory(node.path))}>{t('cmd.fileHistory')}</button>
      )}
      {node?.type === 'file' && isMarkdownName(node.name) && (
        <ExportContextSubmenu
          t={t}
          onClose={onClose}
          onExportPdf={onExportPdf ? () => onExportPdf(node.path) : undefined}
          onExportHtml={onExportHtml ? () => onExportHtml(node.path) : undefined}
          onExportPandoc={onExportPandoc ? (format) => onExportPandoc(node.path, format) : undefined}
        />
      )}
      {node && !isRoot && <div className="menu-sep" />}
      {node && !isRoot && <button className="danger" onClick={run(() => onDelete(node))}>{t('side.delete')}</button>}
    </div>
  )
}
