// Links (Feishu / Notion style, user decision 2026-11-03): a plain click
// opens a link — web links in the browser, `#标题` jumps to that heading,
// `other.md` (and `other.md#小节`) opens in HorseMD as a tab (never the
// system's default Markdown app), other files in their own app; a missing
// heading / file says so. A click that ends a text selection does not open.
// Hovering shows ONE link card (Crepe's preview is off): target · 复制 ·
// 编辑 · 取消链接. 编辑 / Mod+K edit text + link; Mod+K on a selection makes
// a new link. Every edit saves exactly the expected Markdown, with no
// rich/source warning. Electron's shell is stubbed in main.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-link-click-'))
const file = join(root, 'doc.md')
const filler = Array.from({ length: 60 }, (_, i) => `填充段落 ${i}`).flatMap((line) => [line, ''])
const head = [
  '# 链接测试', '',
  '外链 [网站](https://example.com/hm) 结束', '',
  '锚点 [跳到第二节](#第二节) 和 [英文](#Second-Part) 和 [缺失](#不存在) 结束', '',
  '本地 [另一个文档](other.md) 和 [小节](other.md#深处的小节) 和 [缺文件](missing.md) 和 [附件](note.txt) 结束', '',
  'HTML <a href="https://example.com/html">html链接</a> 结束', '',
  '编辑 [旧文字](https://old.example) 结束', '',
  '粗体 [**粗**体](https://bold.example) 结束', '',
  '取消 [去掉我](https://gone.example) 结束', '',
  '新链接 词语', '',
  '标题 [带标题](https://t.example "原标题") 结束', '',
  '尖括号 [空格](<./my notes.md>) 结束', '',
  '引用 [引用式][1] 结束', '',
  '[1]: https://ref.example', ''
]
const tail = [...filler, '## 第二节', '', '第二节内容', '', ...filler, '## Second Part', '', '英文内容', '', ...filler]
await writeFile(file, [...head, ...tail].join('\n'))
await writeFile(join(root, 'other.md'), ['# 另一个文档', '', ...filler, '## 深处的小节', '', '小节内容', '', ...filler].join('\n'))
await writeFile(join(root, 'note.txt'), 'plain\n')

const port = 29500 + process.pid % 100
const inspectPort = 9200 + process.pid % 200
const mod = process.platform === 'darwin' ? 4 : 2
let app = null
const send = (...args) => app.send(...args)
const mainEval = async (expression) => {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const done = new Promise((resolve) => ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d) }))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }))
  const res = await done
  ws.close()
  return res.result?.result?.value
}
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (check, message, attempts = 60) => {
  let last
  for (let i = 0; i < attempts; i += 1) { last = await check(); if (last) return last; await sleep(100) }
  throw new Error(`${message}${last === undefined ? '' : `: ${JSON.stringify(last)}`}`)
}
const opened = () => mainEval('globalThis.__hmOpened.slice()')
const resetOpened = () => mainEval('globalThis.__hmOpened.length = 0')
// A plain move has no button down (CDP's button on mouseMoved means held).
const mouse = async (type, point, extra = {}) => send('Input.dispatchMouseEvent', { type, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, x: point.x, y: point.y, ...extra })
const rectOf = (expression) => app.evaluate(`(() => {
  const n = ${expression}
  if (!n) return null
  n.scrollIntoView({ block: 'center' })
  const r = n.getClientRects()[0] || n.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`)
const link = (href) => `(${editor}).querySelector('a[href="${href}"]')`
const clickAt = async (point, modifiers = 0) => {
  await mouse('mouseMoved', point, { modifiers })
  await mouse('mousePressed', point, { modifiers })
  await mouse('mouseReleased', point, { modifiers })
  await sleep(300)
}
const clickLink = async (href, modifiers = 0) => {
  const r = await rectOf(link(href))
  assert.ok(r, `${href} is not rendered as a link`)
  await sleep(150)
  await clickAt(r, modifiers)
}
const paragraph = (start) => `[...(${editor}).querySelectorAll('p')].find(p => p.textContent.startsWith(${JSON.stringify(start)}))`
// Caret at the end of a paragraph, without touching its links.
const caretAtEnd = async (start) => {
  const r = await rectOf(paragraph(start))
  await clickAt({ x: r.right - 2, y: r.y })
  await pressKey(send, { key: 'End' })
}
const headingOffset = (text) => app.evaluate(`(() => {
  const view = ${editor}
  const h = [...view.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(n => n.textContent.trim() === ${JSON.stringify(text)})
  if (!h) return null
  let s = view.parentElement
  while (s && !(s.scrollHeight > s.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement
  // + 0: CDP hands -0 back as no value.
  return Math.round(h.getBoundingClientRect().top - (s ? s.getBoundingClientRect().top : 0)) + 0
})()`)
const toasts = () => app.evaluate('globalThis.__toasts.slice()')
const card = () => app.evaluate(`(() => {
  const c = [...document.querySelectorAll('.hm-link-card')].find(n => !n.hidden)
  const crepe = [...document.querySelectorAll('.milkdown-link-preview')].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0)
  return { shown: !!c && !c.hidden, edit: !!c?.classList.contains('hm-link-card-edit'), url: c?.querySelector('.hm-link-card-url')?.textContent || '',
    acts: c ? [...c.querySelectorAll('[data-link-act]')].map(b => b.dataset.linkAct) : [], crepe: crepe.length,
    inEditor: !!c?.closest('.ProseMirror'), focused: document.activeElement?.dataset?.linkField || '' }
})()`)
const hover = async (href) => {
  const r = await rectOf(link(href))
  await mouse('mouseMoved', { x: r.x - 1, y: r.y })
  await mouse('mouseMoved', { x: r.x, y: r.y })
  return waitFor(async () => { const c = await card(); return c.shown && !c.edit && c.url && c }, `no card on ${href}`)
}
const cardButton = async (act) => {
  const r = await app.evaluate(`(() => { const b = [...document.querySelectorAll('.hm-link-card:not([hidden]) [data-link-act="${act}"]')][0]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  assert.ok(r, `no ${act} button`)
  await clickAt(r)
}
const fieldInput = async (name, value) => {
  const r = await app.evaluate(`(() => { const i = document.querySelector('.hm-link-card:not([hidden]) [data-link-field="${name}"]'); const r = i.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)
  await clickAt(r)
  await app.evaluate(`document.querySelector('.hm-link-card:not([hidden]) [data-link-field="${name}"]').select()`)
  await typeTextLikeUser(send, value)
}
// The floating Save button (a CDP Mod+S never reaches the macOS menu).
const save = async () => {
  await waitFor(() => app.evaluate("!!document.querySelector('.hm-save-fab')"), 'no save button')
  await app.evaluate("document.querySelector('.hm-save-fab').click()")
  await waitFor(() => app.evaluate("!document.querySelector('.status-dot.mod')"), 'save did not finish')
  await sleep(200)
  return readFile(file, 'utf8')
}
const expectFile = (lines) => [...lines, ...tail].join('\n')
const noMismatch = async () => {
  const bad = (await toasts()).filter((m) => /不一致|mismatch|无法安全/.test(m || ''))
  assert.deepEqual(bad, [], 'rich/source warning')
}

try {
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'), port,
    appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
  })
  await waitFor(() => app.evaluate(`!!${link('other.md')}`), 'document did not open', 150)
  await sleep(800)
  await mainEval(`(() => { const { shell } = require('electron'); globalThis.__hmOpened = []
    shell.openPath = async (p) => { globalThis.__hmOpened.push('path:' + p); return '' }
    shell.openExternal = async (u) => { globalThis.__hmOpened.push('url:' + u) }
    return true })()`)
  await app.evaluate(`(() => { globalThis.__toasts = []
    window.addEventListener('hm:toast', (e) => globalThis.__toasts.push(typeof e.detail === 'string' ? e.detail : e.detail?.msg)) })()`)

  // 1. Hover (editor focused, so Crepe's own preview would show too): one card.
  await caretAtEnd('新链接')
  let c = await hover('https://example.com/hm')
  assert.equal(c.url, 'https://example.com/hm')
  assert.deepEqual(c.acts, ['open', 'copy', 'edit', 'remove'])
  assert.equal(c.crepe, 0, "Crepe's link preview shows too")
  assert.equal(c.inEditor, false, 'the card is inside the editor')
  // Raw HTML <a>: open / copy only.
  c = await hover('https://example.com/html')
  assert.deepEqual(c.acts, ['open', 'copy'])

  // 2. A plain click opens web links; a drag selection inside a link does not.
  await clickLink('https://example.com/hm')
  await clickLink('https://example.com/html')
  assert.deepEqual(await opened(), ['url:https://example.com/hm', 'url:https://example.com/html'])
  const r = await rectOf(link('https://example.com/hm'))
  await mouse('mouseMoved', { x: r.left + 2, y: r.y })
  await mouse('mousePressed', { x: r.left + 2, y: r.y })
  await mouse('mouseMoved', { x: r.right - 2, y: r.y }, { button: 'left', buttons: 1 })
  await mouse('mouseReleased', { x: r.right - 2, y: r.y })
  await sleep(300)
  assert.equal(await app.evaluate('getSelection().toString()'), '网站', 'drag did not select the link text')
  assert.equal((await opened()).length, 2, 'a drag selection opened the link')
  // Mod+click still opens.
  await clickLink('https://example.com/hm', mod)
  assert.equal((await opened()).length, 3)
  // The card's target opens; its copy button copies.
  await hover('https://example.com/hm')
  await cardButton('open')
  assert.equal((await opened()).length, 4)
  await hover('https://example.com/hm')
  await cardButton('copy')
  await waitFor(async () => (await mainEval("require('electron').clipboard.readText()")) === 'https://example.com/hm', 'copy did not copy')
  await resetOpened()

  // 3. Heading anchors jump (by text and by slug); a missing one says so.
  await clickLink('#第二节')
  await waitFor(async () => Math.abs(await headingOffset('第二节')) < 40, '#第二节 did not jump')
  await sleep(1000) // the jump keeps the heading in place while the page settles
  await clickLink('#Second-Part')
  await waitFor(async () => Math.abs(await headingOffset('Second Part')) < 40, '#Second-Part did not jump')
  await sleep(1000)
  await clickLink('#不存在')
  await waitFor(async () => (await toasts()).some((m) => /没有标题「不存在」/.test(m)), 'no toast for a missing heading')

  // 4. A Markdown file opens in HorseMD as a tab — not through the system.
  await clickLink('other.md')
  await waitFor(() => app.evaluate(`[...document.querySelectorAll('.tab.active')].some(t => t.textContent.includes('other.md'))`), 'other.md did not open as the active tab')
  await waitFor(() => app.evaluate(`(${editor})?.querySelector('h1')?.textContent === '另一个文档'`), 'other.md is not shown')
  assert.deepEqual(await opened(), [], 'other.md went to the system')
  const backToDoc = async () => {
    await app.evaluate(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('doc.md')).click()`)
    await waitFor(() => app.evaluate(`!!${link('other.md')}`), 'doc.md is not back')
    await sleep(300)
  }
  await backToDoc()
  await clickLink('other.md#深处的小节')
  await waitFor(() => app.evaluate(`(${editor})?.querySelector('h1')?.textContent === '另一个文档'`), 'other.md#… did not switch tabs')
  await waitFor(async () => Math.abs(await headingOffset('深处的小节')) < 40, 'other.md#深处的小节 did not jump')
  await backToDoc()
  await clickLink('missing.md')
  await waitFor(async () => (await toasts()).some((m) => /打不开「missing\.md」/.test(m)), 'no toast for a missing file')
  await clickLink('note.txt')
  const last = await waitFor(async () => { const v = await opened(); return v.length === 1 && v[0] }, 'note.txt was not opened')
  assert.ok(last.startsWith('path:') && last.endsWith('note.txt'), last)
  assert.equal(await app.evaluate("!!document.querySelector('.status-dot.mod')"), false, 'opening links dirtied the document')

  // 5. 编辑: new text + new link → exactly that Markdown.
  await hover('https://old.example')
  await cardButton('edit')
  c = await card()
  assert.ok(c.edit, 'edit did not open the fields')
  assert.equal(c.focused, 'href', 'the link field is not focused')
  assert.equal(await app.evaluate(`document.querySelector('.hm-link-card:not([hidden]) [data-link-field="text"]').value`), '旧文字')
  await fieldInput('text', '新文字')
  await fieldInput('href', 'https://new.example/路径')
  await pressKey(send, { key: 'Enter' })
  await waitFor(() => app.evaluate(`!!${link('https://new.example/路径')}`), 'edit did not apply')
  assert.equal((await card()).shown, false)
  head[10] = '编辑 [新文字](https://new.example/路径) 结束'
  assert.equal(await save(), expectFile(head))

  // 6. Link only, on a link with bold inside: the bold stays.
  await hover('https://bold.example')
  await cardButton('edit')
  await fieldInput('href', 'https://bold2.example')
  await cardButton('apply')
  await waitFor(() => app.evaluate(`!!${link('https://bold2.example')}`), 'bold link edit did not apply')
  head[12] = '粗体 [**粗**体](https://bold2.example) 结束'
  assert.equal(await save(), expectFile(head))

  // 7. 取消链接: plain text.
  await hover('https://gone.example')
  await cardButton('remove')
  await waitFor(() => app.evaluate(`!${link('https://gone.example')}`), 'remove did not apply')
  head[14] = '取消 去掉我 结束'
  assert.equal(await save(), expectFile(head))

  // 8. Mod+K with the caret in a link edits it (Esc closes, nothing changes);
  // Mod+K on a selection makes a new link.
  await caretAtEnd('编辑')
  for (let i = 0; i < 5; i++) await pressKey(send, { key: 'ArrowLeft' })
  await pressKey(send, { key: 'k', code: 'KeyK', modifiers: mod })
  c = await waitFor(async () => { const v = await card(); return v.edit && v }, 'Mod+K in a link did not open the fields')
  assert.equal(await app.evaluate(`document.querySelector('.hm-link-card:not([hidden]) [data-link-field="href"]').value`), 'https://new.example/路径')
  await pressKey(send, { key: 'Escape' })
  assert.equal((await card()).shown, false, 'Esc did not close the fields')
  assert.equal(await app.evaluate("!!document.querySelector('.status-dot.mod')"), false, 'Esc changed the document')
  await caretAtEnd('新链接')
  await pressKey(send, { key: 'ArrowLeft', modifiers: 8 })
  await pressKey(send, { key: 'ArrowLeft', modifiers: 8 })
  assert.equal(await app.evaluate('getSelection().toString()'), '词语')
  await pressKey(send, { key: 'k', code: 'KeyK', modifiers: mod })
  c = await waitFor(async () => { const v = await card(); return v.edit && v }, 'Mod+K on a selection did not open the fields')
  assert.equal(await app.evaluate(`document.querySelector('.hm-link-card:not([hidden]) [data-link-field="text"]').value`), '词语')
  await typeTextLikeUser(send, 'https://word.example')
  await pressKey(send, { key: 'Enter' })
  await waitFor(() => app.evaluate(`!!${link('https://word.example')}`), 'new link was not made')
  head[16] = '新链接 [词语](https://word.example)'
  assert.equal(await save(), expectFile(head))
  // Typing right after goes on as plain text.
  await typeTextLikeUser(send, '后文')
  head[16] = '新链接 [词语](https://word.example)后文'
  assert.equal(await save(), expectFile(head))

  // 9. Other spellings keep their form: the title, the <…> destination; a
  // reference link's definition is not touched by mistake.
  await hover('https://t.example')
  await cardButton('edit')
  await fieldInput('href', 'https://t2.example')
  await pressKey(send, { key: 'Enter' })
  await waitFor(() => app.evaluate(`!!${link('https://t2.example')}`), 'titled link edit did not apply')
  head[18] = '标题 [带标题](https://t2.example "原标题") 结束'
  assert.equal(await save(), expectFile(head))
  await hover('./my notes.md')
  await cardButton('edit')
  await fieldInput('href', './other notes.md')
  await pressKey(send, { key: 'Enter' })
  await waitFor(() => app.evaluate(`!!${link('./other notes.md')}`), 'angle link edit did not apply')
  head[20] = '尖括号 [空格](<./other notes.md>) 结束'
  assert.equal(await save(), expectFile(head))
  await hover('https://ref.example')
  await cardButton('edit')
  await fieldInput('href', 'https://ref2.example')
  await pressKey(send, { key: 'Enter' })
  await waitFor(() => app.evaluate(`!!${link('https://ref2.example')}`), 'reference link edit did not apply')
  // Only this link changes: it becomes inline; the definition (maybe shared
  // with other `[…][1]`) stays.
  head[22] = '引用 [引用式](https://ref2.example) 结束'
  assert.equal(await save(), expectFile(head))

  await noMismatch()
  console.log('PASS link click UI: plain click opens (web / #heading by text or slug / other.md as a tab + #anchor / other files; missing → toast), drag-select does not, Mod+click too; one hover card (Crepe preview off) with open / copy / edit / remove (HTML <a>: open / copy); edit text + link, link only (bold kept), remove, Mod+K edit + Esc, Mod+K new link, titled / <…> links keep their form, a reference link becomes inline (definition kept) — exact saved Markdown, no rich/source warning')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
