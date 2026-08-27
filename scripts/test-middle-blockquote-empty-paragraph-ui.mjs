import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs65-middle-quote-${process.pid}`
const file = join(root, 'rs-65.md')
const port = Number(process.env.CDP_PORT || 10765)
const fixture = '# RS65\n\n> lknlkjn.kln\n\n2. 斛律v哦\n'
const filledExpected = '# RS65\n\n> lknlkjn.kln\n>\n> 第二段\n\n2. 斛律v哦\n'
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 140) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function key(app, keyValue, code, keyCode) {
  const common = {
    key: keyValue,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(80)
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

const focusQuoteEnd = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const paragraph = editor?.querySelector('blockquote p')
  if (!editor || !paragraph) return false
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(false)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const quote = editor?.querySelector('blockquote')
  const quoteParagraphs = [...(quote?.querySelectorAll('p') || [])]
    .filter((node) => node.closest('blockquote') === quote)
  const ordered = editor?.querySelector('ol')
  return {
    quoteTexts: quoteParagraphs.map((node) => node.textContent || ''),
    orderedText: ordered?.textContent || '',
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(0, 420),
      canonical: String(entry.canonical || '').slice(0, 420)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-12).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      source: String(source || '').slice(0, 420),
      previous: String(previous || '').slice(0, 420),
      next: String(next || '').slice(0, 420),
      markdown: String(markdown || '').slice(0, 420)
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
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) =>
      node.offsetParent && (node.textContent || '').includes('lknlkjn.kln') && (node.textContent || '').includes('斛律v哦')))`),
    'RS-65 fixture did not mount'
  )
  await sleep(450)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)
  assert.equal(await focusQuoteEnd(app), true, 'could not focus RS-65 blockquote end')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await key(app, 'Enter', 'Enter', 13)
  await sleep(850)
  const afterEnter = await snapshot(app)
  console.log('RS65_AFTER_ENTER:', JSON.stringify(afterEnter))
  assert.deepEqual(afterEnter.quoteTexts, ['lknlkjn.kln', ''], `Enter did not create the middle quote empty paragraph: ${JSON.stringify(afterEnter)}`)
  assert.match(afterEnter.orderedText, /斛律v哦/, 'following ordered list changed after quote Enter')
  assert.equal(afterEnter.integrity.some((entry) => entry.ok === false), false, `RS-65 Enter failed integrity: ${JSON.stringify(afterEnter.integrity)}`)
  assert.equal(afterEnter.toasts.some((text) => warningPattern.test(text)), false, `RS-65 Enter showed warning: ${JSON.stringify(afterEnter.toasts)}`)
  assert.equal(
    afterEnter.integrity.some((entry) =>
      entry.preservationReason === 'trailing-empty-blockquote-paragraph-created' &&
      entry.ok === true && entry.semanticOk === true
    ),
    true,
    `RS-65 did not use the strict quote transient proof: ${JSON.stringify(afterEnter.integrity)}`
  )

  await app.send('Input.insertText', { text: '第二段' })
  await sleep(850)
  const filled = await snapshot(app)
  console.log('RS65_AFTER_FILL:', JSON.stringify(filled))
  assert.deepEqual(filled.quoteTexts, ['lknlkjn.kln', '第二段'], 'RS-65 second quote paragraph did not fill in place')
  assert.match(filled.orderedText, /斛律v哦/, 'following ordered list changed after filling quote')
  assert.equal(filled.integrity.some((entry) => entry.ok === false), false, `RS-65 fill failed integrity: ${JSON.stringify(filled.integrity)}`)
  assert.equal(filled.toasts.some((text) => warningPattern.test(text)), false, `RS-65 fill showed warning: ${JSON.stringify(filled.toasts)}`)

  assert.equal(await toggleSource(app), true, 'could not inspect RS-65 source')
  const source = await waitFor(() => visibleSource(app), 'RS-65 source textarea missing')
  assert.equal(source, filledExpected, `RS-65 source changed quote/following block bytes: ${JSON.stringify(source)}`)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-65 leaked quote placeholder into source')
  assert.equal(await toggleSource(app), true, 'could not return RS-65 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), filledExpected, 'RS-65 saved bytes differ from source view')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await snapshot(app)
  assert.deepEqual(reopened.quoteTexts, ['lknlkjn.kln', '第二段'], `RS-65 cold reopen changed quote paragraphs: ${JSON.stringify(reopened)}`)
  assert.match(reopened.orderedText, /斛律v哦/, 'RS-65 cold reopen lost following ordered list')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-65 reopened source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-65 reopened source missing'), filledExpected)

  console.log('PASS RS-65 middle blockquote Enter: transient proof, fill, following block, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
