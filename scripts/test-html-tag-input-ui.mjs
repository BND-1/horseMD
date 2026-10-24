// Typing an HTML tag in the rich editor makes it HTML (Typora parity,
// editor-html-input.js). User report: typed `<xxx>` was saved as `\<xxx>`
// and only rendered after deleting the backslash in source mode.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-html-input-'))
const file = join(root, 'tags.md')
const original = [
  '# Tags',
  '',
  'first line',
  '',
  'second line',
  '',
  'third line',
  '',
  '<font style="color:rgb(255, 0, 0);">红色文字</font>',
  '',
  'end line',
  ''
].join('\n')
await writeFile(file, original)

const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label, attempts = 150) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const warnings = (app) => app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t))`)
const pointIn = (app, needle, offset) => app.evaluate(`(() => {
  const walk = document.createTreeWalker(${editor}, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walk.nextNode())) if (node.data.includes(${JSON.stringify(needle)})) break
  node.parentElement.scrollIntoView({ block: 'center' })
  const at = node.data.indexOf(${JSON.stringify(needle)}) + ${offset}
  const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at)
  const b = r.getBoundingClientRect(); return { x: b.left + 0.5, y: b.top + b.height / 2 }
})()`)
const click = async (app, p) => {
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(300)
}
const paragraph = (app, needle) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent.includes(${JSON.stringify(needle)}))
  return p && {
    text: p.textContent,
    html: [...p.querySelectorAll('[data-type=html]')].map((n) => n.dataset.value),
    spans: [...p.querySelectorAll('.hm-html-span')].map((n) => ({ text: n.textContent, color: n.style.color })),
    links: [...p.querySelectorAll('a')].map((n) => n.textContent),
    code: [...p.querySelectorAll('code')].map((n) => n.textContent),
    breaks: p.querySelectorAll('br:not(.ProseMirror-trailingBreak)').length
  }
})()`)

const port = 29850 + process.pid % 40
let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('end line')`), 'fixture did not open')
  await sleep(800)

  // 1. A <span> pair typed in a paragraph becomes the editable coloured span.
  await click(app, await pointIn(app, 'first line', 'first line'.length))
  await typeTextLikeUser(app.send, ' <span style="color:red">红</span> 后', { delayMs: 60 })
  await sleep(700)
  let p = await paragraph(app, 'first line')
  assert.deepEqual(p.spans, [{ text: '红', color: 'red' }], `typed span renders: ${JSON.stringify(p)}`)
  assert.ok(!p.text.includes('<span'), `no literal tag text left: ${p.text}`)

  // 2. Void tags, inline tags and an unknown tag become HTML.
  await click(app, await pointIn(app, 'second line', 'second line'.length))
  await typeTextLikeUser(app.send, ' a<br>b <kbd>Ctrl</kbd> <xxx>', { delayMs: 60 })
  await sleep(700)
  p = await paragraph(app, 'second line')
  assert.deepEqual(p.html, ['<kbd>Ctrl</kbd>', '<xxx>'], `inline/unknown tags are HTML: ${JSON.stringify(p)}`)
  // `<br>` is the line break it opens as (brToBreakRemarkPlugin).
  assert.equal(p.breaks, 1, `<br> became a line break: ${JSON.stringify(p)}`)
  assert.ok(!p.text.includes('<br'), 'no literal <br> text')

  // 3. Inline code and angle autolinks keep their own meaning.
  await click(app, await pointIn(app, 'third line', 'third line'.length))
  await typeTextLikeUser(app.send, ' `<i>` <https://example.com>', { delayMs: 60 })
  await sleep(700)
  p = await paragraph(app, 'third line')
  assert.deepEqual(p.code, ['<i>'], `inline code keeps the tag as code: ${JSON.stringify(p)}`)
  assert.deepEqual(p.links, ['https://example.com'], `angle autolink still links: ${JSON.stringify(p)}`)
  assert.deepEqual(p.html, [], 'nothing in that line became HTML')

  // 4. Inside a Yuque <font>: the tag stays inside the font.
  await click(app, await pointIn(app, '红色文字', 2))
  await typeTextLikeUser(app.send, '<b>粗</b>', { delayMs: 60 })
  await sleep(700)
  p = await paragraph(app, '红色')
  assert.deepEqual(p.html, ['<b>粗</b>'], `tag typed inside <font> is HTML: ${JSON.stringify(p)}`)
  assert.ok(await app.evaluate(`Boolean([...(${editor}).querySelectorAll('.hm-html-span [data-type=html]')].length)`), 'the HTML stays inside the font span')
  assert.deepEqual(await warnings(app), [], 'no mismatch warning while typing tags')

  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  await sleep(400)
  const saved = await readFile(file, 'utf8')
  assert.ok(!saved.includes('\\<'), `no escaped tags in the file:\n${saved}`)
  assert.ok(saved.includes('first line <span style="color:red">红</span> 后'), `span saved raw:\n${saved}`)
  assert.match(saved, /second line a(?:<br>|  \n|\\\n)b <kbd>Ctrl<\/kbd> <xxx>/, `tags saved raw:\n${saved}`)
  assert.ok(saved.includes('third line `<i>` <https://example.com>'), `code and autolink saved:\n${saved}`)
  assert.ok(saved.includes('<font style="color:rgb(255, 0, 0);">红色<b>粗</b>文字</font>'), `tag inside the font saved:\n${saved}`)
  assert.deepEqual(await warnings(app), [], 'save raised no warning')
  await stopBuiltElectron(app)

  // 5. Reopen: same rendering.
  app = await launchBuiltElectron({ profileDir: join(root, 'profile2'), port: port + 1, appArgs: [file, '--horsemd-input-trace'] })
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('end line')`), 'saved file did not reopen')
  await sleep(800)
  assert.deepEqual((await paragraph(app, 'first line')).spans, [{ text: '红', color: 'red' }], 'span after reopen')
  assert.deepEqual((await paragraph(app, 'second line')).html, ['<kbd>Ctrl</kbd>', '<xxx>'], 'tags after reopen')
  assert.deepEqual(await warnings(app), [], 'no warning after reopen')
  console.log('PASS html tag input: typed tags become HTML (span pair, void, inline, unknown, inside <font>), code/autolink untouched, saved raw, same after reopen')
} finally {
  await stopBuiltElectron(app)
}
