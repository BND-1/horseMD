// Reproduce: at the very end of the quote-heavy manual-test file, after the
// trailing quote block, type `1. ` — it must become an ordered list row, not
// the escaped literal `1\.`.
import assert from 'node:assert/strict'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
const root = `/tmp/horsemd-tail-ordered-${process.pid}`
const file = join(root, 'tail.md')
const port = Number(process.env.CDP_PORT || 9870)
const delay = Number(process.env.KEY_DELAY || 70)
const fixture = process.env.FIXTURE
  ? process.env.FIXTURE.replaceAll('\\n', '\n')
  : process.env.SIMPLE === '1' ? 'A\n\nB\n' : [
      '123',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试\\',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试',
      '',
      '1',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试\\',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试\\',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试',
      '',
      '3',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试\\',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试',
      '',
      '# 测试',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试\\',
      '> 测试',
      '>',
      '> 测试',
      '>',
      '> 测试',
      '',
      ''
    ].join('\n')

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function focusEnd(evaluate, send) {
  const done = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const selection = getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.ok(done, 'could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p, h1') || [])]
      .filter((candidate) => !candidate.closest('li'))
      .filter((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)})
      .at(-1)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 5, rect.right - 3), y: rect.top + Math.min(14, rect.height / 2) }
  })()`)
  assert.ok(point, `missing block: ${text}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
  await sleep(200)
}

async function typeDelimiter(send, key, code, keyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(700)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  if (process.env.FILE) {
    await copyFile(process.env.FILE, file)
  } else {
    await writeFile(file, fixture, 'utf8')
  }
  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app
    if (process.env.CLICK_END === '1') {
      await clickTextEnd(evaluate, send, process.env.CLICK_TEXT || '测试')
    } else {
      await focusEnd(evaluate, send)
    }
    if (process.env.TYPE_FIRST === '1') {
      await typeTextLikeUser(send, 'X', { delayMs: delay })
      await sleep(700)
    }
    if (process.env.SEQUENCE === '1') {
      for (const [text, isQuote] of [
        ['123', false],
        ['1', false],
        ['3', false],
        ['# 测试', false],
        ['> 测试', true]
      ]) {
        await typeTextLikeUser(send, text, { delayMs: delay })
        await sleep(400)
        await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
        await sleep(400)
        if (isQuote) {
          await typeDelimiter(send, '>', 'Shift+Period', 190)
          await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
          await typeDelimiter(send, '>', 'Shift+Period', 190)
          await sleep(300)
        }
      }
      // exit the quote: two Enters then type `1. `
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
      await sleep(300)
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
      await sleep(400)
    }
    if (process.env.ENTER_FIRST === '1') {
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
      await sleep(700)
    }
    const marker = process.env.MARKER || '1.'
    if (process.env.INSERT_TEXT === '1') {
      await send('Input.insertText', { text: marker })
      await sleep(delay)
    } else {
      for (const character of marker) {
        const key = /^\d$/.test(character)
          ? { key: character, code: 'Digit' + character, keyCode: 48 + Number(character) }
          : character === '.' ? { key: '.', code: 'Period', keyCode: 190 }
          : character === ')' ? { key: ')', code: 'Digit0', keyCode: 48 }
          : { key: character, code: 'Minus', keyCode: 189 }
        await typeDelimiter(send, key.key, key.code, key.keyCode)
        if (process.env.STEP_DEBUG === '1') {
          const state = await evaluate(`(() => {
            const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
            return {
              text: editor?.textContent?.slice(-20),
              lists: editor?.querySelectorAll('ul, ol')?.length || 0
            }
          })()`)
          console.log(`after '${character}':`, JSON.stringify(state))
        }
      }
    }
    await typeDelimiter(send, ' ', ' ', 32)
    if (process.env.STEP_DEBUG === '1') {
      const state = await evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return {
          text: editor?.textContent?.slice(-20),
          lists: editor?.querySelectorAll('ul, ol')?.length || 0
        }
      })()`)
      console.log(`after space:`, JSON.stringify(state))
    }
    await sleep(600)
    const richText = await evaluate(`([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent || '')`)
    console.log('rich tail:', JSON.stringify(richText.slice(-80)))
    const pmStructure = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const lastBlock = [...editor.querySelectorAll(':scope > *')].at(-1)
      return { tag: lastBlock?.tagName, cls: lastBlock?.className?.slice(0, 60) }
    })()`)
    console.log('last pm block:', JSON.stringify(pmStructure))
    assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea missing')
    console.log('source tail:', JSON.stringify(source.slice(-80)))
    const lastLine = source.split('\n').filter(Boolean).at(-1)
    console.log('last source line:', JSON.stringify(lastLine))
    const log = await evaluate(`(window.__hmPreserveLog || []).slice(-3).map((entry) => ({
      reason: entry.reason,
      previousTail: entry.previous?.slice(-60),
      nextTail: entry.next?.slice(-60),
      markdownTail: entry.markdown?.slice(-60)
    }))`)
    console.log('preserve log:', JSON.stringify(log, null, 1))
    assert.doesNotMatch(
      lastLine,
      /\\\./,
      `typed \`1. \` must not escape as literal: ${JSON.stringify(lastLine)}`
    )
    console.log('PASS tail ordered list: `1. ` at document end stays unescaped')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
