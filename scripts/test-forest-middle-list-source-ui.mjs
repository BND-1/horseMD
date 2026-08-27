import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const sourceFixture = '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-forest-middle-list-${process.pid}`
const file = join(root, 'fixture.md')
const port = 10600 + (process.pid % 100)
const delay = 80

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const typeRaw = async (send, key, code, keyCode) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const pressEnter = async (send) => {
  const common = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

let compositionId = 1
const imeType = async (send, text) => {
  for (const character of [...String(text)]) {
    const replacementId = `forest-${process.pid}-${compositionId++}`
    const pinyin = 'ceshi'
    for (let index = 0; index < pinyin.length; index += 1) {
      const letter = pinyin[index]
      const keyCode = letter.charCodeAt(0)
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: letter,
        code: `Key${letter.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: letter,
        code: `Key${letter.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      })
      const candidate = pinyin.slice(0, index + 1)
      await send('Input.imeSetComposition', {
        text: candidate,
        selectionStart: candidate.length,
        selectionEnd: candidate.length,
        replacementId,
        location: 0
      })
      await sleep(delay)
    }
    await send('Input.insertText', { text: character })
    await sleep(delay)
  }
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
  await sleep(200)
}

const toggleSource = async (app) => {
  const point = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|⌘/.test(node.title || node.textContent || ''))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!point) return false
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  return true
}

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const diagnostics = (app) => app.evaluate(`(() => {
  const focus = (value) => {
    const text = String(value || '')
    const marker = text.indexOf('# 森林')
    return marker >= 0 ? text.slice(marker, marker + 520) : text.slice(-520)
  }
  return {
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceForest: focus(source),
      previousForest: focus(previous),
      nextForest: focus(next),
      markdownForest: focus(markdown)
    })),
    inputTrace: (window.__hmInputTrace || []).slice(-10),
    transaction: (window.__hmSourceTransactionLog || []).slice(-20),
    transactionTrace: (window.__hmSourceTransactionTrace || []).slice(-10),
    paragraph: (window.__hmParagraphTrace || []).slice(-10),
    intents: (window.__hmListIntentTrace || []).slice(-20),
    flush: (window.__hmFlushTrace || []).slice(-20),
    toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
  }
})()`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFixture, file)
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
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceTransactionLog = []
      window.__hmSourceTransactionTrace = []
      window.__hmParagraphTrace = []
      window.__hmListIntentTrace = []
      window.__hmFlushTrace = []
    })()`)

    const checkpoint = async (label) => {
      const info = await diagnostics(app)
      const failures = info.preserve.filter((entry) => entry.preserved === false)
      console.log('FOREST_CHECKPOINT:', JSON.stringify({
        label,
        preserveCount: info.preserve.length,
        reasons: info.preserve.map((entry) => entry.reason),
        details: info.preserve.slice(-2).map(({ reason, preserved, sourceForest, previousForest, nextForest, markdownForest }) => ({ reason, preserved, sourceForest, previousForest, nextForest, markdownForest })),
        paragraph: info.paragraph.slice(-3),
        failures: failures.map(({ reason, preserved, change, sourceForest, previousForest, nextForest }) => ({ reason, preserved, change, sourceForest, previousForest, nextForest }))
      }))
    }
    await placeCaretAfter(app, '了科纳克里；你')
    await pressEnter(app.send)
    await checkpoint('after-first-enter')
    await imeType(app.send, '测试是否中间正常')
    await checkpoint('after-first-paragraph')
    await pressEnter(app.send)
    await checkpoint('after-paragraph-enter')
    await pressEnter(app.send)
    await checkpoint('after-empty-line-enter')
    await typeRaw(app.send, '1', 'Digit1', 49)
    await checkpoint('after-1')
    await typeRaw(app.send, '.', 'Period', 190)
    await checkpoint('after-period')
    await typeRaw(app.send, ' ', 'Space', 32)
    await checkpoint('after-list-space')
    await pressEnter(app.send)
    await checkpoint('after-empty-list-enter')
    await imeType(app.send, '测试是否中间正常')
    await checkpoint('after-second-paragraph')
    await pressEnter(app.send)
    await pressEnter(app.send)
    await checkpoint('after-second-paragraph-breaks')
    await imeType(app.send, '测试是否中间正常')
    await sleep(1000)

    const rich = await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)
    assert.equal((rich.match(/测试是否中间正常/g) || []).length, 3, 'rich editor lost one of the three paragraphs')
    assert.equal(await toggleSource(app), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(app), 'source textarea did not open', 20).catch(async (error) => {
      console.error('FOREST_SOURCE_BUTTONS:', await app.evaluate(`([...document.querySelectorAll('.status-btn')].map((node) => ({ title: node.title, text: node.textContent, display: !!node.offsetParent, disabled: node.disabled, ariaDisabled: node.getAttribute('aria-disabled'), outer: node.outerHTML.slice(0, 500) })))`))
      console.error('FOREST_SOURCE_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
      throw error
    })
    const forestStart = source.indexOf('# 森林')
    const forestEnd = source.indexOf('\n# ', forestStart + 3)
    const forest = source.slice(forestStart, forestEnd > forestStart ? forestEnd : forestStart + 900)
    console.log('FOREST_SOURCE_REGION:', JSON.stringify(forest))
    assert.equal((forest.match(/测试是否中间正常/g) || []).length, 3, `source lost a paragraph: ${JSON.stringify(forest)}`)
    assert.match(forest, /测试是否中间正常\n\n测试是否中间正常/, 'source did not preserve the middle paragraph boundary')
    assert.match(forest, /测试是否中间正常\n+测试是否中间正常\n+测试是否中间正常\n+这是一个测试\n+1\./, 'source did not preserve the following block boundary')
    const info = await diagnostics(app)
    console.log('FOREST_MIDDLE_RESULT:', JSON.stringify({ rich, source: forest, diagnostics: info }, null, 2))
    const failures = info.preserve.filter((entry) => entry.preserved === false)
    assert.equal(failures.length, 0, `source sync failed: ${JSON.stringify(failures)}`)
    console.log('PASS forest middle paragraph/list/paragraph source sync')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
