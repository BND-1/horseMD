import { useCallback, useEffect, useRef, useState } from 'react'
import { keybindingMatchesEvent } from '../lib/commands/keybinding-normalize.js'

// Full-screen reading/editing mode (Typora-style): the shell (tabs, activity
// bar, sidebar, status bar, floating controls) is hidden by the
// `.app.hm-immersive` class and only the document remains editable. The
// window itself is not resized. On mobile the system status bar is hidden too.
//
// Exit: Esc (when nothing else owns it), the same shortcut again, or the
// corner button rendered by App.
//
// Edge reveal (desktop): the pointer at the top, bottom or left window edge
// slides ALL the shell in over the document — top bar (tabs), status bar,
// activity bar + open sidebar. The pointer has to rest at the edge briefly:
// on its way to the Dock or the menu bar it only crosses the edge and leaves
// the window, which reveals nothing. The document slides right just enough
// to clear the sidebar (a transform: no re-layout), and back when the bars
// slide out after the pointer leaves them all.

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

// Distance from the window edge that counts as "at the edge", how long the
// pointer rests there before the bars come out, and how long it may be away
// before they slide out (crossing a gap or overshooting is fine).
const EDGE_PX = 4
const REVEAL_DWELL_MS = 180
const HIDE_DELAY_MS = 450
// Space kept between the revealed sidebar and the document text.
const CLEARANCE_PX = 24

const REVEAL_PARTS = '.topbar, .statusbar, .activity-bar, .pane-left, .pane-left-resizer'

// Menus opened from a revealed bar (tab context menu, palette-style menus)
// keep it out until they close.
const REVEAL_HOLDERS = '.menu-backdrop'

const atEdge = (event) =>
  event.clientY <= EDGE_PX ||
  event.clientY >= window.innerHeight - 1 - EDGE_PX ||
  event.clientX <= EDGE_PX

const isTextField = (node) =>
  node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')

export function useImmersiveMode({ enabled, effectiveKeybindings, platform, revealEdges = true }) {
  const [immersive, setImmersive] = useState(false)
  const [reveal, setReveal] = useState(false)
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

  const revealRef = useRef(null)
  revealRef.current = reveal
  useEffect(() => {
    if (!active || !revealEdges) {
      setReveal(false)
      return undefined
    }
    let hideTimer = 0
    let showTimer = 0
    // Where the pointer last was: on a bar (or the edge), or away. A click on
    // a bar changes focus and swaps the document without moving the pointer,
    // so the hide timer must ask this instead of trusting the last event.
    let pointerStays = false
    const cancelHide = () => {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = 0
    }
    const cancelShow = () => {
      if (showTimer) clearTimeout(showTimer)
      showTimer = 0
    }
    const scheduleShow = () => {
      if (showTimer) return
      showTimer = setTimeout(() => {
        showTimer = 0
        setReveal(true)
      }, REVEAL_DWELL_MS)
    }
    const holds = () => {
      if (document.querySelector(REVEAL_HOLDERS)) return true
      // Typing in a revealed field (sidebar search, rename) keeps it out.
      const focused = document.activeElement
      return isTextField(focused) && Boolean(focused.closest(REVEAL_PARTS))
    }
    const scheduleHide = () => {
      if (hideTimer) return
      hideTimer = setTimeout(() => {
        hideTimer = 0
        if (revealRef.current && !pointerStays && !holds()) setReveal(false)
      }, HIDE_DELAY_MS)
    }
    const onMove = (event) => {
      const onShell = Boolean(event.target?.closest?.(REVEAL_PARTS))
      pointerStays = onShell || atEdge(event)
      if (!revealRef.current) {
        // Dragging a selection into an edge is not a reveal.
        if (!event.buttons && atEdge(event)) scheduleShow()
        else cancelShow()
        return
      }
      if (onShell || atEdge(event)) cancelHide()
      else scheduleHide()
    }
    // Leaving the window (down to the Dock, up into the menu bar) never
    // reveals, and hides what is out.
    const onOut = (event) => {
      if (event.relatedTarget) return
      pointerStays = false
      cancelShow()
      if (revealRef.current) scheduleHide()
    }
    // Focus leaving a field that held the bars out (typing in the sidebar
    // search) lets them go once the pointer is away too.
    const onFocusOut = () => {
      if (revealRef.current && !pointerStays) scheduleHide()
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseout', onOut)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      cancelHide()
      cancelShow()
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [active, revealEdges])

  // How far the document slides right so the revealed sidebar never covers
  // its text. Re-measured when the sidebar opens, closes or is resized while
  // the bars are out (e.g. its activity-bar button was clicked).
  useEffect(() => {
    const app = document.querySelector('.app')
    if (!app) return undefined
    const clear = () => {
      app.style.removeProperty('--hm-reveal-shift')
      app.style.removeProperty('--hm-reveal-inset')
    }
    if (!(active && reveal)) {
      clear()
      return undefined
    }
    let current = 0
    let inset = 0
    const measure = () => {
      const pane = document.querySelector('.app .pane-left:not(.collapsed)')
      const activity = document.querySelector('.app .activity-bar')
      const cover = (activity?.offsetWidth || 0) + (pane?.offsetWidth || 0)
      const text = [...document.querySelectorAll('.pane-center .ProseMirror, .pane-center textarea.source-editor')]
        .find((node) => node.offsetParent)
      // Where the characters start without the current shift: the element's
      // edge plus its padding (the source textarea spans the pane).
      if (inset) {
        if (inset === cover) return // already laid out beside the sidebar
        inset = 0 // the sidebar changed: measure the plain layout again
        app.style.removeProperty('--hm-reveal-inset')
      }
      // Remove the slide as it is right now (it animates, so not `current`).
      const centre = document.querySelector('.app .pane-center')
      const matrix = centre ? getComputedStyle(centre).transform : 'none'
      const moved = matrix && matrix !== 'none' ? new DOMMatrixReadOnly(matrix).m41 : 0
      const rect = text?.getBoundingClientRect()
      const box = rect && { left: rect.left - moved, right: rect.right - moved }
      const left = box ? box.left + (parseFloat(getComputedStyle(text).paddingLeft) || 0) : 0
      const shift = Math.max(0, Math.round(cover + CLEARANCE_PX - left))
      // A narrow window has no room to slide the text over: lay the document
      // out beside the sidebar instead (once, like the normal window).
      if (box && shift && box.right + shift > window.innerWidth) {
        inset = cover
        current = 0
        app.style.removeProperty('--hm-reveal-shift')
        app.style.setProperty('--hm-reveal-inset', `${cover}px`)
        return
      }
      if (shift === current) return
      current = shift
      app.style.setProperty('--hm-reveal-shift', `${shift}px`)
    }
    measure()
    // A click on a bar can swap what is shown (another tab, source/rich, a
    // file from the sidebar): measure again once it has rendered, and again
    // after a slower document has mounted.
    const timers = new Set()
    const later = () => {
      requestAnimationFrame(() => requestAnimationFrame(measure))
      for (const ms of [250, 700]) {
        const id = setTimeout(() => { timers.delete(id); measure() }, ms)
        timers.add(id)
      }
    }
    document.addEventListener('click', later, true)
    const pane = document.querySelector('.app .pane-left')
    const observer = new MutationObserver(measure)
    if (pane) {
      observer.observe(pane, { attributes: true, attributeFilter: ['class', 'style'] })
      pane.addEventListener('transitionend', measure)
    }
    return () => {
      document.removeEventListener('click', later, true)
      for (const id of timers) clearTimeout(id)
      observer.disconnect()
      pane?.removeEventListener('transitionend', measure)
    }
  }, [active, reveal])

  useEffect(() => {
    window.api?.setSystemBarsHidden?.(active)
  }, [active])
  useEffect(() => () => { window.api?.setSystemBarsHidden?.(false) }, [])

  return { immersive: active, reveal: active && reveal, toggleImmersive, exitImmersive: () => setImmersive(false) }
}
