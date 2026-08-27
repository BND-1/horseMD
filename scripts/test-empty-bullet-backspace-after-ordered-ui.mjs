import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs54-empty-bullet-after-ordered-${process.pid}`
const file = join(root, 'rs-54.md')
const port = Number(process.env.CDP_PORT || 10392)
const initial = '# 你好\n\n1. 测试\n2. 哪里呢\n\n- \n'
const expected = '# 你好\n\n1. 测试\n2. 哪里呢'
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'editor did not mount'
  )
  await sleep(500)
  return app
}

const state = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const ordered = [...(editor?.querySelectorAll('ol') || [])]
  const bullets = [...(editor?.querySelectorAll('ul') || [])]
  const topParagraphs = [...(editor?.querySelectorAll('p') || [])].filter((node) => !node.closest('li'))
  return {
    orderedItems: ordered[0]?.querySelectorAll('li').length || 0,
    bulletLists: bullets.length,
    bulletItems: bullets[0]?.querySelectorAll('li').length || 0,
    emptyTopParagraphs: topParagraphs.filter((node) => !(node.textContent || '').trim()).length,
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-10).map(({ parsed, expected, ...entry }) => entry)
  }
})()`)

async function clickEmptyBullet(app) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const ul = editor?.querySelector('ul')
    const p = [...(ul?.querySelectorAll('p') || [])]
      .find((node) => !(node.textContent || '').trim())
    if (!p) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, 'could not find empty bullet paragraph')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(180)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')

  app = await openApp('edit', port)
  await app.evaluate(`(() => {
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmPreserveLog = []
  })()`)

  const before = await state(app)
  assert.equal(before.orderedItems, 2, `fixture did not open as two ordered items: ${JSON.stringify(before)}`)
  assert.equal(before.bulletItems, 1, `fixture did not open as one empty bullet: ${JSON.stringify(before)}`)

  await clickEmptyBullet(app)
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
  await sleep(1000)

  const after = await state(app)
  console.log('RS54_AFTER_BACKSPACE:', JSON.stringify(after))
  assert.equal(after.orderedItems, 2, 'Backspace converted empty bullet into a third ordered item')
  assert.equal(after.bulletLists, 0, 'Backspace did not remove/exit isolated empty bullet list')
  assert.ok(after.emptyTopParagraphs >= 1, 'Backspace did not leave/reuse a plain paragraph after ordered list')
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, `RS-54 integrity failed: ${JSON.stringify(after.integrity)}`)
  assert.equal(after.toasts.some((text) => warningPattern.test(text)), false, `RS-54 showed warning: ${JSON.stringify(after.toasts)}`)

  assert.equal(await toggleSource(app), true, 'could not switch to source after Backspace')
  const source = await waitFor(() => visibleSource(app), 'source textarea missing')
  assert.equal(source, expected, `RS-54 source mismatch after Backspace: ${JSON.stringify(source)}`)
  assert.equal(source.includes('\n3.'), false, 'source gained third ordered item')
  assert.equal(source.includes('\n- '), false, 'source retained deleted bullet marker')
  assert.equal(await toggleSource(app), true, 'could not return to rich mode')

  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-54 disk source mismatch')

  await stopBuiltElectron(app, { removeProfile: true })
  app = await openApp('reopen', port + 1)
  const reopened = await state(app)
  assert.equal(reopened.orderedItems, 2, 'cold reopen changed ordered item count')
  assert.equal(reopened.bulletLists, 0, 'cold reopen resurrected bullet list')
  assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen changed source bytes')
  console.log('PASS RS-54 empty bullet after ordered Backspace: no cross-type merge, source/save/reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
