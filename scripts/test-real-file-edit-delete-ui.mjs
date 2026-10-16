// Focused repro on a real user file: append content at the document end,
// verify source, save, then delete the appended content and verify the
// deletion reaches source (no resurrection) and no save-pause toast appears.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
assert.ok(sourceFile, 'FILE is required')
const marker = `尾插验证${process.pid}`
const root = `/tmp/horsemd-edit-delete-${process.pid}`
const file = join(root, 'repro.md')
const port = Number(process.env.CDP_PORT || 9890)
const delay = Number(process.env.KEY_DELAY || 60)

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
  assert.ok(done, 'could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
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

const toasts = (evaluate) => evaluate(`[...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent)`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(700)
  return app
}

async function saveAndWait(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing (edit not dirty?)')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    .catch(async () => {
      console.error('save paused; toasts:', JSON.stringify(await toasts(app.evaluate)))
      return false
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

    // 1. Append `1. marker` at the document end.
    await focusEnd(evaluate, send)
    for (const ch of ['1', '.', ' ']) {
      await send('Input.insertText', { text: ch })
      await sleep(delay)
    }
    await typeTextLikeUser(send, marker, { delayMs: delay })
    await sleep(600)

    assert.equal(await toggleSource(evaluate), true, 'source toggle failed after append')
    const afterAppend = await waitFor(() => visibleSource(evaluate), 'source missing after append')
    const appendLine = afterAppend.split('\n').find((line) => line.includes(marker)) || ''
    const richTail = await evaluate(`([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent || '').slice(-120)`)
    const preserveLog = await evaluate(`(window.__hmPreserveLog || []).slice(-3).map((entry) => ({
      reason: entry.reason,
      previousTail: entry.previous?.slice(-80),
      nextTail: entry.next?.slice(-80),
      markdownTail: entry.markdown?.slice(-80)
    }))`)
    console.log('rich tail:', JSON.stringify(richTail))
    console.log('preserve log:', JSON.stringify(preserveLog, null, 1))
    assert.ok(
      afterAppend.includes(marker),
      `appended content missing in source: ${JSON.stringify(afterAppend.slice(-160))}`
    )
    console.log('append source line:', JSON.stringify(appendLine))
    assert.equal(await toggleSource(evaluate), true, 'back to rich failed')

    // 2. Save, reopen, then delete the appended list row.
    await saveAndWait(app)
    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const { evaluate: e2, send: s2 } = app
    await e2(`(() => { window.__hmPreserveLog = [] })()`)
    await focusEnd(e2, s2)
    await pressKey(s2, { key: 'End', code: 'End', delayMs: 40 })
    for (let i = 0; i < (marker.length + 3); i += 1) {
      await pressKey(s2, { key: 'Backspace', code: 'Backspace', delayMs: delay })
    }
    await sleep(600)
    assert.equal(await toggleSource(e2), true, 'source toggle failed after delete')
    const afterDelete = await waitFor(() => visibleSource(e2), 'source missing after delete')
    assert.ok(
      !afterDelete.includes(marker),
      `deleted content resurrected in source: ${JSON.stringify(afterDelete.slice(-160))}`
    )
    const pauseToasts = await toasts(e2)
    assert.ok(
      !pauseToasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖/.test(text || '')),
      `save-pause toast appeared: ${JSON.stringify(pauseToasts)}`
    )
    console.log('PASS edit+delete on real file: append survived, deletion reached source, no pause toast')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
