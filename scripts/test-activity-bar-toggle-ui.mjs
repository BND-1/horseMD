// Activity bar toggles like VS Code (user report 2026-11-23): a click on the
// view that is showing (files / outline / search) hides the sidebar, another
// click shows it again; a click on another view switches to it. An icon is
// marked active only while its view shows. No separate collapse button; the
// toggle-sidebar shortcut still works. The status bar has no language
// switch (Settings › 通用 has it).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-activity-'))
const file = join(root, 'doc.md')
await fs.writeFile(file, '# 标题\n\n正文。\n\n## 小节\n\n更多。\n')
const port = 9740 + Math.floor(Math.random() * 40)
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
const ev = (expression) => app.evaluate(expression)
const state = () => ev(`(() => {
  const pane = document.querySelector('.pane-left')
  return {
    open: Boolean(pane) && !pane.classList.contains('collapsed'),
    active: [...document.querySelectorAll('.activity-bar .activity-item.active:not(.activity-home)')].map((n) => n.title),
    items: [...document.querySelectorAll('.activity-bar .activity-item')].map((n) => n.title)
  }
})()`)
const clickItem = async (pattern) => {
  const point = await ev(`(() => {
    const b = [...document.querySelectorAll('.activity-bar .activity-item')].find((n) => ${pattern}.test(n.title))
    const r = b?.getBoundingClientRect()
    return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
  })()`)
  assert.ok(point, `activity item ${pattern}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  }
  await sleep(300)
  return state()
}

try {
  for (let i = 0; i < 80; i++) {
    if (await ev(`Boolean(document.querySelector('.activity-bar')) && Boolean([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent))`)) break
    await sleep(150)
  }
  await sleep(600)
  let s = await state()
  assert.equal(s.items.some((t) => /侧边栏|Sidebar/i.test(t)), false, `no collapse button: ${s.items}`)
  assert.equal(await ev(`[...document.querySelectorAll('.statusbar .status-btn')].some((n) => /中文|EN/.test(n.textContent) || /语言|Language/.test(n.title))`), false, 'no language switch in the status bar')

  // Outline: show → click again hides → click again shows.
  s = await clickItem('/大纲|Outline/')
  if (!s.open) s = await clickItem('/大纲|Outline/')
  assert.equal(s.open, true)
  assert.deepEqual(s.active.length, 1)
  assert.match(s.active[0], /大纲|Outline/)
  s = await clickItem('/大纲|Outline/')
  assert.equal(s.open, false, 'a click on the showing view hides the sidebar')
  assert.deepEqual(s.active, [], 'no icon is active while the sidebar is hidden')
  s = await clickItem('/大纲|Outline/')
  assert.equal(s.open, true, 'another click shows it again')
  // Another view switches (stays open); clicking it again hides.
  s = await clickItem('/文件|Files|资源/')
  assert.equal(s.open, true, 'a click on another view switches to it')
  assert.match(s.active[0] || '', /文件|Files|资源/)
  s = await clickItem('/文件|Files|资源/')
  assert.equal(s.open, false)
  s = await clickItem('/搜索|Search/')
  assert.equal(s.open, true, 'a hidden sidebar opens on any view')
  assert.match(s.active[0] || '', /搜索|Search/)
  s = await clickItem('/搜索|Search/')
  assert.equal(s.open, false)
  console.log('PASS activity bar: files / outline / search toggle the sidebar (VS Code), active only while showing, no collapse button, no language switch in the status bar')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await fs.rm(root, { recursive: true, force: true })
}
