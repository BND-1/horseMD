import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { isMarkdownName } from '../paths.js'
import { copyToClipboard } from '../ui.js'

export default function Tabs({
  tabs,
  activeId,
  splitId,
  focusedPane,
  onActivate,
  onClose,
  onNew,
  onCloseOthers,
  onOpenRight,
  onRename,
  onDuplicate,
  onDelete,
  onExportPdf
}) {
  const { t } = useI18n()
  const activeRef = useRef(null)
  // Right-click context menu: { x, y, tab } in viewport coords, or null.
  const [menu, setMenu] = useState(null)

  // When the active tab changes (opened a new file, switched, or restored a
  // session), the tab strip may have scrolled it out of view once the tabs
  // overflow the window width. Pull it back into the visible range so the user
  // never has to hunt/scroll for the file they just opened. `inline: 'nearest'`
  // only scrolls when it's actually off-screen and never jumps vertically.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId, tabs.length])

  // Close the menu on Escape (clicks outside are handled by the backdrop).
  useEffect(() => {
    if (!menu) return
    const onKey = (e) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const copyPath = (tab) => {
    if (tab.path) copyToClipboard(tab.path, t('code.copied'))
  }
  const copyName = (tab) => copyToClipboard(tab.title || '', t('code.copied'))
  const reveal = (tab) => {
    if (tab.path) window.api.showInFolder(tab.path)
  }

  return (
    <div className="tabs">
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const dirty = tab.content !== tab.savedContent
          const isLeft = tab.id === activeId
          const isRight = splitId != null && tab.id === splitId
          // Both panes' tabs are highlighted in split view; the focused pane's tab
          // gets the stronger style (that's where a tab click lands).
          const isActive = isLeft || isRight
          const focused = isRight ? focusedPane === 'right' : isLeft ? focusedPane !== 'right' : false
          return (
            <div
              key={tab.id}
              ref={isLeft ? activeRef : null}
              className={`tab${isActive ? ' active' : ''}${isActive && !focused ? ' split-peer' : ''}`}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, tab })
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.id)
                }
              }}
              title={tab.path || tab.title}
            >
              <span className="tab-title">{tab.title}</span>
              <span
                className={`tab-close${dirty ? ' dirty' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
              >
                {dirty ? <span className="dot" /> : <Icon name="close" size={13} />}
              </span>
            </div>
          )
        })}
      </div>
      <button className="tab-new" title={t('tab.new')} onClick={onNew}>
        <Icon name="plus" size={16} />
      </button>

      {menu && (
        <>
          <div
            className="menu-backdrop"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="tab-ctxmenu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 220),
              top: Math.min(menu.y, window.innerHeight - 400)
            }}
          >
            {(() => {
              const tab = menu.tab
              const hasPath = !!tab.path
              const noPathTip = !hasPath ? t('tab.noPath') : undefined
              const run = (fn) => () => { fn(); setMenu(null) }
              return (
                <>
                  {window.api.capabilities?.splitView !== false && onOpenRight && tabs.length > 1 && (
                    <>
                      <button className="tab-menu-item" onClick={run(() => onOpenRight(tab.id))}>
                        {t('tab.openRight')}
                      </button>
                      <div className="tab-menu-sep" />
                    </>
                  )}
                  <button className="tab-menu-item" disabled={!hasPath} title={noPathTip} onClick={run(() => copyPath(tab))}>
                    {t('tab.copyPath')}
                  </button>
                  <button className="tab-menu-item" onClick={run(() => copyName(tab))}>
                    {t('tab.copyName')}
                  </button>
                  {window.api.capabilities?.revealInFolder !== false && (
                    <button className="tab-menu-item" disabled={!hasPath} title={noPathTip} onClick={run(() => reveal(tab))}>
                      {t('tab.reveal')}
                    </button>
                  )}
                  <div className="tab-menu-sep" />
                  <button className="tab-menu-item" disabled={!hasPath} title={noPathTip} onClick={run(() => onRename?.(tab.id))}>
                    {t('side.rename')}
                  </button>
                  <button className="tab-menu-item" disabled={!hasPath} title={noPathTip} onClick={run(() => onDuplicate?.(tab.id))}>
                    {t('side.duplicate')}
                  </button>
                  {window.api.capabilities?.pdfExport !== false && hasPath && isMarkdownName(tab.title) && (
                    <button className="tab-menu-item" onClick={run(() => onExportPdf?.(tab.path))}>
                      {t('side.exportPdf')}
                    </button>
                  )}
                  <div className="tab-menu-sep" />
                  <button className="tab-menu-item" onClick={run(() => onClose(tab.id))}>
                    {t('tab.close')}
                  </button>
                  {onCloseOthers && tabs.length > 1 && (
                    <button className="tab-menu-item" onClick={run(() => onCloseOthers(tab.id))}>
                      {t('tab.closeOthers')}
                    </button>
                  )}
                  {onDelete && (
                    <button className="tab-menu-item danger" disabled={!hasPath} title={noPathTip} onClick={run(() => onDelete(tab.id))}>
                      {t('side.delete')}
                    </button>
                  )}
                </>
              )
            })()}
          </div>
        </>
      )}
    </div>
  )
}
