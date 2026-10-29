// Real Electron regression for auto-save (#136): default off, enabled from
// Settings › 通用 › 保存与恢复, inactivity debounce in rich and source mode, and the
// external-change conflict guard (never overwrite a file changed on disk;
// an explicit save merges, or — when both changed the same lines — keeps the
// disk version and saves the editor text as a conflict copy, see
// test:save-external-merge-ui). Input is dispatched one character at a time.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-autosave-ui-${process.pid}`
const file = join(root, 'autosave.md')
const profile = join(root, 'profile')
const port = Number(process.env.CDP_PORT || 9760 + (process.pid % 60))
const original = '# Auto save\n\nFirst line\n'
let app = null

const disk = () => readFile(file, 'utf8')
const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const click = async (point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
// The active tab's unsaved dot. (The floating Save button is hidden while
// auto-save will write the tab — it shows only when auto-save is off or
// paused; position:fixed, so test presence, not offsetParent.)
const dirty = () => app.evaluate(`Boolean(document.querySelector('.tab.active .tab-close.dirty'))`)
const fab = () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)
const toastText = () => app.evaluate(`[...document.querySelectorAll('.hm-toast-msg')].map((node) => node.textContent).join(' | ')`)
// Cmd/Ctrl+S is a native menu accelerator (CDP key events never reach the
// menu): run the same 'save' handler through the command palette.
const ctrlS = () => runCommand('保存')
const runCommand = async (title) => {
  assert.ok(await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(n => /command palette|命令面板/i.test(n.title || n.getAttribute('aria-label') || '')); b?.click(); return Boolean(b) })()`), 'palette button not found')
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.palette input'))`), 'palette did not open')
  await app.evaluate(`document.querySelector('.palette input').focus()`)
  await app.send('Input.insertText', { text: title })
  await sleep(200)
  assert.ok(await app.evaluate(`(() => { const item = [...document.querySelectorAll('.palette-item')].find(n => n.querySelector('.pi-title')?.textContent.trim() === ${JSON.stringify(title)}); item?.click(); return Boolean(item) })()`), `palette item ${title} not found`)
}
const placeCaretAtParagraphEnd = async (text) => {
  const point = await app.evaluate(`((text) => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const p = [...(pm?.querySelectorAll('p') || [])].find((node) => node.textContent.startsWith(text))
    const rect = p?.getBoundingClientRect()
    return rect ? { x: Math.round(rect.left + 10), y: Math.round(rect.top + rect.height / 2) } : null
  })(${JSON.stringify(text)})`)
  assert.ok(point, `paragraph "${text}" not found`)
  await click(point)
  await sleep(150)
  await pressKey(app.send, { key: 'End' })
}
const toggleSource = () => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const clickByText = (selector, pattern) => app.evaluate(`(() => {
  const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((item) => item.offsetParent && ${pattern}.test(item.textContent.replace(/\\s+/g, ' ').trim()))
  node?.click()
  return Boolean(node)
})()`)

try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, original, 'utf8')
  app = await launchBuiltElectron({ profileDir: profile, port, appArgs: [file] })
  await app.send('Runtime.enable')
  // Watcher conflict notices use window.alert, which would block CDP.
  await app.evaluate(`window.__alerts = []; window.alert = (message) => { window.__alerts.push(String(message)) }`)
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent && node.textContent.includes('First line'))`),
    'fixture did not open in the rich editor'
  )

  // 1. Default is OFF: an edit stays dirty and the disk is untouched.
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' one')
  await sleep(4500)
  assert.equal(await disk(), original, 'auto-save must be off by default')
  assert.equal(await dirty(), true, 'edited tab must be dirty while auto-save is off')
  assert.equal(await fab(), true, 'save button must show while auto-save is off')

  // 2. Enable 3 s from Settings › Files through the real UI.
  assert.ok(await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.offsetParent && /settings|设置/i.test(node.title || node.getAttribute('aria-label') || ''))
    button?.click()
    return Boolean(button)
  })()`), 'settings button not found')
  await sleep(300)
  // Settings › 通用 › 保存与恢复 (moved out of 文件与图片).
  assert.ok(await clickByText('.settings-nav-item', '/^(General|通用)$/'), 'general settings section not found')
  assert.ok(await app.evaluate(`Boolean([...document.querySelectorAll('.settings-block-title')].find((n) => /保存与恢复|Save & recover/.test(n.textContent)))`), '保存与恢复 block missing in 通用')
  await sleep(200)
  assert.ok(await clickByText('.settings-segmented-option', '/^(3s|3 秒)$/'), 'auto-save 3s option not found')
  await sleep(200)
  assert.equal(await app.evaluate(`JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').autoSaveDelay`), 3)
  assert.ok(await clickByText('.tab', '/autosave\\.md/'), 'document tab not found')
  // Leaving the settings tab does not blur the window; the pending edit is
  // written once the 3 s inactivity timer fires.
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one\n', 'pending edit was not auto-saved after enabling', 60)
  await waitFor(async () => !(await dirty()), 'tab stayed dirty after auto-save')

  // 3. Debounce: continuous typing is not written mid-burst; idle writes it.
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' two', { delayMs: 400 })
  const midBurst = await disk()
  assert.equal(midBurst, '# Auto save\n\nFirst line one\n', 'auto-save fired before the inactivity delay elapsed')
  assert.equal(await dirty(), true, 'mid-burst tab must be dirty')
  assert.equal(await fab(), false, 'save button must stay hidden while auto-save will write the tab')
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one two\n', 'rich edit was not auto-saved after idling', 60)
  await waitFor(async () => !(await dirty()), 'tab stayed dirty after the second auto-save')

  // 4. Source mode: textarea edits are auto-saved byte-exactly.
  assert.ok(await toggleSource(), 'source toggle not found')
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`), 'source mode did not open')
  await app.evaluate(`(() => {
    const area = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  })()`)
  await typeTextLikeUser(app.send, 'Source tail')
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one two\nSource tail', 'source edit was not auto-saved', 80)
  assert.ok(await toggleSource(), 'rich toggle not found')
  await waitFor(() => app.evaluate(`![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`), 'rich mode did not return')
  await sleep(500)

  // 5. External change: auto-save must NOT overwrite the other app's version.
  // ("Source tail" is a soft-wrapped continuation of the same paragraph, so
  // End lands after it.)
  const external = '# Changed elsewhere\n\nExternal body\n'
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' three')
  await writeFile(file, external, 'utf8')
  await sleep(5000)
  assert.equal(await disk(), external, 'auto-save overwrote a file changed in another application')
  assert.equal(await dirty(), true, 'conflicted tab must stay dirty')
  assert.equal(await fab(), true, 'save button must come back when auto-save is paused')
  const toast = await app.evaluate(`document.body.textContent`)
  assert.ok(/自动保存已暂停|Auto save paused/.test(toast), 'conflict notice was not shown')
  // Further typing stays paused (no retry overwrite).
  await typeTextLikeUser(app.send, '!')
  await sleep(4000)
  assert.equal(await disk(), external, 'auto-save retried and overwrote the external version')

  // 6. An explicit save never overwrites the other version either: both
  // sides changed the same lines, so the file keeps it and the editor's text
  // goes to a conflict copy the tab moves to; auto-save resumes there.
  assert.ok(await app.evaluate(`(() => { const fab = document.querySelector('.hm-save-fab'); fab?.click(); return Boolean(fab) })()`), 'save button not shown for conflicted tab')
  const copyName = await waitFor(async () => (await readdir(root)).find((name) => /^autosave \(冲突副本 .+\)\.md$/.test(name)), 'explicit save did not write a conflict copy')
  const copyDisk = () => readFile(join(root, copyName), 'utf8')
  assert.equal(await disk(), external, 'explicit save overwrote the other version')
  // Where End lands in the soft-wrapped paragraph differs by platform, so
  // the typed words are checked, not their order.
  const copied = await copyDisk()
  for (const piece of ['# Auto save', 'First line one two', 'Source tail', 'three!']) assert.ok(copied.includes(piece), `conflict copy misses ${piece}: ${JSON.stringify(copied)}`)
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' four')
  await waitFor(async () => (await copyDisk()).includes('four'), 'auto-save did not resume on the conflict copy', 80)
  assert.equal(await disk(), external)
  await waitFor(async () => !(await fab()), 'save button stayed after auto-save resumed')

  // 7. Cmd/Ctrl+S under auto-save still saves at once, keeps the content as
  // a 手动保存 history version, and says twice that it is not needed.
  const copyPath = join(root, copyName)
  await app.evaluate(`localStorage.removeItem('horsemd.autosaveHint.v1')`)
  const manualVersions = () => app.evaluate(`window.api.historyList(${JSON.stringify(copyPath)}).then((res) => (res?.versions || []).filter((v) => v.reason === 'manual').length)`)
  const before = await manualVersions()
  await typeTextLikeUser(app.send, ' five')
  await ctrlS()
  await waitFor(async () => (await copyDisk()).includes('five'), 'Ctrl+S did not save at once', 20)
  await waitFor(async () => /不用再手动保存|no need to save by hand/.test(await toastText()), 'first Ctrl+S did not hint')
  await waitFor(async () => (await manualVersions()) === before + 1, 'Ctrl+S did not keep a 手动保存 version')
  await sleep(3800)
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' six')
  await ctrlS()
  await waitFor(async () => /不用再手动保存|no need to save by hand/.test(await toastText()), 'second Ctrl+S did not hint')
  await sleep(3800)
  await ctrlS()
  await waitFor(async () => /已保存 ✓|Saved ✓/.test(await toastText()), 'third Ctrl+S did not confirm the save')
  assert.ok(!/不用再手动保存|no need to save by hand/.test(await toastText()), 'hinted a third time')
  // Same content as the last manual version: no duplicate.
  await sleep(500)
  assert.equal(await manualVersions(), before + 2, 'unchanged Ctrl+S added a duplicate version')

  // 8. An untitled tab cannot be auto-saved: its Save button shows.
  await runCommand('新建文件')
  await waitFor(() => app.evaluate(`/未命名|Untitled/.test(document.querySelector('.tab.active')?.textContent || '')`), 'new untitled tab did not open')
  await sleep(600)
  await app.evaluate(`[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.focus()`)
  await typeTextLikeUser(app.send, 'draft')
  await waitFor(() => fab(), 'save button not shown for an untitled tab under auto-save')

  console.log('PASS auto-save: default off, settings enable, rich/source debounce, external-change guard, explicit save keeps both (conflict copy), auto-save resumes on the copy; Save button only when auto-save is off / paused / untitled; Ctrl+S keeps a 手动保存 version and hints twice')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: false })
  await rm(root, { recursive: true, force: true })
}
