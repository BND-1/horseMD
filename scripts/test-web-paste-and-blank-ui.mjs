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
    const scroll = host?.closest('.editor-scroll')
    if (!editor || !host || !scroll) return null
    const content = editor.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const scrollRect = scroll.getBoundingClientRect()
    // Exercise the real regression: click below editor-host, where the old
    // listener never received the event, rather than inside its 20vh padding.
    const y = Math.min(scrollRect.bottom - 20, Math.max(hostRect.bottom + 40, content.bottom + 28))
    const x = content.left + Math.min(120, content.width / 2)
    const target = document.elementFromPoint(x, y)
    return y > hostRect.bottom + 1 && target?.closest('.editor-scroll') === scroll
      ? { x, y, target: target.className }
      : null
  })()`)
  if (!blankPoint) throw new Error('No clickable blank area below the document')
  const blankBefore = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return {
      childCount: editor?.children.length || 0,
      lastText: editor?.lastElementChild?.textContent || ''
    }
  })()`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: blankPoint.x, y: blankPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: blankPoint.x, y: blankPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.insertText', { text: 'BLANK-END' })
  await sleep(250)
  const blankResult = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return {
      focused: document.activeElement === editor,
      childCount: editor?.children.length || 0,
      previousText: editor?.lastElementChild?.previousElementSibling?.textContent || '',
      lastText: editor?.lastElementChild?.textContent || ''
    }
  })()`)
  if (!blankResult.focused ||
      blankResult.childCount !== blankBefore.childCount + 1 ||
      blankResult.previousText !== blankBefore.lastText ||
      blankResult.lastText !== 'BLANK-END') {
    throw new Error(`blank-area click did not create the next paragraph: ${JSON.stringify({ blankBefore, blankResult })}`)
  }

  // Some built-in/custom themes stretch ProseMirror to the viewport height.
  // In that layout the blank click target is the root contenteditable itself,
  // not editor-host/editor-scroll. It must still resolve to the document end.
  const stretchedPoint = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    const scroll = editor?.closest('.editor-scroll')
    if (!editor || !scroll) return null
    editor.style.minHeight = scroll.clientHeight + 'px'
    const last = editor.lastElementChild?.getBoundingClientRect()
    const outer = scroll.getBoundingClientRect()
    const x = editor.getBoundingClientRect().left + Math.min(120, editor.clientWidth / 2)
    const y = Math.min(outer.bottom - 24, last.bottom + 80)
    return document.elementFromPoint(x, y) === editor ? { x, y } : null
  })()`)
  if (!stretchedPoint) throw new Error('No ProseMirror-owned blank area for stretched-theme regression')
  const stretchedBefore = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return { childCount: editor?.children.length || 0, lastText: editor?.lastElementChild?.textContent || '' }
  })()`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: stretchedPoint.x, y: stretchedPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: stretchedPoint.x, y: stretchedPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.insertText', { text: 'STRETCHED-END' })
  await sleep(250)
  const stretchedResult = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    editor.style.minHeight = ''
    return {
      focused: document.activeElement === editor,
      childCount: editor?.children.length || 0,
      previousText: editor?.lastElementChild?.previousElementSibling?.textContent || '',
      lastText: editor?.lastElementChild?.textContent || ''
    }
  })()`)
  if (!stretchedResult.focused ||
      stretchedResult.childCount !== stretchedBefore.childCount + 1 ||
      stretchedResult.previousText !== stretchedBefore.lastText ||
      stretchedResult.lastText !== 'STRETCHED-END') {
    throw new Error(`stretched blank-area click did not create the next paragraph: ${JSON.stringify({ stretchedBefore, stretchedResult })}`)
  }

  // A document that already ends in an empty paragraph must reuse it instead
  // of accumulating another empty paragraph for every blank-area click.
  await resetEditor(send, evaluate)
  const emptyBefore = await evaluate(`document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')?.children.length || 0`)
  const emptyPoint = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    const scroll = editor?.closest('.editor-scroll')
    const last = editor?.lastElementChild?.getBoundingClientRect()
    const outer = scroll?.getBoundingClientRect()
    if (!editor || !scroll || !last || !outer) return null
    const x = editor.getBoundingClientRect().left + Math.min(120, editor.clientWidth / 2)
    const y = Math.min(outer.bottom - 20, last.bottom + 40)
    return { x, y }
  })()`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: emptyPoint.x, y: emptyPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: emptyPoint.x, y: emptyPoint.y,
    button: 'left', clickCount: 1
  })
  await send('Input.insertText', { text: 'EMPTY-REUSED' })
  await sleep(250)
  const emptyResult = await evaluate(`(() => {
    const editor = document.querySelector('.editor-scroll:not([style*="display: none"]) .ProseMirror')
    return { childCount: editor?.children.length || 0, lastText: editor?.lastElementChild?.textContent || '' }
  })()`)
  if (emptyResult.childCount !== emptyBefore || emptyResult.lastText !== 'EMPTY-REUSED') {
    throw new Error(`existing trailing paragraph was not reused: ${JSON.stringify({ emptyBefore, emptyResult })}`)
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
    stretchedResult,
    emptyResult,
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
