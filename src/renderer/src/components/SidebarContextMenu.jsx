import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

  // Rendered into <body>: inside the phone drawer (a transformed, clipped
  // ancestor) a fixed menu was positioned against the drawer and its right
  // part cut off (#175).
  const isPhone = window.api?.platform === 'ios' || window.api?.platform === 'android'
  return createPortal(
    <div
      ref={menuRef}
      className={`context-menu${isPhone ? ' hm-touch-menu' : ''}`}
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
      {isRoot && !cloudRoot && node.path !== window.api?.libraryRoot && (
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
      {/* A phone path (the app's sandbox, ext:<id>/…) is nothing a person can
          use; there a file is shared instead. */}
      {node && !isPhone && <button onClick={run(() => onCopyText(node.path))}>{t('tab.copyPath')}</button>}
      {node?.type === 'file' && isPhone && window.api.capabilities?.canShare && (
        <button onClick={run(() => window.api.shareFile?.(node.path))}>{t('status.shareShort')}</button>
      )}
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
    </div>,
    document.body
  )
}
