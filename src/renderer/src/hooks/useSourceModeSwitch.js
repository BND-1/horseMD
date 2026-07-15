import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isHeavyDoc } from '../paths.js'
import {
  captureRichCaret,
  captureRichViewport,
  captureSourceCaret,
  captureSourceViewport,
  isRichCaretVisible,
  restoreRichCaret,
  restoreRichViewport,
  restoreSourceCaret,
  restoreSourceViewport
} from '../scrollAnchor.js'

// Owns rich/source view state and the caret-vs-reading-position transition.
// Textarea editing remains uncontrolled in EditorArea; this hook only consumes
// its stable refs and synchronizes into the mounted rich editor when necessary.
export function useSourceModeSwitch({
  tabs,
  activeId,
  setTabs,
  tabsRef,
  activeIdRef,
  editorApis,
  editorHostRef,
  focusedTabRef,
  commitAllLive,
  findStateRef,
  richLoadingRef
}) {
  const [sourceModeIds, setSourceModeIds] = useState(() => new Set())
  const sourceMode = !!activeId && sourceModeIds.has(activeId)
  const sourceModeRef = useRef(sourceMode)
  sourceModeRef.current = sourceMode

  const sourceEditedIds = useRef(new Set())
  const sourceRef = useRef(null)
  const sourceTextareas = useRef({})
  const caretAnchorRef = useRef(null)
  const viewportAnchorRef = useRef(null)
  const caretFollowRef = useRef(false)
  const preserveRichCaretFollowRef = useRef(false)
  const sourceEnteredWithCaretFollowRef = useRef(false)
  const sourceCaretRoundTripRef = useRef(null)

  useEffect(() => {
    const live = new Set(tabs.map((tab) => tab.id))
    for (const id of Object.keys(sourceTextareas.current)) {
      if (!live.has(id)) delete sourceTextareas.current[id]
    }
    for (const id of [...sourceEditedIds.current]) {
      if (!live.has(id)) sourceEditedIds.current.delete(id)
    }
    setSourceModeIds((prev) => {
      if (!prev.size) return prev
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tabs])

  const syncSourceToRich = useCallback((id) => {
    const sourceEl = sourceTextareas.current[id]
    if (!sourceEl) return false
    const next = sourceEl.value || ''
    const baseline = sourceEl.__horsemdSourceBaseline ?? ''
    const sourceEdited = sourceEditedIds.current.has(id)
    if (next === baseline && !sourceEdited) return false

    const api = editorApis.current[id]
    if (api?.replaceMarkdown?.(next)) {
      sourceEl.__horsemdSourceBaseline = next
      sourceEditedIds.current.delete(id)
      return true
    }

    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id
          ? { ...tab, reloadNonce: tab.reloadNonce + 1, heavy: isHeavyDoc(next) }
          : tab
      )
    )
    sourceEl.__horsemdSourceBaseline = next
    sourceEditedIds.current.delete(id)
    return true
  }, [editorApis, setTabs])

  const toggleSource = useCallback(() => {
    commitAllLive()
    const id = activeIdRef.current
    const tab = tabsRef.current.find((item) => item.id === id)
    if (!id || tab?.kind === 'settings') return
    const view = editorApis.current[id]?.getView?.()

    if (sourceModeRef.current) {
      const sourceEl = sourceRef.current
      const sourceTextChanged = !!sourceEl &&
        (sourceEl.value || '') !== (sourceEl.__horsemdSourceBaseline ?? '')
      const sourceSelection = sourceEl ? `${sourceEl.selectionStart}:${sourceEl.selectionEnd}` : ''
      const sourceSelectionChanged = !!sourceEl &&
        !!sourceEl.__horsemdSourceSelectionBaseline &&
        sourceSelection !== sourceEl.__horsemdSourceSelectionBaseline
      const sourceSelectionUser = !!sourceEl && sourceEl.__horsemdSourceSelectionUser === true
      const sourceViewportMoved = !!sourceEl && sourceEl.__horsemdSourceViewportMoved === true
      const preserveRichCaret =
        !sourceTextChanged && !sourceSelectionChanged && !sourceSelectionUser && !sourceViewportMoved
      const hasSourceCaretIntent = sourceTextChanged || sourceSelectionChanged || sourceSelectionUser
      const followSourceCaret = hasSourceCaretIntent && sourceSelectionUser && !sourceViewportMoved

      caretFollowRef.current = preserveRichCaret
        ? sourceEnteredWithCaretFollowRef.current
        : followSourceCaret
      preserveRichCaretFollowRef.current = preserveRichCaret
      if (preserveRichCaret) {
        caretAnchorRef.current = null
        viewportAnchorRef.current = null
      } else if (!hasSourceCaretIntent && sourceViewportMoved) {
        caretAnchorRef.current = null
        viewportAnchorRef.current = captureSourceViewport(sourceEl)
      } else {
        caretAnchorRef.current = captureSourceCaret(sourceEl)
        viewportAnchorRef.current = followSourceCaret ? null : captureSourceViewport(sourceEl)
      }
      syncSourceToRich(id)
    } else {
      preserveRichCaretFollowRef.current = false
      caretFollowRef.current = isRichCaretVisible(view, editorHostRef.current)
      sourceEnteredWithCaretFollowRef.current = caretFollowRef.current
      const richCaret = captureRichCaret(view)
      const carried = sourceCaretRoundTripRef.current
      const canReuseSourceOffset = !!carried &&
        carried.id === id &&
        carried.doc === view?.state.doc &&
        carried.pmPos === view?.state.selection.head
      const rawOffset = canReuseSourceOffset
        ? carried.rawOffset
        : editorApis.current[id]?.markdownOffsetFromSelection?.()
      if (richCaret && Number.isFinite(rawOffset)) richCaret.rawOffset = rawOffset
      caretAnchorRef.current = richCaret

      const viewport = captureRichViewport(editorHostRef.current, view)
      const viewportRawOffset = editorApis.current[id]?.markdownOffsetFromViewportTop?.()
      if (viewport && Number.isFinite(viewportRawOffset)) {
        viewport.origin = 'rich'
        viewport.rawOffset = viewportRawOffset
      }
      viewportAnchorRef.current = viewport
    }

    setSourceModeIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [activeIdRef, commitAllLive, editorApis, editorHostRef, syncSourceToRich, tabsRef])

  useLayoutEffect(() => {
    const caret = caretAnchorRef.current
    const viewport = viewportAnchorRef.current
    const follow = caretFollowRef.current
    const preserveRichCaretFollow = preserveRichCaretFollowRef.current
    if (caret == null && viewport == null && !preserveRichCaretFollow) return
    const restoreId = activeIdRef.current

    caretAnchorRef.current = null
    viewportAnchorRef.current = null
    caretFollowRef.current = false
    preserveRichCaretFollowRef.current = false

    let supersededByUserFocus = false
    const apply = () => {
      // Mode switching retries caret/viewport restoration while rich content
      // settles. Once the user focuses the other split pane, those retries must
      // never steal focus back to the pane that initiated the switch (#66).
      if (supersededByUserFocus) return false
      const focusedId = focusedTabRef.current
      if (activeIdRef.current !== restoreId || (focusedId && focusedId !== restoreId)) {
        supersededByUserFocus = true
        return false
      }
      if (findStateRef.current.open && findStateRef.current.query) return
      const view = editorApis.current[restoreId]?.getView?.()
      if (sourceMode) {
        if (caret) {
          restoreSourceCaret(sourceRef.current, caret, follow)
          const sourceEl = sourceRef.current
          if (sourceEl) {
            sourceEl.__horsemdSourceSelectionBaseline = `${sourceEl.selectionStart}:${sourceEl.selectionEnd}`
            sourceEl.__horsemdSourceSelectionUser = false
            sourceEl.__horsemdSourceViewportMoved = false
          }
        }
        if (!follow && viewport) {
          restoreSourceViewport(sourceRef.current, viewport)
          if (sourceRef.current) sourceRef.current.__horsemdSourceViewportMoved = false
        }
      } else {
        if (caret) {
          const api = editorApis.current[restoreId]
          const rawRestored = caret.origin === 'source' && Number.isFinite(caret.rawOffset)
            ? api?.restoreMarkdownOffset?.(caret.rawOffset, follow)
            : false
          const restored = rawRestored || restoreRichCaret(view, caret, follow)
          if (restored && caret.origin === 'source' && Number.isFinite(caret.rawOffset)) {
            sourceCaretRoundTripRef.current = {
              id: restoreId,
              rawOffset: caret.rawOffset,
              pmPos: view.state.selection.head,
              doc: view.state.doc
            }
          } else if (caret.origin === 'source') {
            sourceCaretRoundTripRef.current = null
          }
        } else if (preserveRichCaretFollow && follow) {
          view?.focus()
        }
        if (!follow && viewport) restoreRichViewport(editorHostRef.current, view, viewport)
      }
      return true
    }

    const raf = requestAnimationFrame(apply)
    const t1 = setTimeout(apply, 90)
    const t2 = setTimeout(apply, 220)
    const t3 = setTimeout(apply, 450)
    let cancelled = false
    const tailCleans = []
    let lastScrollHeight = -1
    let stableTicks = 0
    const tail = (delay) => {
      if (cancelled) return
      const handle = setTimeout(() => {
        if (cancelled) return
        if (!apply()) return
        const scroller = editorHostRef.current
        const currentHeight = scroller ? scroller.scrollHeight : 0
        const heightChanged = currentHeight > 0 && currentHeight !== lastScrollHeight
        if (heightChanged) stableTicks = 0
        else stableTicks += 1
        lastScrollHeight = currentHeight
        const stillSettling =
          !sourceMode && (richLoadingRef.current || heightChanged || stableTicks < 1)
        if (stillSettling && delay < 3000) tail(delay + 300)
      }, delay)
      tailCleans.push(handle)
    }
    tail(700)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
      tailCleans.forEach(clearTimeout)
    }
  }, [activeIdRef, editorApis, editorHostRef, findStateRef, focusedTabRef, richLoadingRef, sourceMode])

  return {
    sourceMode,
    sourceRef,
    sourceTextareas,
    sourceEditedIds,
    toggleSource
  }
}
