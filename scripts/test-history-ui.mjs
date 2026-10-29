// Local version history + 最近删除 in the real app (docs/cloud-sync-review.md
// P1): a save keeps the version it replaces; 历史版本… (file-tree context
// menu) lists it, previews it, shows the changes and restores it (the file
// and the open editor go back; the restore itself is kept and can be
// undone); a file deleted from the tree is in 最近删除… (command palette) and
// comes back with 还原; Settings › Files shows the space used. History lives
// in the test profile (userData/history).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-history-ui-'))
const work = join(root, '笔记本')
await import('node:fs/promises').then((fs) => fs.mkdir(work))
const file = join(work, '笔记.md')
const other = join(work, '要删的.md')
const original = '# 标题\n\n第一版内容\n'
await writeFile(file, original)
await writeFile(other, '这篇会被删掉\n')
const profile = join(root, 'profile')
const app = await launchBuiltElectron({ profileDir: profile, port: 29200 + process.pid % 100, appArgs: [work, file, '--horsemd-input-trace'] })
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
const center = (expression) => evaluate(`(() => { const n = ${expression}; if (!n) return null; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
const click = async (expression, button = 'left') => {
  const p = await waitFor(() => center(expression), `element ${expression}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...p })
  await sleep(250)
}
const row = (path) => `document.querySelector('.tree-row[data-path=${JSON.stringify(JSON.stringify(path)).slice(1, -1)}]')`
const menuButton = (label) => `[...document.querySelectorAll('.context-menu button, .ctx-menu button, [role=menu] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`
const buttonIn = (scope, label) => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`
// HM_HISTORY_SHOT=<dir>: PNGs of the dialogs, to look at by hand.
const shot = async (name) => {
  if (!process.env.HM_HISTORY_SHOT) return
  await sleep(400)
  const image = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(process.env.HM_HISTORY_SHOT, `${name}.png`), Buffer.from(image.data ?? image.result?.data ?? '', 'base64'))
}
const openPalette = async (label) => {
  await evaluate(`[...document.querySelectorAll('button')].find(n => /command palette|命令面板/i.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
  await waitFor(() => evaluate("!!document.querySelector('.palette input')"), 'palette')
  await evaluate("document.querySelector('.palette input').focus()")
  await send('Input.insertText', { text: label })
  await sleep(250)
  const ok = await evaluate(`(() => { const item = [...document.querySelectorAll('.palette-item')].find(n => n.textContent.includes(${JSON.stringify(label)})); item?.click(); return Boolean(item) })()`)
  assert.ok(ok, `palette item ${label}`)
}

try {
  await send('Page.enable')
  await waitFor(() => evaluate(`(${editor})?.textContent.includes('第一版内容')`), 'document')
  await waitFor(() => evaluate(`Boolean(${row(file)})`), 'file tree')
  await sleep(600)

  // 1. Edit + save: the original goes to the history.
  const p = await center(`[...(${editor}).querySelectorAll('p')].find((n) => n.textContent === '第一版内容')`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: p.x + 200, y: p.y })
  await pressKey(send, { key: 'End', code: 'End' })
  await typeTextLikeUser(send, '，后来改的')
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-save-fab'))"), 'dirty')
  await evaluate("document.querySelector('.hm-save-fab').click()")
  await waitFor(async () => (await readFile(file, 'utf8')).includes('后来改的'), 'saved')

  // 2. 历史版本… from the file tree: one version, 保存前, the original text.
  await click(row(file), 'right')
  await click(menuButton('历史版本…'))
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-history-file .hm-history-row'))"), 'history dialog')
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.hm-history-file .hm-history-row .hm-history-reason')].map((n) => n.textContent)"), ['保存前'])
  await waitFor(async () => (await evaluate("document.querySelector('.hm-history-file .hm-history-text')?.textContent || ''")) === original, 'preview shows the original')
  await shot('history-preview')
  // 只看改动: the line that changed.
  await click("document.querySelector('.hm-history-switch input')")
  const diff = await waitFor(() => evaluate("document.querySelector('.hm-history-diff')?.textContent || ''"), 'diff')
  await shot('history-diff')
  assert.ok(diff.includes('第一版内容') && diff.includes('后来改的'), `diff: ${diff}`)

  // 3. Restore: file and editor go back; a toast says so.
  await click(buttonIn('.hm-history-file', '恢复此版本'))
  await waitFor(async () => (await readFile(file, 'utf8')) === original, 'file restored')
  await waitFor(() => evaluate("!document.querySelector('.hm-history-file')"), 'dialog closed')
  await waitFor(() => evaluate(`!(${editor}).textContent.includes('后来改的')`), 'editor shows the restored text')
  assert.match(await evaluate("document.body.textContent"), /已恢复/)

  // 4. The restore can be undone: the content before it is a version too.
  await click(row(file), 'right')
  await click(menuButton('历史版本…'))
  await waitFor(() => evaluate("document.querySelectorAll('.hm-history-file .hm-history-row').length === 2"), 'two versions')
  assert.equal(await evaluate("document.querySelector('.hm-history-file .hm-history-row .hm-history-reason').textContent"), '恢复前')
  await pressKey(send, { key: 'Escape', code: 'Escape' })
  await waitFor(() => evaluate("!document.querySelector('.hm-history-file')"), 'Esc closes')

  // 5. Deleted from the tree → 最近删除 → 还原.
  await click(row(other), 'right')
  await click("document.querySelector('.context-menu button.danger, button.danger')")
  await waitFor(async () => { try { await access(other); return false } catch { return true } }, 'deleted')
  await openPalette('最近删除')
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-history-row.deleted'))"), 'deleted dialog')
  assert.match(await evaluate("document.querySelector('.hm-history-row.deleted').textContent"), /要删的\.md/)
  await waitFor(async () => (await evaluate("document.querySelector('.hm-history-text')?.textContent || ''")).includes('这篇会被删掉'), 'deleted preview')
  await shot('deleted')
  await click("[...document.querySelectorAll('.hm-history button.primary')].find((b) => b.textContent.trim() === '还原')")
  await waitFor(async () => (await readFile(other, 'utf8').catch(() => '')) === '这篇会被删掉\n', 'restored to its place')
  // The list is empty now (the focused 还原 button is gone): Esc still closes.
  await waitFor(() => evaluate("Boolean(document.querySelector('.hm-history-deleted.empty'))"), 'empty after the restore')
  await pressKey(send, { key: 'Escape', code: 'Escape' })
  await waitFor(() => evaluate("!document.querySelector('.hm-history')"), 'Esc closes the emptied dialog')

  // 6. The history is in the profile; Settings › Files shows the space used.
  if (process.env.HM_HISTORY_SHOT) {
    await evaluate(`[...document.querySelectorAll('button')].find(n => /设置|Settings/.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
    await sleep(600)
    await evaluate(`[...document.querySelectorAll('button, [role=tab], a')].find(n => n.textContent.trim() === '文件与图片')?.click()`)
    await sleep(600)
    await evaluate(`[...document.querySelectorAll('h2, h3, .settings-block-title, .settings-heading')].find(n => /历史版本/.test(n.textContent))?.scrollIntoView({ block: 'start' })`)
    await shot('settings')
  }
  assert.ok((await readdir(join(profile, 'history'))).includes('objects'), 'history under userData')
  const toasts = await evaluate("[...document.querySelectorAll('.hm-toast-msg, .hm-toast')].map((n) => n.textContent).join('|')")
  assert.ok(!/不一致|暂停/.test(toasts), `no source-sync toast: ${toasts}`)
  console.log('PASS history UI: save keeps the replaced version; 历史版本 lists / previews / diffs / restores it (editor follows, restore undoable); tree deletion → 最近删除 → 还原; history in userData')
} finally {
  await stopBuiltElectron(app)
}
