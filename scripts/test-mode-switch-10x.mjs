// Real-interaction regression for source/rich switching.
// Launch Electron with the target document and --remote-debugging-port=9222,
// then run this script. It performs five caret-follow and five reading-position
// round trips across the document and verifies outline stability on every pass.
import { connectCdp, sleep } from './lib/cdp.mjs'

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const visibleSource = (ev) => ev(`(() => {
  const el = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null)
  return !!el
})()`)

const toggle = async (send, ev) => {
  const point = await ev(`(() => {
    const button = [...document.querySelectorAll('.status-btn')].find((node) => node.title?.includes('Ctrl+/'))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (!point) throw new Error('Source toggle button not found')
  await click(send, point)
  await sleep(1200)
}

const outlineSnapshot = (ev) => ev(`(() => [...document.querySelectorAll('.outline-item')].map((item) => ({
  text: item.querySelector('.outline-item-text')?.textContent || '',
  level: Number((item.className.match(/lvl-(\\d)/) || [])[1] || 0)
})))()`)

const caretContext = (ev) => ev(`(() => {
  const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const selection = getSelection()
  if (!pm || !selection?.rangeCount || !pm.contains(selection.anchorNode)) return null
  const range = selection.getRangeAt(0).cloneRange()
  range.collapse(true)
  const before = document.createRange()
  before.selectNodeContents(pm)
  before.setEnd(range.startContainer, range.startOffset)
  const offset = before.toString().length
  const text = pm.textContent || ''
  const rect = range.getBoundingClientRect()
  const host = pm.closest('.editor-scroll')
  const hostRect = host.getBoundingClientRect()
  return {
    offset,
    context: text.slice(Math.max(0, offset - 16), offset + 16),
    visible: rect.top >= hostRect.top && rect.bottom <= hostRect.bottom
  }
})()`)

const viewportContext = (ev) => ev(`(() => {
  const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  if (!pm) return null
  const host = pm.closest('.editor-scroll')
  const top = host.getBoundingClientRect().top + 2
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!(node.nodeValue || '').trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rect = range.getBoundingClientRect()
    if (rect.bottom > top) return { text: node.nodeValue.slice(0, 28), top: Math.round(rect.top - top) }
  }
  return null
})()`)

const scrollRich = async (ev, ratio) => {
  await ev(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
    const host = pm?.closest('.editor-scroll')
    if (!host) return false
    host.scrollTop = ${ratio} * Math.max(0, host.scrollHeight - host.clientHeight)
    return true
  })()`)
  await sleep(350)
}

const clickVisibleText = async (send, ev) => {
  const point = await ev(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
    if (!pm) return null
    const hostRect = pm.closest('.editor-scroll').getBoundingClientRect()
    const center = (hostRect.top + hostRect.bottom) / 2
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    let best = null
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!(node.nodeValue || '').trim()) continue
      const parent = node.parentElement
      if (parent?.closest('.cm-editor, table, [contenteditable="false"]')) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        if (rect.bottom <= hostRect.top + 12 || rect.top >= hostRect.bottom - 12 || rect.width < 8) continue
        const distance = Math.abs((rect.top + rect.bottom) / 2 - center)
        if (!best || distance < best.distance) {
          best = {
            x: Math.round(Math.min(rect.right - 2, rect.left + Math.max(4, Math.min(20, rect.width / 2)))),
            y: Math.round((rect.top + rect.bottom) / 2),
            distance
          }
        }
      }
    }
    return best && { x: best.x, y: best.y }
  })()`)
  if (!point) throw new Error('No visible text point found')
  await click(send, point)
  await sleep(250)
}

const sameOutline = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const dirtyState = (ev) => ev(`/已修改|Modified/.test(document.querySelector('.statusbar')?.textContent || '')`)
const ratios = [0.16, 0.34, 0.52, 0.68, 0.9]

const main = async () => {
  const { ws, send, evaluate: ev } = await connectCdp()
  await send('Runtime.enable')
  await sleep(1800)

  // Heavy Markdown opens as source for responsiveness. Opt into rich mode so
  // the same real large documents can exercise the round trip.
  if (!(await ev(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent !== null)`))) {
    const point = await ev(`(() => {
      const button = document.querySelector('.hm-heavy-banner button')
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    if (point) await click(send, point)
    for (let i = 0; i < 80; i++) {
      const ready = await ev(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent !== null) && !document.querySelector('.editor-skeleton')`)
      if (ready) break
      await sleep(250)
    }
    await sleep(1000)
  }

  // Open the outline pane when it is not already visible.
  if (!(await ev(`document.querySelectorAll('.outline-item').length > 0`))) {
    const point = await ev(`(() => {
      const item = [...document.querySelectorAll('.activity-item')].find((node) => /大纲|Outline/.test(node.title || ''))
      if (!item) return null
      const rect = item.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    if (point) await click(send, point)
    for (let i = 0; i < 40; i++) {
      if (await ev(`document.querySelectorAll('.outline-item').length > 0`)) break
      await sleep(250)
    }
  }

  if (await visibleSource(ev)) await toggle(send, ev)
  const initialOutline = await outlineSnapshot(ev)
  if (!initialOutline.length) throw new Error('Outline did not finish loading')
  const initialDirty = await dirtyState(ev)
  const results = []

  for (const ratio of ratios) {
    await scrollRich(ev, ratio)
    await clickVisibleText(send, ev)
    const before = await caretContext(ev)
    await toggle(send, ev)
    const sourceOutline = await outlineSnapshot(ev)
    await toggle(send, ev)
    const after = await caretContext(ev)
    const richOutline = await outlineSnapshot(ev)
    const dirty = await dirtyState(ev)
    results.push({
      kind: 'caret', ratio,
      pass: !!before && !!after && before.context === after.context && after.visible &&
        sameOutline(initialOutline, sourceOutline) && sameOutline(initialOutline, richOutline) && dirty === initialDirty,
      before, after,
      outlinesStable: sameOutline(initialOutline, sourceOutline) && sameOutline(initialOutline, richOutline),
      dirtyStable: dirty === initialDirty
    })
  }

  for (const ratio of ratios) {
    await scrollRich(ev, ratio)
    const before = await viewportContext(ev)
    await toggle(send, ev)
    const sourceOutline = await outlineSnapshot(ev)
    await toggle(send, ev)
    const after = await viewportContext(ev)
    const richOutline = await outlineSnapshot(ev)
    const dirty = await dirtyState(ev)
    results.push({
      kind: 'reading', ratio,
      pass: !!before && !!after && before.text === after.text &&
        sameOutline(initialOutline, sourceOutline) && sameOutline(initialOutline, richOutline) && dirty === initialDirty,
      before, after,
      outlinesStable: sameOutline(initialOutline, sourceOutline) && sameOutline(initialOutline, richOutline),
      dirtyStable: dirty === initialDirty
    })
  }

  const report = {
    outline: initialOutline,
    passed: results.filter((item) => item.pass).length,
    total: results.length,
    results
  }
  console.log(JSON.stringify(report, null, 2))
  ws.close()
  process.exit(report.passed === report.total ? 0 : 2)
}

main().catch((error) => {
  console.error('MODE_SWITCH_10X_FAIL', error)
  process.exit(3)
})
