// Broader operation matrix on a real user file copy: middle insert, delete,
// list edit, source round trip — each followed by save and reopen.
//   FILE=... node scripts/test-real-file-ops-ui.mjs
//   OP=mid-insert|delete|list-edit|source-roundtrip
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
assert.ok(sourceFile, 'FILE is required')
const op = process.env.OP || 'mid-insert'
const marker = `操作验证${process.pid}`
const root = `/tmp/horsemd-real-ops-${process.pid}`
const file = join(root, basename(sourceFile))
const port = Number(process.env.CDP_PORT || 9850)

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

async function clickTextContaining(evaluate, send, needle) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p') || [])]
      .find((candidate) => candidate.textContent.includes(${JSON.stringify(needle)}))
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 5, Math.min(rect.right - 3, rect.left + 30)), y: rect.top + Math.min(14, rect.height / 2) }
  })()`)
  assert.ok(point, `missing text containing: ${needle}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
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
        preserve: (window.__hmPreserveLog || []).slice(-3),
        dirty: !!document.querySelector('.hm-save-fab')
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
    await evaluate(`(() => { window.__hmPreserveLog = [] })()`)

    if (op === 'delete') {
      // Delete a few characters from a middle paragraph.
      await clickTextContaining(evaluate, send, '判断标准')
      for (let i = 0; i < 3; i += 1) {
        await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
      }
    } else if (op === 'list-edit') {
      await clickTextContaining(evaluate, send, '反复转换')
      await typeTextLikeUser(send, marker, { delayMs: 70 })
    } else if (op === 'source-roundtrip') {
      await clickTextContaining(evaluate, send, '判断标准')
      await typeTextLikeUser(send, marker, { delayMs: 70 })
      await sleep(400)
      assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
      await waitFor(() => visibleSource(evaluate), 'source textarea missing')
      assert.equal(await toggleSource(evaluate), true, 'back to rich failed')
      await sleep(400)
    } else {
      await clickTextContaining(evaluate, send, '判断标准')
      await typeTextLikeUser(send, marker, { delayMs: 70 })
    }
    await sleep(500)

    await saveAndWait(app)
    const disk = await readFile(file, 'utf8')
    const containsMarker = op === 'delete'
      ? disk !== original
      : disk.includes(marker)
    assert.ok(containsMarker, `disk did not reflect the operation: ${JSON.stringify(disk.slice(-200))}`)

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen source toggle failed')
    const reopened = await waitFor(() => visibleSource(app.evaluate), 'reopen source missing')
    const reopenedOk = op === 'delete'
      ? reopened !== original
      : reopened.includes(marker)
    assert.ok(reopenedOk, `reopen lost the operation result: ${JSON.stringify(reopened.slice(-200))}`)
    console.log(`PASS real-file op (${op}): saved and reopened for ${basename(sourceFile)} (${original.length} -> ${disk.length} bytes)`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
