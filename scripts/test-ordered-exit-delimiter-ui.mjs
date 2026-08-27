import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-ordered-exit-delimiter-${process.pid}`
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
    markdown: String(markdown || '').slice(-260)
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

// An ordered list followed by an INDEPENDENT ordered list whose authored
// delimiter is `1)`. Exiting the first list's empty item makes Crepe
// re-serialize the second list with `1.`, which used to inflate the change
// span and delete the whole second list (source-list-structure-mismatch).
const fixture = `# 测试

1. 三个人过

1) 斯卡洛尼快乐
2) 是干嘛的了；吗
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

  // Enter at the end of the first ordered item creates an empty item 2, then
  // Enter inside that empty item removes it and exits the list.
  await focusParagraphEnd(app, '三个人过')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  // The real repro pauses between the two Enters so the first one commits an
  // empty item before the second one lifts it out (two distinct sync cycles).
  await sleep(700)
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await sleep(1100)

  const before = await diagnostics(app)
  console.log('ORDERED_DELIM_AFTER_INPUT:', JSON.stringify({
    reasons: before.preserve.map(({ reason, preserved, markdown }) => ({ reason, preserved, markdown })),
    toasts: before.toasts
  }))

  const toggled = await toggleSource(app)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open').catch(async (error) => {
    console.error('ORDERED_DELIM_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
    throw error
  })
  const after = await diagnostics(app)
  console.log('ORDERED_DELIM_SOURCE:', JSON.stringify({ source, toasts: after.toasts }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'exiting the empty ordered item showed a sync warning'
  )
  assert.match(source, /1\. 三个人过\n/, 'the first ordered item must survive the exit')
  assert.doesNotMatch(source, /(?:^|\n)2\. \n/, 'the emptied second item must be removed, not left as a dangling row')
  assert.match(
    source,
    /1\) 斯卡洛尼快乐\n2\) 是干嘛的了；吗/,
    'the following ordered list must survive with its authored 1) delimiter'
  )
  assert.doesNotMatch(source, /<br/, 'the standalone empty-paragraph placeholder must not leak into source')
  console.log('PASS ordered exit with delimiter flip: empty item removed, following ordered list kept byte-for-byte')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
