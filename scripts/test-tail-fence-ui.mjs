// Repro: at the end of a real user file, hand-type a fenced code block
// (``` Enter content Enter ```) and verify source sync, save and reopen.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
assert.ok(sourceFile, 'FILE is required')
const marker = `fence${process.pid}`
const root = `/tmp/horsemd-tail-fence-${process.pid}`
const file = join(root, 'fence.md')
const port = Number(process.env.CDP_PORT || 9910)
const delay = Number(process.env.KEY_DELAY || 70)

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
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
  if (!done) throw new Error('could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
  await sleep(150)
}

async function typeBacktick(send) {
  const common = {
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: '`', unmodifiedText: '`' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
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

const toasts = (evaluate) => evaluate(`[...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent)`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(700)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFile, file)
  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app
    await evaluate(`(() => { window.__hmPreserveLog = [] })()`)

    await focusEnd(evaluate, send)
    for (let i = 0; i < 3; i += 1) await typeBacktick(send)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await sleep(400)
    await typeTextLikeUser(send, marker, { delayMs: delay })
    await sleep(400)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await sleep(400)
    for (let i = 0; i < 3; i += 1) await typeBacktick(send)
    await sleep(600)

    const pauseToasts = await toasts(evaluate)
    assert.ok(
      !pauseToasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖/.test(t || '')),
      `save-pause toast appeared: ${JSON.stringify(pauseToasts)}`
    )
    assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(evaluate), 'source missing').catch(() => null)
    assert.ok(source !== null, 'source mode stayed locked')
    assert.ok(
      source.includes(marker),
      `fence content missing in source: ${JSON.stringify(source.slice(-160))}`
    )
    console.log('PASS tail fence: hand-typed code block reached source without pause toast')

    // Persistence leg: save via the FAB (background-mode Cmd+S does not hit
    // the menu accelerator), then fully reopen in a fresh profile and confirm
    // the fenced block renders and maps back to the exact bytes on disk.
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(2500)
    const disk1 = await readFile(file, 'utf8')
    assert.ok(
      disk1.includes(marker),
      `fence content missing after save: ${JSON.stringify(disk1.slice(-160))}`
    )
    await stopBuiltElectron(app, { removeProfile: false })
    app = await openApp('reopen', port + 1)
    const visible = await waitFor(() =>
      app.evaluate(`([...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent) || {}).innerText || ''`),
    'reopen render missing')
    assert.ok(visible.includes(marker), 'fence content not visible after reopen')
    const disk2 = await readFile(file, 'utf8')
    assert.equal(disk1, disk2, 'file bytes changed across reopen')
    assert.equal(await toggleSource(app.evaluate), true, 'source toggle failed after reopen')
    const source2 = await waitFor(() => visibleSource(app.evaluate), 'source missing after reopen')
    assert.ok(
      source2.includes(marker),
      `fence content missing in source after reopen: ${JSON.stringify(source2.slice(-160))}`
    )
    console.log('PASS tail fence: save + reopen kept bytes and source mapping exact')
  } finally {
    try {
      await stopBuiltElectron(app, { removeProfile: true })
    } catch {}
    try { await rm(root, { recursive: true, force: true }) } catch {}
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
