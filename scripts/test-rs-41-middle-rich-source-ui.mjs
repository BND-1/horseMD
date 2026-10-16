import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
assert.ok(sourceFile, 'FILE is required')

const root = `/tmp/horsemd-rs-41-middle-${process.pid}`
const file = join(root, 'repro.md')
const port = Number(process.env.CDP_PORT || 10240)
const delay = Number(process.env.KEY_DELAY || 55)

const insertedPhrases = [
  '色反馈白色及开发',
  '色粉发',
  'sees高；就；就',
  '老师科纳克里呢',
  '额法俄法'
]

async function waitFor(check, message, attempts = 160) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    `${profile}: editor did not mount`
  )
  await sleep(700)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceTransactionLog = []
    window.__hmSourceTransactionTrace = []
  })()`)
  return app
}

async function placeCaretAtStart(app, text) {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(text)}) continue
      const range = document.createRange()
      range.setStart(node, 0)
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
  assert.equal(placed, true, `could not place caret at start of ${text}`)
  await sleep(160)
}

async function typeDelimiter(app, key, code, keyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await app.send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text: key,
    unmodifiedText: key
  })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

async function typeOrderedMarker(app) {
  await typeDelimiter(app, '1', 'Digit1', 49)
  await typeDelimiter(app, '.', 'Period', 190)
  await typeDelimiter(app, ' ', 'Space', 32)
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

const visibleRichText = (evaluate) => evaluate(`(
  [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent)?.textContent ?? ''
)`)

const diagnostics = (evaluate) => evaluate(`({
  preserve: (window.__hmPreserveLog || []).slice(-4).map((entry) => {
    const focus = (value) => {
      const text = String(value || '')
      const at = text.indexOf('###### 色反馈白色及开发')
      return at >= 0 ? text.slice(Math.max(0, at - 180), at + 420) : text.slice(-220)
    }
    const previous = String(entry.previous || '')
    const next = String(entry.next || '')
    let start = 0
    while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1
    let previousEnd = previous.length
    let nextEnd = next.length
    while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
      previousEnd -= 1
      nextEnd -= 1
    }
    return {
      reason: entry.reason,
      preserved: entry.preserved,
      change: {
        start,
        previousEnd,
        nextEnd,
        previousSlice: focus(previous.slice(start, previousEnd)),
        nextSlice: focus(next.slice(start, nextEnd))
      },
      source: focus(entry.source),
      previous: focus(previous),
      next: focus(next),
      markdown: focus(entry.markdown)
    }
  }),
  transaction: (window.__hmSourceTransactionLog || []).slice(-20).map(({ ok, reason }) => ({ ok, reason })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
})`)

function assertPhrases(value, label) {
  for (const phrase of insertedPhrases) {
    assert.ok(value.includes(phrase), `${label} lost phrase ${phrase}: ${JSON.stringify(value.slice(-500))}`)
  }
}

function assertTargetOrderedList(value, label) {
  const start = value.lastIndexOf('###### 色反馈白色及开发')
  const end = value.indexOf('额法俄法', start)
  assert.ok(start >= 0 && end > start, `${label} target block not found`)
  const region = value.slice(start, end)
  assert.match(region, /(?:^|\n)1\. 色粉发(?:\n|$)/, `${label} lost ordered item 1`)
  assert.match(region, /(?:^|\n)2\. sees高；就；就(?:\n|$)/, `${label} lost ordered item 2`)
  assert.match(region, /(?:^|\n)3\. 老师科纳克里呢(?:\n|$)/, `${label} lost ordered item 3`)
  assert.doesNotMatch(region, /(?:^|\n)[-+*] 2\. sees高；就；就(?:\n|$)/, `${label} converted ordered item 2 into a bullet wrapper`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFile, file)

  let app
  try {
    app = await openApp('edit', port)
    await placeCaretAtStart(app, '额法俄法')

    // Create a new paragraph immediately before the existing middle paragraph.
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, insertedPhrases[0], { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeOrderedMarker(app)
    await typeTextLikeUser(app.send, insertedPhrases[1], { delayMs: delay })
    // Enter continues the existing ordered list and assigns the next number;
    // the real user sequence does not type `2.` / `3.` again.
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, insertedPhrases[2], { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, insertedPhrases[3], { delayMs: delay })
    // Exit the list before the original following paragraph.
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await sleep(900)

    const rich = await visibleRichText(app.evaluate)
    assertPhrases(rich, 'rich text')

    assert.equal(await toggleSource(app.evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(app.evaluate), 'source textarea did not open')
    try {
      assertPhrases(source, 'source')
      assertTargetOrderedList(source, 'source')
    } catch (error) {
      console.error('SOURCE MISMATCH', JSON.stringify({ source, rich, diagnostics: await diagnostics(app.evaluate) }, null, 2))
      throw error
    }
    assert.deepEqual(
      (await diagnostics(app.evaluate)).toasts.filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
      [],
      'source sync showed a pause warning'
    )

    assert.equal(await toggleSource(app.evaluate), true, 'return to rich failed')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'rich editor did not return')
    await sleep(250)
    assertPhrases(await visibleRichText(app.evaluate), 'rich round trip')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const saved = await readFile(file, 'utf8')
    assertPhrases(saved, 'saved source')
    assertTargetOrderedList(saved, 'saved source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assertPhrases(await visibleRichText(app.evaluate), 'reopened rich text')
    assert.equal(await toggleSource(app.evaluate), true, 'reopen source toggle failed')
    const reopenedSource = await waitFor(() => visibleSource(app.evaluate), 'reopened source did not open')
    assertPhrases(reopenedSource, 'reopened source')
    assertTargetOrderedList(reopenedSource, 'reopened source')

    console.log('PASS RS-41 middle rich/source input sequence')
  } catch (error) {
    if (app) console.error('RS-41 diagnostics:', JSON.stringify(await diagnostics(app.evaluate), null, 2))
    throw error
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
