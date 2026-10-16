import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-marker-empty-${process.pid}`
const file = join(root, 'seq.md')
const port = Number(process.env.CDP_PORT || 9921)
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

const rawKey = async (send, key, code, keyCode) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleepMs(70)
}
const enter = (send) => pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
const tab = (send) => pressKey(send, { key: 'Tab', code: 'Tab', delayMs: 50 })

async function clickH1(evaluate, send) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector('h1')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + 12 }
  })()`)
  assert.ok(point, 'no h1')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleepMs(300)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')
  const app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
  const { evaluate, send } = app
  try {
    await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'no editor')
    await clickH1(evaluate, send)
    await typeTextLikeUser(send, '测试', { delayMs: 60 })
    await sleepMs(500)
    await enter(send); await sleepMs(300)
    await typeTextLikeUser(send, '测试', { delayMs: 60 })
    await sleepMs(500)
    await enter(send); await sleepMs(300)
    // `## ` heading input rule
    await rawKey(send, '#', 'Digit3', 51); await rawKey(send, '#', 'Digit3', 51); await rawKey(send, ' ', 'Space', 32)
    await typeTextLikeUser(send, '测试', { delayMs: 60 })
    await sleepMs(500)
    await enter(send); await sleepMs(300)
    // ordered list 1. / 2.
    await rawKey(send, '1', 'Digit1', 49); await rawKey(send, '.', 'Period', 190); await rawKey(send, ' ', 'Space', 32)
    await typeTextLikeUser(send, '测试', { delayMs: 60 })
    await sleepMs(500)
    await enter(send); await sleepMs(300)
    await typeTextLikeUser(send, '测试', { delayMs: 60 })
    await sleepMs(500)
    await enter(send); await sleepMs(300) // empty ordered item 3.
    await enter(send); await sleepMs(300) // exit list
    // bullet `- 测试`
    await rawKey(send, '-', 'Minus', 189); await rawKey(send, ' ', 'Space', 32)
    await typeTextLikeUser(send, '测试', { delayMs: 60 })
    await sleepMs(500)
    await enter(send); await sleepMs(300) // empty bullet item
    await tab(send); await sleepMs(300) // nested empty bullet item
    await sleepMs(700)

    await toggleSource(evaluate)
    const source = await waitFor(() => visibleSource(evaluate), 'no source')
    assert.equal(
      /<br\s*\/?>/.test(source || ''),
      false,
      'empty list items must never leak <br /> into source: ' + JSON.stringify(source)
    )
    assert.ok(
      source.includes('- 测试') && !source.includes('* 测试'),
      'a typed dash bullet must survive as `-` after an ordered list and empty nested items: ' + JSON.stringify(source)
    )
    assert.ok(
      !source.includes('## 测试1.'),
      'a stale ordered input-rule intent must not glue list rows onto the heading: ' + JSON.stringify(source)
    )
    console.log('PASS list marker + empty-item source fidelity: dash marker kept, no <br />, heading not glued')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
