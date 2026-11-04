// Formatting an image alone (select it, Mod+B / Mod+I): the saved Markdown
// carries the mark (`**![i](pic.png)**`), no rich/source warning, and the
// reopened document is the same.
//
// Before 2026-11-04 the serializer memo took a document that differed from
// the previous one only by an image's marks for that one (its "same apart
// from heading ids" check compared no marks on leaf nodes) and returned the
// old Markdown; the sync then failed its check.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-image-mark-'))
const file = join(root, 'doc.md')
// A tiny PNG next to the document.
await writeFile(join(root, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))
await writeFile(file, '# 图片\n\n前面 ![i](pic.png) 后面\n\n第二段\n')
const port = 29680 + process.pid % 20
const mod = process.platform === 'darwin' ? 4 : 2
let app = null
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (check, message, attempts = 60) => {
  let last
  for (let i = 0; i < attempts; i += 1) { last = await check(); if (last) return last; await sleep(100) }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}
const launch = async () => {
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
  await waitFor(() => app.evaluate(`!!(${editor})?.querySelector('img') && !!globalThis.__hmSourceReprintHarness`), 'document did not open', 150)
  await sleep(800)
  await app.evaluate(`(() => { globalThis.__toasts = []
    window.addEventListener('hm:toast', (e) => globalThis.__toasts.push(typeof e.detail === 'string' ? e.detail : e.detail?.msg)) })()`)
}
const imageMarks = () => app.evaluate(`(() => { let marks = null
  globalThis.__hmSourceReprintHarness.liveDoc().descendants((n) => { if (n.type.name === 'image') marks = n.marks.map((m) => m.type.name).sort().join('+'); return marks == null })
  return marks })()`)

try {
  await launch()
  // Caret after `前面`, one step over the blank, Shift+→ selects the image
  // (a click on it opens the lightbox).
  const point = await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent.includes('前面'))
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode()
    const range = document.createRange(); range.setStart(node, 2); range.collapse(true)
    const r = range.getClientRects()[0]; return { x: r.left, y: r.top + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(300)
  await pressKey(app.send, { key: 'ArrowRight', code: 'ArrowRight' })
  await pressKey(app.send, { key: 'ArrowRight', code: 'ArrowRight', modifiers: 8 })
  await sleep(300)
  await pressKey(app.send, { key: 'b', code: 'KeyB', modifiers: mod })
  await sleep(900)
  assert.equal(await imageMarks(), 'strong', 'Mod+B on the selected image')
  await pressKey(app.send, { key: 'i', code: 'KeyI', modifiers: mod })
  await sleep(900)
  assert.equal(await imageMarks(), 'emphasis+strong', 'Mod+I on the selected image')
  const bad = (await app.evaluate('globalThis.__toasts.slice()')).filter((m) => /不一致|mismatch|无法安全/.test(m || ''))
  assert.deepEqual(bad, [], 'no rich/source warning')
  await waitFor(() => app.evaluate("!!document.querySelector('.hm-save-fab')"), 'no save button')
  await app.evaluate("document.querySelector('.hm-save-fab').click()")
  await waitFor(() => app.evaluate("!document.querySelector('.status-dot.mod')"), 'save did not finish')
  await sleep(300)
  const saved = await readFile(file, 'utf8')
  assert.match(saved, /前面 (?:\*\*\*!\[i\]\(pic\.png\)\*\*\*|\*\*\*!\[i\]\(pic\.png\)\*\*\*|_\*\*!\[i\]\(pic\.png\)\*\*_|\*\*_!\[i\]\(pic\.png\)_\*\*|\*__!\[i\]\(pic\.png\)__\*) 后面/, `saved: ${saved}`)
  assert.ok(saved.startsWith('# 图片\n\n') && saved.endsWith('\n\n第二段\n'), `the rest kept: ${saved}`)
  await stopBuiltElectron(app, { removeProfile: false })
  app = null
  await launch()
  assert.equal(await imageMarks(), 'emphasis+strong', 'reopened image keeps bold + italic')
  console.log('PASS image marks: Mod+B / Mod+I on a selected image save `***![i](pic.png)***`, no warning, the same after reopening')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
