import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { displayPath, isMarkdownName } from '../paths.js'
import { copyToClipboard } from '../ui.js'
import { labelWithShortcut } from '../lib/commands/shortcut-labels.js'
import ExportContextSubmenu from './ExportContextSubmenu.jsx'
import { isTabDirty } from '../lib/tab-state.js'
import { TAB_DRAG_TYPE, hasTabDrag, tabStripScreenRect } from '../lib/tab-transfer.js'

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
  onExportPdf,
  onExportHtml,
  onExportPandoc,
  onShowHistory,
  onReorder,
  effectiveKeybindings,
  // Multi-window (tab tear-off). `onBuildTransfer(id)` → the tab's payload
  // (null = it cannot move now); `onTransferred(id)` drops it here after
  // main moved it to another window. Absent on mobile / older preloads.
  onBuildTransfer,
  onTransferred,
  onMoveToNewWindow,
  onMoveToMain,
  isSecondary = false
}) {
  const { t } = useI18n()
  const activeRef = useRef(null)
  // Right-click context menu: { x, y, tab } in viewport coords, or null.
  const [menu, setMenu] = useState(null)
  // Tab drag-reorder (#31). dragIndexRef holds the source index during a drag;
  // dragOverIndex drives the visual insertion indicator (the tab being hovered).
  const dragIndexRef = useRef(null)
  const [dragOverIndex, setDragOverIndex] = useState(-1)
  // The tab being dragged OUT of this window: { tabId, token: Promise }. The
  // token comes from main (tab:dragStart); dragend reports where it ended.
  const dragSessionRef = useRef(null)
  const canTearOff = window.api.platform !== 'ios' && window.api.platform !== 'android' && !!onBuildTransfer && !!onTransferred &&
    !!window.api?.tabDragStart && !!window.api?.tabDragEnd
  // A tab of ANOTHER window dragged over this strip (no local drag index).
  const isForeignTabDrag = (e) => dragIndexRef.current === null && hasTabDrag(e)
  const dropForeignTab = (e, index) => {
    e.preventDefault()
    setDragOverIndex(-1)
    let key = ''
    try { key = e.dataTransfer.getData(TAB_DRAG_TYPE) } catch { key = '' }
    window.api?.tabDropIndex?.(key || null, index)
  }
  // On touch there's no hover to reveal the close ✕, so show it always and use a
  // clear ✕ (the unsaved state is shown in the bottom bar, not as a tab dot).
  const isMobile = window.api.platform === 'ios' || window.api.platform === 'android'
  const scrollRef = useRef(null)

  // A plain wheel over the tab strip scrolls it horizontally: trackpads send a
  // vertical delta (Shift+wheel is the OS-level escape hatch, but the strip is
  // itself horizontal, so steering the wheel at it should just work). Only
  // intercept when the strip can actually scroll that way, so a wheel over the
  // tabs keeps scrolling the document when the strip is fully expanded.
  useEffect(() => {
    const strip = scrollRef.current
    if (!strip) return
    const onWheel = (event) => {
      if (event.defaultPrevented || event.ctrlKey) return
      const canScroll = strip.scrollWidth > strip.clientWidth
      const wheelX = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!canScroll || wheelX) return
      strip.scrollLeft += event.deltaY
      event.preventDefault()
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])

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
      <div
        className="tabs-scroll"
        ref={scrollRef}
        // The strip's empty part after the last tab: a tab from another window
        // dropped there is appended (marker on the last tab's right edge).
        onDragOver={(e) => {
          if (e.target.closest?.('.tab') || !isForeignTabDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (dragOverIndex !== tabs.length) setDragOverIndex(tabs.length)
        }}
        onDragLeave={(e) => {
          if (dragOverIndex === tabs.length && !e.currentTarget.contains(e.relatedTarget)) setDragOverIndex(-1)
        }}
        onDrop={(e) => {
          if (e.target.closest?.('.tab') || !isForeignTabDrag(e)) return
          dropForeignTab(e, tabs.length)
        }}
      >
        {tabs.map((tab, index) => {
          const dirty = isTabDirty(tab)
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
              className={`tab${isActive ? ' active' : ''}${isActive && !focused ? ' split-peer' : ''}${dragOverIndex === index ? ' drag-over' : ''}${dragOverIndex === tabs.length && index === tabs.length - 1 ? ' drag-over-after' : ''}`}
              draggable={!!onReorder && !isMobile}
              onDragStart={(e) => {
                if (e.target.closest('.tab-close')) { e.preventDefault(); return }
                dragIndexRef.current = index
                dragSessionRef.current = null
                e.dataTransfer.effectAllowed = 'move'
                // Tear-off (multi-window): ONLY the custom type — never text in
                // text/plain, which an editor drop would type into a document.
                // The value is a drag key another window hands back to main on
                // drop (tab:dropIndex); main's token arrives asynchronously.
                const payload = canTearOff && tab.kind !== 'settings' ? onBuildTransfer(tab.id) : null
                if (payload) {
                  const key = `${window.api.windowId ?? 'w'}:${tab.id}:${Date.now()}`
                  e.dataTransfer.setData(TAB_DRAG_TYPE, key)
                  let token = null
                  try {
                    token = Promise.resolve(window.api.tabDragStart({ ...payload, dragId: key }))
                      .then((r) => (typeof r === 'string' ? r : r?.token || null))
                      .catch(() => null)
                  } catch {
                    token = null
                  }
                  dragSessionRef.current = { tabId: tab.id, token }
                } else {
                  e.dataTransfer.setData('text/plain', '') // Firefox requires data
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                const foreign = isForeignTabDrag(e)
                if (foreign) e.dataTransfer.dropEffect = 'move'
                if ((dragIndexRef.current !== null || foreign) && dragOverIndex !== index) setDragOverIndex(index)
              }}
              onDragLeave={() => { if (dragOverIndex === index) setDragOverIndex(-1) }}
              onDrop={(e) => {
                if (isForeignTabDrag(e)) {
                  // Another window's tab: insert before this one.
                  dropForeignTab(e, index)
                  return
                }
                e.preventDefault()
                if (dragIndexRef.current !== null && onReorder) onReorder(dragIndexRef.current, index)
                dragIndexRef.current = null
                setDragOverIndex(-1)
              }}
              onDragEnd={(e) => {
                dragIndexRef.current = null
                setDragOverIndex(-1)
                const session = dragSessionRef.current
                dragSessionRef.current = null
                if (!session?.token) return
                // Main decides from the cursor where the drag ended: on this
                // strip (nothing), on another window (moved there) or anywhere
                // else (torn off into a new window).
                const stripRect = tabStripScreenRect(e.currentTarget.closest('.topbar') || e.currentTarget.closest('.tabs'))
                const tabCount = tabs.length
                session.token
                  .then((token) => (token ? window.api.tabDragEnd(token, { stripRect, tabCount }) : null))
                  .then((res) => {
                    const result = typeof res === 'string' ? res : res?.result
                    if (result === 'moved' || result === 'torn') onTransferred(session.tabId)
                  })
                  .catch(() => {})
              }}
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
              title={displayPath(tab.path) || tab.title}
            >
              <span className="tab-title">{tab.title}</span>
              <span
                className={`tab-close${dirty ? ' dirty' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
              >
                {dirty && !isMobile ? <span className="dot" /> : <Icon name="close" size={13} />}
              </span>
            </div>
          )
        })}
      </div>
      <button className="tab-new" title={labelWithShortcut(t('tab.new'), 'file.new', effectiveKeybindings)} onClick={onNew}>
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
            role="menu"
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
              // Multi-window: a secondary keeps at least one tab (dragging the
              // last one moves the window); the main window may empty itself.
              const canMoveOut = !isMobile && tab.kind !== 'settings' && !!onMoveToNewWindow &&
                !!window.api?.moveTabToNewWindow && (isSecondary ? tabs.length >= 2 : tabs.length >= 1)
              const canMoveToMain = !isMobile && isSecondary && tab.kind !== 'settings' && !!onMoveToMain &&
                !!window.api?.moveTabToMain
              return (
                <>
                  {(canMoveOut || canMoveToMain) && (
                    <>
                      {canMoveOut && (
                        <button className="tab-menu-item" onClick={run(() => onMoveToNewWindow(tab.id))}>
                          {t('tab.moveToNewWindow')}
                        </button>
                      )}
                      {canMoveToMain && (
                        <button className="tab-menu-item" onClick={run(() => onMoveToMain(tab.id))}>
                          {t('tab.moveToMain')}
                        </button>
                      )}
                      <div className="tab-menu-sep" />
                    </>
                  )}
                  {window.api.capabilities?.splitView !== false && onOpenRight && tabs.length > 1 && (
                    <>
                      <button className="tab-menu-item" onClick={run(() => onOpenRight(tab.id))}>
                        {t('tab.openRight')}
                      </button>
                      <div className="tab-menu-sep" />
                    </>
                  )}
                  {/* A phone path (sandbox, ext:<id>/…) is nothing a person can
                      use: share the file there instead. */}
                  {!isMobile && (
                    <button className="tab-menu-item" disabled={!hasPath} title={noPathTip} onClick={run(() => copyPath(tab))}>
                      {t('tab.copyPath')}
                    </button>
                  )}
                  {isMobile && hasPath && window.api.capabilities?.canShare && (
                    <button className="tab-menu-item" onClick={run(() => window.api.shareFile?.(tab.path))}>
                      {t('status.shareShort')}
                    </button>
                  )}
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
                  {onShowHistory && tab.kind !== 'settings' && (
                    <button className="tab-menu-item" disabled={!hasPath} title={noPathTip} onClick={run(() => onShowHistory(tab.path))}>
                      {t('cmd.fileHistory')}
                    </button>
                  )}
                  {hasPath && isMarkdownName(tab.title) && (
                    <ExportContextSubmenu
                      t={t}
                      itemClassName="tab-menu-item"
                      onClose={() => setMenu(null)}
                      onExportPdf={onExportPdf ? () => onExportPdf(tab.path) : undefined}
                      onExportHtml={onExportHtml ? () => onExportHtml(tab.path) : undefined}
                      onExportPandoc={onExportPandoc ? (format) => onExportPandoc(tab.path, format) : undefined}
                    />
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
