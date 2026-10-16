import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const sourceFixture = '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-repeated-ordered-list-${process.pid}`
const file = join(root, 'fixture.md')
const port = 10700 + (process.pid % 100)
const delay = 70

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
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text,
    unmodifiedText: text
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const enter = async (send) => {
  await rawKey(send, 'Enter', 'Enter', 13, '')
}

const typeOrderedMarker = async (send) => {
  await rawKey(send, '1', 'Digit1', 49)
  await rawKey(send, '.', 'Period', 190)
  await rawKey(send, ' ', 'Space', 32)
}

const imeType = async (send, text) => {
  await typeTextLikeUser(send, text, { delayMs: delay })
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

const diagnostics = (app) => app.evaluate(`({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => {
    const snippet = (value) => {
      const text = String(value || '')
      const at = text.indexOf('# 森林')
      return at >= 0 ? text.slice(at, at + 420) : text.slice(-700)
    }
    return {
      ...entry,
      sourceTail: snippet(source),
      previousTail: snippet(previous),
      nextTail: snippet(next),
      markdownTail: snippet(markdown),
      rawForDebug: entry.reason === 'visible-stream-mismatch'
        ? { source, previous, next, markdown }
        : null
    }
  }),
  transactions: (window.__hmSourceTransactionTrace || []).slice(-10).map((entry) => ({
    transactions: entry.transactions?.map((transaction) => ({
      docChanged: transaction.docChanged,
      steps: transaction.steps?.map((step) => step.stepType || step.type)
    }))
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  intents: (window.__hmListIntentTrace || []).slice(-20),
  markerRestore: (window.__hmListMarkerRestoreTrace || []).slice(-20),
  richDoc: ([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.__hmDebugDoc || null)
})`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const fixture = await readFile(sourceFixture, 'utf8')
  const forestStart = fixture.indexOf('# 森林')
  const nextHeading = fixture.indexOf('\n# ', forestStart + 3)
  assert.ok(forestStart >= 0 && nextHeading > forestStart, 'forest section missing from fixture')
  // Keep the full user fixture: the preceding lists are part of the
  // divergence that makes this sequence fail in the real document.
  await writeFile(file, fixture)
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
      window.__hmSourceTransactionTrace = []
      window.__hmListIntentTrace = []
      window.__hmListMarkerRestoreTrace = []
    })()`)

    await placeCaretAfter(app, '了科纳克里；你')
    await enter(app.send)
    await imeType(app.send, '这是一个测试')
    await enter(app.send)
    await enter(app.send)
    await typeOrderedMarker(app.send)
    await imeType(app.send, '测试')
    await enter(app.send)
    await enter(app.send)
    await typeOrderedMarker(app.send)
    await imeType(app.send, '测试')
    await enter(app.send)
    await enter(app.send)
    await imeType(app.send, '测试')
    await sleep(1200)

    const rich = await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)
    assert.equal((rich.match(/这是一个测试/g) || []).length >= 1, true, 'rich text lost the paragraph')
    assert.equal((rich.match(/测试/g) || []).length >= 3, true, 'rich text lost repeated test text')

    assert.equal(await toggleSource(app), true, 'source toggle button missing')
    const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
    const forestStart = source.indexOf('# 森林')
    const forest = source.slice(forestStart, forestStart + 700)
    const finalDiagnostics = await diagnostics(app)
    console.log('REPEATED_INTENTS:', JSON.stringify(finalDiagnostics.intents, null, 2))
    console.log('REPEATED_MARKER_RESTORE:', JSON.stringify(finalDiagnostics.markerRestore, null, 2))
    console.log('REPEATED_FOREST:', JSON.stringify(forest, null, 2))
    assert.equal((forest.match(/这是一个测试/g) || []).length >= 1, true, 'source lost the paragraph')
    assert.equal((forest.match(/测试/g) || []).length >= 3, true, 'source lost repeated test text')
    assert.doesNotMatch(forest, /undefined/, 'source contains an unexpected undefined paragraph')
    assert.doesNotMatch(forest, /1\) 测试/, 'typed ordered punctuation changed from 1. to 1)')
    assert.match(
      forest,
      /1\. 测试\n\n1\. 测试\n\n测试/,
      'source did not preserve two separate ordered blocks followed by a paragraph'
    )
    assert.doesNotMatch(
      forest,
      /1\. 测试\n\s+1\. 测试\n2\./,
      'source incorrectly nested the repeated ordered lists'
    )
    assert.deepEqual(
      (await diagnostics(app)).toasts.filter((text) => /保存已暂停|无法安全映射|Save paused/.test(text)),
      [],
      'source sync showed a pause warning'
    )

    const expectedForest = forest
    assert.equal(await toggleSource(app), true, 'could not return to rich mode before save')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    const savedForest = saved.slice(saved.indexOf('# 森林'), saved.indexOf('# 森林') + 700)
    assert.equal(savedForest, expectedForest, 'save changed the repeated ordered-list structure')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-reopen'),
      port: port + 1,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
      'saved document did not reopen'
    )
    assert.equal(await toggleSource(app), true, 'could not inspect source after reopen')
    const reopened = await waitFor(() => visibleSource(app), 'reopened source textarea did not open')
    const reopenedForest = reopened.slice(reopened.indexOf('# 森林'), reopened.indexOf('# 森林') + 700)
    assert.equal(reopenedForest, expectedForest, 'reopen changed the repeated ordered-list structure')

    console.log('PASS repeated ordered-list middle source sync: separate ordered blocks survive source switch, save, and reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
