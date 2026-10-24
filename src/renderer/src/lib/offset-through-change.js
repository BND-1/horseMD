// Map a character offset in `before` to the matching offset in `after`, for a
// document that another program rewrote (issue #158). The change is taken as
// one replaced region between the common prefix and suffix: offsets before it
// stay, offsets after it shift by the length difference, and an offset inside
// it keeps its distance from the region start (clamped to the new region).
export function mapOffsetThroughChange(before, after, offset) {
  if (typeof before !== 'string' || typeof after !== 'string') return null
  if (!Number.isFinite(offset)) return null
  const at = Math.max(0, Math.min(offset, before.length))
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let end = 0
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) end++
  if (at <= start) return at
  if (at >= before.length - end) return at + after.length - before.length
  return start + Math.min(at - start, after.length - end - start)
}
