// E2E: typing after a whole-paragraph inline-code span (trace-79495 shape).
// The paragraph is a single inlineCode mark ending at line end; IME text
// appended after the span must publish `` `…`兰芳 `` (outside the span),
// with zero warnings and correct disk bytes after save.
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-inline-span-append-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 15980 + (process.pid % 20))

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

const spanLine = '`练达是整个体系运转顺畅后的人格状态与处事境界，不是终点，而是动态平衡。`'
const fixture = `# 聚合\r\n\r\n${spanLine}\r\n\r\n### next section\r\n`

const open = async ({ file, profileDir, port }) => {
  const app = await launchBuiltElectron({
    profileDir, port, appArgs: [file, '--horsemd-input-trace']
  })
  try {
    await waitFor(() => app.evaluate(`Boolean(${visibleEditor()})`), 'editor did not mount')
    await sleep(400)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const caretToSpanEnd = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const paragraphs = [...(editor?.children || [])]
      .filter((node) => node.tagName === 'P' && node.offsetParent)
    const target = paragraphs.find((node) => (node.textContent || '').includes('练达'))
    const rect = target?.getBoundingClientRect()
    if (!rect) return null
    return { x: rect.right - 4, y: (rect.top + rect.bottom) / 2 }
  })()`), 'span paragraph not found')
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1
  })
  await sleep(150)
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' })
  await sleep(150)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceSyncCoordinatorTrace = []
    return true
  })()`)
  return point
}

// Type through CDP insertText (the IME commit channel) — one insert per char,
// exactly one input per key like a composition commit.
const typeIme = async (app, text) => {
  await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    editor?.focus()
  })()`)
  for (const character of text) {
    await app.send('Input.insertText', { text: character })
    await sleep(140)
  }
  await sleep(700)
}

const collect = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const warnings = [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
    .filter((text) => text.includes('不一致'))
  const paragraph = [...(editor?.children || [])]
    .filter((node) => node.tagName === 'P' && node.offsetParent)
    .find((node) => (node.textContent || '').includes('练达'))
  return {
    paragraphText: paragraph?.textContent || null,
    hasCodeMark: paragraph ? [...paragraph.querySelectorAll('code')].length > 0 : null,
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-10),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-10),
    preserve: (window.__hmPreserveLog || []).slice(-6),
    warnings,
    saveVisible: Boolean(document.querySelector('.hm-save-fab'))
  }
})()`)

const main = async () => {
  await rm(root, { recursive: true, force: true })
  const dir = join(root, 'case')
  const profileDir = join(dir, 'profile')
  const file = join(dir, 'doc.md')
  await mkdir(profileDir, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  const app = await open({ file, profileDir, port: basePort })
  try {
    await caretToSpanEnd(app)
    await typeIme(app, '兰芳')
    const state = await collect(app)

    if ((state.warnings || []).length) {
      throw new Error(`warnings: ${JSON.stringify(state.warnings)}`)
    }
    const failures = (state.integrity || []).filter((entry) => entry && entry.ok === false)
    if (failures.length) {
      throw new Error(`integrity failures: ${JSON.stringify(failures).slice(0, 400)}`)
    }
    if (!state.paragraphText || !state.paragraphText.endsWith('兰芳')) {
      throw new Error(`rich text did not receive the append: ${JSON.stringify(state.paragraphText)}`)
    }
    const published = (state.coordinator || []).filter((entry) => entry?.phase === 'published').pop()
    if (!published) throw new Error('no publication reached the coordinator')

    // Save via the FAB and verify disk bytes: `…`兰芳 with the closing
    // delimiter strictly before the appended text, CRLF intact.
    await waitFor(() => app.evaluate('Boolean(document.querySelector(\'.hm-save-fab\'))'),
      'save FAB did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    await sleep(300)
    const disk = await readFile(file, 'utf8')
    if (!disk.includes('动态平衡。`兰芳\r\n')) {
      throw new Error(`disk bytes wrong: ${JSON.stringify(disk.slice(disk.indexOf('练达') - 2, disk.indexOf('练达') + 40))}`)
    }
    for (let index = 0; index < disk.length; index += 1) {
      if (disk[index] === '\n' && disk[index - 1] !== '\r') {
        throw new Error('bare LF leaked onto disk')
      }
    }

    await rm(root, { recursive: true, force: true })
    console.log('PASS inline-code span append UI: IME text after a whole-paragraph code span publishes outside the delimiter, zero warnings, CRLF disk bytes correct')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch(async (error) => {
  console.error(error.message || error)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
})
