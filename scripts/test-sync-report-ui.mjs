// Sync error details UI: when「检测到富文本与源码不一致」shows, it asks the
// user to send us the details and its prominent 查看详情 button opens a report (version, reason, the changed blocks as in
// the file — CRLF visible — and as in the editor, the last input events);
// the text is folded, then editable; 去提交 opens
// the prefilled bug form with it; 复制详情 copies it and shows the
// author's WeChat ID (the ID chip copies the ID). The failure is forced through the
// --horsemd-input-trace harness (a real unmappable edit has no stable repro
// once fixed); main's clipboard and shell are stubbed via the inspector.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await mkdtemp(join(tmpdir(), 'horsemd-sync-report-'))
const file = join(root, 'report.md')
const original = ['# 诊断', '', '第一段', '', '- 列表项', '', '尾段', ''].join('\r\n')
await writeFile(file, original)
const inspectPort = 9470 + Math.floor(Math.random() * 40)
const mainEval = async (expression) => {
  const [target] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (message) => { const data = JSON.parse(message.data); if (data.id === 1) resolve(data) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return reply.result?.result?.value
}
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'),
  port: 9600 + Math.floor(Math.random() * 200),
  appArgs: [file, '--horsemd-input-trace', `--inspect=${inspectPort}`]
})
const { send, evaluate } = app
const editor = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"
const waitFor = async (expression, what, ms = 20000) => {
  const start = Date.now()
  while (Date.now() - start < ms) { const value = await evaluate(expression); if (value) return value; await sleep(150) }
  throw new Error(`timeout: ${what}`)
}
const click = async (expression) => {
  const point = await evaluate(`(() => { const n = ${expression}; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  await sleep(200)
}

try {
  await waitFor(`(${editor})?.textContent.includes('尾段') && globalThis.__hmSourceReprintHarness`, 'editor + harness')
  await sleep(800)
  await mainEval(`(() => { const { clipboard, shell } = require('electron'); globalThis.__clip = null; globalThis.__opened = []
    clipboard.writeText = (text) => { globalThis.__clip = text }
    shell.openExternal = async (url) => { globalThis.__opened.push(url) }
    return 1 })()`)

  // An edit: end of 第一段, type, Enter, type.
  const end = await evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent === '第一段'); const r = p.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...end })
  await sleep(200)
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, '改动')
  await pressKey(send, { key: 'Enter', text: '\r' })
  await typeTextLikeUser(send, '新段')
  await sleep(400)
  // A Markdown paste: the paste handler stops the event, and the log must
  // still record it (#171).
  await pressKey(send, { key: 'Enter', text: '\r' })
  const pasted = await evaluate(`(() => { const data = new DataTransfer(); data.setData('text/plain', '- 粘贴一\\n- 粘贴二\\n'); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); (${editor}).dispatchEvent(event); return event.defaultPrevented })()`)
  assert.equal(pasted, true, 'the Markdown paste handler took the paste')
  await sleep(600)
  // Fail with the source left as it was before the edit (a real failure
  // keeps the last synced source): "before" is the file's text, "after" the
  // editor's.
  await evaluate(`globalThis.__hmSourceReprintHarness.forceSyncFailure('test-forced-failure', ${JSON.stringify(original)})`)

  // 1. The mismatch toast is a light card: title, message, the ask, and
  // 关闭 / 查看详情 (accent).
  await waitFor(`/不一致/.test(document.querySelector('.hm-toast.sticky .hm-toast-msg')?.textContent || '') && document.querySelector('.hm-toast-action')?.textContent === '查看详情'`, 'toast with 查看详情')
  assert.match(await evaluate(`document.querySelector('.hm-toast-hint')?.textContent || ''`), /查看详情」把信息发给我们/)
  const look = await evaluate(`(() => { const b = document.querySelector('.hm-toast-action'); const card = b.closest('.hm-toast'); const r = b.getBoundingClientRect()
    return { height: r.height, bg: getComputedStyle(b).backgroundColor, title: card.querySelector('.hm-alert-title')?.textContent, close: card.querySelector('.hm-alert-secondary')?.textContent } })()`)
  // (31.28 px on Windows at fractional scaling.)
  assert.ok(look.height >= 30 && look.bg !== 'rgba(0, 0, 0, 0)', `查看详情 is a filled button: ${JSON.stringify(look)}`)
  assert.equal(look.title, '出了点问题')
  assert.equal(look.close, '关闭')
  if (process.env.HM_SYNC_REPORT_SHOT) {
    await sleep(500) // past the fade-in
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(process.env.HM_SYNC_REPORT_SHOT, 'sync-toast.png'), Buffer.from(shot.data ?? shot.result?.data ?? '', 'base64'))
  }
  await click(`document.querySelector('.hm-toast-action')`)
  // The dialog opens with the two ways to send and the content folded.
  await waitFor(`Boolean(document.querySelector('.hm-sync-report'))`, 'report dialog')
  assert.equal(await evaluate(`Boolean(document.querySelector('.hm-sync-report textarea'))`), false, 'content starts folded')
  assert.equal(await evaluate(`document.querySelector('.hm-sync-report-title')?.textContent`), '把出错详情发给我们')
  if (process.env.HM_SYNC_REPORT_SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(process.env.HM_SYNC_REPORT_SHOT, 'sync-report-folded.png'), Buffer.from(shot.data ?? shot.result?.data ?? '', 'base64'))
  }
  await click(`document.querySelector('[data-sync-report="toggle"]')`)
  await waitFor(`Boolean(document.querySelector('.hm-sync-report textarea'))`, 'content expanded')
  const report = await evaluate(`document.querySelector('.hm-sync-report textarea').value`)
  assert.match(report, /- 版本：\d+\.\d+\.\d+/, report)
  assert.match(report, /- 原因：`test-forced-failure`/)
  assert.match(report, /- 文档：.*CRLF/)
  assert.match(report, /#### 改动前（源码原文/, report)
  const before = report.split('#### 改动后')[0].split('#### 改动前')[1] || ''
  assert.ok(before.includes('第一段␍\n') && !before.includes('改动'), `before is the file's CRLF text: ${before}`)
  assert.match(report.split('#### 改动后')[1] || '', /第一段改动[\s\S]*新段/, 'after has the edit')
  assert.match(report, /input insertText "改"|input insertText "动"|insertText/, 'typed input recorded')
  assert.match(report, /key Enter @ paragraph/, 'Enter recorded with its block')
  assert.match(report, /paste "- 粘贴一\\n- 粘贴二\\n" len=\d+ text\/plain/, 'a Markdown paste is recorded although its handler stops the event')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.hm-sync-report textarea')`), true, 'the expanded box has focus')

  // HM_SYNC_REPORT_SHOT=<dir>: save the dialog and the toast as PNGs and the
  // report text, to look at by hand.
  if (process.env.HM_SYNC_REPORT_SHOT) {
    const dir = process.env.HM_SYNC_REPORT_SHOT
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(dir, 'sync-report.png'), Buffer.from(shot.data ?? shot.result?.data ?? '', 'base64'))
    await writeFile(join(dir, 'sync-report.md'), report)
  }

  // 2. WeChat: 复制详情 copies the box and names the author's ID; the ID
  // chip copies the ID.
  const dialogText = await evaluate(`document.querySelector('.hm-sync-report-send')?.textContent || ''`)
  assert.match(dialogText, /GitHub/)
  assert.match(dialogText, /alwaysraiseuplikesun/)
  await mainEval('globalThis.__clip = null')
  const idTop = () => evaluate(`document.querySelector('[data-sync-report="copy-id"]').getBoundingClientRect().top`)
  const topBefore = await idTop()
  await click(`document.querySelector('[data-sync-report="wechat"]')`)
  await waitFor(`/alwaysraiseuplikesun/.test(document.querySelector('.hm-sync-report-status')?.textContent || '')`, 'wechat status')
  assert.equal(await mainEval('globalThis.__clip'), report, 'WeChat copies the details')
  await sleep(300)
  assert.ok(Math.abs((await idTop()) - topBefore) < 1, 'the status line does not move the dialog')
  // The status line must not move the dialog (it was centred and jumped up
  // by half the new height; the click then hit the row, Windows).
  await click(`document.querySelector('[data-sync-report="copy-id"]')`)
  await waitFor(`/微信号已复制/.test(document.querySelector('.hm-sync-report-status')?.textContent || '')`, 'id copied status')
  assert.equal(await mainEval('globalThis.__clip'), 'alwaysraiseuplikesun')

  // 3. The user removes a line; GitHub gets the edited text.
  const edited = report.replace(/- 时间：.*\n/, '')
  await evaluate(`(() => { const area = document.querySelector('.hm-sync-report textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(area, ${JSON.stringify(edited)}); area.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await click(`document.querySelector('[data-sync-report="github"]')`)
  await waitFor(`/反馈页/.test(document.querySelector('.hm-sync-report-status')?.textContent || '')`, 'github status')
  const [opened] = await mainEval('globalThis.__opened')
  const url = new URL(opened)
  assert.equal(url.origin + url.pathname, 'https://github.com/BND-1/horseMD/issues/new')
  assert.equal(url.searchParams.get('template'), 'bug_report.yml')
  assert.equal(url.searchParams.get('os'), process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux')
  assert.equal(url.searchParams.get('logs'), edited, 'the edited report is what goes to GitHub')
  assert.match(url.searchParams.get('version'), /^\d+\.\d+\.\d+/)

  // 4. Esc closes; the document was not touched by any of this.
  await pressKey(send, { key: 'Escape' })
  await waitFor(`!document.querySelector('.hm-sync-report')`, 'dialog closed')
  assert.match(await evaluate(`(${editor}).textContent`), /第一段改动新段/)

  console.log('PASS sync report UI: the mismatch toast asks for the details; its prominent 查看详情 opens an editable report (version, reason, CRLF source before / editor after, input events with blocks); copy copies the box; content folded until expanded; WeChat copies the report and names the author ID (ID copyable); GitHub opens the prefilled bug form with the edited text; Esc closes')
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
