export function clampFloatingRect({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 8
}) {
  const maxLeft = Math.max(margin, viewportWidth - width - margin)
  const maxTop = Math.max(margin, viewportHeight - height - margin)
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop))
  }
}
