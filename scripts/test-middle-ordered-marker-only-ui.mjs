import assert from 'node:assert/strict'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const sourceFixture = process.env.FILE || '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-middle-ordered-marker-only-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 10900 + (process.pid % 50))
const delay = 80

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

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
  await sleep(220)
}

const clickTextEnd = async (app, text) => {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(text)}) continue
      node.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
      const range = document.createRange()
      const start = Math.max(0, node.nodeValue.length - 1)
      range.setStart(node, start)
      range.setEnd(node, node.nodeValue.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + Math.max(1, rect.width / 2), y: rect.top + Math.max(1, rect.height / 2) }
    }
    return null
  })()`)
  assert.ok(point, `could not locate clickable text ${text}`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(220)
}

let compositionId = 1
const imeType = async (send, text) => {
  const replacementId = `middle-ordered-${compositionId++}`
  for (const character of [...String(text)]) {
    await send('Input.imeSetComposition', {
      text: 'ceshi',
      selectionStart: 5,
      selectionEnd: 5,
      replacementId,
      location: 0
    })
    await sleep(delay)
    await send('Input.insertText', { text: character })
    await sleep(delay)
  }
}

const diagnostics = (app) => app.evaluate(`(() => {
  const focus = (value) => {
    const text = String(value || '')
    const at = text.indexOf('# 森林')
    return at >= 0 ? text.slice(at, at + 520) : text.slice(-520)
  }
  return {
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      source: focus(source),
      previous: focus(previous),
      next: focus(next),
      markdown: focus(markdown)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, parsed, expected, ...entry }) => entry),
    structureDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-12),
    paragraph: (window.__hmParagraphTrace || []).slice(-20),
    intents: (window.__hmListIntentTrace || []).slice(-20).map(({ source, canonical, markdown, ...entry }) => ({
      ...entry,
      source: focus(source),
      canonical: focus(canonical),
      markdown: focus(markdown)
    })),
    markerRestore: (window.__hmListMarkerRestoreTrace || []).slice(-20),
    transactions: (window.__hmSourceTransactionTrace || []).slice(-10).map((entry) => ({
      phase: entry.phase,
      steps: entry.steps?.map((step) => step.stepType || step.type),
      transactions: entry.transactions?.map((transaction) => ({
        docChanged: transaction.docChanged,
        steps: transaction.steps?.map((step) => step.stepType || step.type)
      }))
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
  }
})()`)

const toggleSource = async (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFixture, file)
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
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmListIntentTrace = []
    window.__hmSourceTransactionTrace = []
    window.__hmParagraphTrace = []
    window.__hmListMarkerRestoreTrace = []
  })()`)

  // Equivalent to clicking the middle paragraph, then pressing Enter and typing
  // the ordered-list marker without entering an item body yet.
  await placeCaretAfter(app, '啊额绿化')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await rawKey(app.send, '1', 'Digit1', 49)
  await rawKey(app.send, '.', 'Period', 190)
  await rawKey(app.send, ' ', 'Space', 32)
  await imeType(app.send, '识别；不开机')
  await rawKey(app.send, 'Enter', 'Enter', 13, '')
  await sleep(1100)

  const rich = await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)
  const before = await diagnostics(app)
  console.log('MIDDLE_ORDERED_AFTER_INPUT:', JSON.stringify({
    richContainsOrderedText: /你/.test(rich),
    reasons: before.preserve.map(({ reason, preserved }) => ({ reason, preserved })),
    toasts: before.toasts
  }))

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open').catch(async (error) => {
    console.error('MIDDLE_ORDERED_DIAGNOSTICS:', JSON.stringify(await diagnostics(app), null, 2))
    throw error
  })
  const after = await diagnostics(app)
  console.log('MIDDLE_ORDERED_SOURCE:', JSON.stringify({
    sourceForest: (() => { const at = source.indexOf('# 森林'); return at >= 0 ? source.slice(at, at + 180) : source.slice(-180) })(),
    reasons: after.preserve.map(({ reason, preserved }) => ({ reason, preserved })),
    toasts: after.toasts
  }))
  assert.equal(
    after.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'minimal ordered marker input showed a sync warning'
  )
  assert.match(source, /(?:^|\n)1\. 识别；不开机(?:\n|$)/m, 'source does not preserve the ordered item created at the split caret')
  assert.match(source, /(?:^|\n)2\. ?(?:\n|$)/m, 'source does not preserve the next ordered empty item')
  console.log('PASS middle ordered marker-only source sync')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
