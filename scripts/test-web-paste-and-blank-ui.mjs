// Real Electron regression for clicking below the rich document and for web
// editors (notably WeChat) that copy visual paragraphs as <section>/<div>.
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

async function resetEditor(send, evaluate) {
  await evaluate(`document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')?.focus()`)
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
  })
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
    windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Backspace', code: 'Backspace',
    windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
  })
  await sleep(150)
}

async function paste(evaluate, html, plain) {
  const result = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    if (!editor) return 'no-editor'
    const data = new DataTransfer()
    data.setData('text/html', ${JSON.stringify(html)})
    data.setData('text/plain', ${JSON.stringify(plain)})
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    }))
    return true
  })()`)
  if (result !== true) throw new Error(`paste failed: ${result}`)
  await sleep(300)
}

async function main() {
  const { ws, send } = await connect()
  const evaluate = evaluator(send)
  await send('Runtime.enable')
  await sleep(500)

  const blankPoint = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    const host = editor?.closest('.editor-host')
    if (!editor || !host) return null
    const content = editor.getBoundingClientRect()
    const outer = host.getBoundingClientRect()
    const y = Math.min(outer.bottom - 8, content.bottom + 28)
    return y > content.bottom + 1 ? { x: content.left + Math.min(120, content.width / 2), y } : null
  })()`)
  if (!blankPoint) throw new Error('No clickable blank area below the document')
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: blankPoint.x, y: blankPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: blankPoint.x, y: blankPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.insertText', { text: ' BLANK-END' })
  await sleep(250)
  const blankResult = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return {
      focused: document.activeElement === editor,
      lastText: editor?.lastElementChild?.textContent || ''
    }
  })()`)
  if (!blankResult.focused || !blankResult.lastText.endsWith('BLANK-END')) {
    throw new Error(`blank-area click did not place the caret at the end: ${JSON.stringify(blankResult)}`)
  }

  await resetEditor(send, evaluate)
  await paste(
    evaluate,
    '<section data-mpa-powered-by="yiban.io"><span>微信第一段</span></section>' +
      '<section><strong>微信第二段</strong></section>' +
      '<section><section><em>微信第三段</em></section></section>',
    '微信第一段\n微信第二段\n微信第三段'
  )
  const wechatResult = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return {
      paragraphs: [...editor.children]
        .filter((node) => node.matches('p'))
        .map((node) => node.textContent.trim()),
      bold: [...editor.querySelectorAll('strong')].some((node) => node.textContent === '微信第二段'),
      italic: [...editor.querySelectorAll('em')].some((node) => node.textContent === '微信第三段')
    }
  })()`)
  const expected = ['微信第一段', '微信第二段', '微信第三段']
  if (JSON.stringify(wechatResult.paragraphs) !== JSON.stringify(expected) || !wechatResult.bold || !wechatResult.italic) {
    throw new Error(`web paragraphs or inline marks were lost: ${JSON.stringify(wechatResult)}`)
  }

  await resetEditor(send, evaluate)
  await paste(evaluate, '<ul><li><p>普通列表</p></li></ul>', '普通列表')
  const ordinaryList = await evaluate(`document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror li')?.textContent.trim()`)
  if (ordinaryList !== '普通列表') throw new Error(`ordinary HTML list regressed: ${JSON.stringify(ordinaryList)}`)

  await resetEditor(send, evaluate)
  await paste(
    evaluate,
    '<table><tbody><tr><td>表格 A</td><td>表格 B</td></tr></tbody></table>',
    '表格 A\t表格 B'
  )
  const ordinaryTable = await evaluate(`[...document.querySelectorAll('.editor-scroll:not([style*="display: none"]) .ProseMirror td')].map((node) => node.textContent.trim())`)
  if (JSON.stringify(ordinaryTable) !== JSON.stringify(['表格 A', '表格 B'])) {
    throw new Error(`ordinary HTML table regressed: ${JSON.stringify(ordinaryTable)}`)
  }

  await resetEditor(send, evaluate)
  await paste(
    evaluate,
    '<p>图片前<img alt="测试图片" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">图片后</p>',
    '图片前图片后'
  )
  const ordinaryImage = await evaluate(`(() => {
    const image = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror img[alt="测试图片"]')
    return { found: !!image, paragraph: image?.closest('p')?.textContent || '' }
  })()`)
  if (!ordinaryImage.found || ordinaryImage.paragraph !== '图片前图片后') {
    throw new Error(`ordinary HTML image regressed: ${JSON.stringify(ordinaryImage)}`)
  }

  await resetEditor(send, evaluate)
  await paste(evaluate, '', '# Markdown 标题\n\nMarkdown 正文')
  const markdown = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return { heading: editor?.querySelector('h1')?.textContent, paragraph: editor?.querySelector('p')?.textContent }
  })()`)
  if (markdown.heading !== 'Markdown 标题' || markdown.paragraph !== 'Markdown 正文') {
    throw new Error(`Markdown smart paste regressed: ${JSON.stringify(markdown)}`)
  }

  console.log(JSON.stringify({
    blankResult,
    wechatResult,
    ordinaryList,
    ordinaryTable,
    ordinaryImage,
    markdown
  }, null, 2))
  ws.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
