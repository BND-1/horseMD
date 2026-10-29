// Saving a document that changed on disk while it had unsaved edits
// (docs/cloud-sync-review.md R1 — usually the sync writing another device's
// version). It used to overwrite that version after one alert. Now:
//   1. edits in different places → merged, saved, shown in the editor;
//   2. edits in the same place → the file keeps the disk version, the
//      editor's text goes to "名 (冲突副本 <设备> <时间>).md" and the tab moves
//      there; nothing is lost.
// The disk change is written the way the sync writes (temp file + rename).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-save-merge-'))
const file = join(root, '笔记.md')
const original = ['# 标题', '', '第一段', '', '第二段', '', '第三段', ''].join('\n')
await writeFile(file, original)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 29300 + process.pid % 100, appArgs: [file, '--horsemd-input-trace']
})
const { send, evaluate } = app
const dialogs = []
app.ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method !== 'Page.javascriptDialogOpening') return
  dialogs.push(message.params.message)
  send('Page.handleJavaScriptDialog', { accept: true })
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"
const waitFor = async (check, what, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(150) }
  throw new Error(`timeout: ${what}`)
}
const typeAtEnd = async (text, extra) => {
  const p = await evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent.startsWith(${JSON.stringify(text)})); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p })
  await pressKey(send, { key: 'End', code: 'End' })
  await typeTextLikeUser(send, extra)
}
const externalWrite = async (content) => {
  await sleep(300)
  const temp = `${file}.sync.tmp`
  await writeFile(temp, content)
  await rename(temp, file)
}
const paragraphs = () => evaluate(`[...(${editor}).querySelectorAll('p')].map((n) => n.textContent)`)
const save = () => evaluate("document.querySelector('.hm-save-fab')?.click()")
const toasts = () => evaluate("[...document.querySelectorAll('.hm-toast-msg, .hm-toast')].map((n) => n.textContent).join('|')")

try {
  await send('Page.enable')
  await waitFor(() => evaluate(`(${editor})?.textContent.includes('第三段')`), 'document')
  await sleep(800)

  // 1. Different places: merged.
  await typeAtEnd('第一段', ' A改')
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-save-fab'))"), 'dirty')
  await externalWrite(original.replace('第三段', '第三段 B改'))
  await waitFor(() => dialogs.length > 0, 'external-change notice')
  assert.match(dialogs[0], /自动合并/, `notice explains the merge: ${dialogs[0]}`)
  assert.deepEqual(await paragraphs(), ['第一段 A改', '第二段', '第三段'], 'unsaved edits kept, disk not shown yet')
  await save()
  await waitFor(async () => (await readFile(file, 'utf8')).includes('A改'), 'merged save')
  assert.equal(await readFile(file, 'utf8'), original.replace('第一段', '第一段 A改').replace('第三段', '第三段 B改'))
  await waitFor(async () => JSON.stringify(await paragraphs()) === JSON.stringify(['第一段 A改', '第二段', '第三段 B改']), 'merged text shown in the editor')
  await waitFor(() => evaluate("!document.querySelector('.hm-save-fab')"), 'clean after the merge')
  assert.match(await toasts(), /自动合并/)

  // 2. Same place: the file keeps the other version, ours goes to a copy.
  const before = await readFile(file, 'utf8')
  await typeAtEnd('第二段', ' A2')
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-save-fab'))"), 'dirty (2)')
  await externalWrite(before.replace('第二段', '第二段 B2'))
  await waitFor(() => dialogs.length > 1, 'external-change notice (2)')
  await save()
  const copy = await waitFor(async () => (await readdir(root)).find((n) => /^笔记 \(冲突副本 .+ \d{4}-\d{2}-\d{2} \d{4}\)\.md$/.test(n)), 'conflict copy written')
  assert.equal(await readFile(file, 'utf8'), before.replace('第二段', '第二段 B2'), 'the file keeps the other version')
  assert.equal(await readFile(join(root, copy), 'utf8'), before.replace('第二段', '第二段 A2'), 'the copy holds the editor text')
  await waitFor(() => evaluate(`[...document.querySelectorAll('.tab')].some((n) => n.textContent.includes(${JSON.stringify(copy)}) && /active/.test(n.className))`), 'the tab moved to the copy')
  assert.match(await toasts(), /冲突副本|另存为/)
  assert.ok(!/不一致|暂停/.test(await toasts()), 'no source-sync toast')
  console.log('PASS save over an external change: different places merge (saved + shown in place); the same place keeps the disk version and saves the editor text as a device-named conflict copy the tab moves to')
} finally {
  await stopBuiltElectron(app)
}
