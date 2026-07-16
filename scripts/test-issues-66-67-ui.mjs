// Real Electron regression for split-pane outline targeting (#66) and the
// standard bold/sidebar shortcut separation (#67). Launch a built app with the
// two outline-split fixtures and --remote-debugging-port first.
import { connectCdp, sleep } from './lib/cdp.mjs'

async function clickPane(send, evaluate, side) {
  const point = await evaluate(`(() => {
    const pane = [...document.querySelectorAll('.editor-scroll.hm-pane-${side}, .source-editor.hm-pane-${side}')]
      .find((node) => node.offsetParent)
    const paragraph = pane?.querySelector('.ProseMirror p')
    const rect = (paragraph || pane)?.getBoundingClientRect()
    return rect ? { x: rect.left + Math.min(rect.width / 2, 80), y: rect.top + rect.height / 2 } : null
  })()`)
  if (!point) throw new Error(`${side} pane not found`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(700)
}

async function pressMod(send, key, code, modifiers) {
  const vk = key.toUpperCase().charCodeAt(0)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await sleep(250)
}

const same = (actual, expected) =>
  Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index])

async function main() {
  const { ws, send, evaluate } = await connectCdp()
  await send('Runtime.enable')

  // Launch-path files arrive through the app-ready queue. The CDP target can
  // become available before the second file finishes opening, so wait until
  // both fixture tabs exist and the left editor is genuinely active. Otherwise
  // the late open-paths update can steal focus and make the split pick Welcome.
  let leftReady = false
  for (let i = 0; i < 40 && !leftReady; i++) {
    await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.tab')]
      const left = tabs.find((node) => node.textContent.includes('outline-split-left'))
      const right = tabs.find((node) => node.textContent.includes('outline-split-right'))
      if (left && right) left.click()
      return !!left && !!right
    })()`)
    await sleep(200)
    leftReady = await evaluate(`(() => {
      const active = [...document.querySelectorAll('.tab.active')]
        .some((node) => node.textContent.includes('outline-split-left'))
      const heading = document.querySelector('.editor-scroll.hm-pane-left h1')?.textContent.trim()
      return active && heading === 'Left Alpha'
    })()`)
  }
  if (!leftReady) throw new Error('launch fixtures did not settle on the left document')
  await evaluate(`document.querySelectorAll('.activity-item')[2]?.click()`)
  await sleep(700)
  let paneCount = await evaluate(`document.querySelectorAll('.editor-scroll.hm-pane-left, .editor-scroll.hm-pane-right').length`)
  if (paneCount !== 2) {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.topbar .icon-btn')]
        .find((node) => /Split editor|分屏/.test(node.title || ''))
      button?.click()
      return !!button
    })()`)
    await sleep(1000)
    paneCount = await evaluate(`document.querySelectorAll('.editor-scroll.hm-pane-left, .editor-scroll.hm-pane-right').length`)
  }
  if (paneCount !== 2) throw new Error(`split panes did not open: ${paneCount}`)

  await clickPane(send, evaluate, 'right')
  const rightOutline = await evaluate(`[...document.querySelectorAll('.outline-item-text')].map((node) => node.textContent.trim())`)
  if (!same(rightOutline, ['Right One', 'Right End'])) {
    throw new Error(`outline did not follow right pane: ${JSON.stringify(rightOutline)}`)
  }

  await clickPane(send, evaluate, 'left')
  const leftOutline = await evaluate(`[...document.querySelectorAll('.outline-item-text')].map((node) => node.textContent.trim())`)
  if (!same(leftOutline, ['Left Alpha', 'Left Omega'])) {
    throw new Error(`outline did not follow left pane: ${JSON.stringify(leftOutline)}`)
  }

  // The left pane may switch to source while the right pane stays rich. Outline
  // ownership must still follow focus across the two different editor types.
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  await sleep(800)
  const sourceVisible = await evaluate(`!![...document.querySelectorAll('.source-editor.hm-pane-left')].find((node) => node.offsetParent)`)
  if (!sourceVisible) throw new Error('left source editor did not open')
  await clickPane(send, evaluate, 'right')
  const rightWhileSource = await evaluate(`[...document.querySelectorAll('.outline-item-text')].map((node) => node.textContent.trim())`)
  if (!same(rightWhileSource, ['Right One', 'Right End'])) {
    throw new Error(`right rich outline failed while left was source: ${JSON.stringify(rightWhileSource)}`)
  }
  await clickPane(send, evaluate, 'left')
  const leftSourceOutline = await evaluate(`[...document.querySelectorAll('.outline-item-text')].map((node) => node.textContent.trim())`)
  if (!same(leftSourceOutline, ['Left Alpha', 'Left Omega'])) {
    throw new Error(`left source outline did not regain focus: ${JSON.stringify(leftSourceOutline)}`)
  }
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
  })()`)
  await sleep(800)

  await clickPane(send, evaluate, 'right')
  await evaluate(`(() => {
    const left = document.querySelector('.editor-scroll.hm-pane-left')
    const right = document.querySelector('.editor-scroll.hm-pane-right')
    if (left) left.scrollTop = 0
    if (right) right.scrollTop = 0
    document.querySelectorAll('.outline-item')[1]?.click()
  })()`)
  await sleep(1200)
  const jump = await evaluate(`(() => ({
    left: document.querySelector('.editor-scroll.hm-pane-left')?.scrollTop || 0,
    right: document.querySelector('.editor-scroll.hm-pane-right')?.scrollTop || 0,
    active: document.querySelector('.outline-item.active .outline-item-text')?.textContent.trim() || ''
  }))()`)
  if (jump.right <= 0 || jump.left !== 0 || jump.active !== 'Right End') {
    throw new Error(`outline jump targeted the wrong pane: ${JSON.stringify(jump)}`)
  }

  await clickPane(send, evaluate, 'left')
  const sidebarBefore = await evaluate(`!document.querySelector('.pane-left')?.classList.contains('collapsed')`)
  await evaluate(`(() => {
    window.__horsemdCtrlBPassThrough = null
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyB') {
        window.__horsemdCtrlBPassThrough = !event.defaultPrevented
      }
    }, { capture: true, once: true })
  })()`)
  await pressMod(send, 'b', 'KeyB', 2) // Windows Ctrl+B must pass the global capture listener.
  const ctrlBPassThrough = await evaluate(`({
    passed: window.__horsemdCtrlBPassThrough,
    sidebarOpen: !document.querySelector('.pane-left')?.classList.contains('collapsed')
  })`)
  if (!ctrlBPassThrough.passed || ctrlBPassThrough.sidebarOpen !== sidebarBefore) {
    throw new Error(`Ctrl-B was still captured globally: ${JSON.stringify(ctrlBPassThrough)}`)
  }
  const selectionState = await evaluate(`(() => {
    const root = document.querySelector('.editor-scroll.hm-pane-left .ProseMirror')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const start = node.data.indexOf('Bold target')
      if (start < 0) continue
      const selection = getSelection()
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + 'Bold target'.length)
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return {
        selected: true,
        initiallyMarked: !!node.parentElement?.closest('strong')
      }
    }
    return { selected: false, initiallyMarked: false }
  })()`)
  if (!selectionState.selected) throw new Error('bold target text not found')
  await sleep(150)
  await pressMod(send, 'b', 'KeyB', 4) // Meta on macOS; Ctrl uses the same Mod-B binding on Windows.
  const bold = await evaluate(`(() => ({
    marked: [...document.querySelectorAll('.editor-scroll.hm-pane-left strong')].some((node) => node.textContent.includes('Bold target')),
    sidebarOpen: !document.querySelector('.pane-left')?.classList.contains('collapsed')
  }))()`)
  if (bold.marked === selectionState.initiallyMarked || bold.sidebarOpen !== sidebarBefore) {
    throw new Error(`Mod-B did not stay inside the editor: ${JSON.stringify(bold)}`)
  }

  await pressMod(send, 'b', 'KeyB', 4 | 8) // Meta+Shift+B toggles the sidebar.
  const sidebarAfter = await evaluate(`!document.querySelector('.pane-left')?.classList.contains('collapsed')`)
  if (sidebarAfter === sidebarBefore) throw new Error('Mod-Shift-B did not toggle the sidebar')

  console.log(JSON.stringify({ rightOutline, leftOutline, rightWhileSource, leftSourceOutline, jump, ctrlBPassThrough, bold, sidebarAfter }, null, 2))
  ws.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
