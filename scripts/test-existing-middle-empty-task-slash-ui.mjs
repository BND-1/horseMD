import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs66-middle-task-${process.pid}`
const file = join(root, 'rs-66.md')
const port = Number(process.env.CDP_PORT || 10766)
const sentinel = '\u200B'
const fixture = '# RS66\n\n- 额发疯\n- 企鹅分\n\n占位\n\n1\n'
const emptyExpected = `# RS66\n\n- 额发疯\n- 企鹅分\n\n- [ ] ${sentinel}\n\n1\n`
const filledExpected = '# RS66\n\n- 额发疯\n- 企鹅分\n\n- [ ] 任务\n\n1\n'
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 140) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function key(app, keyValue, code, keyCode, text = '') {
  const common = {
    key: keyValue,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'char',
      ...common,
      text,
      unmodifiedText: text
    })
  }
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(90)
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

const state = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const task = [...(editor?.querySelectorAll('li') || [])]
    .find((node) => node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked'))
  return {
    taskCount: [...(editor?.querySelectorAll('li') || [])]
      .filter((node) => node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked')).length,
    taskText: task?.querySelector('p')?.textContent ?? null,
    unchecked: !!task?.querySelector('.label-wrapper .label.unchecked'),
    editorText: editor?.textContent || '',
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(0, 620),
      canonical: String(entry.canonical || '').slice(0, 620)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      source: String(source || '').slice(0, 620),
      previous: String(previous || '').slice(0, 620),
      next: String(next || '').slice(0, 620),
      markdown: String(markdown || '').slice(0, 620)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) =>
      node.offsetParent && (node.textContent || '').includes('额发疯') && (node.textContent || '').includes('1')))`),
    'RS-66 fixture did not mount'
  )
  await sleep(500)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

async function replacePlaceholderWithSlash(app) {
  const selected = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])].find((node) => node.textContent === '占位')
    if (!editor || !paragraph) return false
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(selected, true, 'could not select RS-66 placeholder paragraph')
  await key(app, '/', 'Slash', 191, '/')
  await waitFor(
    () => app.evaluate(`(() => {
      const menu = document.querySelector('.milkdown-slash-menu[data-show="true"]')
      return !!menu && [...menu.querySelectorAll('.hm-slash-item')].some((node) => /Task|任务|待办/i.test(node.textContent || ''))
    })()`),
    'RS-66 slash menu did not expose task item'
  )
}

async function chooseTaskByPointer(app) {
  const result = await app.evaluate(`(() => {
    const menu = document.querySelector('.milkdown-slash-menu[data-show="true"]')
    const item = [...(menu?.querySelectorAll('.hm-slash-item') || [])]
      .find((node) => /Task|任务|待办/i.test(node.textContent || ''))
    if (!item) return ''
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
    return item.textContent || ''
  })()`)
  assert.match(result, /Task|任务|待办/i, `could not pointer-select task item: ${result}`)
}

async function focusEmptyTask(app) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const p = [...(editor?.querySelectorAll('li p') || [])]
      .find((node) => node.closest('li')?.querySelector('.label-wrapper .label.unchecked'))
    if (!p) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, 'could not focus RS-66 reopened empty task')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(150)
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)

  await replacePlaceholderWithSlash(app)
  await sleep(450)
  assert.equal(await readFile(file, 'utf8'), fixture, 'typing slash should not autosave fixture before explicit save')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)
  await chooseTaskByPointer(app)
  await waitFor(async () => (await state(app)).unchecked, 'RS-66 slash command did not create unchecked task')
  await sleep(850)

  const created = await state(app)
  console.log('RS66_AFTER_CREATE:', JSON.stringify(created))
  assert.equal(created.taskCount, 1, `RS-66 created unexpected task count: ${JSON.stringify(created)}`)
  assert.equal(created.taskText, '', `RS-66 empty task exposed sentinel text: ${JSON.stringify(created)}`)
  assert.match(created.editorText, /额发疯/, 'RS-66 changed preceding authored bullet content')
  assert.match(created.editorText, /企鹅分/, 'RS-66 changed preceding authored bullet content')
  assert.match(created.editorText, /1/, 'RS-66 changed following paragraph')
  assert.equal(created.integrity.some((entry) => entry.ok === false), false, `RS-66 create failed integrity: ${JSON.stringify(created.integrity)}`)
  assert.equal(created.toasts.some((text) => warningPattern.test(text)), false, `RS-66 create showed warning: ${JSON.stringify(created.toasts)}`)
  assert.equal(
    created.integrity.some((entry) =>
      entry.preservationReason === 'empty-task-slash-created' &&
      entry.ok === true && entry.semanticOk === true && entry.listSlotsMatch === true
    ),
    true,
    `RS-66 dedicated sentinel proof missing: ${JSON.stringify(created.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-66 empty task source')
  const emptySource = await waitFor(() => visibleSource(app), 'RS-66 source textarea missing')
  console.log('RS66_EMPTY_SOURCE:', JSON.stringify(emptySource))
  assert.equal(emptySource, emptyExpected, `RS-66 empty task source mismatch: ${JSON.stringify(emptySource)}`)
  assert.equal(emptySource.includes(sentinel), true, 'RS-66 empty task source lost sentinel')
  assert.doesNotMatch(emptySource, /<br\s*\/?\s*>/i, 'RS-66 leaked <br /> into source')
  assert.equal(await toggleSource(app), true, 'could not return RS-66 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), emptyExpected, 'RS-66 empty task disk bytes differ from source view')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen-empty', port + 1)
  await waitFor(async () => (await state(app)).unchecked, 'RS-66 cold reopen lost empty task semantics')
  const reopened = await state(app)
  assert.equal(reopened.taskText, '', `RS-66 cold reopen exposed sentinel: ${JSON.stringify(reopened)}`)
  assert.match(reopened.editorText, /额发疯/, 'RS-66 cold reopen changed preceding content')
  assert.match(reopened.editorText, /1/, 'RS-66 cold reopen changed following content')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)
  await focusEmptyTask(app)
  await app.send('Input.insertText', { text: '任务' })
  await sleep(900)
  const filled = await state(app)
  console.log('RS66_AFTER_FILL:', JSON.stringify(filled))
  assert.equal(filled.taskText, '任务', 'RS-66 task did not fill in place after reopen')
  assert.equal(filled.integrity.some((entry) => entry.ok === false), false, `RS-66 fill failed integrity: ${JSON.stringify(filled.integrity)}`)
  assert.equal(filled.toasts.some((text) => warningPattern.test(text)), false, `RS-66 fill showed warning: ${JSON.stringify(filled.toasts)}`)

  assert.equal(await toggleSource(app), true, 'could not inspect RS-66 filled source')
  const filledSource = await waitFor(() => visibleSource(app), 'RS-66 filled source missing')
  assert.equal(filledSource, filledExpected, `RS-66 filled source mismatch: ${JSON.stringify(filledSource)}`)
  assert.equal(filledSource.includes(sentinel), false, 'RS-66 sentinel survived after task body fill')
  assert.equal(await toggleSource(app), true, 'could not return filled RS-66 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), filledExpected, 'RS-66 filled disk bytes mismatch')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen-filled', port + 2)
  await waitFor(async () => (await state(app)).unchecked, 'RS-66 second reopen lost task semantics')
  const reopenedFilled = await state(app)
  assert.equal(reopenedFilled.taskText, '任务', `RS-66 second reopen changed task text: ${JSON.stringify(reopenedFilled)}`)
  assert.match(reopenedFilled.editorText, /额发疯/, 'RS-66 second reopen changed preceding content')
  assert.match(reopenedFilled.editorText, /1/, 'RS-66 second reopen changed following content')

  console.log('PASS RS-66 existing middle slash task: sentinel, integrity, source, save, reopen, fill, and second reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
