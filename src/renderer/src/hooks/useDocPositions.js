// Captures the caret + viewport of every mounted document so a later open
// (session restore or a manual open) can return the user to the same spot in a
// long file instead of the top (issue #111). Persists through
// lib/doc-positions.js, keyed by path and validated against content length.
import { useCallback, useEffect, useRef } from 'react'
import { flushDocPositionSave, queueDocPositionSave } from '../lib/doc-positions.js'

export function useDocPositions({ tabsRef, activeId, editorApis, sourceTextareas, editorHosts }) {
  const saveAllPositions = useCallback(() => {
    const positions = {}
    for (const tab of tabsRef.current) {
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
  const lastActiveId = useRef(activeId)
  useEffect(() => {
    if (lastActiveId.current !== activeId) {
      saveAllPositions()
      lastActiveId.current = activeId
    }
  }, [activeId, saveAllPositions])

  // Flush the last edits/positions synchronously when the window closes.
  useEffect(() => {
    const flush = () => {
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
