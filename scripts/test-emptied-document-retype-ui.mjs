// Air trace 2026-11-06 (0.14.0): in a NEW (untitled) document the user typed
// `woyao` into the skeleton heading, Backspaced it all away (the last
// Backspace turned the empty heading into a paragraph), typed `# ` to make a
// heading again and wrote a whole page with a Chinese IME. From the first
// character every sync failed (visible-stream-mismatch) and stayed failed for
// hours until 「检测到富文本与源码不一致」 at an Enter. Replays that, then the
// same in a saved file emptied the same way; checks no warning, no failed
// check, a source that reopens to the typed document, and (file) save.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-emptied-retype-${process.pid}`
const file = join(root, 'note.md')
const port = Number(process.env.CDP_PORT || 9947)

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const editorReady = (evaluate) => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent && node.dataset.horsemdReady === 'true')`)
const visibleSource = (evaluate) => evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null)`)
const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')].find((node) => node.offsetParent && /源码|Source/.test(node.title || ''))
  button?.click()
  return !!button
})()`)
const watchToasts = (evaluate) => evaluate(`(() => {
  window.__toasts = []
  globalThis.__hmSourceIntegrityTrace = []
  const seen = new WeakSet()
  new MutationObserver(() => {
    for (const node of document.querySelectorAll('.hm-toast-msg, [class*="toast"]')) {
      if (!seen.has(node)) { seen.add(node); window.__toasts.push(node.textContent) }
    }
  }).observe(document.body, { childList: true, subtree: true })
})()`)
const problems = (evaluate) => evaluate(`({
  warnings: (window.__toasts || []).filter((text) => /不一致|暂停|mismatch/i.test(text)),
  failedChecks: (globalThis.__hmSourceIntegrityTrace || []).filter((entry) => entry.ok === false).map((entry) => entry.preservationReason)
})`)
const key = (send, name) => pressKey(send, { key: name, code: name, delayMs: 60 })
const chars = async (send, text) => {
  for (const character of [...text]) { await send('Input.insertText', { text: character }); await sleep(60) }
}

// An IME phrase: composition updates letter by letter, then the commit.
async function ime(send, pinyin, text) {
  for (let length = 1; length <= pinyin.length; length += 1) {
    const part = pinyin.slice(0, length)
    await send('Input.imeSetComposition', { text: part, selectionStart: part.length, selectionEnd: part.length })
    await sleep(40)
  }
  await send('Input.insertText', { text })
  await sleep(150)
}

const caretToHeadingEnd = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const heading = editor?.querySelector('h1')
  if (!heading) return false
  const range = document.createRange()
  range.selectNodeContents(heading)
  range.collapse(false)
  getSelection().removeAllRanges()
  getSelection().addRange(range)
  editor.focus()
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

// The user's sequence after the heading text is gone.
async function writePage(send) {
  await chars(send, '# ')
  await sleep(300)
  await ime(send, 'woyao', '我要写点什么')
  await key(send, 'Enter'); await sleep(300)
  await ime(send, 'chai', '1、拆爆款--内容自己列出来')
  await key(send, 'Enter'); await sleep(300)
  await chars(send, '    ')
  await ime(send, 'keneng', '1、可能每一集都引导会比较好')
  await key(send, 'Enter'); await sleep(300)
  await key(send, 'Enter'); await sleep(300)
  await ime(send, 'qiyu', '其余：英语练习')
  await key(send, 'Enter'); await sleep(300)
  await chars(send, '# ')
  await sleep(300)
  await ime(send, 'suoyou', '所有相关平台的profile修改')
  await key(send, 'Enter'); await sleep(300)
  await ime(send, 'qiantao', '前淘系AI产品经理')
  await key(send, 'Enter')
  await sleep(1500)
}

async function checkSource(app, label) {
  assert.deepEqual(await problems(app.evaluate), { warnings: [], failedChecks: [] }, `${label}: a sync warning or failed check`)
  const doc = await app.evaluate(`JSON.stringify(window.__hmSourceReprintHarness.view().state.doc.toJSON())`)
  assert.equal(await toggleSource(app.evaluate), true, `${label}: could not switch to source mode`)
  const source = await waitFor(() => visibleSource(app.evaluate), `${label}: source textarea did not appear`)
  for (const text of ['# 我要写点什么', '1、拆爆款--内容自己列出来', '1、可能每一集都引导会比较好', '其余：英语练习', '# 所有相关平台的profile修改', '前淘系AI产品经理']) {
    assert.ok(source.includes(text), `${label}: source lost ${JSON.stringify(text)}: ${JSON.stringify(source)}`)
  }
  assert.ok(!source.includes('woyao'), `${label}: the deleted text came back: ${JSON.stringify(source)}`)
  assert.ok(!/<br\s*\/?>/.test(source), `${label}: an empty paragraph leaked <br />: ${JSON.stringify(source)}`)
  const equal = await app.evaluate(`(() => {
    const h = window.__hmSourceReprintHarness
    return h.equivalentForReprint(${JSON.stringify(source)}, h.docFromJSON(${doc}))
  })()`)
  assert.equal(equal, true, `${label}: the source does not reopen to the typed document: ${JSON.stringify(source)}`)
  assert.equal(await toggleSource(app.evaluate), true, `${label}: could not return to rich mode`)
  await sleep(500)
  assert.deepEqual(await problems(app.evaluate), { warnings: [], failedChecks: [] }, `${label}: a warning after the mode switch`)
  return source
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# woyao\n')
  let app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
  try {
    await waitFor(() => editorReady(app.evaluate), 'editor did not mount')
    await sleep(500)

    // 1. A new document, the way the user had it.
    await app.evaluate(`[...document.querySelectorAll('button')].find((node) => /command palette|命令面板/i.test(node.title || node.getAttribute('aria-label') || ''))?.click()`)
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.palette input'))`), 'command palette did not open')
    await app.evaluate(`document.querySelector('.palette input').focus()`)
    await app.send('Input.insertText', { text: '新建文件' })
    await sleep(250)
    await app.evaluate(`[...document.querySelectorAll('.palette-item')].find((node) => node.querySelector('.pi-title')?.textContent.trim() === '新建文件')?.click()`)
    await waitFor(() => app.evaluate(`/未命名|Untitled/.test(document.querySelector('.tab.active')?.textContent || '')`), 'no new document tab')
    await waitFor(() => editorReady(app.evaluate), 'new document editor did not mount')
    await sleep(800)
    await watchToasts(app.evaluate)
    assert.equal(await caretToHeadingEnd(app.evaluate), true, 'the new document has no heading to type in')
    await chars(app.send, 'woyao')
    await sleep(300)
    // Five Backspaces empty the heading, the sixth turns it into a paragraph.
    for (let index = 0; index < 6; index += 1) { await key(app.send, 'Backspace'); await sleep(120) }
    await sleep(600)
    await writePage(app.send)
    await checkSource(app, 'new document')

    // 2. A saved file emptied the same way.
    await app.evaluate(`[...document.querySelectorAll('.tab')].find((node) => /note\\.md/.test(node.textContent))?.click()`)
    await sleep(800)
    await watchToasts(app.evaluate)
    assert.equal(await caretToHeadingEnd(app.evaluate), true, 'could not place the caret in the file heading')
    for (let index = 0; index < 6; index += 1) { await key(app.send, 'Backspace'); await sleep(120) }
    await sleep(600)
    await writePage(app.send)
    const source = await checkSource(app, 'saved file')
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(await readFile(file, 'utf8'), source, 'the saved file differs from the source view')
    console.log('PASS emptied document retyped (new document and saved file): heading text deleted, `# ` + IME page — no warning, no failed check, source reopens to the typed document, save')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
