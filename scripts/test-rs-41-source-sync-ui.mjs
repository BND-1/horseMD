import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs-41-source-sync-${process.pid}`
const listFile = join(root, 'tail-list.md')
const replaceFile = join(root, 'whole-replace.md')
const rawPasteFile = join(root, 'raw-markdown-paste.md')
const basePort = Number(process.env.CDP_PORT || (10900 + (process.pid % 50)))

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const open = async (file, profile, port) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    `editor did not mount for ${file}`
  )
  await sleep(600)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmListIntentTrace = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceSyncCoordinatorTrace = []
  })()`)
  return app
}

const placeCaretAfter = async (app, needle) => {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(needle)}) continue
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
  assert.equal(placed, true, `could not place caret after ${needle}`)
  await sleep(150)
}

const rawCharacter = async (app, key, code, keyCode) => {
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
  await sleep(70)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const pausedToasts = (app) => app.evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text))
`)

async function testTailBullet() {
  await writeFile(listFile, '前文\n\n1. 已有\n')
  const app = await open(listFile, 'tail-list-profile', basePort)
  try {
    await placeCaretAfter(app, '已有')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleep(250)
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleep(350)
    await rawCharacter(app, '-', 'Minus', 189)
    // Let the literal escaped-marker callback publish before Space triggers the
    // list input rule. This matches the failing trace instead of batching both.
    await sleep(550)
    await rawCharacter(app, ' ', 'Space', 32)
    await sleep(1000)

    assert.equal(await toggleSource(app), true, 'tail list: source toggle failed')
    const source = await waitFor(() => visibleSource(app), 'tail list: source textarea missing')
    assert.match(source.replace(/\r\n?/g, '\n'), /1\. 已有\n\n- \n?$/)
    assert.equal(source.includes('1. 已有* '), false, 'tail marker was glued to the ordered list')
    assert.deepEqual(await pausedToasts(app), [], 'tail list triggered source-sync pause')
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }
}

async function testWholeDocumentReplacement() {
  const fixture = [
    '旧文档',
    '',
    '| 周 | 月 |',
    '| --- | --- |',
    '| 一 | 二 |',
    '',
    '1. 旧列表',
    '2. 仍在这里',
    '',
    '> 旧引用',
    ''
  ].join('\n')
  const replacement = '周/月(使用每周复盘数据)'
  await writeFile(replaceFile, fixture)
  const app = await open(replaceFile, 'whole-replace-profile', basePort + 1)
  try {
    const focused = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
      return !!editor
    })()`)
    assert.equal(focused, true, 'whole replace: editor not focused')
    await app.evaluate(`window.api.copyText(${JSON.stringify(replacement)})`)
    await pressKey(app.send, { key: 'a', code: 'KeyA', modifiers: 4, delayMs: 80 })
    const pasteKey = {
      key: 'v',
      code: 'KeyV',
      modifiers: 4,
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86
    }
    await app.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      ...pasteKey,
      commands: ['Paste']
    })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...pasteKey })
    await sleep(1100)

    assert.equal(await toggleSource(app), true, 'whole replace: source toggle failed')
    const source = await waitFor(() => visibleSource(app), 'whole replace: source textarea missing')
    assert.equal(source, `${replacement}\n`)
    assert.equal(source.includes('| |'), false, 'whole replace retained synthesized table rows')
    const replacementState = await app.evaluate(`(() => ({
      reasons: (window.__hmSourceIntegrityTrace || []).map((entry) => entry.preservationReason),
      failures: (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false),
      publications: (window.__hmSourceSyncCoordinatorTrace || []).filter((entry) => entry.phase === 'published')
    }))()`)
    assert.ok(
      replacementState.reasons.includes('whole-document-replacement'),
      `whole replace did not use explicit ownership: ${JSON.stringify(replacementState.reasons)}`
    )
    assert.ok(
      replacementState.publications.some((entry) =>
        entry.boundary === 'whole-document-replacement' &&
        entry.owner === 'transaction' &&
        entry.family === 'whole-document-replacement'
      ),
      `whole replace bypassed document owner: ${JSON.stringify(replacementState.publications)}`
    )
    assert.equal(
      replacementState.failures.length,
      0,
      `whole replace had first-divergence failures: ${JSON.stringify(replacementState.failures)}`
    )
    assert.deepEqual(await pausedToasts(app), [], 'whole replace triggered source-sync pause')

    await waitFor(
      () => app.evaluate(`!!document.querySelector('.hm-save-fab')`),
      'whole replace: save button missing'
    )
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
      'whole replace: save did not complete'
    )
    assert.equal(await readFile(replaceFile, 'utf8'), `${replacement}\n`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }
}

async function testRawMarkdownPasteOwnership() {
  const fixture = 'Old heading\n\nOld body\n'
  const replacement = '# Raw heading\n\n- exact item\n'
  await writeFile(rawPasteFile, fixture)
  const app = await open(rawPasteFile, 'raw-paste-profile', basePort + 2)
  try {
    const focused = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      editor?.focus()
      return !!editor
    })()`)
    assert.equal(focused, true, 'raw paste: editor not focused')
    await pressKey(app.send, { key: 'a', code: 'KeyA', modifiers: 4, delayMs: 80 })
    const consumed = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const data = new DataTransfer()
      data.setData('text/markdown', ${JSON.stringify(replacement)})
      data.setData('text/plain', ${JSON.stringify(replacement)})
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    })()`)
    assert.equal(consumed, true, 'raw paste: Markdown clipboard flavor was not consumed')
    await sleep(900)

    assert.equal(await toggleSource(app), true, 'raw paste: source toggle failed')
    const source = await waitFor(() => visibleSource(app), 'raw paste: source textarea missing')
    const state = await app.evaluate(`(() => ({
      failures: (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false),
      publications: (window.__hmSourceSyncCoordinatorTrace || []).filter((entry) => entry.phase === 'published'),
      preserveReasons: (window.__hmPreserveLog || []).slice(-20)
        .map((entry) => ({ reason: entry.reason, preserved: entry.preserved })),
      toasts: [...document.querySelectorAll('[class*="toast"]')]
        .map((node) => node.textContent || '')
    }))()`)
    assert.equal(
      source,
      replacement,
      `raw paste marker/source mismatch: ${JSON.stringify(state)}`
    )
    assert.ok(
      state.publications.some((entry) =>
        entry.boundary === 'raw-markdown-paste' &&
        entry.owner === 'source' &&
        entry.family === 'raw-markdown-paste'
      ),
      `raw paste bypassed document owner: ${JSON.stringify(state.publications)}`
    )
    assert.equal(state.failures.length, 0, `raw paste integrity failures: ${JSON.stringify(state.failures)}`)
    assert.deepEqual(await pausedToasts(app), [], 'raw paste triggered source-sync pause')

    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'raw paste: save button missing')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'raw paste: save did not complete')
    assert.equal(await readFile(rawPasteFile, 'utf8'), replacement)
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    await testTailBullet()
    await testWholeDocumentReplacement()
    await testRawMarkdownPasteOwnership()
    console.log('PASS RS-41 UI: tail bullet, whole-document replacement, and raw Markdown paste stay source-equivalent')
  } finally {
    await sleep(200)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
