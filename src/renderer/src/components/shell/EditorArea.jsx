// Editor area — the flex row holding the active (left) and split (right) editor
// panes, plus the heavy-doc banner and the split divider/close. Extracted
// verbatim in behavior from App.jsx (phase-2 refactor, US-7).
//
// INVARIANTS preserved exactly (see docs/refactor-plan.md §2):
//   - Lazy mount: a Crepe editor is created only for tabs in view OR already in
//     mountedIds; the rest stay display:none-but-mounted.
//   - Uncontrolled textarea: defaultValue + liveContentRef/liveTimersRef/commitLive
//     (no per-keystroke value re-set).
//   - Split: panes are flex siblings; visibility is display/order, NO re-parenting.
import Editor from '../Editor.jsx'
import { Icon } from '../icons.jsx'
import { isPlainTextDoc } from '../../paths.js'
import { attachSourceCaret } from '../editor-source-caret.js'

export default function EditorArea({
  tabs,
  activeId,
  splitId,
  split,
  splitRatio,
  focusedPane,
  home,
  sourceMode,
  richForced,
  mountedIds,
  activeTab,
  imageUploadCommand,
  spellcheck,
  editorAreaRef,
  editorHostRef,
  editorHosts,
  sourceRef,
  sourceTextareas,
  sourceEditedIds,
  liveContentRef,
  liveTimersRef,
  commitLive,
  editorApis,
  activeIdRef,
  focusedTabRef,
  setRichForced,
  setSplitId,
  setFocusedPane,
  setActiveBlock,
  setRichDocVersion,
  setRichLoading,
  startSplitDrag,
  updateContent,
  t
}) {
  return (
    <div
      ref={editorAreaRef}
      className={`editor-area${split ? ' is-split' : ''}`}
      style={{ display: home || !activeTab || activeTab?.kind === 'settings' ? 'none' : undefined }}
    >
      {tabs.map((tab) => {
        // Settings tabs aren't documents — never mount an editor for them.
        // SettingsView (a sibling in App.jsx) renders instead.
        if (tab.kind === 'settings') return null
        // Which pane (if any) this tab occupies. `split` already excludes
        // home and the case where the two ids are equal.
        const isLeft = !home && tab.id === activeId
        const isRight = split && tab.id === splitId
        const inView = isLeft || isRight
        // Flex order: left pane (1) · divider (2) · right pane (3).
        // Irrelevant for hidden tabs (display:none removes them from layout).
        const order = isRight ? 3 : 1
        // Mark the focused pane (only meaningful while split) so the user
        // can see which pane a tab click will load into.
        const isFocusedPane = split && ((isRight && focusedPane === 'right') || (isLeft && focusedPane === 'left'))
        const paneClass =
          (isRight ? ' hm-pane-right' : isLeft ? ' hm-pane-left' : '') + (isFocusedPane ? ' hm-focused' : '')
        const onPaneFocus = () => {
          focusedTabRef.current = tab.id
          if (split) setFocusedPane(isRight ? 'right' : 'left')
        }
        // In split view the left pane holds a fixed fraction; the right pane
        // grows to fill the rest. Outside split, panes fill the row.
        const paneFlex = split && isLeft ? `0 0 calc(${(splitRatio * 100).toFixed(2)}% - 3px)` : undefined

        // Plain-text docs always use the textarea; "heavy" Markdown docs do
        // too until the user opts into rich (avoids a multi-second freeze).
        // In global source mode the active Markdown pane shows a textarea too,
        // but its already-mounted Crepe editor stays mounted underneath. That
        // avoids a full re-parse/image reload when switching back to rich.
        const heavyAsSource = tab.heavy && !richForced.has(tab.id)
        const plainText = isPlainTextDoc(tab)
        const sourceForActiveRich = sourceMode && isLeft && !plainText && !heavyAsSource
        const usesTextarea = plainText || heavyAsSource || sourceForActiveRich
        // content-visibility virtualization (see .hm-cv in app.css) kicks in
        // only for genuinely large RICH documents — small docs and the
        // textarea path are untouched. ~20k chars ≈ hundreds of blocks,
        // the range where software-composited scrolling starts to struggle.
        const richEligible = !plainText && !heavyAsSource
        const largeRich = richEligible && (tab.content?.length || 0) >= 20000
        const nodes = []

        if (usesTextarea && inView) {
          const setSourceTextareaRef = (el) => {
            if (el) {
              sourceTextareas.current[tab.id] = el
              if (isLeft) sourceRef.current = el
              if (!el.__horsemdSourceCaretCleanup) {
                el.__horsemdSourceCaretCleanup = attachSourceCaret(el)
              }
              if (el.__horsemdSourceBaseline == null) el.__horsemdSourceBaseline = el.value || ''
              if (el.__horsemdSourceSelectionBaseline == null) {
                el.__horsemdSourceSelectionBaseline = `${el.selectionStart || 0}:${el.selectionEnd || 0}`
              }
              if (el.__horsemdSourceViewportMoved == null) el.__horsemdSourceViewportMoved = false
              return
            }
            const existing = sourceTextareas.current[tab.id]
            existing?.__horsemdSourceCaretCleanup?.()
            if (existing) delete existing.__horsemdSourceCaretCleanup
            delete sourceTextareas.current[tab.id]
            if (isLeft && (!existing || sourceRef.current === existing)) sourceRef.current = null
          }
          nodes.push(
            <textarea
              key={`source:${tab.id}:${tab.reloadNonce}`}
              ref={setSourceTextareaRef}
              className={`source-editor${paneClass}`}
              defaultValue={liveContentRef.current.get(tab.id) ?? tab.content}
              spellCheck={false}
              style={{ order, flex: paneFlex }}
              onFocus={onPaneFocus}
              onMouseDown={(e) => {
                onPaneFocus()
              }}
              onMouseUp={(e) => {
                e.currentTarget.__horsemdSourceSelectionUser = true
                e.currentTarget.__horsemdSourceViewportMoved = false
                e.currentTarget.__horsemdSourceSelectionAt = performance.now()
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
                const textarea = e.currentTarget
                const beforeScrollTop = textarea.scrollTop
                let attempts = 0
                const restoreUnexpectedEnterScroll = () => {
                  if (!textarea.isConnected) return
                  if (Math.abs(textarea.scrollTop - beforeScrollTop) > 50) {
                    textarea.scrollTop = beforeScrollTop
                  }
                  attempts += 1
                  if (attempts < 3) requestAnimationFrame(restoreUnexpectedEnterScroll)
                }
                requestAnimationFrame(restoreUnexpectedEnterScroll)
              }}
              onKeyUp={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                  e.currentTarget.__horsemdSourceSelectionUser = true
                  e.currentTarget.__horsemdSourceViewportMoved = false
                  e.currentTarget.__horsemdSourceSelectionAt = performance.now()
                }
              }}
              onSelect={(e) => {
                e.currentTarget.__horsemdSourceSelectionUser = true
                e.currentTarget.__horsemdSourceViewportMoved = false
                e.currentTarget.__horsemdSourceSelectionAt = performance.now()
              }}
              onScroll={(e) => {
                const selectedAt = e.currentTarget.__horsemdSourceSelectionAt || 0
                if (performance.now() - selectedAt > 250) e.currentTarget.__horsemdSourceViewportMoved = true
              }}
              onChange={(e) => {
                // Uncontrolled: stash the edit and debounce-commit it, so
                // typing never re-renders App or re-sets a multi-MB value per
                // keystroke. commitAllLive() flushes before save/close/etc.
                e.target.__horsemdSourceSelectionUser = true
                e.target.__horsemdSourceViewportMoved = false
                e.target.__horsemdSourceSelectionAt = performance.now()
                sourceEditedIds.current.add(tab.id)
                const v = e.target.value
                liveContentRef.current.set(tab.id, v)
                const prev = liveTimersRef.current.get(tab.id)
                if (prev) clearTimeout(prev)
                liveTimersRef.current.set(tab.id, setTimeout(() => commitLive(tab.id), 400))
              }}
            />
          )
        }
        // Lazy mount: don't create a Crepe editor for a tab the user hasn't
        // opened yet (keeps session-restore of many tabs fast). Panes in
        // view always mount; visited tabs stay mounted.
        if (richEligible && (inView || mountedIds.has(tab.id))) {
          const setEditorHost = (el) => {
            if (el) {
              editorHosts.current[tab.id] = el
              if (isLeft) editorHostRef.current = el
              return
            }
            const existing = editorHosts.current[tab.id]
            delete editorHosts.current[tab.id]
            if (isLeft && (!existing || editorHostRef.current === existing)) editorHostRef.current = null
          }
          nodes.push(
            <div
              // Include reloadNonce so an external-edit reload remounts the
              // Crepe editor with the new content (the create effect only
              // runs on mount). tab switches keep the same key → stay mounted.
              key={`rich:${tab.id}:${tab.reloadNonce}`}
              className={`editor-scroll${paneClass}${largeRich ? ' hm-cv' : ''}`}
              ref={setEditorHost}
              style={{ display: inView && !sourceForActiveRich ? undefined : 'none', order, flex: paneFlex }}
              onFocusCapture={onPaneFocus}
              onMouseDownCapture={onPaneFocus}
            >
              <Editor
                tabId={`${tab.id}:${tab.reloadNonce}`}
                initialContent={tab.content}
                docPath={tab.path}
                imageUploadCommand={imageUploadCommand}
                spellcheck={spellcheck}
                onChange={(md, isInitial) => updateContent(tab.id, md, isInitial)}
                onReady={(api) => {
                  editorApis.current[tab.id] = api
                }}
                onActiveBlock={(id) => {
                  if (tab.id === activeIdRef.current) setActiveBlock(id)
                }}
                onStructureChange={() => setRichDocVersion((v) => v + 1)}
                onLoadingChange={setRichLoading}
              />
            </div>
          )
        }

        return nodes.length ? nodes : null
      })}

      {/* Heavy-doc notice: this Markdown file is shown as plain source to
          stay responsive; offer a one-click switch to the rich editor. */}
      {!home && activeTab && activeTab.heavy && !richForced.has(activeTab.id) && (
        <div className="hm-heavy-banner">
          <span>{t('heavy.notice')}</span>
          <button onClick={() => setRichForced((s) => new Set(s).add(activeTab.id))}>
            {t('heavy.loadRich')}
          </button>
        </div>
      )}

      {split && (
        <div
          className="hm-split-divider"
          style={{ order: 2 }}
          onMouseDown={startSplitDrag}
          title={t('split.drag')}
        />
      )}

      {split && (
        <button className="hm-split-close" title={t('split.close')} onClick={() => setSplitId(null)}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  )
}
