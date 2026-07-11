// CDP regression for source-mode find. Launch HorseMD with a real document and
// --remote-debugging-port first; this verifies selection, scrolling and overlay.
const port = Number(process.env.CDP_PORT || 9222)
const commonQuery = process.env.FIND_QUERY || '企业'
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
  if (!page) throw new Error(`No Electron page found on port ${port}`)
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
    const current = ++id
    pending.set(current, resolve)
    ws.send(JSON.stringify({ id: current, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text)
    return response.result?.result?.value
  }
  return { ws, send, evaluate }
}

async function main() {
  const { ws, send, evaluate } = await connect()
  await sleep(800)
  await evaluate(`(() => {
    document.querySelector('.tab[title="欢迎使用 HorseMD.md"] .tab-close')?.click()
    if (!document.querySelector('textarea.source-editor')) {
      [...document.querySelectorAll('.status-btn')].find((button) => button.title?.includes('Ctrl+/'))?.click()
    }
    return true
  })()`)
  await sleep(700)
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'f', code: 'KeyF', modifiers: 2,
    windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2,
    windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3
  })
  await sleep(150)

  const setQuery = async (query) => {
    await evaluate(`(() => {
      const input = document.querySelector('.findbar input')
      if (!input) return false
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(250)
  }
  const snapshot = () => evaluate(`(() => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    if (!textarea) return { error: 'No visible source textarea' }
    const textareaRect = textarea.getBoundingClientRect()
    const marks = [...document.querySelectorAll('.hm-source-find-current')].map((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, width: rect.width }
    })
    return {
      count: document.querySelector('.findbar-count')?.textContent || '',
      selection: [textarea.selectionStart, textarea.selectionEnd],
      scrollTop: textarea.scrollTop,
      maxScroll: Math.max(0, textarea.scrollHeight - textarea.clientHeight),
      viewportTop: textareaRect.top,
      viewportBottom: textareaRect.bottom,
      viewportCenter: (textareaRect.top + textareaRect.bottom) / 2,
      marks
    }
  })()`)
  const revealed = (state) => {
    if (state.marks?.length !== 1) return false
    const mark = state.marks[0]
    const centered = Math.abs((mark.top + mark.bottom) / 2 - state.viewportCenter) < 36
    const visible = mark.top >= state.viewportTop && mark.bottom <= state.viewportBottom
    const atBoundary = state.scrollTop <= 1 || state.scrollTop >= state.maxScroll - 1
    return centered || (atBoundary && visible)
  }

  const unique = await evaluate(`(() => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    const value = textarea?.value || ''
    const words = value.slice(Math.floor(value.length * 0.7)).match(/[\\u4e00-\\u9fff]{6,12}/g) || []
    const query = words.find((word) => value.indexOf(word) === value.lastIndexOf(word))
    return query ? { query, offset: value.indexOf(query) } : null
  })()`)
  if (!unique) throw new Error('Could not find a unique late-document query')
  await setQuery(unique.query)
  const uniqueState = await snapshot()
  const uniquePass = uniqueState.selection[0] === unique.offset && revealed(uniqueState)

  await setQuery(commonQuery)
  const initial = await snapshot()
  const total = Number(initial.count.split('/')[1] || 0)
  if (total < 2) throw new Error(`Query ${JSON.stringify(commonQuery)} needs at least two matches`)
  const steps = []
  for (let i = 0; i < Math.min(10, total - 1); i++) {
    await evaluate(`document.querySelectorAll('.findbar-row')[0].querySelectorAll('button')[1].click()`)
    await sleep(150)
    steps.push(await snapshot())
  }
  const stepsPass = steps.every((state, index) =>
    state.count.startsWith(`${index + 2}/`) && state.selection[0] >= 0 && revealed(state)
  )
  const passed = uniquePass && stepsPass
  console.log(JSON.stringify({ passed, unique: { ...unique, state: uniqueState }, commonQuery, total, steps }, null, 2))
  ws.close()
  process.exit(passed ? 0 : 2)
}

main().catch((error) => {
  console.error(`SOURCE_FIND_FAIL: ${error.message}`)
  process.exit(1)
})
