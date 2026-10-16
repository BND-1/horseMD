import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

// Milkdown debounces markdownUpdated for 200ms. HorseMD must show unsaved state
// from the committed rich-editor input event instead of making people wait for
// source serialization. This deliberately checks disk, tab dot, source view,
// save, and an edit-revert sequence independently.
const dir = '/tmp/horsemd-rich-dirty-indicator'
const file = join(dir, 'dirty-indicator.md')
const source = '# 未保存提示\n\n正文锚点。\n'
const port = Number(process.env.CDP_PORT || 9874)

async function waitFor(check, message, attempts = 80, delay = 25) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(delay)
  }
  throw new Error(message)
}

async function putCaretAfter(evaluate, text) {
  const target = JSON.stringify(text)
  const placed = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const offset = node.nodeValue.indexOf(${target})
      if (offset < 0) continue
      const range = document.createRange()
      range.setStart(node, offset + ${target}.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      return true
    }
    return false
  })()`)
  assert.equal(placed, true, `Could not place caret after ${text}`)
}

async function toggleSource(evaluate) {
  const toggled = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return Boolean(button)
  })()`)
  assert.equal(toggled, true, 'Could not find the rich/source toggle')
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile'),
    port,
    appArgs: [file]
  })
  try {
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent && node.dataset.horsemdReady === 'true')`),
      'Rich editor did not become ready for input'
    )
    await putCaretAfter(evaluate, '正文锚点。')

    const startedAt = performance.now()
    await typeTextLikeUser(send, 'X')
    const dirtyAt = await waitFor(
      async () => (await evaluate(`!!document.querySelector('.tab-close.dirty')`)) ? performance.now() - startedAt : null,
      'Rich edit did not immediately show the dirty tab indicator',
      8,
      20
    )
    assert.ok(dirtyAt < 180, `Dirty indicator took ${Math.round(dirtyAt)}ms; it should not wait for Milkdown's 200ms serializer debounce`)
    assert.ok(await evaluate(`!!document.querySelector('.hm-save-fab')`), 'Save action was not available while rich serialization was pending')
    assert.ok(await evaluate(`document.querySelector('.statusbar')?.textContent.includes('已修改')`), 'Status bar did not immediately show 已修改')
    assert.equal(await readFile(file, 'utf8'), source, 'Rich edit unexpectedly auto-saved to disk')

    // The delayed source-preserving markdown still becomes authoritative.
    await sleep(300)
    await toggleSource(evaluate)
    const sourceValue = await waitFor(() => evaluate(`
      [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
    `), 'Source mode did not become visible')
    assert.ok(sourceValue.includes('正文锚点。X'), 'Delayed rich markdown did not reach source mode')
    await toggleSource(evaluate)

    // Explicit Save, not the dirty hint, is the only disk-writing boundary.
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(async () => (await readFile(file, 'utf8')).includes('正文锚点。X'), 'Explicit save did not write rich edit')
    await waitFor(() => evaluate(`!document.querySelector('.tab-close.dirty')`), 'Dirty indicator remained after saving')

    // A fast edit-and-revert first shows feedback, then clears once the delayed
    // serializer proves that content once again equals the saved source.
    await putCaretAfter(evaluate, '正文锚点。X')
    await typeTextLikeUser(send, 'Y')
    await waitFor(() => evaluate(`!!document.querySelector('.tab-close.dirty')`), 'Re-edit did not show dirty indicator')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await waitFor(() => evaluate(`!document.querySelector('.tab-close.dirty')`), 'Dirty indicator did not clear after reverting to saved content', 40, 25)
    assert.equal(await readFile(file, 'utf8'), '# 未保存提示\n\n正文锚点。X\n', 'Edit-revert unexpectedly changed disk content')

    console.log(`PASS rich dirty indicator UI: immediate ${Math.round(dirtyAt)}ms feedback, no auto-save, delayed source preservation, explicit save, and edit-revert clearing`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
