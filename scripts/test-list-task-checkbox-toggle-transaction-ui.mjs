import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-list-task-checkbox-toggle-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 25220 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const scenarios = [
  {
    name: 'top-callback',
    forced: false,
    target: 'Top task',
    previousChecked: false,
    nextChecked: true,
    scope: 'top-level',
    token: '+',
    fixture: '\uFEFF# Tasks\r\n\r\n+ [ ] Top task\r\n+ Parent\r\n  - [x] Nested task\r\n+ Tail\r\n',
    expected: '\uFEFF# Tasks\r\n\r\n+ [x] Top task\r\n+ Parent\r\n  - [x] Nested task\r\n+ Tail\r\n'
  },
  {
    name: 'nested-forced',
    forced: true,
    target: 'Nested task',
    previousChecked: true,
    nextChecked: false,
    scope: 'nested',
    token: '-',
    fixture: '\uFEFF# Tasks\r\n\r\n+ [ ] Top task\r\n+ Parent\r\n  - [x] Nested task\r\n+ Tail\r\n',
    expected: '\uFEFF# Tasks\r\n\r\n+ [ ] Top task\r\n+ Parent\r\n  - [ ] Nested task\r\n+ Tail\r\n'
  }
]
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`
const taskState = (app, target) => app.evaluate(`((target) => {
  const editor = ${visibleEditor()}
  const blocks = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
  const block = blocks.find((node) => {
    const ps = [...node.querySelectorAll('.children p')]
      .filter((p) => p.closest('.milkdown-list-item-block') === node)
    return ps.some((p) => (p.textContent || '') === target)
  })
  const label = block?.querySelector('.label-wrapper .label')
  return label ? {
    checked: label.classList.contains('checked'),
    unchecked: label.classList.contains('unchecked')
  } : null
})(${JSON.stringify(target)})`)
const taskPoint = (app, target) => app.evaluate(`((target) => {
  const editor = ${visibleEditor()}
  const blocks = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
  const block = blocks.find((node) => {
    const ps = [...node.querySelectorAll('.children p')]
      .filter((p) => p.closest('.milkdown-list-item-block') === node)
    return ps.some((p) => (p.textContent || '') === target)
  })
  const rect = block?.querySelector('.label-wrapper')?.getBoundingClientRect()
  return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null
})(${JSON.stringify(target)})`)
const clickTask = async (app, target) => {
  const point = await taskPoint(app, target)
  assert.ok(point, `${target} checkbox point missing`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null)`)
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmListTaskCheckboxToggleTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)
const diagnostics = (app) => app.evaluate(`(() => ({
  journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-30),
  owner: (window.__hmListTaskCheckboxToggleTransactionTrace || []).slice(-30),
  broad: (window.__hmListSubtreeTransactionTrace || []).slice(-30),
  preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => entry),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map((entry) => ({
    ok: entry.ok,
    semanticOk: entry.semanticOk,
    listSlotsMatch: entry.listSlotsMatch,
    preservationReason: entry.preservationReason,
    validationSite: entry.validationSite
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent).map((node) => node.textContent || '')
}))()`)
const save = async (app, label) => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${label} save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not finish`)
}
const open = async ({ file, profile, port, target, checked }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const state = await taskState(app, target)
      return state?.checked === checked ? state : null
    }, `${profile} task did not mount`)
    await sleep(300)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, scenario.fixture, 'utf8')
  let app = await open({
    file,
    profile: `${scenario.name}-edit`,
    port,
    target: scenario.target,
    checked: scenario.previousChecked
  })
  try {
    await clearDiagnostics(app)
    await clickTask(app, scenario.target)
    await waitFor(async () => (await taskState(app, scenario.target))?.checked === scenario.nextChecked,
      `${scenario.name} checkbox did not toggle`)

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
      assert.equal(await toggleSource(app), true)
      await sleep(500)
    } else {
      await sleep(900)
    }

    const state = await diagnostics(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `${scenario.name} integrity: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false, `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const published = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-task-checkbox-toggle')
    assert.equal(published.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
    assert.equal(published[0].boundary,
      scenario.forced ? 'transaction-list-task-checkbox-toggle-forced-flush' : 'transaction-list-task-checkbox-toggle-markdown-updated')
    const proof = state.preserve.find((entry) =>
      entry.reason === 'list-task-checkbox-toggled' &&
      entry.integrityProof?.kind === 'transaction-list-task-checkbox-toggle-proof')?.integrityProof
    assert.ok(proof, `${scenario.name} preservation: ${JSON.stringify(state.preserve)}`)
    assert.equal(proof.scope, scenario.scope)
    assert.equal(proof.previousChecked, scenario.previousChecked)
    assert.equal(proof.nextChecked, scenario.nextChecked)
    assert.equal(proof.step?.name, 'AttrStep')
    assert.equal(proof.step?.attr, 'checked')
    assert.equal(proof.sourceRow?.token, scenario.token)
    assert.equal(proof.rawPatch?.from, scenario.previousChecked ? 'x' : ' ')
    assert.equal(proof.rawPatch?.to, scenario.nextChecked ? 'x' : ' ')
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.preserve.some((entry) => entry.reason === 'list-line-change'), false)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' && entry.owner === 'transaction' && entry.family === 'list-task-checkbox-toggle'), true)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
      assert.equal(await toggleSource(app), true)
    }
    assert.equal(source.charCodeAt(0), 0xFEFF)
    await save(app, scenario.name)
    assert.equal(await readFile(file, 'utf8'), scenario.expected, `${scenario.name} disk mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await open({
    file,
    profile: `${scenario.name}-reopen`,
    port: port + 1,
    target: scenario.target,
    checked: scenario.nextChecked
  })
  try {
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
    assert.equal(await readFile(file, 'utf8'), scenario.expected)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  for (let index = 0; index < scenarios.length; index += 1) {
    await runScenario(scenarios[index], basePort + index * 10)
  }
  completed = true
  console.log('PASS task checkbox toggle transaction UI: top-level callback and nested forced checkbox clicks publish focused-only, change only [ ]/[x], preserve authored +/- marker/BOM/CRLF through source, save, disk and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
