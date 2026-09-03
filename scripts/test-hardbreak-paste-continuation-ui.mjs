// E2E: Shift+Enter (hardbreak callback still pending) immediately followed by
// a multi-paragraph paste (trace-94539 03:15:35). The pasted first line must
// continue the anchor paragraph through the hardbreak; zero warnings; the
// source keeps the `\` continuation; save writes correct bytes.
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-hardbreak-paste-${process.pid}`
const port = Number(process.env.CDP_PORT || 15995 + (process.pid % 20))

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const main = async () => {
  await rm(root, { recursive: true, force: true })
  const dir = join(root, 'd')
  const profileDir = join(dir, 'p')
  const file = join(dir, 'doc.md')
  await mkdir(profileDir, { recursive: true })
  // CRLF authored document, matching the user's environment.
  await writeFile(file, '前文\r\n\r\n2、周期层\r\n\r\n后文\r\n', 'utf8')

  const app = await launchBuiltElectron({ profileDir, port, appArgs: [file, '--horsemd-input-trace'] })
  try {
    await waitFor(() => app.evaluate(`Boolean(${visibleEditor()})`), 'editor did not mount')
    await sleep(600)

    // Click the start of the document area and type the anchor paragraph.
    const point = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const paragraph = [...(editor?.children || [])]
        .filter((node) => node.tagName === 'P' && node.offsetParent)
        .find((node) => (node.textContent || '') === '前文')
      const rect = paragraph?.getBoundingClientRect()
      return rect ? { x: rect.left + 6, y: (rect.top + rect.bottom) / 2 } : null
    })()`)
    if (!point) throw new Error('anchor paragraph not found')
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(150)
    await app.send('Input.insertText', { text: '根据项目梳理，做以下分析：' })
    await sleep(600)

    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceSyncCoordinatorTrace = []
      document.querySelectorAll('[class*="toast"]').forEach((n) => n.remove())
      return true
    })()`)

    // Shift+Enter → hardbreak. Paste IMMEDIATELY so the hardbreak's callback
    // is still pending when the paste transaction lands (trace shape).
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, modifiers: 8
    })
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8
    })
    await sleep(120)

    const consumed = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      editor?.focus()
      const data = new DataTransfer()
      data.setData('text/plain', '1、定义层\\n\\n先明确几个核心概念：')
      data.setData('text/html',
        '<meta charset=\\'utf-8\\'><p class="isSelectedEnd"><span>1、定义层</span></p>' +
        '<p class="isSelectedEnd"><span>先明确几个核心概念：</span></p><p></p>')
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    })()`)
    if (consumed !== true) throw new Error('paste not consumed')
    await sleep(1500)

    const dump = await app.evaluate(`(() => ({
      toasts: [...document.querySelectorAll('[class*="toast"]')]
        .filter((node) => node.offsetParent).map((node) => node.textContent || ''),
      bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false)
        .slice(-3).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
      coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-6)
        .map(e => ({ phase: e.phase, owner: e.owner, reason: e.reason })),
      paragraphs: [...(${visibleEditor()}?.children || [])]
        .filter((node) => node.tagName === 'P' && node.offsetParent)
        .map((node) => node.textContent || '')
    }))()`)
    const warnings = (dump.toasts || []).filter((text) => String(text).includes('不一致'))
    if (warnings.length) throw new Error(`warnings: ${JSON.stringify(warnings)}`)
    if ((dump.bad || []).length) throw new Error(`integrity failures: ${JSON.stringify(dump.bad)}`)
    const continuation = (dump.paragraphs || []).find((text) =>
      String(text).includes('分析：') && String(text).includes('1、定义层'))
    if (!continuation) throw new Error(`hardbreak continuation missing: ${JSON.stringify(dump.paragraphs)}`)
    const published = (dump.coordinator || []).filter((entry) => entry?.phase === 'published')
    if (!published.length) throw new Error('no publication reached the coordinator')

    // Source mode must show the `\` continuation on the anchor line.
    if (await toggleSource(app)) {
      const source = await waitFor(() => visibleSource(app), 'source textarea missing')
      await sleep(400)
      if (!/分析：\\\r?\n1、定义层/.test(source)) {
        throw new Error(`source lost the hardbreak continuation: ${JSON.stringify(source.slice(0, 120))}`)
      }
      if (!source.includes('先明确几个核心概念：')) {
        throw new Error('source lost the second pasted paragraph')
      }
      await toggleSource(app)
      await sleep(300)
    } else {
      throw new Error('source toggle not found')
    }

    // Save via FAB and verify disk bytes.
    await waitFor(() => app.evaluate('Boolean(document.querySelector(\'.hm-save-fab\'))'), 'save FAB missing')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    await sleep(300)
    const disk = await readFile(file, 'utf8')
    if (!/分析：\\\r\n1、定义层/.test(disk)) {
      throw new Error(`disk lost the continuation: ${JSON.stringify(disk.slice(0, 120))}`)
    }
    for (let index = 0; index < disk.length; index += 1) {
      if (disk[index] === '\n' && disk[index - 1] !== '\r') {
        throw new Error('bare LF leaked onto disk')
      }
    }

    await rm(root, { recursive: true, force: true })
    console.log('PASS hardbreak paste continuation UI: Shift+Enter then multi-paragraph paste continues the anchor line through the authored hardbreak, zero warnings, source and CRLF disk bytes correct')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch(async (error) => {
  console.error(error.message || error)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
})
