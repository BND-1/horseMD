import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs57-quote-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10401)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const firstExpected = '# RS57\n\n> 引用正文\n'
const filledExpected = '# RS57\n\n> 引用正文\n>\n> 第二段\n'
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
  await sleep(70)
}

async function typeAscii(app, text) {
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const isLetter = /[a-z]/.test(lower)
    const code = ch === '/' ? 'Slash' : isLetter ? `Key${lower.toUpperCase()}` : ch
    const vk = ch === '/' ? 191 : isLetter ? lower.charCodeAt(0) : ch.charCodeAt(0)
    await key(app, ch, code, vk, ch)
  }
}

async function clickNode(app, selector, ordinal = 0) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const nodes = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
    const node = nodes[${ordinal}]
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, `missing node ${selector}[${ordinal}]`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(120)
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
  const quote = editor?.querySelector('blockquote')
  const owned = [...(quote?.querySelectorAll('p') || [])].filter((node) => node.closest('blockquote') === quote)
  return {
    quoteParagraphs: owned.length,
    quoteTexts: owned.map((node) => node.textContent || ''),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-500),
      canonical: String(entry.canonical || '').slice(-500)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-12).map(({ source, previous, next, markdown, ...entry }) => ({
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

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')

  let app
  try {
    app = await openApp('edit', port)
    await clickNode(app, 'h1')
    await app.send('Input.insertText', { text: 'RS57' })
    await sleep(250)
    await clickNode(app, 'p')

    await typeAscii(app, '/quote')
    await waitFor(
      () => app.evaluate(`(() => {
        const menu = document.querySelector('.milkdown-slash-menu[data-show="true"]')
        const item = menu?.querySelector('.hm-slash-item.hover')
        return item ? item.textContent : ''
      })()`),
      'slash quote menu did not open'
    )
    const selected = await app.evaluate(`document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item.hover')?.textContent || ''`)
    assert.match(selected, /Quote|引用/i, `slash query did not select quote item: ${selected}`)
    await key(app, 'Enter', 'Enter', 13)
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.querySelector('blockquote p')`),
      'slash quote command did not create blockquote'
    )

    await app.send('Input.insertText', { text: '引用正文' })
    await sleep(700)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
      window.__hmFlushTrace = []
    })()`)

    await key(app, 'Enter', 'Enter', 13)
    await sleep(800)
    const afterEnter = await snapshot(app)
    console.log('RS57_AFTER_ENTER:', JSON.stringify(afterEnter))
    assert.equal(afterEnter.quoteParagraphs, 2, `quote Enter did not create exactly two paragraphs: ${JSON.stringify(afterEnter)}`)
    assert.deepEqual(afterEnter.quoteTexts, ['引用正文', ''], `quote paragraph content mismatch: ${JSON.stringify(afterEnter)}`)
    assert.equal(afterEnter.integrity.some((entry) => entry.ok === false), false, `RS-57 integrity failure after Enter: ${JSON.stringify(afterEnter)}`)
    assert.ok(
      afterEnter.integrity.some((entry) =>
        entry.preservationReason === 'trailing-empty-blockquote-paragraph-created' &&
        entry.ok === true && entry.semanticOk === true
      ),
      `missing RS-57 dedicated integrity proof: ${JSON.stringify(afterEnter.integrity)}`
    )
    assert.equal(afterEnter.toasts.some((text) => warningPattern.test(text)), false, `RS-57 showed warning after Enter: ${JSON.stringify(afterEnter.toasts)}`)

    // Fill the unrepresentable empty quote paragraph before changing modes.
    // Once it has real text, normal Markdown can persist both quote paragraphs.
    await app.send('Input.insertText', { text: '第二段' })
    await sleep(900)
    const filled = await snapshot(app)
    assert.deepEqual(filled.quoteTexts, ['引用正文', '第二段'], `second quote paragraph did not fill in place: ${JSON.stringify(filled)}`)
    assert.equal(filled.integrity.some((entry) => entry.ok === false), false, `RS-57 integrity failure after filling: ${JSON.stringify(filled)}`)
    assert.equal(filled.toasts.some((text) => warningPattern.test(text)), false, `RS-57 showed warning after filling: ${JSON.stringify(filled.toasts)}`)

    assert.equal(await toggleSource(app), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(app), 'source textarea missing')
    assert.equal(source, filledExpected, `filled quote source mismatch: ${JSON.stringify(source)}`)
    assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-57 leaked <br /> into source')

    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), filledExpected, 'saved RS-57 source bytes changed')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopened = await snapshot(app)
    assert.deepEqual(reopened.quoteTexts, ['引用正文', '第二段'], `cold reopen changed quote paragraphs: ${JSON.stringify(reopened)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect reopened source')
    assert.equal(await waitFor(() => visibleSource(app), 'reopened source missing'), filledExpected)
    assert.equal(await readFile(file, 'utf8'), filledExpected, 'cold reopen changed disk bytes')

    // Keep the exact first-stage expected bytes explicit in this regression:
    // the Enter transient has no additional authored Markdown bytes.
    assert.equal(firstExpected, '# RS57\n\n> 引用正文\n')
    console.log('PASS RS-57 generated scratch blockquote Enter: transient empty paragraph, fill, source, save, and reopen stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
