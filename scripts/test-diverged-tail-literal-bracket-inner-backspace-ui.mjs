import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs62-tail-bracket-inner-backspace-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10741)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '# RS62\n\n- earlier\n\n1. item\n\n-\\[ ]\n'
const expected = '# RS62\n\n- earlier\n\n1. item\n\n-[] \n'
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

async function placeCaretAtTail(app, offset = null) {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.children || [])]
      .filter((node) => node.tagName === 'P')
      .find((node) => node.textContent === '-[ ]')
    const text = paragraph?.firstChild
    if (!paragraph || !text || text.nodeType !== Node.TEXT_NODE) return false
    const range = document.createRange()
    const targetOffset = offset === null ? text.nodeValue.length : Math.min(offset, text.nodeValue.length)
    range.setStart(text, targetOffset)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(ok, true, 'could not place caret at RS-62 tail paragraph')
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

    // Stage 1 reproduces the live predecessor state: the protected literal
    // becomes a punctuation-only raw tail paragraph `-[ ] `.
    await placeCaretAtTail(app)
    await key(app, ' ', 'Space', 32, ' ')
    await sleep(650)
    const afterSpace = await snapshot(app)
    assert.equal(afterSpace.integrity.some((entry) => entry.ok === false), false, `RS-62 setup hit integrity failure: ${JSON.stringify(afterSpace)}`)
    assert.ok(afterSpace.topLevelParagraphs.some((text) => text.startsWith('-[ ]')), `RS-62 setup tail missing: ${JSON.stringify(afterSpace)}`)

    // Put the caret immediately before `]`; Backspace removes only the inner
    // space, changing the SAME raw tail row `-[ ] ` -> `-[] `.
    await placeCaretAtTail(app, 3)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
      window.__hmFlushTrace = []
    })()`)
    await key(app, 'Backspace', 'Backspace', 8)
    await sleep(900)

    const afterBackspace = await snapshot(app)
    console.log('RS62_AFTER_INNER_BACKSPACE:', JSON.stringify(afterBackspace))
    assert.ok(afterBackspace.topLevelParagraphs.some((text) => text.startsWith('-[]')), `RS-62 edited tail paragraph disappeared: ${JSON.stringify(afterBackspace)}`)
    assert.equal(afterBackspace.integrity.some((entry) => entry.ok === false), false, `RS-62 integrity failure: ${JSON.stringify(afterBackspace)}`)
    assert.equal(
      afterBackspace.preserve.some((entry) => entry.reason === 'diverged-tail-block-append'),
      false,
      `RS-62 was still misclassified as a fresh tail append: ${JSON.stringify(afterBackspace.preserve)}`
    )
    assert.ok(
      afterBackspace.preserve.some((entry) => entry.markdownTail.endsWith('-[] \n')),
      `RS-62 did not replace the raw tail row in place: ${JSON.stringify(afterBackspace.preserve)}`
    )
    assert.equal(
      afterBackspace.preserve.some((entry) => entry.markdownTail.includes('-[ ] \n-[] ')),
      false,
      `RS-62 duplicated old and edited tail rows: ${JSON.stringify(afterBackspace.preserve)}`
    )
    assert.equal(afterBackspace.toasts.some((text) => warningPattern.test(text)), false, `RS-62 showed source warning: ${JSON.stringify(afterBackspace.toasts)}`)

    assert.equal(await toggleSource(app), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(app), 'source textarea missing')
    assert.equal(source, expected, `RS-62 source mismatch: ${JSON.stringify(source)}`)

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), expected, 'saved RS-62 source differs from inspected source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopened = await snapshot(app)
    assert.ok(reopened.topLevelParagraphs.includes('-[]'), `cold reopen lost RS-62 tail paragraph: ${JSON.stringify(reopened)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), expected)
    assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen changed RS-62 disk bytes')

    console.log('PASS RS-62 punctuation-only tail inner Backspace: no duplicate append, integrity, source, save, and reopen stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
