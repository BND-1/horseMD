import { useEffect, useRef } from 'react'
import {
  captureRichViewport,
  captureSourceViewport,
  restoreRichViewport,
  restoreSourceViewport
} from '../scrollAnchor.js'

// Keeps the two representations of ONE document visually aligned without
// mirroring raw scrollTop. The user-facing side owns a frame; the other side is
// restored by a semantic viewport anchor. Programmatic target scroll events are
// remembered so they cannot immediately bounce back in the opposite direction.
export function useSplitScrollSync({ enabled, activeId, sourceTextareas, editorHosts, editorApis }) {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    if (!enabled || !activeId) return undefined

    let sourceEl = null
    let richHost = null
    let cleanup = () => {}
    let cancelled = false
    let attachRaf = 0
    let attempts = 0

    const attach = () => {
      if (cancelled) return
      sourceEl = sourceTextareas.current[activeId]
      richHost = editorHosts.current[activeId]
      if (!sourceEl || !richHost || !richHost.isConnected) {
        if (attempts++ < 30) attachRaf = requestAnimationFrame(attach)
        return
      }

      let owner = null
      let scheduled = false
      const suppressed = {
        source: { until: 0, top: 0 },
        rich: { until: 0, top: 0 }
      }

      const claim = (side) => { owner = side }
      const shouldIgnore = (side, el) => {
        const pending = suppressed[side]
        return performance.now() < pending.until && Math.abs(el.scrollTop - pending.top) < 3
      }
      const writeTarget = (side, el, restore) => {
        restore()
        suppressed[side] = { until: performance.now() + 160, top: el.scrollTop }
      }
      const flush = () => {
        scheduled = false
        if (!enabledRef.current || !owner || !sourceEl?.isConnected || !richHost?.isConnected) return
        const view = editorApis.current[activeId]?.getView?.()
        if (owner === 'source') {
          const anchor = captureSourceViewport(sourceEl)
          writeTarget('rich', richHost, () => restoreRichViewport(richHost, view, anchor))
        } else {
          const anchor = captureRichViewport(richHost, view)
          writeTarget('source', sourceEl, () => restoreSourceViewport(sourceEl, anchor))
        }
      }
      const schedule = (side, el) => {
        if (shouldIgnore(side, el)) return
        claim(side)
        if (!scheduled) {
          scheduled = true
          requestAnimationFrame(flush)
        }
      }
      const sourceScroll = () => schedule('source', sourceEl)
      const richScroll = () => schedule('rich', richHost)
      const sourceOwn = () => claim('source')
      const richOwn = () => claim('rich')

      sourceEl.addEventListener('scroll', sourceScroll, { passive: true })
      richHost.addEventListener('scroll', richScroll, { passive: true })
      for (const type of ['wheel', 'pointerdown', 'focusin', 'keydown']) {
        sourceEl.addEventListener(type, sourceOwn, { passive: true })
        richHost.addEventListener(type, richOwn, { passive: true })
      }
      cleanup = () => {
        sourceEl?.removeEventListener('scroll', sourceScroll)
        richHost?.removeEventListener('scroll', richScroll)
        for (const type of ['wheel', 'pointerdown', 'focusin', 'keydown']) {
          sourceEl?.removeEventListener(type, sourceOwn)
          richHost?.removeEventListener(type, richOwn)
        }
      }
    }
    attach()
    return () => {
      cancelled = true
      cancelAnimationFrame(attachRaf)
      cleanup()
    }
  }, [activeId, editorApis, editorHosts, enabled, sourceTextareas])
}
