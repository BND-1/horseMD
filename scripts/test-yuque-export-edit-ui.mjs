// Yuque export (面试问题.md, Windows report 2026-10-22): every span is wrapped
// in `<font style=…>`, line breaks sit inside `<font>`, and nested lists are
// exported with 4 spaces after a blank line (CommonMark: indented code).
// Editing such a file raised 「检测到富文本与源码不一致」:
// - the list-slot fingerprint counted `    - x` (code) and `2. B` right after
//   it (paragraph text for micromark) as list items, and split a list at the
//   lazy `</font>…` continuation lines Crepe prints on one line;
// - typing over the `<font>` after `**<font>…</font>**` put a letter right
//   after the closing `**`, which no longer closes: Milkdown's strong handler
//   and the reprint segment printer both spelled it literally.
// Each edit here clicks the end of an item, types, presses Enter and types
// again, like a user; then saves and reopens.
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-yuque-'))
const file = join(root, '面试笔记.md')
await copyFile(new URL('./fixtures/yuque-export/start.md', import.meta.url), file)
const original = await readFile(file, 'utf8')
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label, attempts = 150) => {
  for (let i = 0; i < attempts; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const launch = (port) => launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file, '--horsemd-input-trace'] })
const warnings = (app) => app.evaluate(`[...document.querySelectorAll('.toast, [class*=toast], [role=dialog]')].map(n => n.innerText).filter((t) => /不一致|未被覆盖|mismatch|not overwritten/i.test(t))`)
const clickEndOf = async (app, text) => {
  const point = await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('p')].find((n) => n.textContent.includes(${JSON.stringify(text)}))
    p.scrollIntoView({ block: 'center' })
    const r = document.createRange(); r.selectNodeContents(p); const b = r.getBoundingClientRect()
    return { x: b.right - 2, y: b.bottom - 6 }
  })()`)
  await sleep(300)
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(250)
}

const port = 29900 + process.pid % 50
let app = await launch(port)
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('结尾段落')`), 'fixture did not open')
  await sleep(1200)
  for (const [target, typed] of [['maximumPoolSize', 'abc'], ['volatile-lru', 'def'], ['要么全部成功', 'ghi'], ['保存旧版本', 'jkl']]) {
    await clickEndOf(app, target)
    await typeTextLikeUser(app.send, typed, { delayMs: 90 })
    await pressKey(app.send, { key: 'Enter' })
    await typeTextLikeUser(app.send, `${typed}2`, { delayMs: 90 })
    await sleep(1500)
    assert.deepEqual(await warnings(app), [], `editing after "${target}" raised a mismatch warning`)
  }
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => (await readFile(file, 'utf8')) !== original, 'save did not write')
  await sleep(500)
  assert.deepEqual(await warnings(app), [], 'save raised a warning')
  const saved = await readFile(file, 'utf8')
  for (const typed of ['abc', 'def', 'ghi', 'jkl']) {
    assert.ok(saved.includes(typed) || saved.includes(`&#x${typed.charCodeAt(0).toString(16).toUpperCase()};${typed.slice(1)}`), `"${typed}" saved`)
    assert.ok(saved.includes(`${typed}2`), `"${typed}2" saved`)
  }
  // Lines away from the edits keep their authored bytes. (Inside an edited
  // list item, adjacent identical <font> spans may print as one: the editor
  // cannot tell them apart.)
  for (const line of ['    - `<font style="color:rgb(0, 0, 0);">trx_id</font>`<font style="color:rgb(0, 0, 0);">：最近一次修改的事务 ID</font>', '2. **<font style="color:rgb(0, 0, 0);">undo log</font>**', '**<font style="color:rgb(0, 0, 0);">持久性</font>**<font style="color:rgb(0, 0, 0);">  \n</font><font style="color:rgb(0, 0, 0);">提交后永久保存。</font>']) {
    assert.ok(saved.includes(line), `authored line kept: ${line}`)
  }
  await stopBuiltElectron(app)

  // Reopen: the edits read back as typed, bold is still bold.
  app = await launch(port + 1)
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('结尾段落')`), 'saved file did not reopen')
  const view = await app.evaluate(`(() => {
    const ed = ${editor}
    return { text: ed.textContent, literalBold: ed.textContent.includes('**'), bold: [...ed.querySelectorAll('strong')].map((n) => n.textContent) }
  })()`)
  for (const typed of ['abc', 'abc2', 'def', 'def2', 'ghi', 'ghi2', 'jkl', 'jkl2']) assert.ok(view.text.includes(typed), `reopened text has ${typed}`)
  assert.equal(view.literalBold, false, 'no literal ** after reopen')
  assert.ok(view.bold.some((t) => t.includes('maximumPoolSize')), 'maximumPoolSize is still bold')
  console.log('PASS Yuque export: edits next to <font> spans, indented-code lists and in-font line breaks save without a mismatch, bold kept')
} finally {
  await stopBuiltElectron(app)
}
