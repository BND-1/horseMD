import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-paragraph-source-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 9852)

const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function clickRichBlock(evaluate, send, selector) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.min(18, rect.height / 2) }
  })()`)
  assert.ok(point, `block not found: ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

const rawKey = async (send, key, code, keyCode) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleepMs(90)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# 测试\n\n你好\n\n再见\n')
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    let { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not open'
    )

    // Scenario A: empty out the middle paragraph (delete all its text), then
    // type '.', delete, type '/', delete — exactly the user's repro.
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '你好')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    for (const _ of '你好') await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)

    await toggleSource(evaluate)
    const sourceValue = await waitFor(() => visibleSource(evaluate), 'source did not open')
    assert.equal(sourceValue, '# 测试\n\n\n\n再见\n', 'emptying a middle paragraph must not leak <br /> into source')

    await toggleSource(evaluate)
    await sleepMs(400)

    // Scenario B: press Enter to create an empty paragraph, then the same
    // '.' '/' dance on that fresh empty line.
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '再见')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)

    await toggleSource(evaluate)
    const sourceValueB = await waitFor(() => visibleSource(evaluate), 'source B did not open')
    assert.ok(
      !/<br\s*\/?>/.test(sourceValueB || ''),
      'typing and deleting inside an empty paragraph must never leak <br /> into source'
    )
    assert.ok(sourceValueB.includes('再见'), 'the untouched paragraph must survive the empty-line dance')

    // Scenario C: empty the trailing paragraph and switch — the last block
    // must not serialize its internal <br /> either.
    await toggleSource(evaluate)
    await sleepMs(400)
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '再见')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    for (const _ of '再见') await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)
    await toggleSource(evaluate)
    const sourceValueC = await waitFor(() => visibleSource(evaluate), 'source C did not open')
    assert.ok(
      !/<br\s*\/?>/.test(sourceValueC || ''),
      'emptying the trailing paragraph must not leak <br /> into source'
    )

    // Scenario D: the exact user repro on a heading-based document. Press
    // Enter inside a heading (empty paragraph after it), create ANOTHER empty
    // paragraph elsewhere, then run the '.' '/' dance in the heading's empty
    // paragraph. The unrelated empty paragraph used to veto the mapping and
    // let <br /> leak through the localized replacement.
    await toggleSource(evaluate)
    await sleepMs(400)
    await writeFile(file, '# 标题\n\n## 第一节\n\n正文甲\n\n## 第二节\n\n正文乙\n')
    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-d'),
      port: port + 1,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor?.textContent.includes('正文乙')
      })()`),
      'heading fixture did not reload'
    )
    await clickRichBlock(evaluate, send, 'h2')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const heading = [...editor.querySelectorAll('h2')].find((node) => node.textContent === '第一节')
      const text = heading.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    // unrelated empty paragraph at the end
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '正文乙')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    // dance in the heading's empty paragraph
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraphs = [...editor.querySelectorAll('p')]
      const empty = paragraphs.find((node) => !node.textContent.trim())
      if (!empty) return false
      const range = document.createRange()
      range.setStart(empty, 0)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)
    await toggleSource(evaluate)
    const sourceValueD = await waitFor(() => visibleSource(evaluate), 'source D did not open')
    assert.ok(
      !/<br\s*\/?>/.test(sourceValueD || ''),
      'a heading-created empty paragraph plus another unrelated empty paragraph must not leak <br /> into source'
    )
    assert.ok(sourceValueD.includes('正文乙'), 'the unrelated paragraph must survive the heading empty-line dance')

    console.log('PASS empty-paragraph source fidelity: emptied paragraphs never leak <br />, save/reopen stays clean')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
