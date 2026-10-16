import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-task-empty-sibling-split-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 25820 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const sentinel = '\u200B'
const scenarios = [
  {
    name: 'top-unchecked-callback',
    forced: false,
    target: 'Top unchecked',
    checked: false,
    scope: 'top-level',
    token: '+',
    fixture: '\uFEFF# Tasks\r\n\r\n+ [ ] Top unchecked\r\n+ Tail\r\n',
    expected: `\uFEFF# Tasks\r\n\r\n+ [ ] Top unchecked\r\n+ [ ] ${sentinel}\r\n+ Tail\r\n`
  },
  {
    name: 'nested-checked-forced',
    forced: true,
    target: 'Nested checked',
    checked: true,
    scope: 'nested',
    token: '-',
    fixture: '\uFEFF# Tasks\r\n\r\n+ Parent\r\n  - [x] Nested checked\r\n+ Tail\r\n',
    expected: `\uFEFF# Tasks\r\n\r\n+ Parent\r\n  - [x] Nested checked\r\n  - [x] ${sentinel}\r\n+ Tail\r\n`
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
const taskRows = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return [...(editor?.querySelectorAll('li') || [])]
    .filter((node) => node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked'))
    .map((node) => {
      const paragraph = [...node.querySelectorAll('p')].find((p) => p.closest('li') === node)
      const label = node.querySelector('.label-wrapper .label')
      return {
        text: paragraph?.textContent || '',
        checked: Boolean(label?.classList.contains('checked')),
        nested: Boolean(node.parentElement?.closest('li'))
      }
    })
})()`)
const focusTaskEnd = async (app, target) => {
  const placed = await app.evaluate(`((target) => {
    const editor = ${visibleEditor()}
    const task = [...(editor?.querySelectorAll('li') || [])].find((node) => {
      const paragraph = [...node.querySelectorAll('p')].find((p) => p.closest('li') === node)
      return node.querySelector('.label-wrapper .label.unchecked, .label-wrapper .label.checked') &&
        (paragraph?.textContent || '') === target
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
  })(${JSON.stringify(target)})`)
  assert.equal(placed, true, `${target} end placement failed`)
}
const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null)`)
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmListTaskEmptySiblingSplitTransactionTrace = []
  window.__hmListTaskCheckboxToggleTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)
const diagnostics = (app) => app.evaluate(`(() => ({
  owner: (window.__hmListTaskEmptySiblingSplitTransactionTrace || []).slice(-30),
  checkbox: (window.__hmListTaskCheckboxToggleTransactionTrace || []).slice(-30),
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
const open = async ({ file, profile, port, target, expectedRows }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const rows = await taskRows(app)
      return expectedRows(rows) ? rows : null
    }, `${profile} task topology did not mount`)
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
    expectedRows: (rows) => rows.some((row) => row.text === scenario.target && row.checked === scenario.checked)
  })
  try {
    await clearDiagnostics(app)
    await focusTaskEnd(app, scenario.target)
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: scenario.forced ? 8 : 80 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
      assert.equal(await toggleSource(app), true)
      await sleep(550)
    } else {
      await sleep(900)
    }

    const rows = await taskRows(app)
    const targetIndex = rows.findIndex((row) => row.text === scenario.target)
    assert.notEqual(targetIndex, -1, `${scenario.name} target task disappeared`)
    assert.ok(rows[targetIndex + 1], `${scenario.name} empty sibling missing`)
    assert.equal(rows[targetIndex + 1].text, '')
    assert.equal(rows[targetIndex + 1].checked, scenario.checked)
    assert.equal(rows[targetIndex + 1].nested, scenario.scope === 'nested')

    const state = await diagnostics(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `${scenario.name} integrity: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false, `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const published = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-task-empty-sibling-split')
    assert.equal(published.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
    assert.equal(published[0].boundary,
      scenario.forced ? 'transaction-list-task-empty-sibling-split-forced-flush' : 'transaction-list-task-empty-sibling-split-markdown-updated')
    const proof = state.preserve.find((entry) =>
      entry.reason === 'list-task-empty-sibling-split' &&
      entry.integrityProof?.kind === 'transaction-list-task-empty-sibling-split-proof')?.integrityProof
    assert.ok(proof, `${scenario.name} proof missing: ${JSON.stringify(state.preserve)}`)
    assert.equal(proof.scope, scenario.scope)
    assert.equal(proof.checked, scenario.checked)
    assert.equal(proof.step?.name, 'ReplaceStep')
    assert.equal(proof.step?.sliceSize, 4)
    assert.equal(proof.sourceRow?.token, scenario.token)
    assert.equal(proof.rawInsertion?.text.includes(sentinel), true)
    assert.equal(state.checkbox.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.preserve.some((entry) => entry.reason === 'list-line-change'), false)
    assert.equal(state.preserve.some((entry) => entry.reason === 'middle-empty-block-list-filled'), false)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' && entry.owner === 'transaction' && entry.family === 'list-task-empty-sibling-split'), true)

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
    expectedRows: (rows) => {
      const index = rows.findIndex((row) => row.text === scenario.target)
      return index >= 0 && rows[index + 1]?.text === '' && rows[index + 1]?.checked === scenario.checked
    }
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
  console.log('PASS task empty sibling split transaction UI: top-level unchecked callback and nested checked forced Enter publish focused-only, insert same authored task marker/state + U+200B sentinel, preserve BOM/CRLF/successors through source, save, disk and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
