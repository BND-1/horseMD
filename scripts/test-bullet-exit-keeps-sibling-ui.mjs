import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-bullet-exit-keeps-sibling-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10870 + (process.pid % 50))
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

// The exact reproduction from 无序列表测试.md: a bullet item followed by a
// blank line and a second bullet item. Pressing Enter at the end of the first
// item creates an empty `- ` row (first Enter), then Enter inside that empty
// item lifts it out to a blank paragraph (second Enter). The following sibling
// row `- 露娜了` must survive byte-for-byte; only the empty row is removed.
const fixture = `# 测试

- 是v的；发布

- 露娜了

啊额绿化
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

  // Enter creates the empty bullet item; wait for its markdownUpdated sync to
  // land (the user pauses between keystrokes, so the empty `- ` row reaches the
  // source first), then Enter inside the empty item exits the list. This
  // two-phase flow is what previously sent the exit transaction down the wrong
  // handler and deleted the following sibling row.
  await focusParagraphEnd(app, '是v的；发布')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await sleep(650)
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await sleep(1100)

  const before = await diagnostics(app)
  console.log('BULLET_EXIT_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved, markdown }) => ({ reason, preserved, markdown })),
    toasts: before.toasts
  }))

  const toggled = await toggleSource(app)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open').catch(async (error) => {
    console.error('BULLET_EXIT_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
    throw error
  })
  const after = await diagnostics(app)
  console.log('BULLET_EXIT_SOURCE:', JSON.stringify({ source, toasts: after.toasts }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'exiting the empty bullet item showed a sync warning'
  )
  assert.match(source, /- 是v的；发布\n\n- 露娜了/, 'the sibling bullet list must survive with its authored marker and blank separator')
  assert.match(source, /啊额绿化/, 'the following paragraph must survive')
  assert.doesNotMatch(source, /(?:^|\n)- \n/, 'the emptied middle bullet row must be removed, not left dangling')
  assert.doesNotMatch(source, /<br/, 'the standalone empty-paragraph placeholder must not leak into source')
  console.log('PASS bullet exit with following sibling: empty row removed, sibling list kept byte-for-byte')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
