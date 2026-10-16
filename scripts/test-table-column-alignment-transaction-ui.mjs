import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-table-column-alignment-transaction-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13910 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixtureLines = [
  '# table column alignment transaction',
  '',
  '| Key    | Value | Value    | Note      |',
  '| :----- | :---: | -------: | :-------- |',
  '| alpha  | same  | same     | keep-a    |',
  '| beta | same | same | keep-b |',
  '| gamma  | same  | same     | keep-g |',
  '| delta | same | same | keep-d |',
  '',
  'after table',
  ''
]
const fixture = `\uFEFF${fixtureLines.join('\r\n')}`
const rows = [
  ['Key', 'Value', 'Value', 'Note'],
  ['alpha', 'same', 'same', 'keep-a'],
  ['beta', 'same', 'same', 'keep-b'],
  ['gamma', 'same', 'same', 'keep-g'],
  ['delta', 'same', 'same', 'keep-d']
]
const scenarios = [
  {
    name: 'center-callback',
    columnIndex: 2,
    previousAlignment: 'right',
    nextAlignment: 'center',
    buttonIndex: 1,
    immediateFlush: false,
    delimiter: '| :----- | :---: | :-------: | :-------- |'
  },
  {
    name: 'left-forced-flush',
    columnIndex: 2,
    previousAlignment: 'right',
    nextAlignment: 'left',
    buttonIndex: 0,
    immediateFlush: true,
    delimiter: '| :----- | :---: | :------- | :-------- |'
  },
  {
    name: 'right-callback',
    columnIndex: 1,
    previousAlignment: 'center',
    nextAlignment: 'right',
    buttonIndex: 2,
    immediateFlush: false,
    delimiter: '| :----- | ---: | -------: | :-------- |'
  }
]

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const click = async (app, point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point
  })
}

const columnAlignments = (app, columnIndex) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return [...(editor?.querySelectorAll('table tr') || [])].map((row) => {
    const cell = row.querySelectorAll('th,td')[${columnIndex}]
    return cell?.getAttribute('data-alignment') || cell?.dataset?.alignment ||
      cell?.style?.textAlign || getComputedStyle(cell).textAlign || null
  })
})()`)

const openApp = async ({ file, profile, port, scenario, edited = false }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    const alignment = edited ? scenario.nextAlignment : scenario.previousAlignment
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        const tableRows = [...(editor?.querySelectorAll('table tr') || [])]
        const values = tableRows.map((row) =>
          [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
        )
        const alignments = tableRows.map((row) => {
          const cell = row.querySelectorAll('th,td')[${scenario.columnIndex}]
          return cell?.getAttribute('data-alignment') || cell?.dataset?.alignment ||
            cell?.style?.textAlign || getComputedStyle(cell).textAlign || null
        })
        return Boolean(
          editor &&
          JSON.stringify(values) === ${JSON.stringify(JSON.stringify(rows))} &&
          alignments.length === ${rows.length} &&
          alignments.every((value) => value === ${JSON.stringify(alignment)}) &&
          (editor.textContent || '').includes('after table')
        )
      })()`),
      `table alignment editor did not mount for ${profile}`
    )
    await sleep(450)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmTableTransactionTrace = []
  window.__hmFlushTrace = []
  window.__hmTableActionTrace = []
})()`)

const alignTargetColumn = async (app, scenario) => {
  const target = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
      .find((node) => node.offsetParent)
    const header = block?.querySelectorAll('th')?.[${scenario.columnIndex}]
    header?.scrollIntoView({ block: 'center' })
    const rect = header?.getBoundingClientRect()
    if (!rect) return null
    const point = { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) }
    return header.contains(document.elementFromPoint(point.x, point.y)) ? point : null
  })()`), `${scenario.name} target header was not hit-testable`)

  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target })
  await sleep(320)
  const handlePoint = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
      .find((node) => node.offsetParent)
    const handle = [...(block?.querySelectorAll('[data-role="col-drag-handle"]') || [])]
      .find((node) => node.offsetParent && node.dataset.show === 'true')
    const rect = handle?.getBoundingClientRect()
    if (!rect) return null
    const x = Math.round((rect.left + rect.right) / 2)
    const y = Math.round((rect.top + rect.bottom) / 2)
    return handle.contains(document.elementFromPoint(x, y)) ? { x, y } : null
  })()`), `${scenario.name} column drag handle did not appear`)
  await click(app, handlePoint)
  await sleep(220)

  const buttonPoint = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
      .find((node) => node.offsetParent)
    const handle = [...(block?.querySelectorAll('[data-role="col-drag-handle"]') || [])]
      .find((node) => node.offsetParent)
    const buttons = [...(handle?.querySelectorAll('.button-group[data-show="true"] button') || [])]
    const button = buttons[${scenario.buttonIndex}]
    const rect = button?.getBoundingClientRect()
    if (!rect || buttons.length !== 4) return null
    const x = Math.round((rect.left + rect.right) / 2)
    const y = Math.round((rect.top + rect.bottom) / 2)
    return button.contains(document.elementFromPoint(x, y)) ? { x, y, count: buttons.length } : null
  })()`), `${scenario.name} alignment button did not appear`)
  assert.equal(buttonPoint.count, 4)
  await click(app, buttonPoint)
  await waitFor(async () => {
    const values = await columnAlignments(app, scenario.columnIndex)
    return values.length === rows.length && values.every((value) => value === scenario.nextAlignment)
  }, `${scenario.name} did not apply ${scenario.nextAlignment} alignment`)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const expectedFor = (scenario) => fixture.replace(
  '| :----- | :---: | -------: | :-------- |',
  scenario.delimiter
)

const snapshot = (app, scenario) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return {
    rows: [...(editor?.querySelectorAll('table tr') || [])].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
    ),
    alignments: [...(editor?.querySelectorAll('table tr') || [])].map((row) => {
      const cell = row.querySelectorAll('th,td')[${scenario.columnIndex}]
      return cell?.getAttribute('data-alignment') || cell?.dataset?.alignment ||
        cell?.style?.textAlign || getComputedStyle(cell).textAlign || null
    }),
    preserve: (window.__hmPreserveLog || []).slice(-50).map(({ source, previous, next, markdown, ...entry }) => entry),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-50).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite
    })),
    semanticDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-20),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-50),
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-120),
    ownerTrace: (window.__hmTableTransactionTrace || []).slice(-120),
    tableActions: (window.__hmTableActionTrace || []).slice(-50),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const assertSourceView = (source, scenario, label) => {
  const expectedView = expectedFor(scenario).replace(/\r\n/g, '\n')
  assert.equal(source, expectedView, `${label} source differs from delimiter-only alignment patch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes('| Key    | Value | Value    | Note      |'), true, `${label} changed header bytes`)
  assert.equal(source.includes(scenario.delimiter), true, `${label} missed target delimiter`)
  assert.equal(source.includes('| alpha  | same  | same     | keep-a    |'), true, `${label} changed body row`)
  assert.equal(source.includes('after table'), true, `${label} changed neighbour paragraph`)
}

const assertPublication = (state, scenario, boundary) => {
  assert.deepEqual(state.rows, rows, `${scenario.name} changed table text`)
  assert.equal(state.alignments.every((value) => value === scenario.nextAlignment), true)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${scenario.name} integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.semanticDiff.length, 0, `${scenario.name} semantic diff: ${JSON.stringify(state.semanticDiff)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false)
  const captures = state.journalTrace.filter((entry) => entry.phase === 'capture' && entry.ok === true)
  assert.equal(captures.length, 1, `${scenario.name} journal captures: ${JSON.stringify(captures)}`)
  const preservation = state.preserve.find((entry) =>
    entry.reason === 'table-column-alignment-changed' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-table-column-alignment-proof'
  )
  assert.ok(preservation, `${scenario.name} missing transaction owner: ${JSON.stringify(state.preserve)}`)
  const proof = preservation.integrityProof
  assert.equal(proof.family, 'table-column-alignment')
  assert.deepEqual(proof.tablePath, [1])
  assert.equal(proof.columnIndex, scenario.columnIndex)
  assert.equal(proof.previousAlignment, scenario.previousAlignment)
  assert.equal(proof.nextAlignment, scenario.nextAlignment)
  assert.equal(proof.rowCount, rows.length)
  assert.equal(proof.stepRanges.length, rows.length)
  assert.equal(proof.stepRanges.every((entry) => entry.stepName === 'ReplaceAroundStep'), true)
  assert.equal(proof.sourceLayout.delimiter.resultLine, scenario.delimiter)
  assert.equal(proof.transactionJournal?.journalId, captures[0].journalId)
  assert.equal(proof.transactionJournal?.stepCount, rows.length)
  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'table-column-alignment-changed' &&
    entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true
  ), true)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' && entry.owner === 'transaction' &&
    entry.family === 'table-column-alignment' && entry.boundary === boundary
  ), true, `${scenario.name} bypassed Coordinator`)
  assert.equal(state.ownerTrace.some((entry) =>
    entry.phase === 'published' && entry.ok === true &&
    entry.family === 'table-column-alignment' && entry.boundary === boundary
  ), true, `${scenario.name} missing owner trace`)
  assert.equal(state.tableActions.some((entry) => /button/.test(entry.tagName?.toLowerCase?.() || '')), true)
}

const save = async (app, label) => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${label} save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not finish`)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port, scenario })
  try {
    await clearDiagnostics(app)
    await alignTargetColumn(app, scenario)
    let source
    if (scenario.immediateFlush) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSourceView(source, scenario, scenario.name)
      assert.equal(await toggleSource(app), true)
      await sleep(650)
    } else await sleep(1100)

    const state = await snapshot(app, scenario)
    console.log(`${scenario.name.toUpperCase()}_AFTER_ALIGNMENT:`, JSON.stringify(state))
    assertPublication(
      state,
      scenario,
      scenario.immediateFlush
        ? 'transaction-table-column-alignment-forced-flush'
        : 'transaction-table-column-alignment-markdown-updated'
    )
    if (!scenario.immediateFlush) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSourceView(source, scenario, scenario.name)
      assert.equal(await toggleSource(app), true)
    }
    await save(app, scenario.name)
    assert.equal(await readFile(file, 'utf8'), expectedFor(scenario))
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({
    file,
    profile: `${scenario.name}-reopen`,
    port: port + 1,
    scenario,
    edited: true
  })
  try {
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assertSourceView(source, scenario, `${scenario.name} cold reopen`)
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
  console.log('PASS transaction-owned table column alignment UI: real Milkdown left/center/right buttons patch only the selected delimiter cell, preserve duplicate columns/BOM/CRLF/body rows/neighbour, callback/forced flush, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
