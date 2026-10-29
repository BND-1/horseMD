// Sync data-safety audit, app part of R1 (docs/cloud-sync-review.md): a tab
// with unsaved edits whose file is replaced on disk the way a sync download
// writes it (temp file + rename). What does the user see, and what does Save
// write? Prints the observed behaviour; exits 0 either way (audit, not a
// regression test).
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-sync-dirty-'))
const file = join(root, '笔记.md')
await writeFile(file, '原文\n')
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), port: 29500 + process.pid % 100, appArgs: [file, '--horsemd-input-trace']
})
const { send, evaluate } = app
const dialogs = []
app.ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method !== 'Page.javascriptDialogOpening') return
  dialogs.push(`${message.params.type}: ${message.params.message}`)
  send('Page.handleJavaScriptDialog', { accept: true })
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"
const waitFor = async (check, what, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(150) }
  throw new Error(`timeout: ${what}`)
}
try {
  await send('Page.enable')
  await waitFor(() => evaluate(`(${editor})?.textContent.includes('原文')`), 'document')
  await sleep(800)
  const p = await evaluate(`(() => { const r = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent === '原文').getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p })
  await pressKey(send, { key: 'End', code: 'End' })
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await typeTextLikeUser(send, 'A 的修改')
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-save-fab'))"), 'dirty')
  // The sync download: another device's version, written via temp + rename.
  await sleep(300)
  const temp = `${file}.sync.tmp`
  await writeFile(temp, '原文\n\nB 的修改\n')
  await rename(temp, file)
  await waitFor(() => dialogs.length > 0, 'external-change notice', 10000).catch(() => {})
  await sleep(500)
  const editorText = await evaluate(`(${editor}).textContent`)
  await evaluate("document.querySelector('.hm-save-fab')?.click()")
  await sleep(1500)
  const saved = await readFile(file, 'utf8')
  const extraDialogs = dialogs.slice(1)
  const lost = !saved.includes('B 的修改')
  console.log(`[${lost ? 'RISK' : 'OK'}] R1b 未保存的标签页遇到同步下载后再保存`)
  console.log(`       提示：${dialogs[0] ? JSON.stringify(dialogs[0]) : '没有提示'}`)
  console.log(`       编辑器里仍是：${JSON.stringify(editorText)}；按保存时${extraDialogs.length ? '又提示 ' + JSON.stringify(extraDialogs) : '没有再次提醒'}`)
  console.log(`       保存后文件：${JSON.stringify(saved)} → ${lost ? '另一台设备的「B 的修改」被覆盖' : '两边的修改都在'}`)
} finally {
  await stopBuiltElectron(app)
}
