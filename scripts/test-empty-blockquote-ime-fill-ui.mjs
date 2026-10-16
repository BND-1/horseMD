import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-empty-quote-ime-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10190)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const step = Number(process.env.IME_STEP || 55)
const expected = '> 测试\n'

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = (evaluate) => evaluate(`(
  !![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
)`)

const quoteText = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return editor?.querySelector('blockquote p')?.textContent ?? null
})()`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toastTexts = (evaluate) => evaluate(`(
  [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
)`)

async function focusQuote(evaluate, send) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const quote = editor?.querySelector('blockquote p')
    if (!quote) return null
    const rect = quote.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, 'empty blockquote paragraph missing')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(120)
}

async function imeType(send, pinyin, cjk) {
  const replacementId = `rs48-${Date.now()}`
  for (let index = 0; index < pinyin.length; index += 1) {
    const ch = pinyin[index]
    const code = ch.toUpperCase()
    const keyCode = ch.charCodeAt(0)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: ch, code: `Key${code}`,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch, code: `Key${code}`,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
    })
    const text = pinyin.slice(0, index + 1)
    await send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
      replacementId,
      location: 0
    })
    await sleep(step)
  }
  await sleep(step)
  await send('Input.insertText', { text: cjk })
  await sleep(step * 3)
}

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(() => visibleEditor(app.evaluate), 'rich editor did not open')
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent)?.querySelector('blockquote p')`), 'blockquote did not render')
  await sleep(500)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '>\n')

  let app
  try {
    app = await openApp('edit', port)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)
    await focusQuote(app.evaluate, app.send)
    await imeType(app.send, 'ceshi', '测试')

    assert.equal(await quoteText(app.evaluate), '测试', 'IME text must stay inside blockquote')
    assert.deepEqual(
      (await toastTexts(app.evaluate)).filter((text) => /源码|source|不一致|暂停/i.test(text)),
      [],
      'IME fill must not trigger source integrity warning'
    )

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(app.evaluate), 'source textarea did not appear')
    assert.equal(source, expected, 'source must keep IME text inside authored blockquote marker')

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    const saveCompleted = await waitFor(
      () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
      'save did not complete'
    ).then(() => true).catch(() => false)
    if (!saveCompleted) {
      const disk = await readFile(file, 'utf8').catch(() => '<read-failed>')
      const detail = await app.evaluate(`(() => ({
        toasts: [...document.querySelectorAll('[class*="toast"]')]
          .filter((node) => node.offsetParent)
          .map((node) => node.textContent || ''),
        saveVisible: !!document.querySelector('.hm-save-fab'),
        preserve: (window.__hmPreserveLog || []).slice(-6).map(({ source, previous, next, markdown, ...entry }) => ({
          ...entry,
          sourceTail: String(source || '').slice(-220),
          previousTail: String(previous || '').slice(-220),
          nextTail: String(next || '').slice(-220),
          markdownTail: String(markdown || '').slice(-220)
        })),
        integrity: (window.__hmSourceIntegrityTrace || []).slice(-6).map(({ candidate, canonical, ...entry }) => ({
          ...entry,
          candidateTail: String(candidate || '').slice(-260),
          canonicalTail: String(canonical || '').slice(-260)
        })),
        integrityDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-8)
      }))()`)
      throw new Error(`save did not complete: disk=${JSON.stringify(disk)} detail=${JSON.stringify(detail)}`)
    }
    assert.equal(await readFile(file, 'utf8'), expected, 'disk bytes must preserve quoted IME text')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assert.equal(await quoteText(app.evaluate), '测试', 'cold reopen must keep text inside blockquote')
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app.evaluate), 'reopened source missing'), expected)

    console.log('PASS RS-48 empty blockquote IME fill: quote ownership, source, save, and reopen remain stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
