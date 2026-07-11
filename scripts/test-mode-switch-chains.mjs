// Continuous source/rich caret regression. Tests both chains requested by the
// user with real mouse clicks:
//   source -> rich -> source -> rich
//   rich -> source -> rich -> source
const base = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const connect = async () => {
  let targets = []
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(base + '/json/list')).json()
      if (targets.some((target) => target.type === 'page')) break
    } catch {}
    await sleep(250)
  }
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('No Electron page found on CDP port 9222')
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
  return { ws, send }
}

const evaluator = (send) => async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || 'Runtime.evaluate failed')
  return response.result?.result?.value
}

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const inSource = (ev) => ev(`[...document.querySelectorAll('textarea.source-editor')].some((node) => node.offsetParent !== null)`)

const toggle = async (send, ev) => {
  const point = await ev(`(() => {
    const button = [...document.querySelectorAll('.status-btn')].find((node) => node.title?.includes('Ctrl+/'))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (!point) throw new Error('Source toggle button not found')
  await click(send, point)
  await sleep(1300)
}

const ensureRich = async (send, ev) => {
  if (await inSource(ev)) await toggle(send, ev)
}

const ensureSource = async (send, ev) => {
  if (!(await inSource(ev))) await toggle(send, ev)
}

const enableHeavyRich = async (send, ev) => {
  if (await ev(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent !== null)`)) return
  const point = await ev(`(() => {
    const button = document.querySelector('.hm-heavy-banner button')
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (point) await click(send, point)
  for (let i = 0; i < 100; i++) {
    const ready = await ev(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent !== null) && !document.querySelector('.editor-skeleton')`)
    if (ready) break
    await sleep(250)
  }
  await sleep(800)
}

const sourceContext = (ev) => ev(`(() => {
  const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null)
  if (!textarea) return null
  const offset = textarea.selectionStart
  const value = textarea.value || ''
  return {
    offset,
    context: value.slice(Math.max(0, offset - 24), offset + 24),
    visible: document.activeElement === textarea && textarea.selectionStart === textarea.selectionEnd,
    scrollTop: Math.round(textarea.scrollTop)
  }
})()`)

const richContext = (ev) => ev(`(() => {
  const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const selection = getSelection()
  if (!pm || !selection?.rangeCount || !pm.contains(selection.anchorNode)) return null
  const caret = selection.getRangeAt(0).cloneRange()
  caret.collapse(true)
  const before = document.createRange()
  before.selectNodeContents(pm)
  before.setEnd(caret.startContainer, caret.startOffset)
  const offset = before.toString().length
  const text = pm.textContent || ''
  const rect = caret.getBoundingClientRect()
  const host = pm.closest('.editor-scroll')
  const hostRect = host.getBoundingClientRect()
  const active = document.activeElement
  const codeBlock = (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement)?.closest?.('.milkdown-code-block')
  return {
    offset,
    context: text.slice(Math.max(0, offset - 24), offset + 24),
    visible: rect.top >= hostRect.top - 2 && rect.bottom <= hostRect.bottom + 2,
    rectTop: Math.round(rect.top),
    hostTop: Math.round(hostRect.top),
    hostBottom: Math.round(hostRect.bottom),
    scrollTop: Math.round(host.scrollTop),
    activeClass: active?.className || active?.tagName || '',
    codeBlockTop: codeBlock ? Math.round(codeBlock.getBoundingClientRect().top) : null
  }
})()`)

const scrollSourceAndClick = async (send, ev, ratio) => {
  const offsets = [0, 0.01, -0.01, 0.02, -0.02]
  const yFractions = [0.5, 0.38, 0.62]
  for (const offset of offsets) {
    for (const yFraction of yFractions) {
      const point = await ev(`(() => {
        const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null)
        if (!textarea) return null
        const ratio = Math.max(0, Math.min(1, ${ratio} + ${offset}))
        textarea.scrollTop = ratio * Math.max(0, textarea.scrollHeight - textarea.clientHeight)
        const rect = textarea.getBoundingClientRect()
        return { x: Math.round(rect.left + rect.width * 0.58), y: Math.round(rect.top + rect.height * ${yFraction}) }
      })()`)
      await sleep(100)
      if (!point) throw new Error('Visible source textarea not found')
      await click(send, point)
      await sleep(100)
      const context = (await sourceContext(ev))?.context || ''
      const prose = context.replace(/https?:\S+|[^\s]*\.(?:jpe?g|png|gif|webp)\)?/gi, '')
      if (/[\u3400-\u9fff]{4}|[A-Za-z]{8}/u.test(prose)) return
    }
  }
  throw new Error(`No prose source line found near ratio ${ratio}`)
}

const scrollRichAndClick = async (send, ev, ratio) => {
  if (process.env.CHAIN_TARGET === 'table-text') {
    const point = await ev(`(() => {
      const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
      if (!pm) return null
      const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
      const nodes = []
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.parentElement?.closest('td, th') || node.parentElement.closest('code')) continue
        if ((node.nodeValue || '').trim().length >= 3) nodes.push(node)
      }
      const node = nodes[Math.round(${ratio} * Math.max(0, nodes.length - 1))]
      if (!node) return null
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      node.parentElement.scrollIntoView({ block: 'center' })
      const nextRect = range.getBoundingClientRect()
      return {
        x: Math.round(nextRect.left + nextRect.width * 0.55),
        y: Math.round((nextRect.top + nextRect.bottom) / 2)
      }
    })()`)
    await sleep(250)
    if (!point) throw new Error('No plain table-cell text found')
    await click(send, point)
    await click(send, point)
    await sleep(250)
    return
  }
  if (process.env.CHAIN_TARGET === 'code-block') {
    const point = await ev(`(() => {
      const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
      const lines = [...(pm?.querySelectorAll('.milkdown-code-block .cm-line') || [])]
      const line = lines[Math.round(${ratio} * Math.max(0, lines.length - 1))]
      if (!line) return null
      line.scrollIntoView({ block: 'center' })
      const rect = line.getBoundingClientRect()
      return { x: Math.round(rect.left + Math.min(rect.width - 2, Math.max(8, rect.width * 0.58))), y: Math.round((rect.top + rect.bottom) / 2) }
    })()`)
    await sleep(250)
    if (!point) throw new Error('No CodeMirror line found in a visible code block')
    await click(send, point)
    await sleep(250)
    return
  }
  if (process.env.CHAIN_TARGET === 'table-code') {
    const point = await ev(`(() => {
      const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
      const codes = [...(pm?.querySelectorAll('td code, th code') || [])]
      const code = codes[Math.round(${ratio} * Math.max(0, codes.length - 1))]
      if (!code) return null
      code.scrollIntoView({ block: 'center' })
      const rect = code.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width * 0.5), y: Math.round((rect.top + rect.bottom) / 2) }
    })()`)
    await sleep(250)
    if (!point) throw new Error('No inline code inside a visible table found')
    await click(send, point)
    // Crepe's first table click can select the cell paragraph as a node; the
    // second click establishes the text caret the user is testing.
    await click(send, point)
    await sleep(250)
    return
  }
  await ev(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
    const host = pm?.closest('.editor-scroll')
    if (!host) return false
    host.scrollTop = ${ratio} * Math.max(0, host.scrollHeight - host.clientHeight)
    return true
  })()`)
  await sleep(350)
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
      if (node.parentElement?.closest('.cm-editor, table, [contenteditable="false"]')) continue
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
  if (!point) throw new Error('No visible rich text found')
  await click(send, point)
  await sleep(250)
}

const sameCaret = (left, right) => !!left && !!right &&
  left.offset === right.offset && left.context === right.context && right.visible

const semanticMatch = (left, right) => {
  const normalize = (value) => String(value || '').replace(/[\s`*_#|<>()[\]{}:：/\\-]+/g, '')
  const a = normalize(left?.context)
  const b = normalize(right?.context)
  if (!a || !b) return false
  const row = new Array(b.length + 1).fill(0)
  let longest = 0
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j >= 1; j--) {
      row[j] = a[i - 1] === b[j - 1] ? row[j - 1] + 1 : 0
      longest = Math.max(longest, row[j])
    }
  }
  return longest >= 4
}

const ratios = process.env.CHAIN_RATIOS
  ? process.env.CHAIN_RATIOS.split(',').map(Number).filter(Number.isFinite)
  : [0.12, 0.32, 0.52, 0.72, 0.9]

const main = async () => {
  const { ws, send } = await connect()
  await send('Runtime.enable')
  const ev = evaluator(send)
  await sleep(1600)
  await enableHeavyRich(send, ev)
  const results = []

  if (process.env.CHAIN_MODE !== 'rich') for (const ratio of ratios) {
    await ensureSource(send, ev)
    await scrollSourceAndClick(send, ev, ratio)
    const source0 = await sourceContext(ev)
    await toggle(send, ev)
    const rich1 = await richContext(ev)
    await toggle(send, ev)
    const source2 = await sourceContext(ev)
    await toggle(send, ev)
    const rich3 = await richContext(ev)
    const crossModeMatch = semanticMatch(source0, rich1) && semanticMatch(source2, rich3)
    results.push({
      chain: 'source-rich-source-rich', ratio,
      pass: sameCaret(source0, source2) && sameCaret(rich1, rich3) && crossModeMatch,
      crossModeMatch,
      source0, rich1, source2, rich3
    })
  }

  if (process.env.CHAIN_MODE !== 'source') for (const ratio of ratios) {
    await ensureRich(send, ev)
    await scrollRichAndClick(send, ev, ratio)
    const rich0 = await richContext(ev)
    await toggle(send, ev)
    const source1 = await sourceContext(ev)
    await toggle(send, ev)
    const rich2 = await richContext(ev)
    await toggle(send, ev)
    const source3 = await sourceContext(ev)
    results.push({
      chain: 'rich-source-rich-source', ratio,
      pass: sameCaret(rich0, rich2) && sameCaret(source1, source3) &&
        semanticMatch(rich0, source1) && semanticMatch(rich2, source3),
      crossModeMatch: semanticMatch(rich0, source1) && semanticMatch(rich2, source3),
      rich0, source1, rich2, source3
    })
  }

  const report = {
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    results
  }
  console.log(JSON.stringify(report, null, 2))
  ws.close()
  process.exit(report.passed === report.total ? 0 : 2)
}

main().catch((error) => {
  console.error('MODE_SWITCH_CHAINS_FAIL', error)
  process.exit(3)
})
