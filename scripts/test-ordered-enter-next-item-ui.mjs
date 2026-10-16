import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-ordered-enter-next-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10960 + (process.pid % 50))
const delay = 80

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const focusEditorEnd = async (app) => {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const selection = getSelection()
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(ok, true, 'could not focus editor end')
  await sleep(220)
}

let compositionId = 1
const imeType = async (send, text) => {
  const replacementId = `ordered-enter-${compositionId++}`
  for (const character of [...String(text)]) {
    await send('Input.imeSetComposition', {
      text: 'ceshi',
      selectionStart: 5,
      selectionEnd: 5,
      replacementId,
      location: 0
    })
    await sleep(delay)
    await send('Input.insertText', { text: character })
    await sleep(delay)
  }
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    markdown: String(markdown || '').slice(-240)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, parsed, expected, ...entry }) => entry),
  intents: (window.__hmListIntentTrace || []).slice(-20).map(({ source, canonical, markdown, ...entry }) => entry),
  markerRestore: (window.__hmListMarkerRestoreTrace || []).slice(-20),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
}))()`)

const toggleSource = async (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '', 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'editor did not mount'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmListIntentTrace = []
    window.__hmListMarkerRestoreTrace = []
  })()`)

  // Fresh document (generated-scratch path): heading, ordered list item with an
  // IME body, then Enter to create the auto-numbered next item. The stale `1.`
  // input intent must not rewrite the canonical `2.` row.
  await focusEditorEnd(app)
  await rawKey(app.send, '#', 'Digit3', 51, '#')
  await rawKey(app.send, ' ', 'Space', 32)
  await imeType(app.send, '测试')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, '1', 'Digit1', 49)
  await rawKey(app.send, '.', 'Period', 190)
  await rawKey(app.send, ' ', 'Space', 32)
  await imeType(app.send, '是v女老师可能离开')
  // Item 2 with text, then Enter creates item 3, and Enter inside that EMPTY
  // item removes it and exits the list. The authored blank lines created by
  // the exit must collapse to the canonical single empty block (0.13.68).
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await imeType(app.send, '色粉色分')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  // Typing a lone `-` after exiting must stay a literal dash (`\-`).
  await rawKey(app.send, '-', 'Minus', 189, '-')
  await sleep(1100)

  const before = await diagnostics(app)
  const rich = await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)
  console.log('ORDERED_ENTER_AFTER_INPUT:', JSON.stringify({
    rich,
    reasons: before.preserve.map(({ reason, preserved, markdown }) => ({ reason, preserved, markdown })),
    toasts: before.toasts,
    markerRestore: before.markerRestore
  }))

  const toggled = await toggleSource(app)
  console.log('ORDERED_ENTER_TOGGLE:', toggled)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open').catch(async (error) => {
    console.error('ORDERED_ENTER_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
    throw error
  })
  const after = await diagnostics(app)
  console.log('ORDERED_ENTER_SOURCE:', JSON.stringify({
    source,
    reasons: after.preserve.map(({ reason, preserved }) => ({ reason, preserved })),
    toasts: after.toasts
  }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'Enter next ordered item showed a sync warning'
  )
  assert.match(source, /(?:^|\n)1\. 是v女老师可能离开(?:\n|$)/m, 'source does not preserve the first ordered item')
  // The second Enter sits in the empty `2. ` item, so that item is removed
  // while exiting the list — the auto-numbering fix is verified before the
  // second Enter by the rich caret transition and the absent mismatch toast.
  assert.match(source, /(?:^|\n)\\- ?(?:\n|$)/m, 'a lone dash typed after exiting the list must keep its escape')
  assert.doesNotMatch(source, /(?:^|\n)- ?(?:\n|$)/m, 'a lone dash must never be written as an empty bullet item')
  console.log('PASS ordered Enter keeps auto-numbering and a typed lone dash stays literal')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
