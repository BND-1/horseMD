import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-trailing-spaces-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10900 + (process.pid % 50))
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

const focusParagraphEnd = async (app, anchorText) => {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node = null
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.includes(${JSON.stringify(anchorText)})) {
        node = walker.currentNode
        break
      }
    }
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, node.textContent.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(ok, true, `could not focus paragraph containing ${anchorText}`)
  await sleep(220)
}

let compositionId = 1
const imeType = async (send, text) => {
  const replacementId = `trailing-spaces-${compositionId++}`
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
  preserve: (window.__hmPreserveLog || []).slice(-24).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    markdown: String(markdown || '').slice(-220)
  })),
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

const fixture = `# 测试

将皮机配件

- slgensklrg
`

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'editor did not mount'
  )
  await app.evaluate(`(() => { window.__hmPreserveLog = [] })()`)

  // Type seven literal spaces at the end of the paragraph, then IME text. The
  // new text must land AFTER the spaces (they are literal text the user typed,
  // not a hard break), never before them.
  await focusParagraphEnd(app, '将皮机配件')
  for (let index = 0; index < 7; index += 1) {
    await rawKey(app.send, ' ', 'Space', 32)
  }
  // Let markdownUpdated commit the trailing spaces to source FIRST, so the
  // next text lands against an already-trailing-space line (the real repro).
  await sleep(900)
  await imeType(app.send, '了；你')
  await sleep(1100)

  const before = await diagnostics(app)
  console.log('TRAILING_SPACES_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved, markdown }) => ({ reason, preserved, markdown })),
    toasts: before.toasts
  }))

  const toggled = await toggleSource(app)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open').catch(async (error) => {
    console.error('TRAILING_SPACES_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
    throw error
  })
  const after = await diagnostics(app)
  console.log('TRAILING_SPACES_SOURCE:', JSON.stringify({ source, toasts: after.toasts }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'typing after literal line-end spaces showed a sync warning'
  )
  assert.match(source, /将皮机配件       了；你/, 'the new text must append after the typed spaces')
  assert.doesNotMatch(source, /将皮机配件了；你\s/, 'the new text must never be inserted before the typed spaces')
  console.log('PASS trailing spaces then text: new text appends after literal line-end spaces')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
