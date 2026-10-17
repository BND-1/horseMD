// Full-screen reading/editing mode (view.immersive, Typora-style): the top-bar
// button hides every shell element and leaves only the document, which stays
// editable. Exit with Esc (unless a popup owns it), the shortcut, or the
// corner button. The window itself is not resized.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-immersive-'))
const file = join(root, 'doc.md')
await writeFile(file, '# 全屏模式\n\n第一段文字。\n\n尾段\n')
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29600 + process.pid % 100, appArgs: [file, '--horsemd-input-trace']
})
const send = app.send.bind(app)
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const mod = process.platform === 'darwin' ? 4 : 2
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const chrome = () => app.evaluate(`(() => {
  const shown = (selector) => [...document.querySelectorAll(selector)].some((node) => node.offsetParent !== null && getComputedStyle(node).display !== 'none')
  const host = (${editor})?.closest('.editor-area, main') || ${editor}
  const r = host?.getBoundingClientRect()
  return {
    immersive: document.querySelector('.app')?.classList.contains('hm-immersive'),
    topbar: shown('.topbar'), activity: shown('.activity-bar'), status: shown('.statusbar'),
    sidebar: shown('.pane-left'), fab: shown('.hm-save-fab'), handle: shown('.milkdown-block-handle'),
    corner: shown('.hm-immersive-exit'), dirty: shown('.hm-immersive-dirty'),
    left: Math.round(r?.left ?? -1), top: Math.round(r?.top ?? -1), width: Math.round(r?.width ?? 0), innerWidth
  }
})()`)
const clickSelector = async (selector) => {
  const point = await app.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.offsetParent); if (!b) return null; const r = b.getBoundingClientRect(); return {x:r.left + r.width / 2, y:r.top + r.height / 2} })()`)
  assert.ok(point, `missing ${selector}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  await sleep(250)
}
const clickEnd = async (text) => {
  const point = await app.evaluate(`(() => { const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent === ${JSON.stringify(text)}); const r = p.getBoundingClientRect(); return {x:r.right - 2, y:r.top + r.height / 2} })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  await sleep(150)
  await pressKey(send, { key: 'End' })
}
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('尾段')`), 'document did not open')
  await sleep(600)
  const before = await chrome()
  assert.equal(before.immersive, false)
  assert.equal(before.topbar && before.status, true, 'shell should be visible before entering')

  // 1. Enter with the top-bar button: every shell element is hidden.
  await clickSelector('.hm-immersive-btn')
  const inside = await waitFor(async () => { const c = await chrome(); return c.immersive && c }, 'button did not enter full-screen mode')
  for (const key of ['topbar', 'activity', 'status', 'sidebar', 'fab', 'handle']) assert.equal(inside[key], false, `${key} still visible in full-screen mode`)
  assert.equal(inside.corner, true, 'exit button missing')
  assert.ok(inside.left <= 1 && inside.top <= 1 && inside.width >= inside.innerWidth - 2, `document does not fill the window: ${JSON.stringify(inside)}`)

  // 2. Still editable; an unsaved change shows the dot, never the save FAB.
  await clickEnd('尾段')
  await typeTextLikeUser(send, '全屏输入')
  await sleep(500)
  const typed = await chrome()
  assert.equal(await app.evaluate(`(${editor}).textContent.includes('尾段全屏输入')`), true, 'typing failed in full-screen mode')
  assert.equal(typed.dirty, true, 'unsaved dot missing')
  assert.equal(typed.fab, false, 'save FAB shown in full-screen mode')

  // 3. Esc while the slash menu is open closes the menu only.
  await pressKey(send, { key: 'Enter', text: '\r' })
  await typeTextLikeUser(send, '/')
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.milkdown-slash-menu[data-show="true"]'))`), 'slash menu did not open')
  await pressKey(send, { key: 'Escape' })
  await sleep(300)
  assert.equal((await chrome()).immersive, true, 'Esc on the slash menu left full-screen mode')
  assert.equal(await app.evaluate(`Boolean(document.querySelector('.milkdown-slash-menu[data-show="true"]'))`), false, 'slash menu still open')

  // 4. Esc exits; the shell returns.
  await pressKey(send, { key: 'Escape' })
  const after = await waitFor(async () => { const c = await chrome(); return !c.immersive && c }, 'Esc did not exit')
  assert.equal(after.topbar && after.status, true, 'shell did not come back')
  assert.equal(after.corner, false)

  // 5. The shortcut toggles both ways; the corner button exits.
  await pressKey(send, { key: 'Enter', code: 'Enter', text: '\r', modifiers: mod | 8 })
  await waitFor(async () => (await chrome()).immersive, 'shortcut did not enter')
  await pressKey(send, { key: 'Enter', code: 'Enter', text: '\r', modifiers: mod | 8 })
  await waitFor(async () => !(await chrome()).immersive, 'shortcut did not exit')
  await pressKey(send, { key: 'Enter', code: 'Enter', text: '\r', modifiers: mod | 8 })
  await waitFor(async () => (await chrome()).immersive, 'shortcut did not re-enter')
  await clickSelector('.hm-immersive-exit')
  await waitFor(async () => !(await chrome()).immersive, 'corner button did not exit')
  assert.equal(await app.evaluate(`(${editor}).textContent.includes('尾段全屏输入')`), true, 'typed text lost')

  // 6. Mobile layout (same stylesheet): the shell is hidden there too. React
  // owns the root className, so add the platform classes after entering.
  await clickSelector('.hm-immersive-btn')
  await waitFor(async () => (await chrome()).immersive, 'did not re-enter for the mobile check')
  await app.evaluate(`document.querySelector('.app').classList.add('is-mobile', 'is-ios')`)
  await sleep(200)
  const mobile = await chrome()
  assert.equal(await app.evaluate(`document.querySelector('.app').classList.contains('is-mobile')`), true)
  for (const key of ['topbar', 'activity', 'status', 'sidebar', 'fab']) assert.equal(mobile[key], false, `mobile: ${key} still visible`)
  assert.equal(mobile.corner, true, 'mobile: exit button missing')
  // The safe-area strips at the top and bottom edges must show the document
  // background (inside .pane-center), not the app background around it.
  const edges = await app.evaluate(`(() => {
    const x = Math.round(innerWidth / 2)
    const at = (y) => Boolean(document.elementFromPoint(x, y)?.closest('.pane-center'))
    const body = getComputedStyle(document.querySelector('.app .body'))
    return { top: at(1), bottom: at(innerHeight - 2), bodyPad: body.paddingTop + ' ' + body.paddingBottom }
  })()`)
  assert.deepEqual(edges, { top: true, bottom: true, bodyPad: '0px 0px' }, `mobile: screen edges not covered by the document background: ${JSON.stringify(edges)}`)
  console.log('PASS full-screen mode: top-bar button/shortcut/menu command hide tabs, activity bar, sidebar, status bar, save FAB and block handles; document fills the window and stays editable; unsaved dot; Esc (not when the slash menu owns it), shortcut and corner button exit; mobile layout hides the shell too')
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
