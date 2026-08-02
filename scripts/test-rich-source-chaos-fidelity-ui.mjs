// Regression: human-like non-linear rich editing. Unlike linear list tests,
// this deliberately creates, deletes, recreates, revisits earlier blocks, and
// only then performs source switches/save/reopen. Input stays background and
// character-by-character; it never touches the user's keyboard or clipboard.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rich-source-chaos-${process.pid}`
const file = join(root, 'chaos.md')
const port = Number(process.env.CDP_PORT || 9816)
const delay = Number(process.env.CHAOS_KEY_DELAY || 55)
const expected = [
  '# Chaos',
  '',
  'prefix',
  '',
  '1. one',
  '2. two',
  '   1. nested',
  '1. rebuilt',
  '   1. nested-rebuilt',
  '- final-one',
  '- final-two',
  '',
  ''
].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function mouseClick(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function clickSelector(evaluate, send, selector) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.min(rect.height / 2, 16) }
  })()`)
  assert.ok(point, `missing editable block: ${selector}`)
  await mouseClick(send, point)
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p, h1') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 5, rect.right - 3), y: rect.top + Math.min(rect.height / 2, 16) }
  })()`)
  assert.ok(point, `could not find text block: ${text}`)
  await mouseClick(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

async function rawKey(send, key, code, keyCode) {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

async function typeListStart(send, marker) {
  if (marker === '-') await rawKey(send, '-', 'Minus', 189)
  else {
    await rawKey(send, '1', 'Digit1', 49)
    await rawKey(send, '.', 'Period', 190)
  }
  await rawKey(send, ' ', 'Space', 32)
}

const enter = (send) => pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
const tab = (send) => pressKey(send, { key: 'Tab', code: 'Tab', delayMs: delay })
const backspace = (send) => pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay })
const sourceValue = (evaluate) => evaluate(`[
  ...document.querySelectorAll('textarea.source-editor')
].find((node) => node.offsetParent)?.value ?? null`)
const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function assertExactSource(evaluate, stage) {
  const source = await waitFor(() => sourceValue(evaluate), `${stage}: source textarea did not appear`)
  assert.equal(source, expected, `${stage}: rich editing rewrote Markdown source`)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-1'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return !!editor?.querySelector('h1') && !!editor?.querySelector('p')
    })()`), 'new document skeleton did not mount')

    // First writing pass: title/body → outer ordered list → nested item.
    await clickSelector(evaluate, send, 'h1')
    await typeTextLikeUser(send, 'Chaos', { delayMs: delay })
    await clickSelector(evaluate, send, 'p')
    await typeTextLikeUser(send, 'prefix', { delayMs: delay })
    await enter(send); await typeListStart(send, '1.'); await typeTextLikeUser(send, 'one', { delayMs: delay })
    await enter(send); await typeTextLikeUser(send, 'two', { delayMs: delay })
    await enter(send); await tab(send); await typeTextLikeUser(send, 'nested', { delayMs: delay })

    // Delete a just-created unordered item, then build another nested ordered
    // list. This is the exact non-linear path that historically corrupted the
    // source baseline.
    await enter(send); await enter(send); await enter(send)
    await typeListStart(send, '-'); await typeTextLikeUser(send, 'transient', { delayMs: delay })
    for (const _character of 'transient') await backspace(send)
    await enter(send)
    await typeListStart(send, '1.'); await typeTextLikeUser(send, 'rebuilt', { delayMs: delay })
    await enter(send); await tab(send); await typeTextLikeUser(send, 'nested-rebuilt', { delayMs: delay })

    // Continue writing another list after the deletion/recreation branch.
    await enter(send); await enter(send); await enter(send)
    await typeListStart(send, '-'); await typeTextLikeUser(send, 'final-one', { delayMs: delay })
    await enter(send); await typeTextLikeUser(send, 'final-two', { delayMs: delay })

    // A human revisits earlier content, deletes and retypes. Net source bytes
    // must return to the same expected fixture without disturbing later lists.
    await clickTextEnd(evaluate, send, 'prefix')
    await typeTextLikeUser(send, 'X', { delayMs: delay }); await backspace(send)
    await clickTextEnd(evaluate, send, 'one')
    await typeTextLikeUser(send, 'X', { delayMs: delay }); await backspace(send)
    await clickTextEnd(evaluate, send, 'nested')
    await typeTextLikeUser(send, 'X', { delayMs: delay }); await backspace(send)

    // No settle delay: force the same save/switch boundary a real writer hits.
    assert.equal(await toggleSource(evaluate), true, 'could not open source mode')
    await assertExactSource(evaluate, 'first immediate rich→source')
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    assert.equal(await toggleSource(evaluate), true, 'could not reopen source mode')
    await assertExactSource(evaluate, 'second no-edit source round-trip')

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich before save')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'rich save wrote different Markdown than source mode')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-2'), port: port + 1, appArgs: [file] })
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'reopened editor did not mount')
    assert.equal(await toggleSource(app.evaluate), true, 'could not open source after full reopen')
    await assertExactSource(app.evaluate, 'full reopen')

    console.log(`PASS rich-source-chaos-fidelity (${delay}ms): create/delete/recreate/back-edit/mode-switch/save/reopen`) 
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    try { await rm(root, { recursive: true, force: true }) } catch {}
  }
}

run().catch((error) => { console.error(error); process.exit(1) })
