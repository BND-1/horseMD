import { useCallback, useEffect, useRef } from 'react'
import { keybindingMatchesEvent } from '../lib/commands/keybinding-normalize.js'
import { getCommandShortcut } from '../lib/commands/shortcut-labels.js'
import { isReadOnlyMutationKey } from '../components/editor-read-only.js'
import { fireToast } from '../ui.js'

// Desktop reading mode (#163). Documents are read-only (the same lock the
// mobile read-only switch and the source/rich preview use): selecting,
// copying, find, outline jumps and export keep working; nothing writes.
//
// This hook owns the shortcut and the hint shown when someone types into a
// read-only document, so a forgotten mode never looks like a frozen editor.

const HINT_INTERVAL_MS = 4000

// Keys typed into the document itself. Inputs (find bar, rename, dialogs,
// front-matter fields) are not the document and keep working normally.
const typedIntoDocument = (target) => {
  if (!target || target === document.body || target === document.documentElement) return true
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return false
  if (target.tagName === 'TEXTAREA') return target.classList?.contains('source-editor')
  return Boolean(target.closest?.('.editor-area'))
}

export function useReadingMode({ readingMode, enabled, effectiveKeybindings, platform, updateSettings, t }) {
  const tRef = useRef(t)
  tRef.current = t

  const toggleReadingMode = useCallback(() => {
    const next = !readingMode
    updateSettings({ readingMode: next })
    fireToast(tRef.current(next ? 'reading.on' : 'reading.off'), { duration: 1500 })
  }, [readingMode, updateSettings])
  const toggleRef = useRef(toggleReadingMode)
  toggleRef.current = toggleReadingMode

  useEffect(() => {
    const binding = effectiveKeybindings?.['view.readingMode']?.[0]
    if (!binding) return undefined
    const onKey = (event) => {
      if (!keybindingMatchesEvent(binding, event, platform)) return
      event.preventDefault()
      event.stopPropagation()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [effectiveKeybindings, platform])

  const hintAtRef = useRef(0)
  const keybindingsRef = useRef(effectiveKeybindings)
  keybindingsRef.current = effectiveKeybindings
  // Throttled: a burst of typing shows one hint, not one per key.
  const notifyBlocked = useCallback(() => {
    const now = Date.now()
    if (now - hintAtRef.current < HINT_INTERVAL_MS) return
    hintAtRef.current = now
    const key = getCommandShortcut('view.readingMode', keybindingsRef.current)
    fireToast(key
      ? tRef.current('reading.blocked', { key })
      : tRef.current('reading.blockedNoKey'), { duration: 2500 })
  }, [])

  useEffect(() => {
    if (!readingMode || !enabled) return undefined
    const onKey = (event) => {
      // Space is how many readers page down; it never earns a hint.
      if (event.isComposing || event.key === ' ' || !isReadOnlyMutationKey(event)) return
      if (typedIntoDocument(event.target)) notifyBlocked()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [readingMode, enabled, notifyBlocked])

  return { toggleReadingMode, notifyBlocked }
}
