import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-leading-space-list-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10930 + (process.pid % 50))
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
  if (text) await send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const focusParagraphEnd = async (app, anchorText) => {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node = null
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.includes(${JSON.stringify(anchorText)})) {
        node = walker.currentNode
        break
      }
    }
    if (!node) return false
    editor.focus()
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
  const replacementId = `leading-space-list-${compositionId++}`
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
  preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    markdown: String(markdown || '').split('\\n').find((line) => line.includes('色粉色分')) || ''
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

1. 第一项
2. 第二项
4. 第四项
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

  // Enter creates the empty 3. item. A leading space causes the canonical
  // `&#x20;` spelling; continuing with IME text and then another ordinary
  // space changes it to two plain spaces after the list marker. The stale
  // U+200B source sentinel must be removed in that transition.
  await focusParagraphEnd(app, '第二项')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, ' ', 'Space', 32)
  await imeType(app.send, '色粉色分')
  await imeType(app.send, '看了你快乐')
  await rawKey(app.send, ' ', 'Space', 32)
  await sleep(1200)

  const before = await diagnostics(app)
  console.log('LEADING_SPACE_LIST_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved, markdown }) => ({ reason, preserved, markdown })),
    toasts: before.toasts
  }))
  assert.equal(
    before.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'leading-space list transition showed a sync warning'
  )

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  const after = await diagnostics(app)
  console.log('LEADING_SPACE_LIST_SOURCE:', JSON.stringify({ source, toasts: after.toasts }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'source switch showed a leading-space sync warning'
  )
  assert.match(source, /(?:^|\n)3\.  色粉色分看了你快乐 \n/m, 'the ordered item must contain two plain spaces and the trailing space')
  assert.doesNotMatch(source, /\u200B/, 'the stale U+200B sentinel must not remain in source')
  console.log('PASS leading-space ordered-list transition: stale sentinel removed after continued typing')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
