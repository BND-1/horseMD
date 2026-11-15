// iOS: a long press in the file tree or the tab strip opens the same menu a
// right click opens. WKWebView never fires `contextmenu` for a touch (Android's
// WebView does), so on iPhone the file tree's 新建 / 重命名 / 删除 / 从工作区移除
// could not be reached at all (#175). Like Files / Obsidian: hold ~0.5 s
// without moving; the press does not also act as a tap.
const HOLD_MS = 500
const SLOP_PX = 10
const AREAS = '.sidebar, .tabs'

export function installIosLongPressMenu(doc = document) {
  let timer = null
  let start = null
  let swallowClick = false

  const cancel = () => {
    clearTimeout(timer)
    timer = null
    start = null
  }

  doc.addEventListener('touchstart', (event) => {
    cancel()
    // iOS may send no click after a long hold: never swallow a later tap.
    swallowClick = false
    if (event.touches.length !== 1) return
    const target = event.target instanceof Element ? event.target : null
    if (!target || !target.closest(AREAS) || target.closest('input, textarea, [contenteditable="true"]')) return
    const touch = event.touches[0]
    start = { x: touch.clientX, y: touch.clientY, target }
    timer = setTimeout(() => {
      const { x, y, target: pressed } = start || {}
      cancel()
      if (!pressed?.isConnected) return
      swallowClick = true
      pressed.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2
      }))
      navigator.vibrate?.(10)
    }, HOLD_MS)
  }, { passive: true })

  doc.addEventListener('touchmove', (event) => {
    if (!start) return
    const touch = event.touches[0]
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP_PX) cancel()
  }, { passive: true })
  doc.addEventListener('touchend', cancel, { passive: true })
  doc.addEventListener('touchcancel', cancel, { passive: true })

  // The finger lifting after the menu opened would otherwise click the row
  // under it (open the file, fold the folder) and close the menu again.
  doc.addEventListener('click', (event) => {
    if (!swallowClick) return
    swallowClick = false
    event.preventDefault()
    event.stopPropagation()
  }, true)
}
