import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rich-list-source-${process.pid}`
const file = join(root, 'paragraph-to-list.md')
const port = Number(process.env.CDP_PORT || 9803)
const hasFollowingParagraph = process.env.RICH_LIST_MIDDLE === '1'
const initial = hasFollowingParagraph
  ? '已有正文\n\n保留尾段\n'
  : '已有正文\n'
const expected = hasFollowingParagraph
  ? '已有正文追加正文\n\n- 新列表项\n\n保留尾段\n'
  : '已有正文追加正文\n\n- 新列表项\n\n'

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
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

async function focusEndOfBody(evaluate) {
  const focused = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => !node.closest('li'))
    if (!editor || !paragraph) return false
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    return true
  })()`)
  assert.equal(focused, true, 'could not place the caret at the existing paragraph end')
}

// Markdown delimiters must use raw key events rather than bulk/IME-like text
// insertion. This drives the same beforeinput input-rule path as a person
// pressing the physical `-` and Space keys.
async function typeDelimiter(send, key, code) {
  const keyCode = key === '-' ? 189 : 32
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    key,
    code,
    text: key,
    unmodifiedText: key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  })
  await sleep(90)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-edit'),
      port,
      appArgs: [file]
    })
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmSourceTransactionTrace = []
      window.__hmSourceTransactionLog = []
      window.__hmPreserveLog = []
      window.__hmListIntentTrace = []
    })()`)
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not open'
    )
    await focusEndOfBody(evaluate)

    // Type every committed character as a human would, with waits between
    // structural transactions but a normal contiguous `- ` marker. This exposes
    // the prior input-rule race: a later keystroke merged into the preceding
    // paragraph and defaulted the author-selected `-` marker to Crepe's `*`.
    await typeTextLikeUser(send, '追加正文', { delayMs: 90 })
    await sleep(700)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 90 })
    await sleep(700)
    await typeDelimiter(send, '-', 'Minus')
    await typeDelimiter(send, ' ', 'Space')
    await sleep(700)
    await typeTextLikeUser(send, '新列表项', { delayMs: 90 })
    await sleep(700)

    assert.equal(await toggleSource(evaluate), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea did not open')
    if (source !== expected) {
      console.error('TRANSACTION_TRACE', JSON.stringify(await evaluate(`({
        transactions: window.__hmSourceTransactionTrace || [],
        mapped: window.__hmSourceTransactionLog || [],
        preserved: window.__hmPreserveLog || [],
        intents: window.__hmListIntentTrace || []
      })`), null, 2))
    }
    assert.equal(source, expected, 'paragraph-to-list typing changed the authored list boundary or marker')
    assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'empty-list editor placeholder leaked into source')
    assert.doesNotMatch(source, /\* 新列表项/, 'author-entered dash marker fell back to Crepe default')

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not return'
    )
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'save wrote a different list source than source mode showed')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-reopen'),
      port: port + 1,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'saved document did not reopen in rich mode'
    )
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source after full reopen')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'source textarea did not open after full reopen'),
      expected,
      'full reopen normalized the saved paragraph-to-list source'
    )
    console.log(`PASS rich list source fidelity (${hasFollowingParagraph ? 'middle' : 'end'}): paragraph → Enter → typed dash list preserves boundary, marker, save, and reopen`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
