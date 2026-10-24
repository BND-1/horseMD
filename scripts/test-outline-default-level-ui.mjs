// Issue #122 in the real app: the outline's default expansion level is a
// setting (default 2 tiers), the head button expands everything in ONE click
// from the default partly-folded state, Mod+Alt+[ / ] collapse / expand all
// (with the caret in the editor), and folds are remembered per document
// across tab switches.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-outline-level-${process.pid}`
const port = Number(process.env.CDP_PORT || 9530 + (process.pid % 40))
const docA = join(root, 'a.md')
const docB = join(root, 'b.md')
let app = null
const mod = process.platform === 'darwin' ? 4 : 2 // Meta : Ctrl
const ALT = 1

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleItems = () => app.evaluate(`[...document.querySelectorAll('.outline-item')].map((n) => n.querySelector('.outline-item-text').textContent).join('|')`)
const activateTab = async (name) => {
  await app.evaluate(`[...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes(${JSON.stringify(name)}))?.click()`)
  await sleep(400)
}
const focusEditor = async () => {
  const point = await app.evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    const p = pm.querySelector('p')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2) }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  }
  await sleep(200)
}
const bracket = (side) => pressKey(app.send, {
  key: side === 'left' ? '[' : ']',
  code: side === 'left' ? 'BracketLeft' : 'BracketRight',
  modifiers: mod | ALT
})

try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(docA, '# A1\n\nbody\n\n## A2\n\n### A3\n\n#### A4\n\n## A2b\n\n### A3b\n')
  await writeFile(docB, '# B1\n\nbody\n\n## B2\n\n### B3\n')
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [docA, docB] })
  await app.send('Runtime.enable')
  await activateTab('a.md')
  await waitFor(() => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((n) => n.offsetParent && n.textContent.includes('A4'))`), 'a.md did not open')
  await app.evaluate(`[...document.querySelectorAll('button')].find((n) => n.offsetParent && /大纲|Outline/i.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
  await waitFor(() => app.evaluate(`document.querySelectorAll('.outline-item').length > 0`), 'outline did not show')

  // 1. Default: two tiers.
  assert.equal(await visibleItems(), 'A1|A2|A2b')
  // 2. One click on the head button expands everything.
  await app.evaluate(`document.querySelector('.outline-head-btn').click()`)
  await sleep(200)
  assert.equal(await visibleItems(), 'A1|A2|A3|A4|A2b|A3b', 'one click expands all')
  // 3. Shortcuts with the caret in the editor.
  await focusEditor()
  await bracket('left')
  await sleep(200)
  assert.equal(await visibleItems(), 'A1', 'Mod+Alt+[ collapses all')
  assert.equal(await app.evaluate(`document.activeElement?.closest('.ProseMirror') != null`), true, 'focus stays in the editor')
  // 4. Per-document memory: B uses the default, A keeps its folds.
  await activateTab('b.md')
  await waitFor(async () => (await visibleItems()).startsWith('B1'), 'outline did not follow b.md')
  assert.equal(await visibleItems(), 'B1|B2')
  await activateTab('a.md')
  await waitFor(async () => (await visibleItems()).startsWith('A1'), 'outline did not follow a.md')
  assert.equal(await visibleItems(), 'A1', 'a.md keeps its collapsed state')
  await focusEditor()
  await bracket('right')
  await sleep(200)
  assert.equal(await visibleItems(), 'A1|A2|A3|A4|A2b|A3b', 'Mod+Alt+] expands all')
  // A single twisty toggle still works.
  await app.evaluate(`[...document.querySelectorAll('.outline-item')].find((n) => n.textContent.includes('A2'))?.querySelector('.outline-twisty')?.click()`)
  await sleep(200)
  assert.equal(await visibleItems(), 'A1|A2|A2b|A3b')

  // 5. Setting → 1 tier ("1 级"): applies to every document.
  await app.evaluate(`document.querySelector('.activity-item[title="设置"], .activity-item[title="Settings"]')?.click()`)
  await sleep(400)
  await app.evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((n) => /^(Editor|编辑器)$/.test(n.textContent.trim()))?.click()`)
  await sleep(300)
  const clicked = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((n) => /大纲默认展开|Outline default/i.test(n.textContent))
    const button = [...(row?.querySelectorAll('.settings-segmented-option') || [])].find((n) => /^(1 级|1 level|Level 1|1)$/i.test(n.textContent.trim()))
    button?.click()
    return row ? [...row.querySelectorAll('.settings-segmented-option')].map((n) => n.textContent.trim()) : null
  })()`)
  console.log('options', clicked)
  assert.ok(clicked && clicked.length === 5, 'setting row with 5 options')
  await activateTab('a.md')
  // The settings page closes the sidebar (App.jsx); open the outline again.
  await app.evaluate(`document.querySelector('.activity-item[title="大纲"], .activity-item[title="Outline"]')?.click()`)
  await waitFor(async () => (await visibleItems()).startsWith('A1'), 'outline did not come back')
  assert.equal(await visibleItems(), 'A1', '1 tier')
  await activateTab('b.md')
  await waitFor(async () => (await visibleItems()).startsWith('B1'), 'outline did not follow b.md')
  assert.equal(await visibleItems(), 'B1')
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log('PASS outline default level UI: setting, one-click expand all, Mod+Alt+[ / ], per-document folds')
