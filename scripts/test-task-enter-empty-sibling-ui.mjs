import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs70-task-enter-empty-sibling-${process.pid}`
const file = join(root, 'rs-70.md')
const port = Number(process.env.CDP_PORT || 10870)
const sentinel = '\u200B'
const fixture = [
  '# RS70',
  '',
  '- 色个粉色高',
  '',
  '- [ ] 额粉色分',
  '',
  '## after',
  ''
].join('\n')
const emptyExpected = [
  '# RS70',
  '',
  '- 色个粉色高',
  '',
  '- [ ] 额粉色分',
  `- [ ] ${sentinel}`,
  '',
  '## after',
  ''
].join('\n')
const filledExpected = [
  '# RS70',
  '',
  '- 色个粉色高',
  '',
  '- [ ] 额粉色分',
  '- [ ] 距离近',
  '',
  '## after',
  ''
].join('\n')
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 140) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
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
  const tasks = [...(editor?.querySelectorAll('li') || [])]
    .filter((node) => node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked'))
  return {
    taskCount: tasks.length,
    taskText: tasks.map((task) => {
      const paragraph = [...task.querySelectorAll('p')].find((node) => node.closest('li') === task)
      return paragraph?.textContent ?? ''
    }),
    unchecked: tasks.map((task) => !!task.querySelector('.label-wrapper .label.unchecked')),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-24).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(0, 720),
      canonical: String(entry.canonical || '').slice(0, 720)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: String(markdown || '').slice(0, 720)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const focusTaskEnd = (app, text) => app.evaluate(`((targetText) => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const task = [...(editor?.querySelectorAll('li') || [])]
    .find((node) => {
      const paragraph = [...node.querySelectorAll('p')].find((p) => p.closest('li') === node)
      return node.querySelector('.label-wrapper .label.unchecked') && (paragraph?.textContent || '') === targetText
    })
  const paragraph = task && [...task.querySelectorAll('p')].find((p) => p.closest('li') === task)
  if (!editor || !paragraph) return false
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(false)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return true
})(${JSON.stringify(text)})`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) =>
      node.offsetParent && (node.textContent || '').includes('额粉色分')))`),
    'RS-70 fixture did not mount'
  )
  await sleep(450)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-70 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-70 save did not complete')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)

  assert.equal(await focusTaskEnd(app, '额粉色分'), true, 'could not focus RS-70 task end')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
  await sleep(900)

  const created = await state(app)
  console.log('RS70_AFTER_ENTER:', JSON.stringify(created))
  assert.equal(created.taskCount, 2, `RS-70 Enter did not create exactly one task sibling: ${JSON.stringify(created)}`)
  assert.deepEqual(created.taskText, ['额粉色分', ''], `RS-70 task texts changed after Enter: ${JSON.stringify(created.taskText)}`)
  assert.deepEqual(created.unchecked, [true, true], `RS-70 task state changed after Enter: ${JSON.stringify(created.unchecked)}`)
  assert.equal(created.integrity.some((entry) => entry.ok === false), false, `RS-70 Enter failed integrity: ${JSON.stringify(created.integrity)}`)
  assert.equal(created.toasts.some((text) => warningPattern.test(text)), false, `RS-70 Enter showed warning: ${JSON.stringify(created.toasts)}`)
  assert.equal(
    created.integrity.some((entry) =>
      entry.preservationReason === 'middle-empty-block-list-filled' &&
      entry.ok === true && entry.semanticOk === true && entry.listSlotsMatch === true
    ),
    true,
    `RS-70 middle-list proof missing after Enter: ${JSON.stringify(created.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-70 empty sibling source')
  const emptySource = await waitFor(() => visibleSource(app), 'RS-70 source textarea missing after Enter')
  assert.equal(emptySource, emptyExpected, `RS-70 empty sibling source mismatch: ${JSON.stringify(emptySource)}`)
  assert.equal(emptySource.includes(sentinel), true, 'RS-70 empty task sibling lost source sentinel')
  assert.doesNotMatch(emptySource, /^- \[ \]$/m, 'RS-70 published a bare empty task row')
  assert.doesNotMatch(emptySource, /<br\s*\/?\s*>/i, 'RS-70 leaked <br /> into source')
  assert.equal(await toggleSource(app), true, 'could not return RS-70 to rich mode')
  await sleep(250)

  assert.equal(await focusTaskEnd(app, ''), true, 'could not focus RS-70 empty task sibling')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)
  await app.send('Input.insertText', { text: '距离近' })
  await sleep(900)

  const filled = await state(app)
  console.log('RS70_AFTER_FILL:', JSON.stringify(filled))
  assert.deepEqual(filled.taskText, ['额粉色分', '距离近'], `RS-70 task fill changed rows: ${JSON.stringify(filled.taskText)}`)
  assert.equal(filled.integrity.some((entry) => entry.ok === false), false, `RS-70 fill failed integrity: ${JSON.stringify(filled.integrity)}`)
  assert.equal(filled.toasts.some((text) => warningPattern.test(text)), false, `RS-70 fill showed warning: ${JSON.stringify(filled.toasts)}`)

  assert.equal(await toggleSource(app), true, 'could not inspect RS-70 filled source')
  const filledSource = await waitFor(() => visibleSource(app), 'RS-70 filled source missing')
  assert.equal(filledSource, filledExpected, `RS-70 filled source mismatch: ${JSON.stringify(filledSource)}`)
  assert.equal(filledSource.includes(sentinel), false, 'RS-70 sentinel survived after task body fill')
  assert.equal(await toggleSource(app), true, 'could not return filled RS-70 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), filledExpected, 'RS-70 disk bytes differ from filled source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await state(app)
  assert.equal(reopened.taskCount, 2, `RS-70 cold reopen changed task count: ${JSON.stringify(reopened)}`)
  assert.deepEqual(reopened.taskText, ['额粉色分', '距离近'], `RS-70 cold reopen changed task text: ${JSON.stringify(reopened.taskText)}`)
  assert.deepEqual(reopened.unchecked, [true, true], `RS-70 cold reopen changed task state: ${JSON.stringify(reopened.unchecked)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect RS-70 cold-reopen source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-70 cold-reopen source missing'), filledExpected)

  console.log('PASS RS-70 task Enter empty sibling: sentinel, integrity, fill, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
