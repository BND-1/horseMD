import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const sourceFixture = process.env.FILE || '/Users/yangtingyi/vibe_everything/test/测试8.18.md'
const root = `/tmp/horsemd-middle-body-list-${process.pid}`
const file = join(root, 'repro.md')
const port = Number(process.env.CDP_PORT || 10280)
const delay = Number(process.env.KEY_DELAY || 80)

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

const typeOrderedMarker = async (send) => {
  await typeRaw(send, '1', 'Digit1', 49)
  await typeRaw(send, '.', 'Period', 190)
  await typeRaw(send, ' ', 'Space', 32)
}

const typeBulletMarker = async (send) => {
  await typeRaw(send, '-', 'Minus', 189)
  await typeRaw(send, ' ', 'Space', 32)
}

let compositionId = 1
const imeType = async (send, text) => {
  const replacementId = `middle-list-${compositionId++}`
  for (const character of [...String(text)]) {
    const pinyin = 'ceshi'
    const code = pinyin.charCodeAt(0)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code
    })
    await send('Input.imeSetComposition', {
      text: pinyin,
      selectionStart: pinyin.length,
      selectionEnd: pinyin.length,
      replacementId,
      location: 0
    })
    await sleep(delay)
    await send('Input.insertText', { text: character })
    await sleep(delay)
  }
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

const diagnostics = (evaluate) => evaluate(`({
  preserve: (window.__hmPreserveLog || []).slice(-12).map((entry) => ({
    reason: entry.reason,
    preserved: entry.preserved,
    sourceTail: entry.source?.slice(-240),
    previousTail: entry.previous?.slice(-240),
    nextTail: entry.next?.slice(-240),
    markdownTail: entry.markdown?.slice(-240)
  })),
  intents: (window.__hmListIntentTrace || []).slice(-12).map(({ source, canonical, markdown, ...entry }) => ({
    ...entry,
    sourceTail: source?.slice(-160),
    canonicalTail: canonical?.slice(-160),
    markdownTail: markdown?.slice(-160)
  })),
  transactions: (window.__hmSourceTransactionTrace || []).slice(-8).map((entry) => ({
    transactions: entry.transactions?.map((transaction) => ({
      docChanged: transaction.docChanged,
      steps: transaction.steps?.map((step) => step.stepType || step.type)
    }))
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  flush: (window.__hmFlushTrace || []).slice(-20),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-10).map(({ candidate, canonical, ...entry }) => ({ ...entry })),
  structureDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-10)
})`)

const placeCaretAfter = async (app, text) => {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
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
  await sleep(180)
}

const assertSourceContent = (source, label) => {
  const heading = source.indexOf('###### 色反馈白色及开发')
  assert.ok(heading >= 0, `${label}: target heading missing`)
  const region = source.slice(heading, heading + 500)
  assert.match(region, /中间正文/, `${label}: body text missing`)
  assert.match(region, /1\. 有序一/, `${label}: ordered item 1 missing`)
  assert.match(region, /2\. 有序二/, `${label}: ordered item 2 missing`)
  assert.match(region, /- 无序一/, `${label}: bullet item 1 missing`)
  assert.match(region, /- 无序二/, `${label}: bullet item 2 missing`)
  assert.match(region, /后续正文/, `${label}: following paragraph missing`)
  assert.doesNotMatch(region, /(?:^|\n)- 2\. 有序二(?:\n|$)/, `${label}: ordered item became a bullet literal`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFixture, file)
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'editor did not mount'
    )
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmListIntentTrace = []
      window.__hmSourceTransactionTrace = []
      window.__hmFlushTrace = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    await placeCaretAfter(app, '色反馈白色及开发')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await imeType(app.send, '中间正文')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeOrderedMarker(app.send)
    await imeType(app.send, '有序一')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await imeType(app.send, '有序二')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeBulletMarker(app.send)
    await imeType(app.send, '无序一')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await imeType(app.send, '无序二')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await imeType(app.send, '后续正文')
    await sleep(1000)

    const rich = await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)
    assert.match(rich, /中间正文.*有序一.*有序二.*无序一.*无序二/s, 'rich editor lost the inserted sequence')
    assert.equal(await toggleSource(app.evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(app.evaluate), 'source textarea did not open').catch(async (error) => {
      console.error('MIDDLE_BODY_LIST_SOURCE_BUTTONS:', await app.evaluate(`([...document.querySelectorAll('.status-btn')].map((node) => ({ title: node.title, text: node.textContent, display: !!node.offsetParent, disabled: node.disabled })))`))
      console.error('MIDDLE_BODY_LIST_DIAGNOSTICS:', JSON.stringify(await diagnostics(app.evaluate), null, 2))
      throw error
    })
    try {
      assertSourceContent(source, 'source')
    } catch (error) {
      console.error('MIDDLE_BODY_LIST_MISMATCH:', JSON.stringify({ source, rich, diagnostics: await diagnostics(app.evaluate) }, null, 2))
      throw error
    }
    assert.deepEqual(
      (await diagnostics(app.evaluate)).toasts.filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
      [],
      'source sync showed a pause warning'
    )
    console.log('PASS middle body → ordered list → unordered list source sync')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
