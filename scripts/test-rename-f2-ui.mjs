// Issue #156: F2 renames without the right-click menu.
// - Current document, file tree showing → inline rename in its tree row.
// - A clicked folder row has focus → F2 renames that folder.
// - Sidebar on another view → the rename dialog.
// Renaming (or moving) an open file or its folder in the tree also retargets
// the open tab: before, the tab kept the old path and a save recreated the
// old file.
import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rename-f2-${process.pid}`
const ws = join(root, 'ws')
const port = Number(process.env.CDP_PORT || 9580 + (process.pid % 50))
let app = null

const exists = (p) => access(p).then(() => true, () => false)
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
const rowPoint = (label) => app.evaluate(`(() => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.offsetParent && n.querySelector('.tree-label')?.textContent === ${JSON.stringify(label)})
  if (!row) return null
  const r = row.getBoundingClientRect()
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
})()`)
const clickRow = async (label) => {
  const point = await waitFor(() => rowPoint(label), `tree row ${label} not found`)
  await click(point)
  await sleep(300)
}
const expandFolder = async (label) => {
  const open = await app.evaluate(`Boolean([...document.querySelectorAll('.tree-row')].find((n) => n.offsetParent && n.querySelector('.tree-label')?.textContent === ${JSON.stringify(label)})?.querySelector('.chevron-expanded'))`)
  if (!open) await clickRow(label)
}
const f2 = () => pressKey(app.send, { key: 'F2', code: 'F2' })
const renameInput = () => app.evaluate(`(() => {
  const input = document.querySelector('.tree-rename')
  return input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input } : null
})()`)
const activeTitle = () => app.evaluate(`document.querySelector('.tab.active .tab-title, .tab.active')?.textContent.trim()`)
const typeInEditor = async (text, paragraph) => {
  const point = await app.evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    const p = [...pm.querySelectorAll('p')].find((n) => n.textContent.startsWith(${JSON.stringify(paragraph)}))
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(point)
  await sleep(150)
  await pressKey(app.send, { key: 'End' })
  await typeTextLikeUser(app.send, text)
}
const save = async () => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'tab not dirty')
  await app.evaluate(`document.querySelector('.hm-save-fab').click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

try {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(ws, 'sub'), { recursive: true })
  await writeFile(join(ws, 'a.md'), '# A\n\nalpha\n')
  await writeFile(join(ws, 'sub', 'b.md'), '# B\n\nbeta\n')
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [ws] })
  await app.send('Runtime.enable')
  await app.evaluate(`window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)) }`)

  // 1. Current document → inline rename in the tree, name preselected.
  await clickRow('a.md')
  await waitFor(() => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((n) => n.offsetParent && n.textContent.includes('alpha'))`), 'a.md did not open')
  await typeInEditor(' one', 'alpha') // focus in the editor, tab dirty
  await f2()
  const input = await waitFor(renameInput, 'F2 did not start an inline rename')
  assert.deepEqual(input, { value: 'a.md', start: 0, end: 1, focused: true })
  await typeTextLikeUser(app.send, 'renamed')
  await pressKey(app.send, { key: 'Enter' })
  await waitFor(() => exists(join(ws, 'renamed.md')), 'file was not renamed')
  assert.equal(await exists(join(ws, 'a.md')), false)
  await waitFor(async () => (await activeTitle())?.includes('renamed.md'), 'tab title did not follow the rename')
  // The unsaved edit saves into the renamed file; the old name stays gone.
  await save()
  assert.equal(await readFile(join(ws, 'renamed.md'), 'utf8'), '# A\n\nalpha one\n')
  assert.equal(await exists(join(ws, 'a.md')), false, 'save must not recreate the old file')

  // 2. A clicked folder row → F2 renames the folder; an open file inside
  //    follows it.
  await expandFolder('sub')
  await clickRow('b.md')
  await waitFor(() => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((n) => n.offsetParent && n.textContent.includes('beta'))`), 'b.md did not open')
  await clickRow('sub') // toggles it and focuses the row
  await f2()
  const folderInput = await waitFor(renameInput, 'F2 on a folder row did not start a rename')
  assert.equal(folderInput.value, 'sub')
  await pressKey(app.send, { key: 'End' })
  await typeTextLikeUser(app.send, '2')
  await pressKey(app.send, { key: 'Enter' })
  await waitFor(() => exists(join(ws, 'sub2', 'b.md')), 'folder was not renamed')
  await expandFolder('sub2')
  await clickRow('b.md')
  await typeInEditor(' two', 'beta')
  await save()
  assert.equal(await readFile(join(ws, 'sub2', 'b.md'), 'utf8'), '# B\n\nbeta two\n')
  assert.equal(await exists(join(ws, 'sub')), false, 'save must not recreate the old folder')

  // 3. Sidebar on the outline → the rename dialog.
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((n) => n.offsetParent && /大纲|Outline/i.test(n.title || n.getAttribute('aria-label') || ''))
    button?.click()
  })()`)
  await sleep(300)
  await typeInEditor('', 'beta')
  await f2()
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-rename-modal'))`), 'F2 did not open the rename dialog')
  assert.equal(await app.evaluate(`document.querySelector('.hm-rename-input').value`), 'b.md')
  await pressKey(app.send, { key: 'Escape' })
  assert.deepEqual(await app.evaluate('window.__alerts'), [])
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log('PASS rename F2: inline tree rename, folder rename, dialog fallback; open tabs follow the new path')
