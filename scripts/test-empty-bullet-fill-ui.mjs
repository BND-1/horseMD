import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-empty-bullet-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10880 + (process.pid % 50))
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

// Place the caret at the very end of the paragraph containing `anchorText`.
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
  const replacementId = `empty-bullet-${compositionId++}`
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
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, parsed, expected, ...entry }) => entry),
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

// Mirrors the user's 无序列表测试.md divergence: a bare `1` paragraph followed
// by an authored `-   1. 二哥...` row whose nested-list shape Crepe serializes
// differently (`* <br />` + `  1. 二哥...`).
const fixture = `# 无序列表测试

啊额绿化

1

-   1. 二哥你来拿如果
  - ​     就了解了呢
  * 如果可能老顾客
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
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
  })()`)

  // Click at the end of 啊额绿化, Enter to create a middle empty block, then
  // `- ` + space to run the BULLET input rule (writes an empty `- ` row into
  // the source), then IME text. The regression wrote the committed IME text as
  // a NEW paragraph before the empty `- ` row instead of filling the bullet
  // item, failing the list-structure fingerprint.
  await focusParagraphEnd(app, '啊额绿化')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, '-', 'Minus', 189)
  await rawKey(app.send, ' ', 'Space', 32)
  await imeType(app.send, '了海伦凯勒看')
  await sleep(1100)

  const before = await diagnostics(app)
  console.log('EMPTY_BULLET_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved, markdown }) => ({ reason, preserved, markdown })),
    toasts: before.toasts
  }))

  const toggled = await toggleSource(app)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open').catch(async (error) => {
    console.error('EMPTY_BULLET_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
    throw error
  })
  const after = await diagnostics(app)
  console.log('EMPTY_BULLET_SOURCE:', JSON.stringify({ source, toasts: after.toasts }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'filling the empty bullet after the input rule showed a sync warning'
  )
  assert.match(source, /啊额绿化\n\n- 了海伦凯勒看\n\n1\n/m, 'the IME text must fill the - row in place')
  assert.doesNotMatch(source, /了海伦凯勒看\n\n- /, 'the IME text must never be a separate paragraph before the empty bullet')
  assert.match(source, /-   1\. 二哥你来拿如果/, 'the divergent authored row must stay untouched')
  console.log('PASS empty bullet after input rule: IME text fills the - row in place')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
