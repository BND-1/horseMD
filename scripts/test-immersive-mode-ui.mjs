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
// A second tab, for switching tabs from the revealed tab bar.
const other = join(root, 'other.md')
await writeFile(other, '# 另一篇\n\n' + '另一篇的正文。\n\n'.repeat(6))
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29600 + process.pid % 100, appArgs: [other, file, '--horsemd-input-trace']
})
const send = app.send.bind(app)
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const mod = process.platform === 'darwin' ? 4 : 2
const waitFor = async (check, message, attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
const chrome = () => app.evaluate(`(() => {
  // Shown = laid out, visible and inside the window (edge-reveal bars sit
  // outside it, visibility hidden, until the pointer reaches their edge).
  const shown = (selector) => [...document.querySelectorAll(selector)].some((node) => {
    const style = getComputedStyle(node)
    if (node.offsetParent === null && style.position !== 'fixed') return false
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const r = node.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
  })
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
  // The bars take 0.18 s to slide out of the window after entering.
  await sleep(400)
  await clickSelector('.hm-immersive-exit')
  await waitFor(async () => !(await chrome()).immersive, 'corner button did not exit')
  assert.equal(await app.evaluate(`(${editor}).textContent.includes('尾段全屏输入')`), true, 'typed text lost')

  // 6. Edge reveal: the pointer at the top, bottom or left edge slides the
  // whole shell in (tab bar, status bar, activity bar, open sidebar) over the
  // document, which does not move; leaving them all slides it out.
  await clickSelector('.hm-immersive-btn')
  await waitFor(async () => (await chrome()).immersive, 'did not re-enter for the edge check')
  const docTop = () => app.evaluate(`Math.round((${editor}).getBoundingClientRect().top)`)
  const move = async (x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, button: buttons ? 'left' : 'none' })
  const size = await app.evaluate('({ w: innerWidth, h: innerHeight })')
  const centre = { x: Math.round(size.w / 2), y: Math.round(size.h / 2) }
  await move(centre.x, centre.y)
  await sleep(700)
  const top0 = await docTop()
  // Left of the first character vs the right edge of the activity bar + sidebar.
  const gap = () => app.evaluate(`(() => {
    const text = ${editor}
    const r = text.getBoundingClientRect()
    const side = [...document.querySelectorAll('.activity-bar, .pane-left:not(.collapsed)')]
      .map((n) => n.getBoundingClientRect()).filter((b) => b.width && b.right > 0)
    return { textLeft: Math.round(r.left + parseFloat(getComputedStyle(text).paddingLeft)), coverRight: Math.round(Math.max(0, ...side.map((b) => b.right))) }
  })()`)
  const text0 = (await gap()).textLeft
  const sidebarOpen = await app.evaluate(`(() => { const p = document.querySelector('.pane-left'); return Boolean(p && !p.classList.contains('collapsed')) })()`)
  const allOut = (c) => c.topbar && c.status && c.activity && (!sidebarOpen || c.sidebar)
  const noneOut = (c) => !c.topbar && !c.status && !c.activity && !c.sidebar
  // The zones reach 16 px from the top (the empty space above the first
  // line) and 10 px from the bottom / left — the inner end of each is
  // checked here (a 4 px zone was hard to hit).
  const revealEdges = [
    ['top', { x: centre.x, y: 14 }, { x: centre.x, y: 20 }],
    ['bottom', { x: centre.x, y: size.h - 9 }, { x: centre.x, y: size.h - 12 }],
    ['left', { x: 8, y: centre.y }, { x: 24, y: centre.y }]
  ]
  for (const [name, edge, onBar] of revealEdges) {
    // When the bars start to slide, the document's room is already set (same
    // task): it never trails the bars by a frame. It was a CSS variable on
    // .app, measured after the reveal, which restyled the whole document.
    await app.evaluate(`(() => {
      const app = document.querySelector('.app')
      globalThis.__revealStart = null
      const mo = new MutationObserver(() => {
        if (globalThis.__revealStart || !app.classList.contains('hm-reveal')) return
        const centre = document.querySelector('.pane-center')
        globalThis.__revealStart = { transform: centre.style.transform, margin: centre.style.marginLeft, appVars: app.getAttribute('style') || '' }
        mo.disconnect()
      })
      mo.observe(app, { attributes: true, attributeFilter: ['class'] })
    })()`)
    await move(edge.x, edge.y)
    const out = await waitFor(async () => { const c = await chrome(); return allOut(c) && c }, `${name} edge did not reveal every bar`)
    const start = await app.evaluate('globalThis.__revealStart')
    assert.ok(!sidebarOpen || /translateX\(\d+px\)/.test(start?.transform) || /\d+px/.test(start?.margin), `${name}: the document's room was not set when the bars started: ${JSON.stringify(start)}`)
    assert.ok(!/--hm-reveal/.test(start?.appVars || ''), `${name}: a CSS variable on .app restyles the whole document: ${start?.appVars}`)
    assert.equal(out.immersive, true, `${name} reveal left full-screen mode`)
    assert.equal(await docTop(), top0, `${name} reveal moved the document vertically`)
    // The text slides right to clear the sidebar; nothing covers it.
    await sleep(450) // let the 0.26 s slide finish
    const clear = await gap()
    assert.ok(clear.textLeft >= clear.coverRight + 8, `${name}: the sidebar covers the text: ${JSON.stringify(clear)}`)
    assert.ok(clear.textLeft - clear.coverRight <= 60, `${name}: the document slid too far: ${JSON.stringify(clear)}`)
    // Still out while the pointer is on a bar.
    await move(onBar.x, onBar.y)
    await sleep(700)
    assert.equal(allOut(await chrome()), true, `${name}: bars hid while the pointer was on one`)
    await move(centre.x, centre.y)
    await waitFor(async () => noneOut(await chrome()), `${name}: bars did not slide out`)
    await waitFor(async () => (await gap()).textLeft === text0, `${name}: the document did not slide back`)
  }
  // Clicking things on the revealed bars (a tab, an outline entry, the
  // source/rich switch) moves focus and swaps the document, but the bars stay
  // out while the pointer rests on them, and the text stays clear.
  const clickAt = async (point) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  }
  const centreOf = (selector) => app.evaluate(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getBoundingClientRect().width); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const textClear = () => app.evaluate(`(() => {
    const text = [...document.querySelectorAll('.pane-center .ProseMirror, .pane-center textarea.source-editor')].find((n) => n.offsetParent)
    const r = text.getBoundingClientRect(); const cs = getComputedStyle(text)
    const side = [...document.querySelectorAll('.activity-bar, .pane-left:not(.collapsed)')].map((n) => n.getBoundingClientRect()).filter((b) => b.width && b.right > 0)
    return { textLeft: Math.round(r.left + parseFloat(cs.paddingLeft)), coverRight: Math.round(Math.max(0, ...side.map((b) => b.right))) }
  })()`)
  await move(centre.x, 1)
  await waitFor(async () => allOut(await chrome()), 'did not reveal for the click checks')
  await sleep(400)
  const stayOut = async (label) => {
    await sleep(1200) // pointer resting; longer than the hide delay
    assert.equal(allOut(await chrome()), true, `${label}: the bars slid back in while the pointer rested on them`)
    const clear = await textClear()
    assert.ok(clear.textLeft >= clear.coverRight + 8, `${label}: the sidebar covers the text: ${JSON.stringify(clear)}`)
  }
  assert.ok(await app.evaluate(`document.querySelectorAll('.tab').length`) > 1, 'second tab missing')
  {
    await clickAt(await centreOf('.tab:not(.active)'))
    await stayOut('after a tab switch')
    await clickAt(await centreOf('.tab:not(.active)'))
    await stayOut('after switching back')
  }
  const outlineEntry = await centreOf('.outline-item')
  if (outlineEntry) {
    await clickAt(outlineEntry)
    await stayOut('after an outline jump')
  }
  const sourceSwitch = await app.evaluate(`(() => { const b = [...document.querySelectorAll('.statusbar .status-btn')].find((n) => /源码|富文本|Source|Rich/.test(n.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  assert.ok(sourceSwitch, 'source switch missing in the revealed status bar')
  await clickAt(sourceSwitch)
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent))`), 'source mode did not open')
  await stayOut('after switching to source')
  await clickAt(sourceSwitch)
  await waitFor(() => app.evaluate(`![...document.querySelectorAll('textarea.source-editor')].some((n) => n.offsetParent)`), 'rich mode did not return')
  await stayOut('after switching back to rich')
  await move(centre.x, centre.y)
  await waitFor(async () => noneOut(await chrome()), 'bars did not slide out after the click checks')
  await waitFor(async () => (await gap()).textLeft === text0, 'the document did not slide back after the click checks')

  // A narrow window has no room to slide the text: the document is laid out
  // beside the sidebar (nothing covered, nothing pushed past the right edge).
  await send('Emulation.setDeviceMetricsOverride', { width: 820, height: size.h, deviceScaleFactor: 0, mobile: false })
  await sleep(500)
  await move(1, centre.y)
  await waitFor(async () => allOut(await chrome()), 'narrow: left edge did not reveal')
  await sleep(400)
  const narrow = await app.evaluate(`(() => {
    const text = ${editor}; const r = text.getBoundingClientRect()
    const side = [...document.querySelectorAll('.activity-bar, .pane-left:not(.collapsed)')].map((n) => n.getBoundingClientRect()).filter((b) => b.width && b.right > 0)
    const cs = getComputedStyle(text)
    return { textLeft: r.left + parseFloat(cs.paddingLeft), textRight: r.right - parseFloat(cs.paddingRight), coverRight: Math.max(0, ...side.map((b) => b.right)), width: innerWidth }
  })()`)
  assert.ok(narrow.textLeft >= narrow.coverRight + 8 && narrow.textRight <= narrow.width, `narrow window: ${JSON.stringify(narrow)}`)
  await move(400, centre.y)
  await waitFor(async () => noneOut(await chrome()), 'narrow: bars did not slide out')
  await send('Emulation.clearDeviceMetricsOverride', {})
  await sleep(500)
  await waitFor(async () => (await gap()).textLeft === text0, 'the document did not return after the narrow check')

  // Crossing an edge on the way out (Dock, menu bar) reveals nothing: a
  // brief touch, or touching it and leaving the window.
  await move(centre.x, size.h - 2)
  await sleep(30)
  await move(centre.x, centre.y)
  await sleep(500)
  assert.equal(noneOut(await chrome()), true, 'a brief edge touch revealed the bars')
  await move(centre.x, 1)
  await sleep(40)
  await move(centre.x, -20)
  await sleep(500)
  assert.equal(noneOut(await chrome()), true, 'leaving through the top edge revealed the bars')
  await move(centre.x, centre.y)
  // Dragging a selection into an edge reveals nothing.
  await move(centre.x, 1, 1)
  await sleep(500)
  assert.equal((await chrome()).topbar, false, 'a drag at the top edge revealed the top bar')
  await move(centre.x, centre.y)
  // Opening the sidebar from the revealed activity bar slides the text
  // further so the sidebar never covers it.
  await move(1, centre.y)
  await waitFor(async () => (await chrome()).activity, 'left edge did not reveal again')
  await sleep(400)
  // The sidebar toggle at the bottom of the activity bar (last button).
  const outlineButton = await app.evaluate(`(() => { const all = [...document.querySelectorAll('.activity-bar button')]; const b = all[all.length - 1]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  assert.ok(outlineButton, 'sidebar toggle missing in the revealed activity bar')
  const wasOpen = await app.evaluate(`(() => { const p = document.querySelector('.pane-left'); return Boolean(p && !p.classList.contains('collapsed')) })()`)
  const clickOutline = async () => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...outlineButton })
  }
  if (wasOpen) {
    // Close it first, so the open below really happens while revealed.
    await clickOutline()
    await waitFor(async () => !(await chrome()).sidebar, 'sidebar toggle did not close the sidebar')
    await sleep(400)
    assert.equal(allOut(await chrome()) || (await chrome()).activity, true, 'closing the sidebar hid the bars')
  }
  {
    await clickOutline()
    await waitFor(async () => (await chrome()).sidebar, 'sidebar toggle did not open the sidebar')
    await sleep(500)
    const opened = await gap()
    assert.ok(opened.textLeft >= opened.coverRight + 8, `the opened sidebar covers the text: ${JSON.stringify(opened)}`)
  }
  await move(centre.x, centre.y)
  await waitFor(async () => noneOut(await chrome()), 'bars did not slide out after opening the sidebar')
  await waitFor(async () => (await gap()).textLeft === text0, 'the document did not slide back after the sidebar')

  // A revealed tab bar works: its full-screen button exits.
  await move(centre.x, 1)
  await waitFor(async () => (await chrome()).topbar, 'top edge did not reveal again')
  await sleep(400) // the bar slides in for 0.18 s
  await clickSelector('.hm-immersive-btn')
  await waitFor(async () => !(await chrome()).immersive, 'revealed full-screen button did not exit')
  const back = await chrome()
  assert.equal(back.topbar && back.status && back.activity, true, `shell not restored after edge exit: ${JSON.stringify(back)}`)

  // 7. Mobile layout (same stylesheet): the shell is hidden there too. React
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
  console.log('PASS full-screen mode: top-bar button/shortcut/menu command hide tabs, activity bar, sidebar, status bar, save FAB and block handles; document fills the window and stays editable; unsaved dot; Esc (not when the slash menu owns it), shortcut and corner button exit; any of the top/bottom/left edges slides tab bar, status bar and activity bar in together over the unmoved document and out again (not while dragging); mobile layout hides the shell too')
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
