// Real Electron regression for Issues #57, #58, and the #60 export dialog.
// Launch a built app with --remote-debugging-port first. #59's geometry is
// covered by test-menu-position.mjs because native pointer placement varies by
// window manager while the clamping rule itself is pure.
const port = Number(process.env.CDP_PORT || 9222)
const base = `http://127.0.0.1:${port}`
const issue59Dir = process.env.ISSUE59_DIR || ''
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

async function click(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
}

async function key(send, value, code = value, virtualKeyCode = value.charCodeAt(0)) {
  const params = { key: value, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function main() {
  const { ws, send } = await connect()
  const evaluate = evaluator(send)
  await send('Runtime.enable')
  await sleep(900)

  const pointForText = async (text) => evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...pm.querySelectorAll('p,h1,h2,h3')].find((item) => item.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.right - 2, y: rect.top + rect.height / 2 }
  })()`)

  // #57: /math converts the current paragraph, keeps CodeMirror visible, and
  // accepts a multi-character formula without dropping focus.
  const formulaPoint = await pointForText('Formula target')
  if (!formulaPoint) throw new Error('Formula fixture paragraph not found')
  await click(send, formulaPoint.x, formulaPoint.y)
  await key(send, 'End', 'End', 35)
  await key(send, 'Enter', 'Enter', 13)
  await send('Input.insertText', { text: '/math' })
  await sleep(250)
  await key(send, 'Enter', 'Enter', 13)
  await sleep(350)
  await send('Input.insertText', { text: 'x^2 + \\sqrt{4}' })
  await sleep(450)
  const math = await evaluate(`(() => {
    const latex = document.activeElement?.closest('.cm-editor')
    latex?.setAttribute('data-issue-57', '1')
    const host = latex?.closest('.codemirror-host')
    return {
      text: latex?.querySelector('.cm-content')?.textContent || '',
      visible: !!host && getComputedStyle(host).display !== 'none',
      focused: !!latex?.contains(document.activeElement)
    }
  })()`)
  if (!math.text.includes('x^2 + \\sqrt{4}') || !math.visible || !math.focused) {
    throw new Error(`Math editing lost content/focus: ${JSON.stringify(math)}`)
  }

  const dollarPoint = await pointForText('PDF section')
  if (!dollarPoint) throw new Error('Dollar-math fixture heading not found')
  await click(send, dollarPoint.x, dollarPoint.y)
  await key(send, 'End', 'End', 35)
  await key(send, 'Enter', 'Enter', 13)
  await send('Input.insertText', { text: '$$' })
  await key(send, 'Enter', 'Enter', 13)
  await sleep(300)
  await send('Input.insertText', { text: 'z+1' })
  await sleep(300)
  const dollarMath = await evaluate(`(() => {
    const editor = document.activeElement?.closest('.cm-editor')
    return {
      text: editor?.querySelector('.cm-content')?.textContent || '',
      visible: !!editor && getComputedStyle(editor.closest('.codemirror-host')).display !== 'none',
      focused: !!editor?.contains(document.activeElement)
    }
  })()`)
  if (dollarMath.text !== 'z+1' || !dollarMath.visible || !dollarMath.focused) {
    throw new Error(`Dollar math editing lost content/focus: ${JSON.stringify(dollarMath)}`)
  }

  // #58: an empty backtick pair enters inline-code mode. After closing it,
  // clicking the rendered trailing edge and typing appends within the mark.
  const inlinePoint = await pointForText('Inline target')
  if (!inlinePoint) throw new Error('Inline-code fixture paragraph not found')
  await click(send, inlinePoint.x, inlinePoint.y)
  const mathSettled = await evaluate(`(() => {
    const editor = document.querySelector('.cm-editor[data-issue-57="1"]')
    const host = editor?.closest('.codemirror-host')
    return !!host && getComputedStyle(host).display === 'none'
  })()`)
  if (!mathSettled) throw new Error('Math source did not return to preview-only mode after blur')
  await key(send, 'End', 'End', 35)
  await send('Input.insertText', { text: ' ' })
  await send('Input.insertText', { text: '`' })
  await send('Input.insertText', { text: '`' })
  await send('Input.insertText', { text: 'ab' })
  await send('Input.insertText', { text: '`' })
  await sleep(250)
  const codePoint = await evaluate(`(() => {
    const code = [...document.querySelectorAll('.ProseMirror code')].find((node) => node.textContent === 'ab')
    if (!code) return null
    code.setAttribute('data-issue-58', '1')
    const rect = code.getBoundingClientRect()
    return { x: rect.right - 0.25, y: rect.top + rect.height / 2 }
  })()`)
  if (!codePoint) throw new Error('Inline code pair did not render')
  await click(send, codePoint.x, codePoint.y)
  await send('Input.insertText', { text: 'c' })
  await sleep(250)
  const inlineText = await evaluate(`document.querySelector('code[data-issue-58="1"]')?.textContent || ''`)
  if (inlineText !== 'abc') throw new Error(`Inline-code boundary append failed: ${inlineText}`)

  // #59: open the context menu on the final visible file row. The measured
  // menu must move upward enough that its destructive action remains visible.
  let contextMenu = { skipped: true }
  if (issue59Dir) {
    const bottomRow = await evaluate(`(() => {
      const tree = document.querySelector('.tree')
      tree.scrollTop = tree.scrollHeight
      const rows = [...tree.querySelectorAll('.tree-row')].filter((node) => node.offsetParent)
      const row = rows.at(-1)
      const rect = row?.getBoundingClientRect()
      return rect ? { x: rect.left + 40, y: rect.top + rect.height / 2 } : null
    })()`)
    if (!bottomRow) throw new Error('Issue #59 bottom file row not found')
    await click(send, bottomRow.x, bottomRow.y, 'right')
    await sleep(180)
    contextMenu = await evaluate(`(() => {
      const menu = document.querySelector('.context-menu')
      const rect = menu?.getBoundingClientRect()
      const buttons = menu ? [...menu.querySelectorAll('button')].map((node) => node.textContent.trim()) : []
      return {
        top: rect?.top,
        bottom: rect?.bottom,
        viewport: innerHeight,
        hasDelete: buttons.some((text) => /删除|Delete/i.test(text))
      }
    })()`)
    if (contextMenu.top < 0 || contextMenu.bottom > contextMenu.viewport || !contextMenu.hasDelete) {
      throw new Error(`Sidebar context menu is clipped: ${JSON.stringify(contextMenu)}`)
    }
    await evaluate(`document.body.click()`)
  }

  // #60: every PDF entry point now opens the page-options dialog before the
  // native save dialog. Exercise the tab context-menu route and custom fields.
  const tabPoint = await evaluate(`(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab')
    const rect = tab?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!tabPoint) throw new Error('Active tab not found')
  await click(send, tabPoint.x, tabPoint.y, 'right')
  await sleep(150)
  const opened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => /PDF/i.test(node.textContent))
    button?.click()
    return !!button
  })()`)
  if (!opened) throw new Error('PDF context-menu command not found')
  await sleep(200)
  const dialog = await evaluate(`(() => {
    const modal = document.querySelector('.hm-pdf-modal')
    const selects = modal ? [...modal.querySelectorAll('select')] : []
    return {
      open: !!modal,
      selectCount: selects.length,
      orientationCount: modal?.querySelectorAll('input[type="radio"]').length || 0
    }
  })()`)
  if (!dialog.open || dialog.selectCount !== 2 || dialog.orientationCount !== 2) {
    throw new Error(`PDF options dialog incomplete: ${JSON.stringify(dialog)}`)
  }
  const customFields = await evaluate(`(() => {
    const select = document.querySelector('.hm-pdf-modal select')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'Custom')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!customFields) throw new Error('Could not switch PDF dialog to custom size')
  await sleep(100)
  const customDialog = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.hm-pdf-custom input')]
    return {
      inputCount: inputs.length,
      values: inputs.map((input) => input.value),
      ranges: inputs.map((input) => [input.min, input.max])
    }
  })()`)
  if (customDialog.inputCount !== 2 || customDialog.ranges.some(([min, max]) => min !== '50' || max !== '1000')) {
    throw new Error(`PDF custom-size controls incomplete: ${JSON.stringify(customDialog)}`)
  }
  await evaluate(`document.querySelector('.hm-pdf-modal .hm-pdf-actions button')?.click()`)

  console.log(`PASS Electron UI #57–#60: ${JSON.stringify({ math, dollarMath, mathSettled, inlineText, contextMenu, dialog, customDialog })}`)
  ws.close()
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exit(1)
})
