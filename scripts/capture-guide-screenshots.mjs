import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.CDP_PORT || 9222)
const base = `http://127.0.0.1:${port}`
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const outputDir = path.join(root, `guide/public/images/v${appPackage.version}`)
const fixtureDir = process.env.GUIDE_FIXTURE_DIR || path.join(root, 'guide/public/downloads/HorseMD 教程工作区')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  let targets = []
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      targets = await (await fetch(`${base}/json/list`)).json()
      if (targets.some((target) => target.type === 'page')) break
    } catch {}
    await sleep(500)
  }
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error(`No Electron page found on CDP port ${port}`)

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    pending.get(message.id)(message)
    pending.delete(message.id)
  })
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const requestId = ++id
      pending.set(requestId, resolve)
      socket.send(JSON.stringify({ id: requestId, method, params }))
    })

  return { socket, send }
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true })
  const { socket, send } = await connect()
  await send('Runtime.enable')
  await send('Page.enable')

  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
    }
    return response.result?.result?.value
  }

  const waitFor = async (expression, timeout = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(120)
    }
    throw new Error(`Timed out waiting for: ${expression}`)
  }

  const capture = async (name) => {
    await sleep(450)
    const response = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    })
    const file = path.join(outputDir, `${name}.png`)
    await fs.writeFile(file, Buffer.from(response.result.data, 'base64'))
    console.log(`CAPTURED ${path.relative(root, file)}`)
  }

  const click = async (expression) => {
    const clicked = await evaluate(`(() => { const target = ${expression}; if (!target) return false; target.click(); return true })()`)
    if (!clicked) throw new Error(`Could not click: ${expression}`)
    await sleep(350)
  }

  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })
    await waitFor("document.querySelector('.app')")
    await click("[...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes('欢迎使用 HorseMD'))")
    await capture('first-launch')

    await click("[...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes('HorseMD-教程示例'))")
    await waitFor("[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)")
    await sleep(1400)
    await capture('interface-overview')

    await click("[...document.querySelectorAll('.activity-item')].find((button) => button.title.includes('大纲'))")
    await capture('outline')

    await click("document.querySelector('.topbar .icon-btn[title*=" + JSON.stringify('Command palette') + "]')")
    await capture('command-palette')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

    await click("[...document.querySelectorAll('.activity-item')].find((button) => button.title.includes('设置'))")
    await waitFor("document.querySelector('.settings-page')")
    await capture('settings')

    const session = {
      folderRoots: [fixtureDir],
      theme: 'light',
      lang: 'zh',
      sidebarOpen: true,
      sidebarMode: 'files',
      paneWidth: 300,
      openPaths: [path.join(fixtureDir, 'HorseMD-教程示例.md')],
      activePath: path.join(fixtureDir, 'HorseMD-教程示例.md'),
      recents: []
    }
    const preloadSession = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('horsemd.onboarded.v1', '1'); localStorage.setItem('minimd.session.v1', ${JSON.stringify(JSON.stringify(session))})`
    })
    await send('Page.reload', { ignoreCache: true })
    await waitFor("document.querySelector('.sidebar')", 15000)
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preloadSession.result.identifier })
    await sleep(1800)
    await capture('workspace')

    await click("[...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes('HorseMD-教程示例'))")
    const slashTarget = await evaluate(`(() => {
      const paragraph = [...document.querySelectorAll('.ProseMirror p')].find((node) => node.textContent.includes('尝试按下'))
      if (!paragraph) return null
      paragraph.scrollIntoView({ block: 'center' })
      const rect = paragraph.getBoundingClientRect()
      return { x: Math.round(rect.right - 5), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    if (!slashTarget) throw new Error('Could not find slash-command paragraph')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slashTarget.x, y: slashTarget.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slashTarget.x, y: slashTarget.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: slashTarget.x, y: slashTarget.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    for (const key of [
      { key: '/', code: 'Slash', vk: 191 },
      { key: 'b', code: 'KeyB', vk: 66 },
      { key: 't', code: 'KeyT', vk: 84 }
    ]) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: key.key, code: key.code, text: key.key, windowsVirtualKeyCode: key.vk })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk })
    }
    await waitFor("document.querySelector('.milkdown-slash-menu[data-show=" + JSON.stringify('true') + "]')")
    await capture('slash-command')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

    await click("[...document.querySelectorAll('.activity-item')].find((button) => button.title.includes('大纲'))")
    await click("document.querySelector('.status-btn[title*=" + JSON.stringify('Ctrl+/') + "]')")
    await waitFor("[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)")
    await capture('source-mode')

    const tabPoint = await evaluate(`(() => {
      const tab = document.querySelector('.tab.active')
      if (!tab) return null
      const rect = tab.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    if (!tabPoint) throw new Error('Could not locate active tab for PDF export')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tabPoint.x, y: tabPoint.y, button: 'right', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tabPoint.x, y: tabPoint.y, button: 'right', clickCount: 1 })
    await waitFor("[...document.querySelectorAll('.tab-ctxmenu button')].some((button) => /PDF/i.test(button.textContent))")
    const exportPoint = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.tab-ctxmenu button')].find((node) => /PDF/i.test(node.textContent))
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    if (!exportPoint) throw new Error('Could not locate PDF export menu item')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: exportPoint.x, y: exportPoint.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: exportPoint.x, y: exportPoint.y, button: 'left', clickCount: 1 })
    await waitFor("document.querySelector('.hm-pdf-studio')")
    await waitFor("document.querySelector('.hm-pdf-preview')?.dataset.previewToken", 20000)
    await waitFor("document.querySelector('.hm-pdf-page canvas')", 20000)
    const outlineButton = "document.querySelector('.hm-pdf-preview-leading > button')"
    if (await evaluate(`Boolean(${outlineButton})`)) await click(outlineButton)
    await capture('pdf-export')
  } finally {
    socket.close()
  }
}

main().catch((error) => {
  console.error(`CAPTURE_FAIL ${error.stack || error.message}`)
  process.exit(1)
})
