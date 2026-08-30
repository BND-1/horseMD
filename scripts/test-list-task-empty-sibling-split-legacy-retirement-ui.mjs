import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-task-empty-sibling-split-retirement-${process.pid}`
const file = join(root, 'entity-body.md')
const port = Number(process.env.CDP_PORT || 25920 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFF# Tasks\r\n\r\n+ [ ] A &amp; B\r\n+ Tail\r\n'
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`
const taskRows = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return [...(editor?.querySelectorAll('li') || [])]
    .filter((node) => node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked'))
    .map((node) => {
      const p = [...node.querySelectorAll('p')].find((candidate) => candidate.closest('li') === node)
      const label = node.querySelector('.label-wrapper .label')
      return { text: p?.textContent || '', checked: Boolean(label?.classList.contains('checked')) }
    })
})()`)
const focusTaskEnd = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const task = [...(editor?.querySelectorAll('li') || [])].find((node) => {
    const p = [...node.querySelectorAll('p')].find((candidate) => candidate.closest('li') === node)
    return node.querySelector('.label-wrapper .label.unchecked') && (p?.textContent || '') === 'A & B'
  })
  const paragraph = task && [...task.querySelectorAll('p')].find((candidate) => candidate.closest('li') === task)
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
})()`)

let app = null
let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(async () => (await taskRows(app)).some((row) => row.text === 'A & B'), 'entity task did not mount')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListTaskEmptySiblingSplitTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)
  assert.equal(await focusTaskEnd(app), true)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListTaskEmptySiblingSplitTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' && entry.family === 'list-task-empty-sibling-split' &&
      entry.reason === 'task-empty-sibling-split-source-row-unproven' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'entity task split did not fail closed')
  await sleep(250)

  const rows = await taskRows(app)
  assert.deepEqual(rows.map((row) => row.text), ['A & B', ''])
  assert.deepEqual(rows.map((row) => row.checked), [false, false])
  const state = await app.evaluate(`(() => ({
    owner: (window.__hmListTaskEmptySiblingSplitTransactionTrace || []).slice(-30),
    broad: (window.__hmListSubtreeTransactionTrace || []).slice(-30),
    preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => entry),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent).map((node) => node.textContent || '')
  }))()`)
  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' && entry.reason === 'task-empty-sibling-split-source-row-unproven')
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-task-empty-sibling-split'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-line-change'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'middle-empty-block-list-filled'), false)
  assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true, JSON.stringify(state.toasts))
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed task split overwrote disk')

  completed = true
  console.log('PASS task empty sibling split legacy retirement UI: entity-authored task body is recognized by exact end-split family but raw proof fails closed, blocks list-line-change/broad/legacy publication, retains rich empty task sibling, warns, and leaves disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
