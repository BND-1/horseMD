// Phones: the open drawer (activity bar + side pane) follows a leftward swipe
// and closes when released far or fast enough, like Android's navigation
// drawer and iOS sidebars (user review 2026-11-15: only the collapse button
// closed it). A swipe that is mostly vertical stays a scroll of the file
// tree / outline; only a horizontal one is taken over.
import { useEffect, useRef } from 'react'

const START_SLOP = 10 // px before deciding horizontal vs vertical
const CLOSE_DISTANCE = 64 // px dragged left that closes on release
const CLOSE_VELOCITY = 0.45 // px / ms leftward flick that closes

export function useDrawerSwipe({ enabled, onClose }) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!enabled) return undefined
    const app = document.querySelector('.app')
    if (!app) return undefined
    const panes = () => [...app.querySelectorAll('.activity-bar, .pane-left')]
    const scrim = () => app.querySelector('.hm-scrim')
    let start = null // { x, y, t, width }
    let mode = null // null | 'drawer' | 'scroll'
    let lastX = 0
    let lastT = 0
    let velocity = 0

    const setOffset = (dx) => {
      for (const el of panes()) {
        el.style.transition = 'none'
        el.style.transform = `translateX(${dx}px)`
      }
      const s = scrim()
      if (s && start) s.style.opacity = String(Math.max(0, 1 + dx / start.width))
    }
    const reset = () => {
      for (const el of panes()) {
        el.style.transition = ''
        el.style.transform = ''
      }
      const s = scrim()
      if (s) s.style.opacity = ''
    }

    const onStart = (event) => {
      if (event.touches.length !== 1) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.activity-bar, .pane-left, .hm-scrim')) return
      // Inputs (rename field, search box) keep their own gestures.
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      const touch = event.touches[0]
      const pane = app.querySelector('.pane-left')
      const bar = app.querySelector('.activity-bar')
      const width = (pane?.getBoundingClientRect().right || 300) - (bar?.getBoundingClientRect().left || 0)
      start = { x: touch.clientX, y: touch.clientY, t: event.timeStamp, width: Math.max(120, width) }
      mode = null
      lastX = touch.clientX
      lastT = event.timeStamp
      velocity = 0
    }
    const onMove = (event) => {
      if (!start || event.touches.length !== 1) return
      const touch = event.touches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (!mode) {
        if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return
        mode = dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'drawer' : 'scroll'
      }
      if (mode !== 'drawer') return
      event.preventDefault() // no tree scroll, no long-press menu
      const dt = Math.max(1, event.timeStamp - lastT)
      velocity = (touch.clientX - lastX) / dt
      lastX = touch.clientX
      lastT = event.timeStamp
      setOffset(Math.min(0, dx))
    }
    const onEnd = (event) => {
      if (!start) return
      const wasDrawer = mode === 'drawer'
      const dx = lastX - start.x
      start = null
      mode = null
      if (!wasDrawer) return
      // A drag never becomes a click on the row or scrim under the finger.
      event.preventDefault?.()
      const close = dx <= -CLOSE_DISTANCE || velocity <= -CLOSE_VELOCITY
      // The CSS transition runs from where the finger left the drawer: to
      // closed (the class goes first, then the inline offset), or back open.
      for (const el of panes()) el.style.transition = ''
      if (close) {
        onCloseRef.current?.()
        requestAnimationFrame(() => requestAnimationFrame(reset))
      } else {
        reset()
      }
    }
    const onCancel = () => {
      if (mode === 'drawer') reset()
      start = null
      mode = null
    }

    app.addEventListener('touchstart', onStart, { passive: true })
    app.addEventListener('touchmove', onMove, { passive: false })
    app.addEventListener('touchend', onEnd, { passive: false })
    app.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      app.removeEventListener('touchstart', onStart)
      app.removeEventListener('touchmove', onMove)
      app.removeEventListener('touchend', onEnd)
      app.removeEventListener('touchcancel', onCancel)
      reset()
    }
  }, [enabled])
}
