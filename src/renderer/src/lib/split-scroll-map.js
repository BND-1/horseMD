// Source + preview scroll link (user report 2026-11-19: a table- and
// code-heavy document drifted by whole sections; rich → source by up to two
// screens). VS Code's Markdown preview: each block's source position is paired
// with its rendered element, and a scroll position between two blocks is
// interpolated by the same fraction on the other side. Here a map is two
// increasing lists of scrollTop values — `source[k]` puts pair k's source
// line at the top of the textarea, `rich[k]` its element at the top of the
// preview — with (0, 0) and both scroll ends as the first and last points, so
// the panes start and finish together.
import { textareaOffsetsY } from '../textarea-metrics.js'
import { textareaOffsetForSource } from '../source-text-fidelity.js'

const elementTop = (view, pos, scrollerTop, scrollTop) => {
  let el = null
  try { el = view.nodeDOM(pos) } catch {}
  if (el && el.nodeType !== 1) el = el.parentElement
  if (!el || !el.getClientRects().length) return null // folded / not rendered
  return el.getBoundingClientRect().top - scrollerTop + scrollTop
}

export function buildSplitScrollMap({ textarea, scroller, view, anchors }) {
  const sourceMax = textarea.scrollHeight - textarea.clientHeight
  const richMax = scroller.scrollHeight - scroller.clientHeight
  if (!anchors?.pairs?.length || sourceMax <= 0 || richMax <= 0) return null
  const offsets = anchors.pairs.map((p) => textareaOffsetForSource(textarea, p.raw))
  const sourceYs = textareaOffsetsY(textarea, offsets)
  const scrollerTop = scroller.getBoundingClientRect().top
  const scrollTop = scroller.scrollTop
  const source = [0]
  const rich = [0]
  for (let k = 0; k < anchors.pairs.length; k++) {
    const s = sourceYs[k]
    const r = elementTop(view, anchors.pairs[k].pmPos, scrollerTop, scrollTop)
    if (r == null || !Number.isFinite(s)) continue
    // Strictly increasing on both sides (cells of one table row share a line).
    if (s <= source[source.length - 1] || r <= rich[rich.length - 1]) continue
    if (s >= sourceMax || r >= richMax) break
    source.push(s)
    rich.push(r)
  }
  source.push(sourceMax)
  rich.push(richMax)
  return { source, rich }
}

// The other side's scrollTop for `top` on side `from` ('source' | 'rich').
export function mapSplitScroll(map, from, top) {
  const a = from === 'source' ? map.source : map.rich
  const b = from === 'source' ? map.rich : map.source
  if (top <= a[0]) return b[0]
  const last = a.length - 1
  if (top >= a[last]) return b[last]
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (a[mid] <= top) lo = mid
    else hi = mid
  }
  const t = (top - a[lo]) / (a[hi] - a[lo])
  return b[lo] + t * (b[hi] - b[lo])
}
