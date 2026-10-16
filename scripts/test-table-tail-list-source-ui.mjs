import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const sourceFixture = '/Users/yangtingyi/vibe_everything/test/无序列表测试.md'
const root = `/tmp/horsemd-table-tail-list-${process.pid}`
const file = join(root, 'fixture.md')
const port = 10900 + (process.pid % 80)
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

const enter = (send) => rawKey(send, 'Enter', 'Enter', 13, '')
const orderedMarker = async (send) => {
  await rawKey(send, '1', 'Digit1', 49)
  await rawKey(send, '.', 'Period', 190)
  await rawKey(send, ' ', 'Space', 32)
}
const bulletMarker = async (send) => {
  await rawKey(send, '-', 'Minus', 189)
  await rawKey(send, ' ', 'Space', 32)
}

const placeCaretInTrailingParagraph = async (app) => {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return { ok: false, children: [] }
    const trailing = [...editor.children].reverse().find((node) => node.tagName === 'P' && !node.closest('table'))
    if (!trailing) return { ok: false, children: [...editor.children].map((node) => node.tagName) }
    const range = document.createRange()
    range.selectNodeContents(trailing)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, trailingText: trailing.textContent }
  })()`)
  assert.equal(placed.ok, true, `could not place caret in trailing paragraph: ${JSON.stringify(placed)}`)
  await sleep(250)
}

const toggleSource = async (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const sourceValue = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

const compactDiagnostics = (app) => app.evaluate(`({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    sourceTail: String(source || '').slice(-360),
    previousTail: String(previous || '').slice(-360),
    nextTail: String(next || '').slice(-360),
    markdownTail: String(markdown || '').slice(-360)
  })),
  intents: (window.__hmListIntentTrace || []).slice(-20),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-5),
  integrityDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-8),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
})`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, await readFile(sourceFixture, 'utf8'))
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
    await app.evaluate(`(() => { window.__hmPreserveLog = []; window.__hmListIntentTrace = []; window.__hmSourceIntegrityTrace = []; window.__hmSourceIntegrityDiffTrace = [] })()`)
    await placeCaretInTrailingParagraph(app)

    await orderedMarker(app.send)
    await typeTextLikeUser(app.send, '时间和功夫', { delayMs: delay })
    await enter(app.send)
    await typeTextLikeUser(app.send, '急哦', { delayMs: delay })
    await enter(app.send)
    await enter(app.send)
    await bulletMarker(app.send)
    await typeTextLikeUser(app.send, '色风景', { delayMs: delay })
    await sleep(1200)

    const rich = await app.evaluate(`([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || '')`)
    assert.match(rich, /时间和功夫.*急哦.*色风景/s, `rich text did not contain both lists: ${rich.slice(-400)}`)
    assert.equal(await toggleSource(app), true, 'source toggle failed')
    let source
    try {
      source = await waitFor(() => sourceValue(app), 'source textarea did not open')
    } catch (error) {
      console.log('TABLE_TAIL_INTEGRITY_FAILURE:', JSON.stringify(await compactDiagnostics(app), null, 2))
      throw error
    }
    const diagnostics = await compactDiagnostics(app)
    console.log('TABLE_TAIL_DIAGNOSTICS:', diagnostics.preserve.map(({ reason, preserved }) => `${reason}:${preserved}`).join(', '))
    assert.match(source, /1\. 时间和功夫[\s\S]*2\. 急哦/, 'ordered list was not written to source')
    assert.match(source, /(?:^|\n)- 色风景(?:\n|$)/, 'unordered list was not written to source')
    assert.equal(source.slice(-200).includes('* 色风景'), false, 'unordered list fell back to the serializer bullet')
    assert.deepEqual(
      diagnostics.toasts.filter((text) => /保存已暂停|无法安全映射|Save paused/.test(text)),
      [],
      'tail list source sync showed a pause warning'
    )

    const expected = source
    assert.equal(await toggleSource(app), true, 'could not return to rich mode before save')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(await readFile(file, 'utf8'), expected, 'save changed the table-tail list source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'reopen-profile'),
      port: port + 1,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
      'saved tail-list document did not reopen'
    )
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => sourceValue(app), 'reopened source textarea did not open'), expected, 'reopen changed the table-tail list source')
    console.log('PASS table tail ordered → unordered list source, save, and reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
