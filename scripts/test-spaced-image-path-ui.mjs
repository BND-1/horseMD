// Typora parity: Zhihu/WeChat exports name images after the article title,
// so paths carry bare spaces: `![](images/【每日meme】英国生活 篇-1.jpg)`.
// CommonMark leaves that as literal text; Typora shows the image. The images
// must render, links with spaced paths must be links, and editing next to
// them must save only the typed bytes (authored paths untouched, CRLF kept).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-spaced-image-'))
const file = join(root, '【每日meme】英国生活 篇.md')
const img = (n) => `images/【每日meme】英国生活 篇-${n}.jpg`
const original = [
  '---', 'title: "【每日meme】英国生活 篇"', '---',
  '第一段文字。', '',
  `![](${img(1)})![](${img(2)})`, '',
  `![](${img(3)})`, '',
  '看 [笔记](notes/my notes.md "Notes") 结尾', ''
].join('\r\n')
await mkdir(join(root, 'images'))
// 1×1 PNG bytes; the browser sniffs the type, the .jpg name is what matters.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
for (const n of [1, 2, 3]) await writeFile(join(root, img(n)), png)
await writeFile(file, original)

const inspectPort = 9600 + process.pid % 200
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29300 + process.pid % 300, appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label, attempts = 120) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const mainMenu = async (label) => {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const expr = `(() => { const { Menu } = require('electron'); const find = (items) => { for (const it of items) { if (it.label === ${JSON.stringify(label)}) return it; if (it.submenu) { const f = find(it.submenu.items); if (f) return f } } }; const it = find(Menu.getApplicationMenu().items); it.click(); return !!it })()`
  const done = new Promise((resolve) => ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d) }))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, includeCommandLineAPI: true } }))
  const res = await done
  ws.close()
  return res.result?.result?.value
}
const toggleSource = () => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)
const visibleSource = () => app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`)
const dirty = () => app.evaluate(`Boolean(document.querySelector('.tab.active .tab-dirty, .tab.active.dirty'))`)
const caretAtEnd = (match) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll('p')].find((n) => ${match})
  p.scrollIntoView({ block: 'center' }); (${editor}).focus()
  getSelection().setBaseAndExtent(p, p.childNodes.length, p, p.childNodes.length)
  return true
})()`)

try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('结尾')`), 'fixture did not open')
  const images = await waitFor(() => app.evaluate(`(() => {
    const imgs = [...(${editor}).querySelectorAll('img')].filter((n) => !n.closest('.ProseMirror-separator') && !n.classList.contains('ProseMirror-separator'))
    return imgs.length >= 3 && imgs.every((n) => n.complete && n.naturalWidth > 0) ? imgs.length : 0
  })()`), 'spaced-path images did not load')
  assert.equal(images, 3, 'three images render')
  const view = await app.evaluate(`(() => {
    const ed = ${editor}
    const a = [...ed.querySelectorAll('a')].find((n) => n.textContent === '笔记')
    return { literal: ed.textContent.includes('!['), linkHref: a?.getAttribute('href') ?? null, block: ed.querySelectorAll('.milkdown-image-block').length }
  })()`)
  assert.equal(view.literal, false, 'no image markdown shown as text')
  assert.equal(view.block, 1, 'a lone spaced-path image is an image block')
  assert.equal(view.linkHref, 'notes/my notes.md', 'spaced-path link is a link')
  await sleep(800)
  assert.equal(await dirty(), false, 'opening does not dirty the file')

  // A view toggle keeps the authored source.
  assert.equal(await toggleSource(), true, 'source toggle missing')
  const source = await waitFor(visibleSource, 'source textarea did not open')
  assert.equal(source.replace(/\r\n/g, '\n'), original.replace(/\r\n/g, '\n'), 'source mode shows the authored paths')
  await toggleSource()
  await waitFor(() => app.evaluate(`Boolean(${editor})`), 'rich editor did not come back')
  await sleep(500)
  assert.equal(await dirty(), false, 'toggle does not dirty the file')

  // Type in the image paragraph (after the second image) and in the link one.
  await caretAtEnd(`n.querySelectorAll('img').length >= 2`)
  await sleep(150)
  await typeTextLikeUser(app.send.bind(app), '图')
  await sleep(300)
  await caretAtEnd(`n.textContent.includes('结尾')`)
  await sleep(150)
  await typeTextLikeUser(app.send.bind(app), '啊')
  await sleep(500)

  assert.equal(await mainMenu('Save'), true, 'Save menu item not found')
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  const saved = await readFile(file, 'utf8')
  const expected = original
    .replace(`![](${img(2)})\r\n`, `![](${img(2)})图\r\n`)
    .replace('结尾\r\n', '结尾啊\r\n')
  assert.equal(saved, expected, `saved bytes:\n${JSON.stringify(saved)}`)
  const toasts = await app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter(Boolean)`)
  assert.ok(!toasts.some((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t)), `warning shown: ${JSON.stringify(toasts)}`)
  console.log('PASS spaced image path: Typora-style `![](a b.jpg)` renders, `[x](a b.md)` is a link, edits save only typed bytes (paths + CRLF kept)')
} finally {
  await stopBuiltElectron(app)
}
