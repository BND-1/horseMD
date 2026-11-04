// Highlight over bold text (#173) — and the selection toolbar survives a
// slow drag (its fade starts at the release): a mouse selection that covers part of a
// bold run, all of one, or a bold run plus plain text, highlighted with the
// toolbar's colour swatches or Mod+Alt+H, saves the Markdown the editor
// shows, with no rich/source warning — and reopens as the same document.
// Before, `<mark class="hm-hl-blue">a**b**</mark>` / `==a**b**==` read back
// as literal tags / `==`, so every such highlight paused the source sync
// (「检测到富文本与源码不一致」).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-highlight-bold-'))
const file = join(root, 'doc.md')
const lines = [
  '# 高亮和粗体', '',
  '最主要标志就是**摄影**的诞生。', '',
  '就是抹除了**原作和复制品**之间的区别。', '',
  '宗教的礼仪变成了**政治**。我们会发现', '',
  '比如==摄影作品==，到了==电影==这种。', '',
  '**它需要是有道理的、可被承认的**。那么从那个时候开始呢', ''
]
await writeFile(file, lines.join('\n'))

const port = 29600 + process.pid % 100
const mod = process.platform === 'darwin' ? 4 : 2
let app = null
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (check, message, attempts = 60) => {
  let last
  for (let i = 0; i < attempts; i += 1) { last = await check(); if (last) return last; await sleep(100) }
  throw new Error(`${message}${last === undefined ? '' : `: ${JSON.stringify(last)}`}`)
}
// `held`: a move with the left button down (a drag).
const mouse = (type, point, held = false) => app.send('Input.dispatchMouseEvent', {
  type, button: type === 'mouseMoved' && !held ? 'none' : 'left', buttons: type === 'mouseReleased' || (type === 'mouseMoved' && !held) ? 0 : 1, clickCount: 1, x: point.x, y: point.y
})
// The point at `offset` characters into the first occurrence of `text`.
const pointAt = (text, offset) => app.evaluate(`((text, offset) => {
  const w = document.createTreeWalker(${editor}, NodeFilter.SHOW_TEXT)
  let seen = ''
  const nodes = []
  while (w.nextNode()) { nodes.push([w.currentNode, seen.length]); seen += w.currentNode.nodeValue }
  const at = seen.indexOf(text)
  if (at < 0) return null
  const target = at + offset
  for (const [node, start] of nodes) {
    if (target < start || target > start + node.nodeValue.length) continue
    const r = document.createRange()
    r.setStart(node, target - start); r.collapse(true)
    const rect = r.getClientRects()[0] || node.parentElement.getBoundingClientRect()
    return { x: rect.left, y: rect.top + rect.height / 2 }
  }
  return null
})(${JSON.stringify(text)}, ${offset})`)
// Drag-select `text` inside `context` (marks split the DOM text; the walker
// joins it). `settle`: wait before reading the selection (not when the
// toolbar comes next: it fades 1.5 s after the selection is made). `hold`: ms
// the button stays down at the end before the release (a slow drag).
const select = async (context, text, settle = true, hold = 0) => {
  const at = context.indexOf(text)
  const from = await pointAt(context, at)
  const to = await pointAt(context, at + text.length)
  assert.ok(from && to, `text not found: ${context}`)
  await mouse('mouseMoved', from)
  await mouse('mousePressed', from)
  for (let i = 1; i <= 6; i += 1) await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / 6, y: to.y }, true)
  if (hold) await sleep(hold)
  await mouse('mouseReleased', to)
  if (settle) await sleep(350)
  const selected = await app.evaluate('String(getSelection())')
  assert.equal(selected, text, 'mouse selection')
}
const visibleCenter = (selector) => app.evaluate(`(() => {
  const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length && e.getBoundingClientRect().width > 0)
  if (!n) return null
  const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
// Select, go straight to the selection toolbar's highlight button and click
// the colour. The toolbar fades 1.5 s after the selection (toolbar-autohide);
// when a slow machine (Windows over CDP) is not there in time, select again,
// as a person would.
const highlightWith = async (context, text, color, hold = 0) => {
  for (let attempt = 1; ; attempt += 1) {
    await select(context, text, false, hold)
    let item = null
    for (let i = 0; i < 15 && !item; i += 1) { item = await visibleCenter('.hm-highlight-item'); if (!item) await sleep(100) }
    if (item) {
      await mouse('mouseMoved', item)
      let sw = null
      for (let i = 0; i < 10 && !sw; i += 1) { await sleep(100); sw = await visibleCenter(`.hm-hl-swatch.hm-hl-${color}`) }
      if (sw) {
        await mouse('mouseMoved', sw)
        await mouse('mousePressed', sw)
        await mouse('mouseReleased', sw)
        await sleep(900)
        return
      }
    }
    assert.ok(attempt < 3, `no ${color} swatch in the selection toolbar`)
    console.log(`note: the toolbar had faded before the pointer reached it (${color}, attempt ${attempt}); selecting again`)
    await pressKey(app.send, { key: 'ArrowRight', code: 'ArrowRight' })
    await sleep(300)
  }
}
const toasts = () => app.evaluate('globalThis.__toasts.slice()')
const noMismatch = async (step) => {
  const bad = (await toasts()).filter((m) => /不一致|mismatch|无法安全/.test(m || ''))
  assert.deepEqual(bad, [], `rich/source warning after ${step}`)
}
// Paragraph content as [text, marks] runs (heading ids ignored).
const runs = () => app.evaluate(`(() => {
  const doc = globalThis.__hmSourceReprintHarness.liveDoc()
  const out = []
  doc.forEach((block) => {
    const row = []
    block.forEach((n) => row.push([n.text || n.type.name, n.marks.map((m) => m.type.name + (m.attrs.color ? ':' + m.attrs.color : '')).sort().join('+')]))
    out.push(row)
  })
  return JSON.stringify(out)
})()`)
const launch = async () => {
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
  await waitFor(() => app.evaluate(`!!(${editor}) && !!globalThis.__hmSourceReprintHarness`), 'document did not open', 150)
  await sleep(800)
  await app.evaluate(`(() => { globalThis.__toasts = []
    window.addEventListener('hm:toast', (e) => globalThis.__toasts.push(typeof e.detail === 'string' ? e.detail : e.detail?.msg)) })()`)
}

try {
  await launch()
  // 1. Plain + bold + plain → blue (the issue's shape).
  await highlightWith('最主要标志就是摄影的诞生', '主要标志就是摄影的', 'blue')
  await noMismatch('blue over bold')
  // 2. Plain + the start of a bold run → yellow by shortcut.
  await select('就是抹除了原作和复制品', '抹除了原作')
  await pressKey(app.send, { key: 'h', code: 'KeyH', modifiers: mod | 1 })
  await sleep(900)
  await noMismatch('Mod+Alt+H over the start of bold')
  // 3. Exactly one bold run → red, after a slow drag: the button held 2 s
  // before the release. The toolbar used to fade while the button was down
  // and never came back.
  await highlightWith('礼仪变成了政治。', '政治', 'red', 2000)
  await noMismatch('red over a whole bold run')
  // 4. Across two yellow highlights → blue (replaces them).
  await highlightWith('比如摄影作品，到了电影这种', '影作品，到了电', 'blue')
  await noMismatch('blue across two highlights')
  // 5. The end of a bold run + plain → yellow.
  await select('可被承认的。那么从', '承认的。那么')
  await pressKey(app.send, { key: 'h', code: 'KeyH', modifiers: mod | 1 })
  await sleep(900)
  await noMismatch('Mod+Alt+H over the end of bold')

  const live = await runs()
  await waitFor(() => app.evaluate("!!document.querySelector('.hm-save-fab')"), 'no save button')
  await app.evaluate("document.querySelector('.hm-save-fab').click()")
  await waitFor(() => app.evaluate("!document.querySelector('.status-dot.mod')"), 'save did not finish')
  await sleep(300)
  await noMismatch('save')
  const saved = await readFile(file, 'utf8')
  assert.equal(saved, [
    '# 高亮和粗体', '',
    '最<mark class="hm-hl-blue">主要标志就是**摄影**的</mark>诞生。', '',
    '就是==抹除了**原作**==**和复制品**之间的区别。', '',
    // The authored `**…**` stays; the highlight goes inside it.
    '宗教的礼仪变成了**<mark class="hm-hl-red">政治</mark>**。我们会发现', '',
    '比如==摄==<mark class="hm-hl-blue">影作品，到了电</mark>==影==这种。', '',
    '**它需要是有道理的、可被==承认的==**==。那么==从那个时候开始呢', ''
  ].join('\n'))
  await stopBuiltElectron(app, { removeProfile: false })
  app = null

  // Reopen: the same document.
  await launch()
  assert.equal(await runs(), live, 'reopened document differs')
  console.log('PASS highlight over bold: blue / red swatches (red after a 2 s held drag: the toolbar stays) and Mod+Alt+H over part of, all of and the edges of bold runs and across two highlights — no rich/source warning, exact Markdown saved, same document after reopening')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
