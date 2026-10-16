import { useCallback, useMemo, useState } from 'react'
import {
  getEffectiveKeybindingMap,
  loadKeybindingState,
  resetAllKeybindings,
  resetCommandKeybindings,
  saveKeybindingState,
  setCommandKeybindings
} from '../lib/commands/keybinding-store.js'

export function useKeybindings() {
  const [state, setState] = useState(() => loadKeybindingState())

  const persist = useCallback((next) => {
    const saved = saveKeybindingState(next)
    setState(saved)
    return saved
  }, [])

  const setKeybindings = useCallback((commandId, bindings) => {
    setState((current) => {
      const next = saveKeybindingState(setCommandKeybindings(current, commandId, bindings))
      return next
    })
  }, [])

  const resetCommand = useCallback((commandId) => {
    setState((current) => {
      const next = saveKeybindingState(resetCommandKeybindings(current, commandId))
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    persist(resetAllKeybindings())
  }, [persist])

  const effectiveKeybindings = useMemo(
    () => getEffectiveKeybindingMap(state.overrides),
    [state.overrides]
  )

  return {
    keybindingState: state,
    effectiveKeybindings,
    setKeybindings,
    resetCommand,
    resetAll
  }
}
