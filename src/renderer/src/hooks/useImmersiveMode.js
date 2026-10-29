import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
  '.hm-history',
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

// Distance from each window edge that counts as "at the edge", how long the
// pointer rests there before the bars come out, and how long it may be away
// before they slide out (crossing a gap or overshooting is fine). The top
// zone is the empty space above the first line (36 px in full screen); a
// 4 px zone with a 180 ms rest was hard to hit. Passing through 10–16 px on
// the way to the Dock / menu bar takes a frame or two, far under the rest.
const TOP_EDGE_PX = 16
const SIDE_EDGE_PX = 10
const REVEAL_DWELL_MS = 100
const HIDE_DELAY_MS = 450
// Space kept between the revealed sidebar and the document text.
const CLEARANCE_PX = 24

const REVEAL_PARTS = '.topbar, .statusbar, .activity-bar, .pane-left, .pane-left-resizer'

// Menus opened from a revealed bar (tab context menu, palette-style menus)
// keep it out until they close.
const REVEAL_HOLDERS = '.menu-backdrop'

const atEdge = (event) =>
  event.clientY <= TOP_EDGE_PX ||
  event.clientY >= window.innerHeight - 1 - SIDE_EDGE_PX ||
  event.clientX <= SIDE_EDGE_PX

// How the document makes room for the revealed sidebar, measured on the
// plain layout: { shift } slides it right (a transform: no re-layout), or
// { inset } lays it out beside the sidebar when the window is too narrow.
// Written as the pane's own inline transform / margin — NOT a CSS variable
// on .app or the pane: a custom property is inherited, and changing it
// restyled every element of the document (≈ 6 000 on a long one, 10+ ms)
// in the first frame of the slide.
function revealRoom() {
  const centre = document.querySelector('.app .pane-center')
  if (!centre) return null
  const pane = document.querySelector('.app .pane-left:not(.collapsed)')
  const activity = document.querySelector('.app .activity-bar')
  const cover = (activity?.offsetWidth || 0) + (pane?.offsetWidth || 0)
  const text = [...centre.querySelectorAll('.ProseMirror, textarea.source-editor')].find((node) => node.offsetParent)
  if (!text) return { centre, cover, shift: 0, inset: 0 }
  // Without what is applied right now (the slide animates: read its current
  // value) — the plain position of the characters.
  const matrix = getComputedStyle(centre).transform
  const moved = matrix && matrix !== 'none' ? new DOMMatrixReadOnly(matrix).m41 : 0
  const inset = parseFloat(centre.style.marginLeft) || 0
  // Already laid out beside an unchanged sidebar: the margin re-flowed the
  // text, so its position no longer tells the plain one — keep it.
  if (inset && inset === cover) return { centre, cover, shift: 0, inset }
  const rect = text.getBoundingClientRect()
  const left = rect.left - moved - inset + (parseFloat(getComputedStyle(text).paddingLeft) || 0)
  const right = rect.right - moved - inset
  const shift = Math.max(0, Math.round(cover + CLEARANCE_PX - left))
  if (shift && right + shift > window.innerWidth) return { centre, cover, shift: 0, inset: cover }
  return { centre, cover, shift, inset: 0 }
}

function applyRoom(room) {
  if (!room?.centre) return
  const transform = room.shift ? `translateX(${room.shift}px)` : ''
  const margin = room.inset ? `${room.inset}px` : ''
  if (room.centre.style.transform !== transform) room.centre.style.transform = transform
  if (room.centre.style.marginLeft !== margin) room.centre.style.marginLeft = margin
}

function clearRoom() {
  const centre = document.querySelector('.app .pane-center')
  if (!centre) return
  if (centre.style.transform) centre.style.transform = ''
  if (centre.style.marginLeft) centre.style.marginLeft = ''
}

// First-use hint (desktop): entering full screen briefly says that ANY of
// the three edges brings the shell back, and the edges glow once. Shown until
// the user has revealed the bars once, at most HINT_MAX times. Remembered in
// this browser only (a convenience; losing it just shows the hint again).
const HINT_KEY = 'horsemd.immersiveHint.v1'
const HINT_MAX = 3
const HINT_DELAY_MS = 250
export const HINT_MS = 4500
const readHint = () => {
  try { return JSON.parse(localStorage.getItem(HINT_KEY) || '{}') || {} } catch { return {} }
}
const writeHint = (value) => {
  try { localStorage.setItem(HINT_KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const isTextField = (node) =>
  node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')

export function useImmersiveMode({ enabled, effectiveKeybindings, platform, revealEdges = true }) {
  const [immersive, setImmersive] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [hint, setHint] = useState(false)
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
    // The bars (class, via React) and the document (inline transform) must
    // start moving in the same frame: commit synchronously, then place the
    // document with the room measured while it was still plain.
    const show = () => {
      const room = revealRoom()
      flushSync(() => setReveal(true))
      applyRoom(room)
    }
    const hide = () => {
      flushSync(() => setReveal(false))
      clearRoom()
    }
    const scheduleShow = () => {
      if (showTimer) return
      showTimer = setTimeout(() => {
        showTimer = 0
        show()
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
        if (revealRef.current && !pointerStays && !holds()) hide()
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
      clearRoom()
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [active, revealEdges])

  // While the bars are out, keep the document clear of the sidebar when it
  // opens, closes or is resized, or a click swaps what is shown (another
  // tab, source/rich, a file from the sidebar). The first placement happens
  // in show(), before the slide starts.
  useEffect(() => {
    if (!(active && reveal)) {
      clearRoom()
      return undefined
    }
    const measure = () => applyRoom(revealRoom())
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
    // Revealed some other way than show() (none today): place it next frame.
    const first = requestAnimationFrame(measure)
    return () => {
      cancelAnimationFrame(first)
      document.removeEventListener('click', later, true)
      for (const id of timers) clearTimeout(id)
      observer.disconnect()
      pane?.removeEventListener('transitionend', measure)
    }
  }, [active, reveal])

  useEffect(() => {
    if (!active || !revealEdges) {
      setHint(false)
      return undefined
    }
    const seen = readHint()
    if (seen.learned || (seen.shown || 0) >= HINT_MAX) return undefined
    writeHint({ ...seen, shown: (seen.shown || 0) + 1 })
    const show = setTimeout(() => setHint(true), HINT_DELAY_MS)
    const hide = setTimeout(() => setHint(false), HINT_DELAY_MS + HINT_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
      setHint(false)
    }
  }, [active, revealEdges])
  // Revealing the bars once means the user found it: no more hints.
  useEffect(() => {
    if (!(active && reveal)) return
    setHint(false)
    const seen = readHint()
    if (!seen.learned) writeHint({ ...seen, learned: true })
  }, [active, reveal])

  useEffect(() => {
    window.api?.setSystemBarsHidden?.(active)
  }, [active])
  useEffect(() => () => { window.api?.setSystemBarsHidden?.(false) }, [])

  return { immersive: active, reveal: active && reveal, hint: active && hint, toggleImmersive, exitImmersive: () => setImmersive(false) }
}
