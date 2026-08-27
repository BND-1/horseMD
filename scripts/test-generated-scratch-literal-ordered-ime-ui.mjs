import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs49-scratch-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10330)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const expected = '# RS49\n\n- 1\\. 测试\n'

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function clickBlock(app, selector) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, `missing block ${selector}`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(100)
}

async function rawKey(app, key, code, keyCode, text = key, delay = 80) {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

async function imeType(app, pinyin, cjk, step = 55) {
  const replacementId = `rs49-${Date.now()}`
  for (let index = 0; index < pinyin.length; index += 1) {
    const ch = pinyin[index]
    const code = ch.charCodeAt(0)
    const common = {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code
    }
    await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    const text = pinyin.slice(0, index + 1)
    await app.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
      replacementId,
      location: 0
    })
    await sleep(step)
  }
  await app.send('Input.insertText', { text: cjk })
  await sleep(step * 4)
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

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(-500),
    canonical: String(entry.canonical || '').slice(-500)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

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
  await sleep(450)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')
  let app
  try {
    app = await openApp('edit', port)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    await clickBlock(app, 'h1')
    await app.send('Input.insertText', { text: 'RS49' })
    await sleep(180)
    await clickBlock(app, 'p')
    await rawKey(app, '-', 'Minus', 189, '-')
    await rawKey(app, ' ', 'Space', 32, ' ')
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.querySelector('li p')`),
      'bullet input rule did not create a list item'
    )

    await rawKey(app, '1', 'Digit1', 49, '1')
    await rawKey(app, '.', 'Period', 190, '.')
    await rawKey(app, ' ', 'Space', 32, ' ')
    await sleep(700)
    const transient = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const p = editor?.querySelector('li p')
      return { text: p?.textContent || '', depth: p ? (() => { let n=p,d=0; while(n && n!==editor){ d++; n=n.parentElement } return d })() : 0 }
    })()`)
    assert.match(transient.text, /^1\.\s*$/, `expected transient literal ordered marker inside bullet: ${JSON.stringify(transient)}`)
    // RS-49 begins at the following IME/body transaction. The preceding
    // `1. ` input-rule setup has its own ownership diagnostics, so reset the
    // window here and prove only the real 0.13.94 failure boundary.
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    await imeType(app, 'ceshi', '测试')
    await sleep(700)
    const state = await diagnostics(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `RS-49 integrity failure: ${JSON.stringify(state)}`)
    assert.equal(
      state.toasts.some((text) => /源码|source|不一致|保存已暂停|Save paused/i.test(text)),
      false,
      `RS-49 showed source warning: ${JSON.stringify(state.toasts)}`
    )

    assert.equal(await toggleSource(app), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(app), 'source textarea did not appear')
    assert.equal(source, expected, 'generated scratch source must preserve literal ordered-marker escape')

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk bytes lost RS-49 protective escape')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopenedText = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.querySelector('li p')?.textContent || ''
    })()`)
    assert.equal(reopenedText, '1. 测试', 'cold reopen changed literal ordered text into nested list structure')
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), expected)
    console.log('PASS RS-49 generated scratch: literal ordered marker survives IME, source, save, and reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
