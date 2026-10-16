import { useEffect, useRef, useState } from 'react'

export default function PdfPage({ document, pageNumber, size, zoom }) {
  const shellRef = useRef(null)
  const canvasRef = useRef(null)
  const [visible, setVisible] = useState(pageNumber <= 2)

  useEffect(() => {
    const shell = shellRef.current
    if (!shell || visible) return
    const root = shell.closest('.hm-pdf-preview-scroll')
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { root, rootMargin: '900px 0px' })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible || !document || !canvasRef.current) return
    let canceled = false
    let renderTask = null
    document.getPage(pageNumber).then((page) => {
      if (canceled || !canvasRef.current) return
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1)
      const viewport = page.getViewport({ scale: zoom * pixelRatio })
      const canvas = canvasRef.current
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${viewport.width / pixelRatio}px`
      canvas.style.height = `${viewport.height / pixelRatio}px`
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport })
      return renderTask.promise
    }).catch((error) => {
      if (!canceled && error?.name !== 'RenderingCancelledException') console.error('PDF page render failed', error)
    })
    return () => {
      canceled = true
      renderTask?.cancel?.()
    }
  }, [document, pageNumber, visible, zoom])

  return (
    <figure
      ref={shellRef}
      className="hm-pdf-page"
      data-pdf-page={pageNumber}
      style={{ width: size.width * zoom, minHeight: size.height * zoom }}
    >
      {visible && <canvas ref={canvasRef} />}
      <figcaption>{pageNumber}</figcaption>
    </figure>
  )
}
