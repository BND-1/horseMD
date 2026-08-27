import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs61-tail-bracket-space-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10681)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '# RS61\n\n- earlier\n\n1. item\n\n-\\[ ]\n'
const expected = '# RS61\n\n- earlier\n\n1. item\n\n-[ ] \n'
const warningPattern = /源码|source|不一致|保存已暂停|Save paused/i

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function key(app, keyValue, code, keyCode, text = '') {
  const common = {
    key: keyValue,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'char',
      ...common,
      text,
      unmodifiedText: text
    })
  }
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(100)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const topLevelParagraphs = [...(editor?.children || [])]
    .filter((node) => node.tagName === 'P')
    .map((node) => node.textContent || '')
  return {
    topLevelParagraphs,
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-500),
      canonical: String(entry.canonical || '').slice(-500)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-320),
      previousTail: String(previous || '').slice(-320),
      nextTail: String(next || '').slice(-320),
      markdownTail: String(markdown || '').slice(-320)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'rich editor did not open'
  )
  await sleep(550)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

async function placeCaretAtTail(app) {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.children || [])]
      .filter((node) => node.tagName === 'P')
      .find((node) => node.textContent === '-[ ]')
    const text = paragraph?.firstChild
    if (!paragraph || !text || text.nodeType !== Node.TEXT_NODE) return false
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(ok, true, 'could not place caret at RS-61 tail paragraph')
  await sleep(120)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')

  let app
  try {
    app = await openApp('edit', port)
    const initial = await snapshot(app)
    assert.ok(initial.topLevelParagraphs.includes('-[ ]'), `literal bracket tail did not parse as plain paragraph: ${JSON.stringify(initial)}`)
    await placeCaretAtTail(app)

    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
      window.__hmFlushTrace = []
    })()`)

    // This single Space is the exact RS-61 trigger from packaged PID 20800:
    // canonical changes `-\\[ ]` -> `-[ ] ` while the PM node remains a plain
    // paragraph. The tail mapper must not confuse visible-empty with raw delete.
    await key(app, ' ', 'Space', 32, ' ')
    await sleep(900)

    const afterSpace = await snapshot(app)
    console.log('RS61_AFTER_SPACE:', JSON.stringify(afterSpace))
    assert.ok(afterSpace.topLevelParagraphs.includes('-[ ] '), `punctuation-only tail paragraph disappeared: ${JSON.stringify(afterSpace)}`)
    assert.equal(afterSpace.integrity.some((entry) => entry.ok === false), false, `RS-61 integrity failure: ${JSON.stringify(afterSpace)}`)
    assert.equal(
      afterSpace.preserve.some((entry) => entry.reason === 'diverged-tail-line-delete'),
      false,
      `RS-61 was still misclassified as tail deletion: ${JSON.stringify(afterSpace.preserve)}`
    )
    assert.ok(
      afterSpace.preserve.some((entry) => entry.markdownTail.endsWith('-[ ] \n')),
      `RS-61 mapper did not preserve the raw tail row: ${JSON.stringify(afterSpace.preserve)}`
    )
    assert.equal(afterSpace.toasts.some((text) => warningPattern.test(text)), false, `RS-61 showed source warning: ${JSON.stringify(afterSpace.toasts)}`)

    assert.equal(await toggleSource(app), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(app), 'source textarea missing')
    assert.equal(source, expected, `RS-61 source mismatch: ${JSON.stringify(source)}`)

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), expected, 'saved RS-61 source differs from inspected source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopened = await snapshot(app)
    assert.ok(reopened.topLevelParagraphs.includes('-[ ]'), `cold reopen lost RS-61 tail paragraph: ${JSON.stringify(reopened)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), expected)
    assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen changed RS-61 disk bytes')

    console.log('PASS RS-61 punctuation-only tail Space: integrity, source, save, and reopen stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
