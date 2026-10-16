import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-list-task-checkbox-toggle-retirement-${process.pid}`
const file = join(root, 'entity-body.md')
const port = Number(process.env.CDP_PORT || 25320 + (process.pid % 30))
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
const targetState = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const blocks = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
  const block = blocks.find((node) => {
    const ps = [...node.querySelectorAll('.children p')]
      .filter((p) => p.closest('.milkdown-list-item-block') === node)
    return ps.some((p) => (p.textContent || '') === 'A & B')
  })
  const label = block?.querySelector('.label-wrapper .label')
  const rect = block?.querySelector('.label-wrapper')?.getBoundingClientRect()
  return {
    found: Boolean(label && rect),
    checked: Boolean(label?.classList.contains('checked')),
    point: rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null
  }
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
  const initial = await waitFor(async () => {
    const state = await targetState(app)
    return state.found && !state.checked ? state : null
  }, 'entity task did not mount')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmListTaskCheckboxToggleTransactionTrace = []
    window.__hmListSubtreeTransactionTrace = []
  })()`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...initial.point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...initial.point, button: 'left', clickCount: 1 })
  await waitFor(async () => (await targetState(app)).checked === true, 'entity task checkbox did not toggle')
  await waitFor(() => app.evaluate(`(() =>
    (window.__hmListTaskCheckboxToggleTransactionTrace || []).some((entry) =>
      entry.phase === 'plan' && entry.family === 'list-task-checkbox-toggle' &&
      entry.reason === 'list-task-checkbox-toggle-source-row-unproven' &&
      entry.recognized === true && entry.legacyBlocked === true
    )
  )()`), 'entity task toggle did not fail closed')
  await sleep(250)

  const state = await app.evaluate(`(() => ({
    owner: (window.__hmListTaskCheckboxToggleTransactionTrace || []).slice(-30),
    broad: (window.__hmListSubtreeTransactionTrace || []).slice(-30),
    preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => entry),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent).map((node) => node.textContent || '')
  }))()`)
  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' && entry.reason === 'list-task-checkbox-toggle-source-row-unproven')
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) => entry.recognized === true && entry.legacyBlocked === true), true)
  assert.equal((await targetState(app)).checked, true, 'rich checkbox toggle was not retained')
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-task-checkbox-toggled'), false)
  assert.equal(state.preserve.some((entry) => entry.reason === 'list-line-change'), false)
  assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
  assert.equal(state.coordinator.some((entry) => entry.phase === 'published'), false)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true, JSON.stringify(state.toasts))
  assert.equal(await readFile(file, 'utf8'), fixture, 'fail-closed task toggle overwrote disk')

  completed = true
  console.log('PASS task checkbox toggle legacy retirement UI: entity-authored body is recognized by exact checked AttrStep family but raw proof fails closed, blocks list-line-change/broad/legacy publication, retains rich checkbox toggle, warns, and leaves disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
