import { useEffect, useRef } from 'react'
import {
  captureRichViewport,
  captureSourceViewport,
  restoreRichViewport,
  restoreSourceViewport
} from '../scrollAnchor.js'
import { buildSplitScrollMap, mapSplitScroll } from '../lib/split-scroll-map.js'

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
      // The scrollTop this hook last wrote on each side. A scroll event that
      // finds the pane still there is the echo of that write, however late it
      // comes (a 160 ms window was too short on a Windows PC with slow frames:
      // the late echo took ownership and wrote the first pane back). The
      // user's own input on a side forgets it.
      const written = { source: NaN, rich: NaN }

      // The other pane's position when the user turns to this one: a scroll
      // event it delivers late (from before) finds it unchanged and is not
      // taken for the user scrolling there (Windows, slow frames).
      const claim = (side) => {
        owner = side
        written[side] = NaN
        if (side === 'source') written.rich = richHost.scrollTop
        else written.source = sourceEl.scrollTop
      }
      const shouldIgnore = (side, el) => Math.abs(el.scrollTop - written[side]) < 2
      const writeTarget = (side, el, restore) => {
        restore()
        written[side] = el.scrollTop
      }
      // Rebuilt when either side's text, width or height changed (typing,
      // a window resize, an image that finished loading).
      let map = null
      let mapKey = null
      const currentMap = (api, view) => {
        const anchors = api?.getScrollAnchors?.()
        if (!anchors || !view) return null
        const pm = richHost.querySelector('.ProseMirror')
        const key = [
          anchors.doc, anchors.markdown, sourceEl.value, sourceEl.clientWidth, sourceEl.scrollHeight,
          richHost.clientWidth, richHost.clientHeight, sourceEl.clientHeight, pm?.scrollHeight
        ]
        if (!mapKey || key.some((value, index) => value !== mapKey[index])) {
          map = buildSplitScrollMap({ textarea: sourceEl, scroller: richHost, view, anchors })
          mapKey = key
        }
        return map
      }
      const flush = () => {
        scheduled = false
        if (!enabledRef.current || !owner || !sourceEl?.isConnected || !richHost?.isConnected) return
        const api = editorApis.current[activeId]
        const view = api?.getView?.()
        let linked = null
        try { linked = currentMap(api, view) } catch { linked = null }
        if (linked) {
          if (owner === 'source') {
            writeTarget('rich', richHost, () => { richHost.scrollTop = mapSplitScroll(linked, 'source', sourceEl.scrollTop) })
          } else {
            writeTarget('source', sourceEl, () => { sourceEl.scrollTop = mapSplitScroll(linked, 'rich', richHost.scrollTop) })
          }
          return
        }
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
        owner = side
        if (!scheduled) {
          scheduled = true
          // A frame, or a timer when Chromium gives no frames (an occluded
          // window on Windows: one frame in 1.5 s), whichever comes first.
          const frame = requestAnimationFrame(() => { clearTimeout(timer); flush() })
          const timer = setTimeout(() => { cancelAnimationFrame(frame); flush() }, 50)
        }
      }
      const sourceScroll = () => schedule('source', sourceEl)
      const richScroll = () => schedule('rich', richHost)
      const sourceOwn = () => claim('source')
      const richOwn = () => claim('rich')

      sourceEl.addEventListener('scroll', sourceScroll, { passive: true })
      richHost.addEventListener('scroll', richScroll, { passive: true })
      for (const type of ['wheel', 'pointerdown', 'touchstart', 'focusin', 'keydown']) {
        sourceEl.addEventListener(type, sourceOwn, { passive: true })
        richHost.addEventListener(type, richOwn, { passive: true })
      }
      cleanup = () => {
        sourceEl?.removeEventListener('scroll', sourceScroll)
        richHost?.removeEventListener('scroll', richScroll)
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'focusin', 'keydown']) {
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
