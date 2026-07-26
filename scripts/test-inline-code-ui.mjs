import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9697)
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'inline-code-input.md')

async function waitFor(check, message, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  const app = await launchBuiltElectron({
    profileDir: `/tmp/horsemd-inline-code-ui-${process.pid}`,
    port,
    appArgs: [fixture]
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
      'inline-code fixture did not render'
    )
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.ProseMirror')]
        .filter((node) => node.offsetParent)
        .some((editor) => [...editor.querySelectorAll('p')].some((node) => node.textContent.includes('Type target')))`),
      'inline-code input target did not render'
    )
    const caretPoint = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...(editor?.querySelectorAll('p') || [])]
        .find((node) => node.textContent.includes('Type target'))
      const rect = paragraph?.getBoundingClientRect()
      return rect ? { x: rect.right - 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(caretPoint, 'could not locate the real editor input target')
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: caretPoint.x, y: caretPoint.y, button: 'left', clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: caretPoint.x, y: caretPoint.y, button: 'left', clickCount: 1
    })
    await sleep(100)

    // Use native key events rather than Input.insertText: the latter bypasses
    // ProseMirror's handleTextInput hook and therefore cannot validate the
    // keyboard path users actually take.
    for (let index = 0; index < 3; index += 1) {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: '`',
        code: 'Backquote',
        windowsVirtualKeyCode: 192,
        nativeVirtualKeyCode: 192
      })
      await send('Input.dispatchKeyEvent', {
        type: 'char',
        key: '`',
        code: 'Backquote',
        text: '`',
        unmodifiedText: '`',
        windowsVirtualKeyCode: 192,
        nativeVirtualKeyCode: 192
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: '`',
        code: 'Backquote',
        windowsVirtualKeyCode: 192,
        nativeVirtualKeyCode: 192
      })
      await sleep(80)
    }
    const richTextBeforeSource = await evaluate(`[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || ''`)

    assert.equal(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\//.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`), true, 'could not open source mode')
    const source = await waitFor(
      () => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value || null`),
      'source editor did not open'
    )
    assert.match(
      source,
      /Type target(?:\\?`){3}/,
      `three manually typed backticks must remain intact in Markdown; rich text was: ${richTextBeforeSource}`
    )
    console.log('PASS inline code UI: manual triple-backtick input is not deleted')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
