import { useCallback, useEffect, useState } from 'react'
import { keybindingMatchesEvent } from '../lib/commands/keybinding-normalize.js'

// Full-screen reading/editing mode (Typora-style): the shell (tabs, activity
// bar, sidebar, status bar, floating controls) is hidden by the
// `.app.hm-immersive` class and only the document remains editable. The
// window itself is not resized. On mobile the system status bar is hidden too.
//
// Exit: Esc (when nothing else owns it), the same shortcut again, or the
// corner button rendered by App.

// Esc belongs to these first: menus, palette, dialogs, lightbox, slash menu,
// inline editors (find bar, rename, caption inputs).
const ESC_OWNERS = [
  '.palette-overlay',
  '.menu-backdrop',
  '.hm-rename-modal',
  '.hm-image-lightbox',
  '.milkdown-slash-menu[data-show="true"]',
  '.block-ctxmenu'
].join(', ')

// Decided in the CAPTURE phase, before any handler runs: by the bubble phase
// the slash menu has already closed itself. `defaultPrevented` cannot be used —
// ProseMirror's base keymap binds Escape (selectParentNode) and prevents it on
// every press.
const escOwnedElsewhere = (event) => {
  if (event.isComposing) return true
  const target = event.target
  if (target?.closest?.('input, select, .find-bar, .hm-findbar')) return true
  return Boolean(document.querySelector(ESC_OWNERS))
}

export function useImmersiveMode({ enabled, effectiveKeybindings, platform }) {
  const [immersive, setImmersive] = useState(false)
  const active = immersive && enabled

  const toggleImmersive = useCallback(() => setImmersive((value) => !value), [])

  // Leaving the document (Home page, Settings) ends the mode: there is nothing
  // to read full screen, and the hidden shell would strand the user.
  useEffect(() => {
    if (!enabled) setImmersive(false)
  }, [enabled])

  useEffect(() => {
    const binding = effectiveKeybindings?.['view.immersive']?.[0]
    const onKey = (event) => {
      if (binding && keybindingMatchesEvent(binding, event, platform)) {
        event.preventDefault()
        event.stopPropagation()
        if (enabled) setImmersive((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [effectiveKeybindings, enabled, platform])

  useEffect(() => {
    if (!active) return undefined
    let owned = false
    const onCapture = (event) => {
      if (event.key === 'Escape') owned = escOwnedElsewhere(event)
    }
    const onBubble = (event) => {
      if (event.key !== 'Escape' || owned) return
      setImmersive(false)
    }
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onBubble)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onBubble)
    }
  }, [active])

  useEffect(() => {
    window.api?.setSystemBarsHidden?.(active)
  }, [active])
  useEffect(() => () => { window.api?.setSystemBarsHidden?.(false) }, [])

  return { immersive: active, toggleImmersive, exitImmersive: () => setImmersive(false) }
}
