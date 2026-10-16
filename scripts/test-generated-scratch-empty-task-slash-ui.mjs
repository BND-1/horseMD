import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs50-task-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10370)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const sentinel = '\u200B'
const emptyExpected = `# RS50\n\n* [ ] ${sentinel}\n`
const filledExpected = '# RS50\n\n* [ ] 任务\n'

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function clickBlock(app, selector) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, `missing block ${selector}`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(120)
}

async function key(app, keyValue, code, keyCode, text = '') {
  const common = { key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(70)
}

async function typeAscii(app, text) {
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const isLetter = /[a-z]/.test(lower)
    const code = ch === '/' ? 'Slash' : isLetter ? `Key${lower.toUpperCase()}` : ch
    const vk = ch === '/' ? 191 : isLetter ? lower.charCodeAt(0) : ch.charCodeAt(0)
    await key(app, ch, code, vk, ch)
  }
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const state = (app) => app.evaluate(`(() => ({
  taskCount: document.querySelectorAll('.ProseMirror li.task-list-item, .ProseMirror li:has(.label-wrapper .label.unchecked), .ProseMirror li:has(.label-wrapper .label.checked)').length,
  taskText: [...document.querySelectorAll('.ProseMirror li')]
    .find((node) => node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked'))
    ?.querySelector('p')?.textContent ?? null,
  unchecked: !!document.querySelector('.ProseMirror .label-wrapper .label.unchecked'),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(-400),
    canonical: String(entry.canonical || '').slice(-400)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'rich editor did not open'
  )
  await sleep(500)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')
  let app
  try {
    app = await openApp('edit', port)
    await clickBlock(app, 'h1')
    await app.send('Input.insertText', { text: 'RS50' })
    await sleep(180)
    await clickBlock(app, 'p')
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    await typeAscii(app, '/task')
    await waitFor(
      () => app.evaluate(`(() => {
        const menu = document.querySelector('.milkdown-slash-menu[data-show="true"]')
        const item = menu?.querySelector('.hm-slash-item.hover')
        return item ? item.textContent : ''
      })()`),
      'slash task menu did not open'
    )
    const selected = await app.evaluate(`document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item.hover')?.textContent || ''`)
    assert.match(selected, /Task|任务|待办/i, `slash query did not select task item: ${selected}`)
    await key(app, 'Enter', 'Enter', 13)

    await waitFor(async () => (await state(app)).unchecked, 'slash task command did not create unchecked task')
    await sleep(700)
    const created = await state(app)
    assert.equal(created.taskText, '', `empty task exposed placeholder text: ${JSON.stringify(created)}`)
    assert.equal(created.integrity.some((entry) => entry.ok === false), false, `RS-50 integrity failure: ${JSON.stringify(created)}`)
    assert.equal(
      created.toasts.some((text) => /源码|source|不一致|保存已暂停|Save paused/i.test(text)),
      false,
      `RS-50 showed source warning: ${JSON.stringify(created.toasts)}`
    )

    assert.equal(await toggleSource(app), true, 'could not switch to source after task command')
    assert.equal(await waitFor(() => visibleSource(app), 'source textarea missing'), emptyExpected)
    assert.equal(await toggleSource(app), true, 'could not return to rich mode')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), emptyExpected, 'empty task disk source lost GFM-safe sentinel')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen-empty', port + 1)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)
    await waitFor(async () => (await state(app)).unchecked, 'cold reopen lost unchecked task semantics')
    const reopened = await state(app)
    assert.equal(reopened.taskText, '', `cold reopen exposed sentinel as text: ${JSON.stringify(reopened)}`)

    const taskPoint = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const p = [...(editor?.querySelectorAll('li p') || [])]
        .find((node) => node.closest('li')?.querySelector('.label-wrapper .label.unchecked'))
      if (!p) return null
      const rect = p.getBoundingClientRect()
      return { x: rect.left + 8, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
    })()`)
    assert.ok(taskPoint, 'could not focus reopened empty task')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...taskPoint, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...taskPoint, button: 'left', clickCount: 1 })
    await app.send('Input.insertText', { text: '任务' })
    await sleep(900)
    console.log('RS50_AFTER_REOPEN_FILL:', JSON.stringify(await state(app)))

    assert.equal(await toggleSource(app), true, 'could not inspect filled task source')
    await sleep(350)
    console.log('RS50_AFTER_FILL_SOURCE_TOGGLE:', JSON.stringify({ state: await state(app), source: await visibleSource(app) }))
    const filled = await waitFor(() => visibleSource(app), 'filled task source missing')
    assert.equal(filled, filledExpected, 'typing into reopened empty task must consume sentinel completely')
    assert.equal(filled.includes(sentinel), false, 'empty-task sentinel leaked into non-empty task source')
    assert.equal(await toggleSource(app), true, 'could not return to rich before filled save')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), filledExpected, 'filled task disk bytes retained sentinel or lost task syntax')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen-filled', port + 2)
    await waitFor(async () => (await state(app)).unchecked, 'filled task lost task semantics after second reopen')
    assert.equal((await state(app)).taskText, '任务', 'filled task text changed after second cold reopen')
    console.log('PASS RS-50 generated scratch slash task: empty sentinel, save, reopen, fill, and second reopen remain stable')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
