import { useCallback, useEffect, useRef, useState } from 'react'
import { getTextareaSourceValue, setTextareaSourceValue } from '../source-text-fidelity.js'

const PREVIEW_DELAY = 180

// Coordinates the one document shown as source + rich text in split preview.
// It deliberately owns only cross-surface synchronization. Saving, source-byte
// preservation, editor lifecycle, and normal rich/source switching keep their
// existing owners. A monotonically increasing revision makes stale debounce
// callbacks harmless, which is essential when source typing and rich edits
// happen close together.
export function useSplitSourceRichSync({
  enabled,
  activeId,
  tabs,
  tabsRef,
  setTabs,
  editorApis,
  sourceTextareas,
  sourceEditedIds,
  liveContentRef,
  liveTimersRef,
  commitLive
}) {
  const enabledRef = useRef(enabled)
  const activeIdRef = useRef(activeId)
  enabledRef.current = enabled
  activeIdRef.current = activeId

  const statesRef = useRef(new Map())
  const [previewState, setPreviewState] = useState('idle')

  const isEnabledFor = useCallback((id) => enabledRef.current && activeIdRef.current === id, [])

  const stateFor = useCallback((id) => {
    let state = statesRef.current.get(id)
    if (!state) {
      state = { revision: 0, timer: 0, composing: false }
      statesRef.current.set(id, state)
    }
    return state
  }, [])

  const clearTimer = useCallback((id) => {
    const state = statesRef.current.get(id)
    if (!state?.timer) return
    clearTimeout(state.timer)
    state.timer = 0
  }, [])

  const commitTabContent = useCallback((id, content) => {
    const current = tabsRef.current.find((tab) => tab.id === id)
    if (!current || current.content === content) return
    const apply = (items) => items.map((tab) => tab.id === id ? { ...tab, content } : tab)
    tabsRef.current = apply(tabsRef.current)
    setTabs(apply)
  }, [setTabs, tabsRef])

  const syncSourceToRich = useCallback((id, revision) => {
    const state = statesRef.current.get(id)
    if (!state || state.revision !== revision || !isEnabledFor(id)) return
    state.timer = 0
    if (state.composing) return

    const sourceEl = sourceTextareas.current[id]
    const source = getTextareaSourceValue(sourceEl)
    // Commit before replacing the rich projection. Save/close can happen while
    // Crepe is parsing, and must still see the newest authored source.
    commitLive(id)
    commitTabContent(id, source)

    const api = editorApis.current[id]
    if (!api?.replaceMarkdown?.(source)) {
      if (isEnabledFor(id) && state.revision === revision) setPreviewState('error')
      return
    }

    // replaceMarkdown suppresses its programmatic markdownUpdated callbacks in
    // Editor.jsx. Once it accepts this exact revision, source is the baseline
    // for the next genuine rich edit; clear the old source-mode edit marker.
    if (state.revision === revision) {
      const currentEl = sourceTextareas.current[id]
      if (currentEl && getTextareaSourceValue(currentEl) === source) {
        currentEl.__horsemdSourceBaseline = currentEl.value || ''
        sourceEditedIds.current.delete(id)
      }
      if (isEnabledFor(id)) setPreviewState('idle')
    }
  }, [commitLive, commitTabContent, editorApis, isEnabledFor, sourceEditedIds, sourceTextareas])

  const scheduleSourcePreview = useCallback((id, source) => {
    if (!isEnabledFor(id)) return
    const state = stateFor(id)
    state.revision += 1
    const revision = state.revision
    clearTimer(id)
    commitTabContent(id, source)
    if (state.composing) return
    setPreviewState('pending')
    state.timer = setTimeout(() => syncSourceToRich(id, revision), PREVIEW_DELAY)
  }, [clearTimer, commitTabContent, isEnabledFor, stateFor, syncSourceToRich])

  const onSourceInput = useCallback((id, source) => {
    scheduleSourcePreview(id, source)
  }, [scheduleSourcePreview])

  const onSourceCompositionStart = useCallback((id) => {
    if (!isEnabledFor(id)) return
    const state = stateFor(id)
    state.composing = true
    clearTimer(id)
  }, [clearTimer, isEnabledFor, stateFor])

  const onSourceCompositionEnd = useCallback((id) => {
    if (!isEnabledFor(id)) return
    const state = stateFor(id)
    state.composing = false
    const source = getTextareaSourceValue(sourceTextareas.current[id])
    scheduleSourcePreview(id, source)
  }, [isEnabledFor, scheduleSourcePreview, sourceTextareas, stateFor])

  // Call this instead of updateContent for Editor's normal onChange. Rich
  // programmatic replaces are suppressed in Editor.jsx, so this path represents
  // a genuine rich edit when split mode is active.
  const onRichContent = useCallback((id, markdown, isInitial, updateContent) => {
    updateContent(id, markdown, isInitial)
    if (isInitial || !isEnabledFor(id)) return

    const state = stateFor(id)
    state.revision += 1
    clearTimer(id)
    const timer = liveTimersRef.current.get(id)
    if (timer) clearTimeout(timer)
    liveTimersRef.current.delete(id)
    liveContentRef.current.delete(id)

    const sourceEl = sourceTextareas.current[id]
    if (sourceEl) {
      // Direct DOM assignment preserves the textarea's uncontrolled contract and
      // cannot dispatch a second source input event. Do not focus/select here:
      // the rich pane remains the interaction owner.
      setTextareaSourceValue(sourceEl, markdown)
      sourceEl.__horsemdSourceBaseline = sourceEl.value || ''
      sourceEditedIds.current.delete(id)
    }
    commitTabContent(id, markdown)
    setPreviewState('idle')
  }, [clearTimer, commitTabContent, isEnabledFor, liveContentRef, liveTimersRef, sourceEditedIds, sourceTextareas, stateFor])

  useEffect(() => {
    const live = new Set(tabs.map((tab) => tab.id))
    for (const [id, state] of statesRef.current) {
      if (live.has(id)) continue
      if (state.timer) clearTimeout(state.timer)
      statesRef.current.delete(id)
    }
  }, [tabs])

  useEffect(() => {
    if (enabled) return
    // A tab switch, document split, close, or exit from source+preview must
    // cancel every pending source task. The callback also checks its revision,
    // but clearing here prevents background work and makes exit deterministic.
    for (const state of statesRef.current.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = 0
    }
    setPreviewState('idle')
  }, [enabled])

  useEffect(() => () => {
    for (const state of statesRef.current.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
  }, [])

  return {
    previewState,
    onSourceInput,
    onSourceCompositionStart,
    onSourceCompositionEnd,
    onRichContent,
    cancelSourcePreview: clearTimer
  }
}
