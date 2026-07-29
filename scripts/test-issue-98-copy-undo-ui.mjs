import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP issue 98 clipboard verification: native clipboard assertion runs on macOS')
  process.exit(0)
}

const root = `/tmp/horsemd-issue-98-copy-undo-${process.pid}`
const fixture = join(root, 'copy-undo.md')
const code = 'const alpha = 1\nconsole.log(alpha)'
const previousClipboard = execFileSync('pbpaste', { encoding: 'utf8' })
let app = null

const waitFor = async (check, message, attempts = 50) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

try {
  await mkdir(root, { recursive: true })
  await writeFile(fixture, [
    '# Copy and undo',
    '',
    'Editable target',
    '',
    '**bold-marker**',
    '',
    '```javascript',
    'const alpha = 1',
    'console.log(alpha)',
    '```'
  ].join('\n'), 'utf8')

  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port: 9810 + (process.pid % 80),
    appArgs: [fixture]
  })

  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.querySelector('.milkdown-code-block .copy-button')`),
    'code block copy button did not render'
  )
  const clicked = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const button = editor?.querySelector('.milkdown-code-block .copy-button')
    button?.click()
    return Boolean(button)
  })()`)
  assert.equal(clicked, true)
  await sleep(150)
  assert.equal(execFileSync('pbpaste', { encoding: 'utf8' }), code, 'code-block button did not copy the complete code')

  const boldRect = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const strong = [...(editor?.querySelectorAll('strong') || [])].find((node) => node.textContent === 'bold-marker')
    const rect = strong?.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(boldRect)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: boldRect.left + 1, y: boldRect.y, button: 'left', clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: boldRect.right - 1, y: boldRect.y, button: 'left', buttons: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: boldRect.right - 1, y: boldRect.y, button: 'left', clickCount: 1
  })
  await sleep(100)
  const richPlain = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const clipboardData = new DataTransfer()
    editor.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
    return clipboardData.getData('text/plain')
  })()`)
  assert.match(richPlain, /\*\*bold-marker\*\*/, 'rich copy lost Markdown markers')

  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => node.textContent.includes('Editable target'))
    const rect = paragraph?.getBoundingClientRect()
    return rect ? { x: rect.right - 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
  })
  await app.send('Input.insertText', { text: '-undo-marker' })
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror p')].some((node) => node.textContent.includes('Editable target-undo-marker'))`),
    'typed undo marker did not appear'
  )
  await app.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'z',
    code: 'KeyZ',
    modifiers: 4,
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'z',
    code: 'KeyZ',
    modifiers: 4,
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90
  })
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror p')].some((node) => node.textContent === 'Editable target')`),
    'Cmd+Z did not undo the rich-editor edit'
  )

  console.log('PASS issue 98 UI: native code copy, Markdown-rich copy, and editor undo')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  spawnSync('pbcopy', { input: previousClipboard })
  await rm(root, { recursive: true, force: true })
}
