// Heading folds in the real app. A fold hides the rest of a heading's
// section (up to the next heading of the same or a higher level) without
// touching the document: never dirty, saved bytes unchanged, export complete.
// Covers the hover toggle, Alt-click (every heading of that level), the
// shortcut, the context menu, the palette, the outline jump into a folded
// section, the caret never staying in hidden content, typing right after a
// folded heading, source/rich switching, reading mode and HTML export.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-heading-fold-'))
const file = join(root, 'doc.md')
const original = [
  '# 文档',
  '',
  '引言段',
  '',
  '## 第一节',
  '',
  '一节正文',
  '',
  '### 小节A',
  '',
  'A正文',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '',
  '### 小节B',
  '',
  'B正文',
  '',
  '## 第二节',
  '',
  '二节正文',
  '',
  '尾段',
  ''
].join('\n')
await writeFile(file, original)
const port = 29800 + process.pid % 100
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace']
})
const send = (...args) => app.send(...args)
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const mod = process.platform === 'darwin' ? 4 : 2
const ALT = 1
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const text = () => app.evaluate(`(${editor})?.pmViewDesc?.node?.textContent || ''`)
const mouse = (type, point, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point, ...extra })
const click = async (point, extra = {}) => {
  await mouse('mouseMoved', point, extra)
  await mouse('mousePressed', point, extra)
  await mouse('mouseReleased', point, extra)
  await sleep(250)
}
const block = (tag, value) => `[...(${editor}).children].find(n => n.matches(${JSON.stringify(tag)}) && n.textContent.trim() === ${JSON.stringify(value)})`
const rectOf = (expression) => app.evaluate(`(() => {
  const node = ${expression}
  if (!node) return null
  const r = node.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
})()`)
const textRect = (expression) => app.evaluate(`(() => {
  const node = ${expression}
  if (!node) return null
  node.scrollIntoView({ block: 'center' })
  const range = document.createRange()
  range.selectNodeContents(node)
  const r = [...range.getClientRects()].pop()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, y: r.top + r.height / 2 }
})()`)
// Which body blocks are on screen (display != none).
const shownBlocks = () => app.evaluate(`[...(${editor}).children]
  .filter(n => n.getClientRects().length)
  .map(n => n.matches('.milkdown-code-block') ? 'code' : n.matches('.milkdown-table-block, table') || n.querySelector?.('table') ? 'table' : n.textContent.trim())
  .join('|')`)
const toggles = () => app.evaluate(`[...document.querySelectorAll('.hm-fold-toggle')].map(b => {
  const r = b.getBoundingClientRect()
  return { pos: b.dataset.pos, folded: b.dataset.folded === 'true', x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, h: r.height }
})`)
const dirty = () => app.evaluate("Boolean(document.querySelector('.status-dot.mod'))")
const selectionHidden = () => app.evaluate(`(() => {
  const node = getSelection().anchorNode
  const el = node?.nodeType === 1 ? node : node?.parentElement
  return Boolean(el?.closest('.hm-fold-hidden'))
})()`)
const hoverToggle = async (heading) => {
  const r = await textRect(block(heading.tag, heading.text))
  assert.ok(r, `heading ${heading.text} missing`)
  await mouse('mouseMoved', { x: r.left + 4, y: r.y })
  await sleep(150)
  return waitFor(async () => {
    const list = await toggles()
    return list.find((b) => Math.abs(b.y - r.y) < 12) || null
  }, `no fold toggle next to ${heading.text}`)
}
const openPalette = async (label) => {
  await app.evaluate(`[...document.querySelectorAll('button')].find(n => /command palette|命令面板/i.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
  await waitFor(() => app.evaluate("!!document.querySelector('.palette')"), 'palette did not open')
  const input = "document.querySelector('.palette input')"
  await app.evaluate(`(() => { const i = ${input}; i.focus(); })()`)
  await send('Input.insertText', { text: label })
  await sleep(200)
  const ok = await app.evaluate(`(() => {
    const item = [...document.querySelectorAll('.palette-item')].find(n => n.textContent.includes(${JSON.stringify(label)}))
    item?.click()
    return Boolean(item)
  })()`)
  assert.ok(ok, `palette item ${label} missing`)
  await sleep(300)
}
const H1 = { tag: 'h2', text: '第一节' }
const ALL = '文档|引言段|第一节|一节正文|小节A|A正文|code|table|小节B|B正文|第二节|二节正文|尾段'

try {
  await waitFor(async () => (await text()).includes('尾段'), 'document did not open')
  await sleep(800)
  const baseline = await text()
  assert.equal(await shownBlocks(), ALL)

  // 1. Hovering a heading shows its toggle right after the text, on its line.
  const hTitle = await textRect(block('h2', '第一节'))
  const toggle = await hoverToggle(H1)
  assert.equal(toggle.folded, false)
  assert.ok(toggle.left >= hTitle.right && toggle.left < hTitle.right + 24, `toggle not after the text: ${JSON.stringify({ toggle, hTitle })}`)
  // Moving away hides it; a heading with nothing under it (none here) and
  // body text never get one.
  const body = await textRect(block('p', '引言段'))
  await mouse('mouseMoved', { x: body.left + 4, y: body.y })
  await waitFor(async () => (await toggles()).length === 0, 'toggle stayed after leaving the heading')

  // 2. Click folds the section: its H3s, code and table too; 第二节 stays.
  await click({ x: (await hoverToggle(H1)).x, y: toggle.y })
  await waitFor(async () => (await shownBlocks()) === '文档|引言段|第一节|第二节|二节正文|尾段', `fold hid the wrong blocks: ${await shownBlocks()}`)
  const folded = await waitFor(async () => (await toggles()).find((b) => b.folded), 'folded heading shows no toggle')
  assert.equal(await dirty(), false, 'folding made the document dirty')
  assert.equal(await text(), baseline, 'folding changed the document')
  // The folded toggle stays when the pointer leaves.
  await mouse('mouseMoved', { x: body.left + 4, y: body.y })
  await sleep(250)
  assert.equal((await toggles()).filter((b) => b.folded).length, 1)

  // 3. Click again unfolds.
  await click({ x: folded.x, y: folded.y })
  await waitFor(async () => (await shownBlocks()) === ALL, 'unfold did not restore every block')

  // 4. Shortcut with the caret in the body folds the nearest heading (小节A)
  //    and moves the caret out of the hidden part.
  const aBody = await textRect(block('p', 'A正文'))
  await click({ x: aBody.right - 2, y: aBody.y })
  await pressKey(send, { key: '.', code: 'Period', modifiers: mod | ALT })
  await waitFor(async () => (await shownBlocks()) === '文档|引言段|第一节|一节正文|小节A|小节B|B正文|第二节|二节正文|尾段', `shortcut folded the wrong part: ${await shownBlocks()}`)
  assert.equal(await selectionHidden(), false, 'caret left inside folded content')
  // Shortcut again (caret now on the folded heading) unfolds.
  await pressKey(send, { key: '.', code: 'Period', modifiers: mod | ALT })
  await waitFor(async () => (await shownBlocks()) === ALL, 'shortcut did not unfold')

  // 5. Alt-click folds every heading of that level (both H3s).
  const h3 = await hoverToggle({ tag: 'h3', text: '小节A' })
  await click({ x: h3.x, y: h3.y }, { modifiers: ALT })
  await waitFor(async () => (await shownBlocks()) === '文档|引言段|第一节|一节正文|小节A|小节B|第二节|二节正文|尾段', `Alt-click did not fold every H3: ${await shownBlocks()}`)
  assert.equal((await toggles()).filter((b) => b.folded).length, 2)

  // 6. Context menu on a heading: unfold all.
  const h2b = await textRect(block('h2', '第二节'))
  await mouse('mouseMoved', { x: h2b.left + 4, y: h2b.y })
  await mouse('mousePressed', { x: h2b.left + 4, y: h2b.y }, { button: 'right' })
  await mouse('mouseReleased', { x: h2b.left + 4, y: h2b.y }, { button: 'right' })
  await waitFor(() => app.evaluate("!!document.querySelector('[data-heading-fold=\"unfoldAll\"]')"), 'context menu has no unfold-all')
  assert.ok(await app.evaluate("!!document.querySelector('[data-heading-fold=\"level\"]')"))
  await app.evaluate("document.querySelector('[data-heading-fold=\"unfoldAll\"]').click()")
  await waitFor(async () => (await shownBlocks()) === ALL, 'context menu unfold-all did not open everything')

  // 7. Palette: fold all headings -> only the top heading's section folds
  //    (its sub-headings are inside it).
  await openPalette('折叠全部标题')
  await waitFor(async () => (await shownBlocks()) === '文档', `palette fold-all: ${await shownBlocks()}`)
  await openPalette('展开全部标题')
  await waitFor(async () => (await shownBlocks()) === ALL, 'palette unfold-all')

  // 8. Outline jump into a folded section opens it.
  await click({ x: (await hoverToggle(H1)).x, y: (await hoverToggle(H1)).y })
  await waitFor(async () => !(await shownBlocks()).includes('A正文'), 'fold for outline check')
  await app.evaluate(`[...document.querySelectorAll('button')].find(n => n.offsetParent && /大纲|Outline/i.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
  await waitFor(() => app.evaluate("document.querySelectorAll('.outline-item').length > 0"), 'outline did not open')
  // The outline shows H1-H2 by default: expand it.
  if (!(await app.evaluate("[...document.querySelectorAll('.outline-item')].some(n => n.textContent.includes('小节B'))"))) {
    await app.evaluate("document.querySelector('.outline-head-btn').click()")
  }
  await waitFor(() => app.evaluate("[...document.querySelectorAll('.outline-item')].some(n => n.textContent.includes('小节B'))"), 'outline does not list headings inside the fold')
  await app.evaluate("[...document.querySelectorAll('.outline-item')].find(n => n.textContent.includes('小节B')).click()")
  await waitFor(async () => (await shownBlocks()) === ALL, 'outline jump did not open the folded section')
  await sleep(600)
  const target = await rectOf(block('h3', '小节B'))
  const viewport = await app.evaluate('innerHeight')
  assert.ok(target.h > 0 && target.top > 0 && target.bottom < viewport, `outline jump target not on screen: ${JSON.stringify({ target, viewport })}`)

  // 9. Source mode and back keeps the folds and the bytes.
  await click({ x: (await hoverToggle(H1)).x, y: (await hoverToggle(H1)).y })
  await waitFor(async () => !(await shownBlocks()).includes('A正文'), 'fold before source switch')
  const sourceButton = "[...document.querySelectorAll('.status-right .status-btn')].find(b => /源码|富文本/.test(b.textContent))"
  await app.evaluate(`${sourceButton}.click()`)
  const src = await waitFor(() => app.evaluate("document.querySelector('textarea.source-editor')?.offsetParent ? document.querySelector('textarea.source-editor').value : ''"), 'source mode did not open')
  assert.equal(src, original, 'source mode shows different bytes while folded')
  await app.evaluate(`${sourceButton}.click()`)
  await waitFor(async () => Boolean(await app.evaluate(`Boolean(${editor})`)), 'rich mode did not come back')
  await sleep(400)
  assert.equal(await shownBlocks(), '文档|引言段|第一节|第二节|二节正文|尾段', 'folds lost across the source switch')
  assert.equal(await dirty(), false)

  // 10. HTML export of a folded document contains everything.
  await openPalette('HTML')
  await waitFor(() => app.evaluate("document.querySelector('.hm-html-preview')?.dataset.previewStatus === 'ready'"), 'HTML preview not ready', 150)
  const html = await app.evaluate("document.querySelector('.hm-html-preview iframe')?.srcdoc || ''")
  for (const piece of ['一节正文', 'A正文', 'B正文', '小节B', 'const a = 1', '列二']) assert.ok(html.includes(piece), `export misses ${piece}`)
  assert.ok(!html.includes('hm-fold-hidden'), 'export carries the fold class')
  await pressKey(send, { key: 'Escape', code: 'Escape' })
  await waitFor(() => app.evaluate("!document.querySelector('.hm-html-studio')"), 'HTML studio did not close')
  assert.equal(await shownBlocks(), '文档|引言段|第一节|第二节|二节正文|尾段', 'folds not restored after export')

  // 11. Reading mode: the toggle still works (view-only).
  await app.evaluate("document.querySelector('.hm-reading-btn').click()")
  await waitFor(() => app.evaluate(`(${editor}).contentEditable === 'false'`), 'reading mode did not start')
  const readToggle = (await toggles()).find((b) => b.folded)
  await click({ x: readToggle.x, y: readToggle.y })
  await waitFor(async () => (await shownBlocks()) === ALL, 'toggle did not work in reading mode')
  await app.evaluate("document.querySelector('.hm-reading-btn').click()")
  await waitFor(() => app.evaluate(`(${editor}).contentEditable === 'true'`), 'reading mode did not end')

  // 12. Typing right after a folded heading: Enter at its end makes a new
  //     paragraph inside the section, so the section opens; the save writes
  //     exactly the typed change.
  await click({ x: (await hoverToggle(H1)).x, y: (await hoverToggle(H1)).y })
  await waitFor(async () => !(await shownBlocks()).includes('A正文'), 'fold before typing')
  const head = await textRect(block('h2', '第一节'))
  await click({ x: head.right - 2, y: head.y })
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await typeTextLikeUser(send, '新段')
  await waitFor(async () => (await shownBlocks()).includes('新段') && (await shownBlocks()).includes('A正文'), `typing after a folded heading: ${await shownBlocks()}`)
  assert.equal(await selectionHidden(), false)
  await waitFor(() => app.evaluate("!!document.querySelector('.hm-save-fab')"), 'save button did not appear')
  await app.evaluate("document.querySelector('.hm-save-fab').click()")
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  assert.equal(await readFile(file, 'utf8'), original.replace('## 第一节\n\n', '## 第一节\n\n新段\n\n'))

  // 13. The trace log shows no source-sync pause / mismatch.
  const toastsSeen = await app.evaluate("[...document.querySelectorAll('.hm-toast-msg')].map(n => n.textContent).join('|')")
  assert.ok(!/不一致|暂停/.test(toastsSeen), `unexpected toast: ${toastsSeen}`)
  console.log('PASS heading fold UI: hover/click, shortcut, Alt-click, context menu, palette, outline jump, source switch, export, reading mode, typing + save')
} finally {
  await stopBuiltElectron(app)
}
