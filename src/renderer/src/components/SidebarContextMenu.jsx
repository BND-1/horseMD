import { isMarkdownName } from '../paths.js'

export default function SidebarContextMenu({
  menu,
  t,
  onClose,
  onNewFile,
  onNewFolder,
  onAddFolder,
  onOpenRight,
  onRemoveFolder,
  onCopyText,
  onRename,
  onDuplicate,
  onExportPdf,
  onDelete
}) {
  if (!menu) return null
  const { node, isRoot } = menu
  const run = (action) => () => {
    action?.()
    onClose()
  }

  return (
    <div
      className="context-menu"
      style={{
        left: Math.min(menu.x, window.innerWidth - 210),
        top: Math.min(menu.y, window.innerHeight - 340)
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button onClick={run(() => onNewFile(node?.type === 'dir' ? node : null))}>{t('side.ctxNewFile')}</button>
      <button onClick={run(() => onNewFolder(node?.type === 'dir' ? node : null))}>{t('side.ctxNewFolder')}</button>
      {!node && (
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
      {isRoot && (
        <>
          <div className="menu-sep" />
          <button className="danger" onClick={run(() => onRemoveFolder?.(node.path))}>
            {t('workspace.removeFolder')}
          </button>
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
      {node?.type === 'file' && isMarkdownName(node.name) && window.api.capabilities?.pdfExport !== false && (
        <button onClick={run(() => onExportPdf?.(node.path))}>{t('side.exportPdf')}</button>
      )}
      {node && !isRoot && <div className="menu-sep" />}
      {node && !isRoot && <button className="danger" onClick={run(() => onDelete(node))}>{t('side.delete')}</button>}
    </div>
  )
}
