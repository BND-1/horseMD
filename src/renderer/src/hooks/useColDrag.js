import { useCallback, useRef } from 'react'

// Shared horizontal-drag helper for the column resizers (split-pane divider +
// outline/file-tree pane edge). Both used to hand-roll the same
// mousemove/mouseup + body-class-toggle dance; this holds the listener wiring
// once. Each call site supplies its own body class (so the freeze-CSS can target
// the right elements) and an onMove (and optional onStart to capture initial
// state at mousedown). #dedupe.
//
// While dragging, `bodyClass` is on <body> — CSS uses it to kill text selection,
// set the col-resize cursor, and freeze width/transition so the drag tracks the
// cursor 1:1.
export function useColDrag({ bodyClass, onStart, onMove }) {
  // Refs so the latest callbacks fire without re-creating the returned handler
  // (the handler stays stable across renders, like the old useCallback([], ...)).
  const onStartRef = useRef(onStart)
  const onMoveRef = useRef(onMove)
  onStartRef.current = onStart
  onMoveRef.current = onMove

  return useCallback((e) => {
    e.preventDefault()
    // onStart may return state (e.g. the mousedown x / start width) that onMove
    // needs; pass it through so call sites don't have to keep their own ref.
    const state = onStartRef.current?.(e)
    const move = (ev) => onMoveRef.current(ev, state)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove(bodyClass)
    }
    document.body.classList.add(bodyClass)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [bodyClass])
}
