// Real Electron regression for the fixed app viewport and wide-table scrolling.
// Launch a built app with --remote-debugging-port first and open the fixture at
// scripts/fixtures/table-scroll.md.
const port = Number(process.env.CDP_PORT || 9222)
const base = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  let targets = []
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`${base}/json/list`)).json()
      if (targets.some((target) => target.type === 'page')) break
    } catch {}
    await sleep(250)
  }
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error(`No Electron page found on CDP port ${port}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    pending.get(message.id)(message)
    pending.delete(message.id)
  })
  await new Promise((resolve) => { ws.onopen = resolve })
  const send = (method, params = {}) => new Promise((resolve) => {
    const callId = ++id
    pending.set(callId, resolve)
    ws.send(JSON.stringify({ id: callId, method, params }))
  })
  return { ws, send }
}

function evaluator(send) {
  return async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description || 'CDP evaluation failed')
    }
    return response.result?.result?.value
  }
}

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

async function main() {
  const { ws, send } = await connect()
  const evaluate = evaluator(send)
  await send('Runtime.enable')
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(1200)

  const desktop = await inspect(evaluate)
  verifyLayout(desktop, 'desktop')
  await verifyTableHandles(send, evaluate)
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
