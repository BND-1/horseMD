// Real Electron regression for the fixed app viewport and wide-table scrolling.
// Launch a built app with --remote-debugging-port first and open the fixture at
// scripts/fixtures/table-scroll.md.
import { connectCdp, sleep } from './lib/cdp.mjs'

function verifyLayout(result, label) {
  if (!result.rootLocked || result.documentScrollTop !== 0) {
    throw new Error(`${label}: document shell can still scroll: ${JSON.stringify(result)}`)
  }
  if (Math.abs(result.appTop) > 1 || Math.abs(result.appBottom - result.viewportHeight) > 1) {
    throw new Error(`${label}: app does not fill the viewport: ${JSON.stringify(result)}`)
  }
  if (result.markdownTables < 2 || !result.wideMarkdownScrollable) {
    throw new Error(`${label}: wide Markdown table is not independently scrollable: ${JSON.stringify(result)}`)
  }
  if (!result.rawHtmlScrollable) {
    throw new Error(`${label}: raw HTML table is not independently scrollable: ${JSON.stringify(result)}`)
  }
  const widenedParent = result.parentWidths.find((item) => item.scroll > item.client + 1)
  if (widenedParent) {
    throw new Error(`${label}: table widened ${widenedParent.name}: ${JSON.stringify(result)}`)
  }
}

async function inspect(evaluate, mobile = false) {
  return evaluate(`(() => {
    const app = document.querySelector('.app')
    app.classList.toggle('is-mobile', ${mobile})
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const editor = rich?.closest('.editor-scroll')
    const markdownTables = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
    const compactWrapper = markdownTables[0]?.querySelector('.table-wrapper')
    const wideWrapper = markdownTables[1]?.querySelector('.table-wrapper')
    const rawBlock = rich?.querySelector('.hm-html-block')
    const appRect = app?.getBoundingClientRect()
    const editorHost = rich?.closest('.editor-host')
    const milkdown = rich?.closest('.milkdown')
    const parentWidths = [
      ['document', document.documentElement],
      ['editor-scroll', editor],
      ['editor-host', editorHost],
      ['milkdown', milkdown],
      ['ProseMirror', rich]
    ].filter(([, node]) => node).map(([name, node]) => ({
      name,
      client: node.clientWidth,
      scroll: node.scrollWidth
    }))
    const compactMarkdownScrollable = !!compactWrapper && compactWrapper.scrollWidth > compactWrapper.clientWidth + 1
    const wideMarkdownScrollable = !!wideWrapper && wideWrapper.scrollWidth > wideWrapper.clientWidth + 1
    const rawHtmlScrollable = !!rawBlock && rawBlock.scrollWidth > rawBlock.clientWidth + 1
    document.scrollingElement.scrollTop = 100
    if (wideWrapper) wideWrapper.scrollLeft = wideWrapper.scrollWidth
    if (rawBlock) rawBlock.scrollLeft = rawBlock.scrollWidth
    const rootStyle = getComputedStyle(document.documentElement)
    const bodyStyle = getComputedStyle(document.body)
    const rootNodeStyle = getComputedStyle(document.querySelector('#root'))
    return {
      rootLocked: rootStyle.overflow === 'hidden' && bodyStyle.overflow === 'hidden' && rootNodeStyle.overflow === 'hidden',
      documentScrollTop: document.scrollingElement.scrollTop,
      appTop: appRect?.top,
      appBottom: appRect?.bottom,
      viewportHeight: innerHeight,
      markdownTables: markdownTables.length,
      compactMarkdownScrollable,
      wideMarkdownScrollable: wideMarkdownScrollable && wideWrapper.scrollLeft > 0,
      rawHtmlScrollable: rawHtmlScrollable && rawBlock.scrollLeft > 0,
      parentWidths,
      wideClientWidth: wideWrapper?.clientWidth || 0,
      wideScrollWidth: wideWrapper?.scrollWidth || 0,
      rawClientWidth: rawBlock?.clientWidth || 0,
      rawScrollWidth: rawBlock?.scrollWidth || 0
    }
  })()`)
}

async function verifyHorizontalGesture(send, evaluate, label, touch = false) {
  const point = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const wrapper = rich?.querySelectorAll('.milkdown-table-block')[1]?.querySelector('.table-wrapper')
    if (!wrapper) return null
    wrapper.scrollIntoView({ block: 'center' })
    wrapper.scrollLeft = 0
    const rect = wrapper.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!point) throw new Error(`${label}: wide table gesture target not found`)
  if (touch) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: point.x + 80, y: point.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }]
    })
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: point.x + 80 - i * 30, y: point.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }]
      })
      await sleep(30)
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 360,
      deltaY: 0
    })
  }
  await sleep(150)
  const scrollLeft = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return rich?.querySelectorAll('.milkdown-table-block')[1]?.querySelector('.table-wrapper')?.scrollLeft || 0
  })()`)
  if (scrollLeft <= 0) throw new Error(`${label}: horizontal gesture did not move the table`)
}

async function verifyTableHandles(send, evaluate) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await sleep(100)
  const hidden = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const handles = [...(rich?.querySelectorAll('.milkdown-table-block > div > .cell-handle[data-show="false"]') || [])]
    return {
      count: handles.length,
      allRemovedFromLayout: handles.every((handle) => getComputedStyle(handle).display === 'none')
    }
  })()`)
  if (!hidden.count || !hidden.allRemovedFromLayout) {
    throw new Error(`desktop: hidden table handles can widen the editor: ${JSON.stringify(hidden)}`)
  }

  const point = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = rich?.querySelectorAll('.milkdown-table-block')[1]
    block?.scrollIntoView({ block: 'center' })
    const wrapper = block?.querySelector('.table-wrapper')
    if (wrapper) wrapper.scrollLeft = 0
    const cell = block?.querySelector('td, th')
    const rect = cell?.getBoundingClientRect()
    return rect ? { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 } : null
  })()`)
  if (!point) throw new Error('desktop: table handle target not found')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await sleep(150)
  const visible = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = rich?.querySelectorAll('.milkdown-table-block')[1]
    const handles = [...(block?.querySelectorAll(':scope > div > .cell-handle[data-show="true"]') || [])]
    const allHandles = [...(block?.querySelectorAll(':scope > div > .cell-handle') || [])]
    return {
      count: handles.length,
      anyVisible: handles.some((handle) => getComputedStyle(handle).display !== 'none'),
      states: allHandles.map((handle) => ({
        show: handle.getAttribute('data-show'),
        display: getComputedStyle(handle).display,
        className: handle.className
      }))
    }
  })()`)
  if (!visible.count || !visible.anyVisible) {
    throw new Error(`desktop: table handles do not reappear on hover: ${JSON.stringify(visible)}`)
  }
}

async function verifyTableControlBounds(send, evaluate) {
  const verticalOffset = Number(process.env.TABLE_SCROLL_Y || 260)
  const horizontalRatio = Number(process.env.TABLE_SCROLL_X || 1)
  const point = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const editor = rich?.closest('.editor-scroll')
    const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    if (!editor || !block) return null
    block.scrollIntoView({ block: 'start' })
    editor.scrollTop += ${verticalOffset}
    const wrapper = block.querySelector('.table-wrapper')
    wrapper.scrollLeft = (wrapper.scrollWidth - wrapper.clientWidth) * ${horizontalRatio}
    const editorRect = editor.getBoundingClientRect()
    const cell = [...block.querySelectorAll('td')].find((node) => {
      const rect = node.getBoundingClientRect()
      return rect.top > editorRect.top + 80 && rect.bottom < editorRect.bottom - 20 &&
        rect.left > editorRect.left + 20 && rect.right < editorRect.right - 20
    })
    const rect = cell?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!point) throw new Error('desktop: tall table control target not found')
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await sleep(250)

  const handlePoint = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    const handle = block?.querySelector('[data-role="col-drag-handle"]')
    const rect = handle?.getBoundingClientRect()
    const x = rect?.left + rect?.width / 2
    const y = rect?.top + rect?.height / 2
    return rect && handle.dataset.show === 'true' && handle.contains(document.elementFromPoint(x, y))
      ? { x, y }
      : null
  })()`)
  if (!handlePoint) throw new Error('desktop: tall table column handle did not appear')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handlePoint, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...handlePoint, button: 'left', clickCount: 1 })
  await sleep(250)

  const column = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const editor = rich?.closest('.editor-scroll')
    const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    const handle = block?.querySelector('[data-role="col-drag-handle"]')
    const group = handle?.querySelector('.button-group[data-show="true"]')
    const bounds = editor?.getBoundingClientRect()
    const blockBounds = block?.getBoundingClientRect()
    const handleRect = handle?.getBoundingClientRect()
    const groupRect = group?.getBoundingClientRect()
    return {
      bounds: bounds?.toJSON(),
      blockBounds: blockBounds?.toJSON(),
      handle: handleRect?.toJSON(),
      group: groupRect?.toJSON(),
      below: group?.classList.contains('hm-table-menu-below'),
      paintRelaxed: block?.classList.contains('hm-table-controls-open'),
      buttons: [...(group?.querySelectorAll('button') || [])].map((button) => {
        const rect = button.getBoundingClientRect()
        return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
      })
    }
  })()`)
  if (!column.handle || !column.group || column.handle.top < column.bounds.top + 7 ||
      column.group.top < column.bounds.top + 7 || column.group.left < column.bounds.left + 7 ||
      column.group.right > column.bounds.right - 7 || !column.paintRelaxed ||
      column.buttons.length !== 4 || column.buttons.some((hit) => !hit)) {
    throw new Error(`desktop: column controls escaped the editor viewport: ${JSON.stringify(column)}`)
  }

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await sleep(200)
  const rowHandlePoint = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    const handle = block?.querySelector('[data-role="row-drag-handle"]')
    const rect = handle?.getBoundingClientRect()
    const x = rect?.left + rect?.width / 2
    const y = rect?.top + rect?.height / 2
    return rect && handle.dataset.show === 'true' && handle.contains(document.elementFromPoint(x, y))
      ? { x, y }
      : null
  })()`)
  if (!rowHandlePoint) throw new Error('desktop: tall table row handle did not appear')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rowHandlePoint, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rowHandlePoint, button: 'left', clickCount: 1 })
  await sleep(250)
  const row = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const editor = rich?.closest('.editor-scroll')
    const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    const group = block?.querySelector('[data-role="row-drag-handle"] .button-group[data-show="true"]')
    const bounds = editor?.getBoundingClientRect()
    const blockBounds = block?.getBoundingClientRect()
    const rect = group?.getBoundingClientRect()
    const button = group?.querySelector('button')
    const buttonRect = button?.getBoundingClientRect()
    return {
      bounds: bounds?.toJSON(),
      blockBounds: blockBounds?.toJSON(),
      group: rect?.toJSON(),
      paintRelaxed: block?.classList.contains('hm-table-controls-open'),
      buttonHit: !!button && button.contains(document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2))
    }
  })()`)
  if (!row.group || row.group.top < row.bounds.top + 7 || row.group.left < row.bounds.left + 7 ||
      row.group.right > row.bounds.right - 7 || !row.paintRelaxed || !row.buttonHit) {
    throw new Error(`desktop: row controls escaped the editor viewport: ${JSON.stringify(row)}`)
  }
}

async function verifyTableAddButtons(send, evaluate) {
  const target = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...(rich?.querySelectorAll('.milkdown-table-block') || [])]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const wrapper = block.querySelector('.table-wrapper')
    wrapper.scrollLeft = 0
    const cell = block.querySelector('td')
    const rect = cell?.getBoundingClientRect()
    return rect ? {
      col: { x: rect.left + 2, y: rect.top + rect.height / 2 },
      row: { x: rect.left + rect.width / 2, y: rect.bottom - 2 }
    } : null
  })()`)
  if (!target) throw new Error('desktop: add-button target not found')

  const activateAndClick = async (role, point) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await sleep(250)
    const button = await evaluate(`(() => {
      const handle = [...document.querySelectorAll('.line-handle')]
        .find((node) => node.offsetParent && node.dataset.role === '${role}' && node.dataset.show === 'true')
      const button = handle?.querySelector('.add-button')
      const rect = button?.getBoundingClientRect()
      if (!rect) return null
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      return { x, y, hit: button.contains(document.elementFromPoint(x, y)) }
    })()`)
    if (!button?.hit) throw new Error(`desktop: ${role} add button is clipped: ${JSON.stringify(button)}`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y, button: 'left', clickCount: 1 })
    await sleep(250)
  }

  const before = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...rich.querySelectorAll('.milkdown-table-block')]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    return { rows: block.querySelectorAll('tr').length, cols: block.querySelector('tr').children.length }
  })()`)
  await activateAndClick('y-line-drag-handle', target.col)
  const afterCol = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...rich.querySelectorAll('.milkdown-table-block')]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    return block.querySelector('tr').children.length
  })()`)
  if (afterCol !== before.cols + 1) throw new Error(`desktop: add column failed: ${before.cols} -> ${afterCol}`)

  const rowPoint = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...rich.querySelectorAll('.milkdown-table-block')]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    const rect = block.querySelector('td')?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.bottom - 2 } : null
  })()`)
  await activateAndClick('x-line-drag-handle', rowPoint)
  const afterRow = await evaluate(`(() => {
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = [...rich.querySelectorAll('.milkdown-table-block')]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    return block.querySelectorAll('tr').length
  })()`)
  if (afterRow !== before.rows + 1) throw new Error(`desktop: add row failed: ${before.rows} -> ${afterRow}`)
}

async function main() {
  const { ws, send, evaluate } = await connectCdp()
  await send('Runtime.enable')
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(1200)

  if (process.env.TABLE_CONTROLS_ONLY === '1') {
    await verifyTableAddButtons(send, evaluate)
    await verifyTableControlBounds(send, evaluate)
    console.log('table controls: visible and hit-testable inside the table block')
    ws.close()
    return
  }

  const desktop = await inspect(evaluate)
  verifyLayout(desktop, 'desktop')
  await verifyTableHandles(send, evaluate)
  await verifyTableAddButtons(send, evaluate)
  await verifyTableControlBounds(send, evaluate)
  await verifyHorizontalGesture(send, evaluate, 'desktop')

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  await sleep(300)
  const mobile = await inspect(evaluate, true)
  verifyLayout(mobile, 'mobile width')
  await verifyHorizontalGesture(send, evaluate, 'mobile width', true)

  console.log(JSON.stringify({ desktop, mobile }, null, 2))
  await evaluate(`(() => {
    document.querySelector('.app')?.classList.remove('is-mobile')
    const rich = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    rich?.querySelectorAll('.table-wrapper, .hm-html-block').forEach((node) => { node.scrollLeft = 0 })
  })()`)
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
