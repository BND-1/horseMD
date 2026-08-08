import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-full-doc-delete-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const sleepMs = (ms) => sleep(ms)

async function stopApp(app, removeProfile = true) {
  try {
    await stopBuiltElectron(app, { removeProfile })
  } catch {
    // Chromium helper processes can hold profile files for a moment after
    // exit; one retry with a settle delay makes profile cleanup deterministic.
    await sleepMs(800)
    await stopBuiltElectron(app, { removeProfile })
  }
}

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

// A deleted document legitimately has an EMPTY source value, which is falsy;
// waitFor() therefore must poll for the textarea element itself, not its value.
const sourceTextareaVisible = (evaluate) => evaluate(`(
  !![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
)`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const richText = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return editor ? editor.textContent : null
})()`)

const richSelection = (evaluate) => evaluate(`(() => {
  const sel = getSelection()
  return sel && sel.rangeCount ? sel.toString() : ''
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'editor did not open'
  )
  await sleepMs(800)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // Diverged authored source: `-` markers + a mid-line `* ` that remark splits
  // into a list. Before the fix, deleting everything in rich mode failed every
  // preservation mapping closed, resurrected the old source in source mode and
  // in saves, and the reopened file grew the deleted content back.
  const authored =
    '# 测试\n\n价格是 * 优惠价\n\n- 项一\n- 项二\n\n结尾。\n'
  await writeFile(file, authored)
  let app
  try {
    app = await openApp('edit', port)

    // Select the whole document and delete it, exactly like a user clearing a file.
    await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
    })()`)
    await app.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    })
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    })
    await sleepMs(300)
    const selected = await richSelection(app.evaluate)
    assert.ok(
      selected.includes('测试') && selected.includes('价格是 * 优惠价') && selected.includes('结尾'),
      `Cmd+A must select the full document (got: ${JSON.stringify(selected)})`
    )
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(900)

    // Rich mode: everything is gone.
    assert.equal(
      await richText(app.evaluate),
      '',
      'rich mode must be empty after deleting the full document'
    )

    // Switch to source: the deleted content must NOT come back.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    await waitFor(() => sourceTextareaVisible(app.evaluate), 'source textarea did not appear')
    const raw = await visibleSource(app.evaluate)
    assert.equal(
      raw,
      '',
      'source mode must be empty after a full-document rich deletion (no resurrection, no `# ` remnant)'
    )

    // Round-trip back to rich and check the caret stays at the start (offset 0).
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleepMs(500)
    const richEmpty = await richText(app.evaluate)
    assert.equal(richEmpty, '', 'switching back to rich must stay empty')
    // The production build strips the DEV-only __horsemd hook, so read the
    // DOM selection instead: the caret must live inside the rich editor at
    // offset 0 (the only position of an emptied document), not in another
    // pane or at a stale position.
    const richCaret = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const sel = getSelection()
      if (!editor || !sel || !sel.rangeCount) return null
      const range = sel.getRangeAt(0)
      return editor.contains(range.startContainer) && range.collapsed
        ? range.startOffset
        : -1
    })()`)
    assert.equal(richCaret, 0, 'the rich caret must rest at the start of the emptied document')

    // Save and verify the file on disk is empty, not the old content.
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    assert.equal(saved, '', 'saving an emptied document must persist the empty file')

    // Full reopen: the file must stay empty.
    await stopApp(app)
    app = await openApp('reopen', port + 1)
    assert.equal(await richText(app.evaluate), '', 'the reopened document must still be empty')
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source after reopen')
    await waitFor(() => sourceTextareaVisible(app.evaluate), 'source textarea did not appear after reopen')
    const reopened = await visibleSource(app.evaluate)
    assert.equal(reopened, '', 'reopened source must be empty too')

    console.log('PASS full-doc delete source sync: deletion survives mode switch, save, and full reopen')
  } finally {
    if (app) await stopApp(app)
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
