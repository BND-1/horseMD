// Smoke against real user files (copies): open, type a unique marker at the
// document end (or after the trailing quote), save, fully reopen, and verify
// the marker survived. Run with:
//   FILE=/path/to/copy.md node scripts/test-real-file-save-ui.mjs
//   FILE=... MODE=after-quote node scripts/test-real-file-save-ui.mjs
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
assert.ok(sourceFile, 'FILE is required')
const mode = process.env.MODE || 'end'
const marker = `末段新增验证${process.pid}`
const root = `/tmp/horsemd-real-file-${process.pid}`
const file = join(root, basename(sourceFile))
const port = Number(process.env.CDP_PORT || 9840)

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function focusEnd(evaluate, send) {
  const done = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const selection = getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.ok(done, 'could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
}

async function clickTrailingBlank(evaluate, send) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraphs = [...(editor?.querySelectorAll('p') || [])]
      .filter((node) => !node.closest('li') && !node.textContent.trim())
    const last = paragraphs.at(-1)
    if (!last) return null
    last.scrollIntoView({ block: 'center' })
    const rect = last.getBoundingClientRect()
    return { x: rect.left + Math.max(4, Math.min(16, rect.width / 2)), y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, 'trailing blank paragraph not found')
  await click(send, point)
  await sleep(150)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(600)
  return app
}

async function saveAndWait(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing (edit not dirty?)')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    .catch(async (error) => {
      const diagnostics = await app.evaluate(`(() => ({
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent),
        rich: [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent.slice(-200) || '',
        dirty: !!document.querySelector('.hm-save-fab'),
        preserve: window.__hmPreserveLog || [],
        mapped: window.__hmSourceTransactionLog || []
      }))()`)
      console.error('save diagnostics:', JSON.stringify(diagnostics, null, 2))
      throw error
    })
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFile, file)
  const original = await readFile(file, 'utf8')
  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceTransactionLog = []
    })()`)
    if (mode === 'after-quote') {
      await clickTrailingBlank(evaluate, send)
    } else {
      await focusEnd(evaluate, send)
    }
    await typeTextLikeUser(send, marker, { delayMs: 70 })
    await sleep(500)
    const richText = await evaluate(`([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent || '')`)
    assert.ok(richText.includes(marker), `rich editor did not contain the marker: ${JSON.stringify(richText.slice(-120))}`)

    await saveAndWait(app)
    const disk = await readFile(file, 'utf8')
    assert.ok(disk.includes(marker), `disk lost the marker: ${JSON.stringify(disk.slice(-160))}`)

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen source toggle failed')
    const reopened = await waitFor(() => visibleSource(app.evaluate), 'reopen source missing')
    assert.ok(reopened.includes(marker), `reopen lost the marker: ${JSON.stringify(reopened.slice(-160))}`)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen back-to-rich toggle failed')
    const reopenedRich = await waitFor(
      () => app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent || '')`),
      'reopen rich editor did not return'
    )
    assert.ok(reopenedRich.includes(marker), `reopen rich lost the marker: ${JSON.stringify(reopenedRich.slice(-160))}`)
    console.log(`PASS real-file save (${mode}): marker survived save + reopen for ${basename(sourceFile)} (${original.length} bytes -> ${disk.length} bytes)`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
