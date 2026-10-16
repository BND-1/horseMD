import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-caret-audit-${process.pid}`
const port = Number(process.env.CDP_PORT || 9981)
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
  await sleepMs(60)
}
const richCaret = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const sel = getSelection()
  const node = sel?.anchorNode
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
  const paragraph = element?.closest?.('p, h1, h2, h3, li')
  if (!editor || !paragraph || !editor.contains(paragraph) || !sel.rangeCount) return null
  const before = document.createRange()
  before.selectNodeContents(paragraph)
  before.setEnd(sel.anchorNode, sel.anchorOffset)
  return { text: paragraph.textContent.slice(0, 20), offset: before.toString().length }
})()`)
const sourceCaret = (evaluate) => evaluate(`(() => {
  const t = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
  return t ? { start: t.selectionStart, end: t.selectionEnd } : null
})()`)
async function caretAfter(evaluate, needle) {
  return evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const index = node.nodeValue.indexOf(${JSON.stringify(needle)})
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + ${JSON.stringify(needle)}.length)
      range.collapse(true)
      const sel = getSelection()
      sel.removeAllRanges(); sel.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  })()`)
}
async function clickEmptyP(evaluate, send) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const p = [...editor.querySelectorAll('p')].find((n) => !n.textContent.trim())
    if (!p) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + 8 }
  })()`)
  if (!point) return false
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleepMs(300)
  return true
}

async function run(name, sourceText, setup, expectedSourceCaret) {
  const file = join(root, `${name}.md`)
  await writeFile(file, sourceText)
  const app = await launchBuiltElectron({ profileDir: join(root, `${name}-p`), port: port + Math.floor(Math.random() * 10), appArgs: [file] })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), `${name}: no editor`)
    await setup({ evaluate, send })
    const richBefore = await richCaret(evaluate)
    await toggleSource(evaluate)
    const source = await waitFor(() => visibleSource(evaluate), `${name}: no source`)
    const sc = await sourceCaret(evaluate)
    const effectiveExpected = expectedSourceCaret == null ? source.length : expectedSourceCaret
    const srcOk = sc && sc.start === effectiveExpected
    console.log(`${name}: rich=${JSON.stringify(richBefore)} sourceCaret=${JSON.stringify(sc)} expected=${effectiveExpected} srcOk=${srcOk} source=${JSON.stringify(source)}`)
    // back to rich
    await toggleSource(evaluate)
    await sleepMs(700)
    const richAfter = await richCaret(evaluate)
    const backOk = richAfter && richAfter.text === richBefore.text && richAfter.offset === richBefore.offset
    console.log(`${name}: richAfter=${JSON.stringify(richAfter)} backOk=${backOk}`)
    return srcOk && backOk
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  let pass = true

  // 1. middle empty paragraph (Enter after 你好): caret in empty -> blank line
  pass = pass && await run('middle-empty', '# 测试\n\n你好\n\n再见\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 50 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 50 })
    await sleepMs(600)
  }, '# 测试\n\n你好\n\n再见\n'.indexOf('再见') - 1)

  // 2. trailing empty paragraph: caret in trailing empty -> end of source
  pass = pass && await run('trailing-empty', '# 测试\n\n你好\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
  }, null)

  // 3. multi-toggle chain with caret stable (middle empty)
  {
    const file = join(root, 'chain.md')
    await writeFile(file, '# 测试\n\n你好\n\n再见\n')
    const app = await launchBuiltElectron({ profileDir: join(root, 'chain-p'), port: port + 5, appArgs: [file] })
    try {
      const { evaluate, send } = app
      await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'chain: no editor')
      await caretAfter(evaluate, '你好')
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
      await sleepMs(400)
      const r0 = await richCaret(evaluate)
      for (let i = 0; i < 3; i++) {
        await toggleSource(evaluate)
        await waitFor(() => visibleSource(evaluate), `chain: no source ${i}`)
        await sleepMs(300)
        await toggleSource(evaluate)
        await sleepMs(500)
      }
      const r1 = await richCaret(evaluate)
      const ok = r0.text === r1.text && r0.offset === r1.offset
      console.log(`chain: before=${JSON.stringify(r0)} after3x=${JSON.stringify(r1)} ok=${ok}`)
      pass = pass && ok
    } finally {
      await stopBuiltElectron(app, { removeProfile: true })
    }
  }

  // 4. caret in a NORMAL paragraph after the dance (paragraph not emptied)
  pass = pass && await run('normal-para', '# 测试\n\n你好\n\n再见\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 50 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 50 })
    await sleepMs(600)
  }, '# 测试\n\n你好\n\n再见\n'.indexOf('你好') + 2)

  // 5. empty paragraph before a LIST
  pass = pass && await run('empty-before-list', '# 测试\n\n你好\n\n- 甲\n- 乙\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
  }, '# 测试\n\n你好\n\n- 甲\n- 乙\n'.indexOf('- 甲') - 1)

  // 6. empty paragraph before a TABLE
  pass = pass && await run('empty-before-table', '# 测试\n\n你好\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
  }, '# 测试\n\n你好\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'.indexOf('| A |') - 1)

  // 7. caret at heading text start maps after the '# ' marker (not a gap bug)
  pass = pass && await run('heading-start', '# 测试\n\n你好\n', async ({ evaluate, send }) => {
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const first = editor.querySelector('h1')
      const text = first.firstChild
      const range = document.createRange()
      range.setStart(text, 0)
      range.collapse(true)
      const sel = getSelection()
      sel.removeAllRanges(); sel.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await sleepMs(400)
  }, 2)

  // 7b. empty paragraph after a LIST
  pass = pass && await run('empty-after-list', '# 测试\n\n- 甲\n- 乙\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '乙')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(300)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
  }, null)

  // 7c. empty paragraph after a CODE block
  pass = pass && await run('empty-after-code', '# 测试\n\n```js\ncode\n```\n\n你好\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
  }, null)

  // 8. two consecutive empty paragraphs in the middle
  pass = pass && await run('two-empty', '# 测试\n\n你好\n\n再见\n', async ({ evaluate, send }) => {
    await caretAfter(evaluate, '你好')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(200)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 50 })
    await sleepMs(400)
  }, '# 测试\n\n你好\n\n再见\n'.indexOf('再见') - 1)

  console.log(pass ? 'AUDIT PASS' : 'AUDIT FAIL')
  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
