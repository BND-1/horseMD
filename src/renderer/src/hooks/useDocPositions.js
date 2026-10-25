// Captures the caret + viewport of every mounted document so a later open
// (session restore or a manual open) can return the user to the same spot in a
// long file instead of the top (issue #111). Persists through
// lib/doc-positions.js, keyed by path and validated against content length.
import { useCallback, useEffect, useRef } from 'react'
import { flushDocPositionSave, queueDocPositionSave } from '../lib/doc-positions.js'

export function useDocPositions({ tabsRef, activeId, editorApis, sourceTextareas, editorHosts }) {
  // `onlyIds`: save just these tabs. A tab switch passes the tab being left —
  // the others have not moved since they were left, and each save maps the
  // caret through the document's Markdown blocks.
  const saveAllPositions = useCallback((onlyIds = null) => {
    const positions = {}
    for (const tab of tabsRef.current) {
      if (onlyIds && !onlyIds.includes(tab.id)) continue
      if (tab.kind === 'settings' || !tab.path) continue
      const api = editorApis.current[tab.id]
      const textarea = sourceTextareas.current[tab.id]
      let offset = null
      if (api?.markdownOffsetFromSelection || api?.markdownOffsetFromViewportTop) {
        try {
          const caret = api.markdownOffsetFromSelection?.() ?? null
          const viewport = api.markdownOffsetFromViewportTop?.() ?? null
          // A mounted-but-hidden editor keeps its ProseMirror selection, so the
          // caret is still readable after a tab switch; the viewport top is the
          // fallback for pure reading scrolls where the caret never moved.
          offset = Number.isFinite(caret) && caret > 0
            ? caret
            : Number.isFinite(viewport) ? viewport : (Number.isFinite(caret) ? caret : null)
        } catch {
          offset = null
        }
      } else if (textarea) {
        offset = textarea.selectionStart ?? 0
      }
      if (offset == null) continue
      const scroller = editorHosts.current[tab.id]
      const scrollTop = scroller ? scroller.scrollTop : null
      positions[tab.path.replace(/\\/g, '/')] = {
        offset,
        len: (tab.content || '').length,
        scrollTop: scrollTop || (textarea ? textarea.scrollTop || null : null)
      }
    }
    queueDocPositionSave(positions)
  }, [tabsRef, editorApis, sourceTextareas, editorHosts])

  // Persist when the active tab changes; the leaving tab's editor is still
  // mounted and readable at that point (hidden panes keep their PM selection).
  // The save runs when idle, not inside the click that switched tabs: the left
  // tab is hidden and its selection does not change meanwhile, and the switch
  // should paint first. A pending save is flushed before the next one.
  const lastActiveId = useRef(activeId)
  const pendingSave = useRef(null)
  const flushPendingSave = useCallback(() => {
    const pending = pendingSave.current
    if (!pending) return
    pendingSave.current = null
    pending.cancel()
    saveAllPositions([pending.id])
  }, [saveAllPositions])
  useEffect(() => {
    if (lastActiveId.current !== activeId) {
      flushPendingSave()
      const id = lastActiveId.current
      lastActiveId.current = activeId
      if (id) {
        const run = () => {
          if (pendingSave.current?.id !== id) return
          pendingSave.current = null
          saveAllPositions([id])
        }
        const idle = typeof window.requestIdleCallback === 'function'
        const handle = idle ? window.requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 300)
        pendingSave.current = {
          id,
          cancel: () => (idle ? window.cancelIdleCallback(handle) : clearTimeout(handle))
        }
      }
    }
  }, [activeId, saveAllPositions, flushPendingSave])

  // Flush the last edits/positions synchronously when the window closes.
  useEffect(() => {
    const flush = () => {
      if (pendingSave.current) { pendingSave.current.cancel(); pendingSave.current = null }
      saveAllPositions()
      flushDocPositionSave()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [saveAllPositions])

  return { saveAllPositions }
}
