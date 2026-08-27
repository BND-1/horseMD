import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs59-escaped-standalone-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10481)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '- 前文\n\n哈哈；\n\n***\n\n驱动器\n'
const expected = '- 前文\n\n哈哈；\n\n-【】\n\n***\n\n驱动器\n'
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
  const common = { key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  }
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(90)
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
  await sleep(500)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

async function placeCaretAtParagraphEnd(app, textValue) {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => node.textContent === ${JSON.stringify(textValue)})
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
  assert.equal(ok, true, `could not place caret at paragraph ${JSON.stringify(textValue)}`)
  await sleep(100)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')

  let app
  try {
    app = await openApp('edit', port)
    await placeCaretAtParagraphEnd(app, '哈哈；')
    await key(app, 'Enter', 'Enter', 13)
    await waitFor(async () => {
      const state = await snapshot(app)
      return state.topLevelParagraphs.includes('') ? state : null
    }, 'Enter did not create the middle empty paragraph')

    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
      window.__hmFlushTrace = []
    })()`)

    await key(app, '-', 'Minus', 189, '-')
    await sleep(750)
    const afterDash = await snapshot(app)
    assert.equal(afterDash.integrity.some((entry) => entry.ok === false), false, `RS-59 integrity failed at lone dash stage: ${JSON.stringify(afterDash)}`)
    assert.ok(
      afterDash.preserve.some((entry) => entry.markdownTail.includes('\\-')),
      `lone dash did not stay as a protected standalone paragraph: ${JSON.stringify(afterDash.preserve)}`
    )
    assert.equal(afterDash.toasts.some((text) => warningPattern.test(text)), false, `RS-59 warned at lone dash stage: ${JSON.stringify(afterDash.toasts)}`)

    await app.send('Input.insertText', { text: '【】' })
    await sleep(900)
    const expanded = await snapshot(app)
    console.log('RS59_AFTER_EXPAND:', JSON.stringify(expanded))
    assert.ok(expanded.topLevelParagraphs.includes('哈哈；'), `previous paragraph changed: ${JSON.stringify(expanded)}`)
    assert.ok(expanded.topLevelParagraphs.includes('-【】'), `expanded standalone paragraph missing: ${JSON.stringify(expanded)}`)
    assert.equal(expanded.topLevelParagraphs.includes('哈哈；-【】'), false, `RS-59 glued the standalone paragraph to its previous sibling: ${JSON.stringify(expanded)}`)
    assert.equal(expanded.integrity.some((entry) => entry.ok === false), false, `RS-59 integrity failure after expansion: ${JSON.stringify(expanded)}`)
    assert.ok(
      expanded.preserve.some((entry) => entry.reason === 'mapped-line-change' && entry.markdownTail.includes('哈哈；\n\n-【】')),
      `missing RS-59 mapped-line fallback proof: ${JSON.stringify(expanded.preserve)}`
    )
    assert.equal(expanded.toasts.some((text) => warningPattern.test(text)), false, `RS-59 showed warning after expansion: ${JSON.stringify(expanded.toasts)}`)

    assert.equal(await toggleSource(app), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(app), 'source textarea missing')
    assert.equal(source, expected, `RS-59 source mismatch: ${JSON.stringify(source)}`)
    assert.doesNotMatch(source, /哈哈；-【】/, 'source glued the standalone paragraph to the previous paragraph')

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), expected, 'saved RS-59 source bytes changed')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopened = await snapshot(app)
    assert.ok(reopened.topLevelParagraphs.includes('哈哈；'), `cold reopen lost previous paragraph: ${JSON.stringify(reopened)}`)
    assert.ok(reopened.topLevelParagraphs.includes('-【】'), `cold reopen lost standalone paragraph: ${JSON.stringify(reopened)}`)
    assert.equal(reopened.topLevelParagraphs.includes('哈哈；-【】'), false, `cold reopen merged paragraphs: ${JSON.stringify(reopened)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), expected)
    assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen changed disk bytes')

    console.log('PASS RS-59 escaped standalone paragraph expansion: boundary, integrity, source, save, and reopen stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
