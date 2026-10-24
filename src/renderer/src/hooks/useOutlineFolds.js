import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collapseAllEntry, expandAllEntry } from '../components/outline-model.js'

// Per-document outline fold memory for the session (#122). Keyed by tab id;
// each entry holds structural paths (see outline-model.js), so text edits and
// switching tabs keep the user's folds. Lives in App (not Outline) so the
// expand/collapse-all commands work while the outline panel is not mounted:
// the Outline reads the entry when it shows that document again.
// Changing the default level clears the memory → every document re-applies it.
export function useOutlineFolds(defaultLevel) {
  const entries = useRef(new Map())
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const firstLevelRef = useRef(true)
  useEffect(() => {
    if (firstLevelRef.current) {
      firstLevelRef.current = false
      return
    }
    entries.current.clear()
    bump()
  }, [defaultLevel, bump])

  const get = useCallback((docKey) => (docKey == null ? null : entries.current.get(docKey) || null), [])
  const set = useCallback((docKey, entry) => {
    if (docKey == null) return
    entries.current.set(docKey, entry)
    bump()
  }, [bump])
  const expandAll = useCallback((docKey) => set(docKey, expandAllEntry()), [set])
  const collapseAll = useCallback((docKey) => set(docKey, collapseAllEntry()), [set])

  return useMemo(
    () => ({ version, defaultLevel, get, set, expandAll, collapseAll }),
    [version, defaultLevel, get, set, expandAll, collapseAll]
  )
}
