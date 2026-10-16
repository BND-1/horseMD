import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-input-intent-staleness-${process.pid}`
const file = join(root, 'fixture.md')
const port = 10900 + (process.pid % 100)
const delay = 10
const fixture = '# A\n\n第一个锚点\n\n# B\n\n第二个锚点\n'

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
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text,
    unmodifiedText: text
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

const placeCaretAfter = async (app, text) => {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(text)}) continue
      const range = document.createRange()
      range.setStart(node, node.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  })()`)
  assert.equal(placed, true, `could not place caret after ${text}`)
}

const typeMarker = async (app, number, punctuation) => {
  await rawKey(app.send, String(number), `Digit${number}`, 48 + number)
  await rawKey(app.send, punctuation, punctuation === '.' ? 'Period' : 'Digit1', punctuation === '.' ? 190 : 49)
  await rawKey(app.send, ' ', 'Space', 32)
}

const toggleSource = async (app) => {
  const point = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|⌘/.test(node.title || node.textContent || ''))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, 'source toggle missing')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

const sourceValue = (app) => app.evaluate(`document.querySelector('textarea.source-editor[style*="display"], textarea.source-editor')?.value || ''`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file, '--horsemd-input-trace']
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
      'editor did not mount'
    )
    await app.evaluate(`(() => { window.__hmPreserveLog = []; window.__hmListIntentTrace = [] })()`)

    // Capture two different list markers before the deferred markdown callback
    // settles. The second list is the one whose marker must win.
    await placeCaretAfter(app, '第一个锚点')
    await rawKey(app.send, 'Enter', 'Enter', 13, '')
    await typeMarker(app, 1, ')')
    await placeCaretAfter(app, '第二个锚点')
    await rawKey(app.send, 'Enter', 'Enter', 13, '')
    await typeMarker(app, 1, '.')
    await sleep(600)

    // Trigger a later callback after the second intent has published. A stale
    // first intent would now be applied to this second list.
    await rawKey(app.send, 'x', 'KeyX', 88)
    await sleep(600)
    await toggleSource(app)
    const source = await waitFor(() => sourceValue(app), 'source did not open')
    console.log(source)
    assert.match(source, /1\. x/, 'the later ordered list lost its own 1. punctuation')
    assert.doesNotMatch(source, /1\) x/, 'a stale earlier ordered-list intent rewrote the later list')
    console.log('PASS stale input intents cannot rewrite a later ordered list')
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
