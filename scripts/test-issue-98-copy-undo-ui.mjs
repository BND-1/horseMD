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

const selectContents = async (selector, text, includeElement = false) => {
  const selected = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const element = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
      .find((node) => node.textContent.includes(${JSON.stringify(text)}))
    if (!element) return null
    editor.focus()
    const range = document.createRange()
    if (${JSON.stringify(includeElement)}) range.selectNode(element)
    else range.selectNodeContents(element)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return selection.toString()
  })()`)
  assert.ok(selected, `could not select ${text}`)
  await sleep(100)
  return selected
}

const readCopyPayload = () => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const clipboardData = new DataTransfer()
  const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData })
  editor.dispatchEvent(event)
  return {
    prevented: event.defaultPrevented,
    plain: clipboardData.getData('text/plain'),
    markdown: clipboardData.getData('text/markdown'),
    html: clipboardData.getData('text/html'),
    types: [...clipboardData.types]
  }
})()`)

try {
  await mkdir(root, { recursive: true })
  await writeFile(fixture, [
    '# Copy and undo',
    '',
    'Editable target',
    '',
    'Paragraph copy target',
    '',
    'Soft-break copy first',
    'Soft-break copy second',
    '',
    '**bold-marker**',
    '',
    '1. Ordered item copy target',
    '',
    'Paste destination',
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

  await selectContents('p', 'Paragraph copy target')
  const paragraphCopy = await readCopyPayload()
  assert.equal(paragraphCopy.prevented, true)
  assert.equal(paragraphCopy.plain, 'Paragraph copy target', 'plain paragraph copy gained block newlines')
  assert.equal(paragraphCopy.markdown.trim(), 'Paragraph copy target')
  assert.match(paragraphCopy.html, /Paragraph copy target/)

  await selectContents('p', 'Soft-break copy first')
  const softBreakCopy = await readCopyPayload()
  assert.equal(
    softBreakCopy.plain,
    'Soft-break copy first\nSoft-break copy second',
    'visually preserved source newline did not remain a plain-text newline'
  )
  assert.match(
    softBreakCopy.html,
    /Soft-break copy first<br[^>]*>Soft-break copy second/,
    'visually preserved source newline did not become an HTML line break'
  )
  assert.equal(
    softBreakCopy.markdown.trim(),
    'Soft-break copy first\nSoft-break copy second',
    'Markdown clipboard flavor changed an ordinary source newline'
  )

  await selectContents('strong', 'bold-marker', true)
  const boldCopy = await readCopyPayload()
  assert.equal(boldCopy.plain, 'bold-marker', 'plain rich-text copy exposed Markdown delimiters')
  assert.match(boldCopy.markdown, /\*\*bold-marker\*\*/, 'Markdown clipboard flavor lost bold markers')
  assert.match(boldCopy.html, /<strong[^>]*>bold-marker<\/strong>/, 'HTML clipboard flavor lost bold markup')

  await selectContents('ol', 'Ordered item copy target')
  const orderedCopy = await readCopyPayload()
  assert.equal(
    orderedCopy.plain,
    'Ordered item copy target',
    'plain ordered-list copy gained a generated list marker'
  )
  assert.match(
    orderedCopy.markdown,
    /1\.\s+Ordered item copy target/,
    'Markdown clipboard flavor lost ordered-list structure'
  )

  await selectContents('p', 'Paste destination')
  const pastedOrderedList = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', ${JSON.stringify(orderedCopy.plain)})
    clipboardData.setData('text/markdown', ${JSON.stringify(orderedCopy.markdown)})
    clipboardData.setData('text/html', ${JSON.stringify(orderedCopy.html)})
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    editor.dispatchEvent(event)
    return event.defaultPrevented
  })()`)
  assert.equal(pastedOrderedList, true, 'HorseMD did not consume its Markdown clipboard flavor')
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror ol li')].filter((node) => node.textContent.includes('Ordered item copy target')).length === 2`),
    'internal paste lost ordered-list structure'
  )

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

  console.log('PASS issue 98 UI: clipboard MIME separation, native code copy, and editor undo')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  spawnSync('pbcopy', { input: previousClipboard })
  await rm(root, { recursive: true, force: true })
}
