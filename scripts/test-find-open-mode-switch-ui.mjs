// Air 0.13.250 trace (2026-10-20): with the find bar still open from an
// earlier search, the user edited a table cell in the middle of the document
// and switched to source — the caret and scroll jumped to the top. The mode
// switch let find own the restore, and the rebuilt search landed on its first
// match (or nowhere when nothing matched). Now find owns the switch only when
// it was the user's last navigation; a click/keystroke in the document since
// gives the switch back to the caret.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const lines = ['# 沙箱API工具调用说明', '']
for (let i = 0; i < 40; i += 1) lines.push(`第${i}段，用于撑开文档高度的普通文字，沙箱里不会用到。`, '')
lines.push('| 参数 | 必填 | 说明 |', '| --- | --- | --- |', '| `is_trailer` | 否 | 是否只看预告：1=仅还没开抢的在线有券商品，按开抢时间升序 |', '')
for (let i = 40; i < 80; i += 1) lines.push(`第${i}段，后半部分的普通文字。`, '')
const root = await mkdtemp(join(tmpdir(), 'horsemd-find-open-switch-'))
const file = join(root, 'doc.md')
await writeFile(file, lines.join('\n'))

const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: 29950 + process.pid % 40, appArgs: [file, '--horsemd-input-trace'] })
const send = app.send.bind(app)
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const clickAt = async (point) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
}
const toggleSource = async () => {
  const point = await app.evaluate(`(() => { const n = [...document.querySelectorAll('.status-btn')].find(n => /源码|Source/.test(n.title || n.textContent || '')); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await clickAt(point)
}
const sourceState = () => app.evaluate(`(() => {
  const ta = [...document.querySelectorAll('textarea.source-editor')].find(n => n.offsetParent)
  return ta && { caret: ta.selectionStart, end: ta.selectionEnd, scrollTop: ta.scrollTop, value: ta.value }
})()`)
const setFindQuery = (query) => app.evaluate(`(() => {
  const input = document.querySelector('.findbar input'); if (!input) return false
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)})
  input.dispatchEvent(new Event('input', { bubbles: true })); return true
})()`)
let failed = false
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('第79段')`), 'document did not open')
  await sleep(1000)
  // Open the find bar (Cmd/Ctrl+F is a menu accelerator, so use the same
  // renderer handler the find icon/menu reaches) and search for a word whose
  // first match is the title at the top.
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: navigator.platform.includes('Mac'), ctrlKey: !navigator.platform.includes('Mac'), bubbles: true }))`)
  if (!(await app.evaluate(`!!document.querySelector('.findbar input')`))) {
    await pressKey(send, { key: 'f', code: 'KeyF', modifiers: (await app.evaluate(`navigator.platform.includes('Mac')`)) ? 4 : 2 })
  }
  const opened = await app.evaluate(`!!document.querySelector('.findbar input')`)
  if (!opened) throw new Error('find bar did not open')
  assert.equal(await setFindQuery('沙箱'), true)
  await sleep(500)

  // 1. Edit in the table cell, then switch: the caret stays at the edit.
  const cell = await app.evaluate(`(() => { const td = [...(${editor}).querySelectorAll('td')].find(n => n.textContent.includes('是否只看预告')); td.scrollIntoView({ block: 'center' }); const r = td.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()`)
  await sleep(300)
  await clickAt(cell)
  await sleep(300)
  await typeTextLikeUser(send, 'QQQ')
  await sleep(500)
  await toggleSource()
  const edited = await waitFor(sourceState, 'source mode did not open')
  await sleep(1200)
  const after = await sourceState()
  const editAt = after.value.indexOf('QQQ')
  assert.ok(editAt > 0, 'edit missing from source')
  assert.equal(after.caret, editAt + 3, `caret moved away from the edit: caret=${after.caret} edit=${editAt} near=${JSON.stringify(after.value.slice(after.caret - 10, after.caret + 10))}`)
  assert.ok(after.scrollTop > 100, `source scrolled to the top: ${after.scrollTop}`)
  console.log('ok   find bar open: editing a table cell then switching keeps the caret at the edit')

  // 2. Back to rich, step find past the first match without touching the
  // document, switch again: find owns it and source lands on that match.
  await toggleSource()
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)`), 'rich mode did not return')
  await sleep(900)
  await setFindQuery('沙箱')
  await sleep(400)
  for (let k = 0; k < 2; k += 1) { await pressKey(send, { key: 'Enter', code: 'Enter', text: '\r' }); await sleep(300) }
  const counter = await app.evaluate(`document.querySelector('.findbar-count')?.textContent`)
  await toggleSource()
  await waitFor(sourceState, 'source mode did not open again')
  await sleep(1200)
  const found = await sourceState()
  const active = Number(String(counter).split('/')[0])
  assert.ok(active >= 2, `find did not move past the first match: ${counter}`)
  let nth = -1
  for (let k = 0; k < active; k += 1) nth = found.value.indexOf('沙箱', nth + 1)
  assert.deepEqual([found.caret, found.end], [nth, nth + 2], `find result not kept: ${found.caret}-${found.end}, want match ${counter} at ${nth}`)
  assert.equal(await app.evaluate(`document.querySelector('.findbar-count')?.textContent`), counter)
  console.log('ok   find navigation last: switching keeps the active find result')
  void edited
} catch (error) {
  failed = true
  console.log(`FAIL ${String(error?.message || error).slice(0, 1200)}`)
} finally {
  await stopBuiltElectron(app)
}
console.log(failed ? 'FAIL find-open mode switch' : 'PASS find-open mode switch: an edit after searching keeps the caret across rich→source; pure find navigation keeps the find result')
process.exit(failed ? 1 : 0)
