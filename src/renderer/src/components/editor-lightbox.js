import { useEffect } from 'react'

const clampScale = (scale) => Math.min(10, Math.max(0.2, scale))

const applyTransform = (element, scale, translate) => {
  if (!element) return
  element.style.transform = `translate(${translate.x}px, ${translate.y}px) scale(${scale})`
  element.style.transformOrigin = 'center center'
}

export function useEditorLightboxControls({
  zoom,
  setZoom,
  scaleRef,
  translateRef,
  contentRef,
  setScaleLabel
}) {
  const setScale = (nextScale, resetPan = false) => {
    const scale = clampScale(nextScale)
    scaleRef.current = scale
    if (resetPan) translateRef.current = { x: 0, y: 0 }
    applyTransform(contentRef.current, scale, translateRef.current)
    setScaleLabel(scale)
  }

  const fitToWindow = () => setScale(1, true)
  const zoomIn = () => setScale(scaleRef.current * 1.2)
  const zoomOut = () => setScale(scaleRef.current / 1.2)
  const showActualSize = () => {
    const element = contentRef.current
    if (!element) return
    const media = element.matches?.('img') ? element : element.querySelector?.('svg')
    if (!media) return
    const naturalWidth = element.matches?.('img')
      ? element.naturalWidth
      : Number(zoom?.width) || media.viewBox?.baseVal?.width
    const displayedWidth = media.clientWidth
    if (!naturalWidth || !displayedWidth) return
    setScale(naturalWidth / displayedWidth, true)
  }

  // Close the lightbox on Escape and reset transform state when closed.
  useEffect(() => {
    if (!zoom) {
      scaleRef.current = 1
      translateRef.current = { x: 0, y: 0 }
      setScaleLabel(1)
      return
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom, setZoom, scaleRef, translateRef, setScaleLabel])

  // Ctrl+wheel zoom + drag-pan, scoped to the lightbox content.
  useEffect(() => {
    if (!zoom) return
    let clearDragListeners = () => {}
    let clearClickSuppressor = () => {}
    const onWheel = (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      const element = contentRef.current
      if (!element) return
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      const scale = clampScale(scaleRef.current * factor)
      scaleRef.current = scale
      applyTransform(element, scale, translateRef.current)
      setScaleLabel(scale)
    }
    const onMouseDown = (event) => {
      const element = contentRef.current
      if (!element || !element.contains(event.target) || event.button !== 0) return
      clearDragListeners()
      clearClickSuppressor()
      event.preventDefault()
      element.style.cursor = 'grabbing'
      const startX = event.clientX - translateRef.current.x
      const startY = event.clientY - translateRef.current.y
      let dragged = false
      const onMove = (moveEvent) => {
        dragged = true
        translateRef.current = { x: moveEvent.clientX - startX, y: moveEvent.clientY - startY }
        applyTransform(element, scaleRef.current, translateRef.current)
      }
      const onUp = () => {
        element.style.cursor = 'grab'
        clearDragListeners()
        if (dragged) {
          // Suppress the click that follows a drag so it doesn't close the lightbox.
          const onClick = (clickEvent) => {
            clickEvent.stopPropagation()
            clearClickSuppressor()
          }
          window.addEventListener('click', onClick, true)
          clearClickSuppressor = () => {
            window.removeEventListener('click', onClick, true)
            clearClickSuppressor = () => {}
          }
        }
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      clearDragListeners = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        element.style.cursor = 'grab'
        clearDragListeners = () => {}
      }
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true, passive: false })
      window.removeEventListener('mousedown', onMouseDown)
      clearDragListeners()
      clearClickSuppressor()
    }
  }, [zoom, scaleRef, translateRef, contentRef, setScaleLabel])

  return { fitToWindow, showActualSize, zoomIn, zoomOut }
}
