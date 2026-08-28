import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-table-column-width-transaction-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 14620 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixtureLines = [
  'before table',
  '',
  '| Key    | Value | Note      |',
  '| :----- | :---: | --------: |',
  '| alpha  | same  | keep-a    |',
  '| beta | same | keep-b |',
  '| gamma  | same  | keep-g |',
  '',
  'after table',
  ''
]
const fixture = `\uFEFF${fixtureLines.join('\r\n')}`
const rows = [
  ['Key', 'Value', 'Note'],
  ['alpha', 'same', 'keep-a'],
  ['beta', 'same', 'keep-b'],
  ['gamma', 'same', 'keep-g']
]
const scenarios = [
  { name: 'width-callback', immediateSourceToggle: false, delta: 72 },
  { name: 'width-immediate-source-toggle', immediateSourceToggle: true, delta: 64 }
]
const columnIndex = 1

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

const openApp = async ({ file, profile, port, expectWidths = false }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        const tableRows = [...(editor?.querySelectorAll('table tr') || [])]
        const values = tableRows.map((row) =>
          [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
        )
        const widths = tableRows.map((row) =>
          row.querySelectorAll('th,td')[${columnIndex}]?.getAttribute('data-colwidth') || ''
        )
        return Boolean(
          editor &&
          JSON.stringify(values) === ${JSON.stringify(JSON.stringify(rows))} &&
          widths.length === ${rows.length} &&
          ${expectWidths ? 'widths.every(Boolean)' : 'widths.every((value) => !value)'} &&
          (editor.textContent || '').includes('after table')
        )
      })()`),
      `table width editor did not mount for ${profile}`
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
})()`)

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

const targetColumnState = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const tableRows = [...(editor?.querySelectorAll('table tr') || [])]
  const cells = tableRows.map((row) => row.querySelectorAll('th,td')[${columnIndex}])
  return {
    widths: cells.map((cell) => cell?.getBoundingClientRect().width || 0),
    colwidths: cells.map((cell) => cell?.getAttribute('data-colwidth') || ''),
    manual: Boolean(editor?.querySelector('table[data-hm-column-widths="true"]'))
  }
})()`)

const dragTargetColumn = async (app, delta) => {
  const before = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
      .find((node) => node.offsetParent)
    block?.scrollIntoView({ block: 'center' })
    const bodyRow = block?.querySelectorAll('tr')?.[1]
    const cell = bodyRow?.querySelectorAll('td')?.[${columnIndex}]
    const rect = cell?.getBoundingClientRect()
    if (!rect) return null
    const point = {
      x: Math.round(rect.right - 2),
      y: Math.round((rect.top + rect.bottom) / 2)
    }
    return document.elementFromPoint(point.x, point.y)?.closest?.('td,th') === cell
      ? { ...point, width: rect.width }
      : null
  })()`), 'column resize target was not hit-testable')

  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: before.x, y: before.y
  })
  await sleep(180)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: before.x, y: before.y,
    button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(280)
  const active = await app.evaluate(`(() => ({
    resizing: document.body.classList.contains('hm-table-resizing'),
    guides: document.querySelectorAll('.hm-column-resize-guide').length
  }))()`)
  assert.equal(active.resizing, true, `resize hold did not activate: ${JSON.stringify(active)}`)
  assert.equal(active.guides, 1, `resize guide count: ${JSON.stringify(active)}`)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: before.x + delta, y: before.y,
    button: 'left', buttons: 1
  })
  await sleep(100)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: before.x + delta, y: before.y,
    button: 'left', buttons: 0, clickCount: 1
  })
  return before
}

const holdTargetColumnWithoutMove = async (app) => {
  const target = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
      .find((node) => node.offsetParent)
    const bodyRow = block?.querySelectorAll('tr')?.[1]
    const cell = bodyRow?.querySelectorAll('td')?.[${columnIndex}]
    const rect = cell?.getBoundingClientRect()
    if (!rect) return null
    const point = {
      x: Math.round(rect.right - 2),
      y: Math.round((rect.top + rect.bottom) / 2)
    }
    return document.elementFromPoint(point.x, point.y)?.closest?.('td,th') === cell
      ? point
      : null
  })()`), 'column no-op resize target was not hit-testable')
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: target.x, y: target.y
  })
  await sleep(180)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: target.x, y: target.y,
    button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(280)
  const active = await app.evaluate(`(() => ({
    resizing: document.body.classList.contains('hm-table-resizing'),
    guides: document.querySelectorAll('.hm-column-resize-guide').length
  }))()`)
  assert.equal(active.resizing, true, `no-op resize hold did not activate: ${JSON.stringify(active)}`)
  assert.equal(active.guides, 1)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: target.x, y: target.y,
    button: 'left', buttons: 0, clickCount: 1
  })
  await sleep(350)
}

const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const tableRows = [...(editor?.querySelectorAll('table tr') || [])]
  const cells = tableRows.map((row) => row.querySelectorAll('th,td')[${columnIndex}])
  return {
    rows: tableRows.map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
    ),
    widths: cells.map((cell) => cell?.getBoundingClientRect().width || 0),
    colwidths: cells.map((cell) => cell?.getAttribute('data-colwidth') || ''),
    manual: Boolean(editor?.querySelector('table[data-hm-column-widths="true"]')),
    saveVisible: Boolean(document.querySelector('.hm-save-fab')),
    preserve: (window.__hmPreserveLog || []).slice(-50)
      .map(({ source, previous, next, markdown, ...entry }) => entry),
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
    flushTrace: (window.__hmFlushTrace || []).slice(-50),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const assertSourceView = (source, label) => {
  const expected = fixture.replace(/\r\n/g, '\n')
  assert.equal(source, expected, `${label} changed authored Markdown for editor-only colwidth`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR bytes`)
  assert.equal(source.includes('| Key    | Value | Note      |'), true)
  assert.equal(source.includes('| :----- | :---: | --------: |'), true)
  assert.equal(source.includes('| beta | same | keep-b |'), true)
  assert.equal(source.endsWith('after table\n'), true)
}

const assertPublication = (state, scenario, boundary, before) => {
  assert.deepEqual(state.rows, rows, `${scenario.name} changed table text`)
  assert.equal(state.colwidths.length, rows.length)
  assert.equal(state.colwidths.every(Boolean), true, `${scenario.name} missing colwidth attrs`)
  assert.equal(new Set(state.colwidths).size, 1, `${scenario.name} widths differ by row`)
  assert.equal(state.widths.every((width) => width >= before.width + 35), true,
    `${scenario.name} did not widen target column: ${JSON.stringify({ before, state })}`)
  assert.equal(state.manual, true, `${scenario.name} did not activate manual table widths`)
  assert.equal(state.saveVisible, false, `${scenario.name} marked source dirty for editor-only metadata`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${scenario.name} integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.semanticDiff.length, 0,
    `${scenario.name} semantic diff: ${JSON.stringify(state.semanticDiff)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false)
  const captures = state.journalTrace.filter((entry) => entry.phase === 'capture' && entry.ok === true)
  assert.equal(captures.length, 1, `${scenario.name} journal captures: ${JSON.stringify(captures)}`)
  const preservation = state.preserve.find((entry) =>
    entry.reason === 'table-column-width-changed' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-table-column-width-proof'
  )
  assert.ok(preservation, `${scenario.name} missing width owner: ${JSON.stringify(state.preserve)}`)
  const proof = preservation.integrityProof
  assert.equal(proof.family, 'table-column-width')
  assert.deepEqual(proof.tablePath, [1])
  assert.equal(proof.columnIndex, columnIndex)
  assert.equal(proof.previousWidth, null)
  assert.equal(Number.isInteger(proof.nextWidth), true)
  assert.equal(proof.nextWidth >= 25, true)
  assert.equal(proof.rowCount, rows.length)
  assert.deepEqual(proof.cellPaths, [[1, 0, 1], [1, 1, 1], [1, 2, 1], [1, 3, 1]])
  assert.equal(proof.stepRanges.length, rows.length)
  assert.equal(proof.stepRanges.every((entry) => entry.stepName === 'ReplaceAroundStep'), true)
  assert.equal(proof.transactionJournal?.stepCount, rows.length)
  assert.equal(proof.sourceUnchanged, true)
  assert.equal(proof.canonicalUnchanged, true)
  assert.equal(proof.metadataDocumentEquivalent, true)
  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'table-column-width-changed' &&
    entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true
  ), true, `${scenario.name} missing full integrity success`)
  const coordinatorPublications = state.coordinator.filter((entry) =>
    entry.phase === 'published' && entry.owner === 'transaction' &&
    entry.family === 'table-column-width'
  )
  assert.equal(coordinatorPublications.length, 1,
    `${scenario.name} published width metadata more than once: ${JSON.stringify(coordinatorPublications)}`)
  assert.equal(coordinatorPublications[0].boundary, boundary,
    `${scenario.name} used the wrong publication boundary`)
  const ownerPublications = state.ownerTrace.filter((entry) =>
    entry.phase === 'published' && entry.ok === true &&
    entry.family === 'table-column-width'
  )
  assert.equal(ownerPublications.length, 1,
    `${scenario.name} duplicated owner publication: ${JSON.stringify(ownerPublications)}`)
  assert.equal(ownerPublications[0].boundary, boundary)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port })
  try {
    await clearDiagnostics(app)
    const before = await dragTargetColumn(app, scenario.delta)
    let source = null
    if (scenario.immediateSourceToggle) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSourceView(source, scenario.name)
      assert.equal(await toggleSource(app), true, `${scenario.name} rich toggle failed`)
      await sleep(650)
    } else {
      await sleep(1100)
    }

    await waitFor(async () => {
      const state = await targetColumnState(app)
      return state.manual && state.colwidths.every(Boolean)
    }, `${scenario.name} width attrs did not settle`)
    const state = await snapshot(app)
    assertPublication(
      state,
      scenario,
      scenario.immediateSourceToggle
        ? 'transaction-table-column-width-forced-flush'
        : 'transaction-table-column-width-markdown-updated',
      before
    )
    if (!scenario.immediateSourceToggle) {
      const beforeNoOp = await snapshot(app)
      await holdTargetColumnWithoutMove(app)
      const afterNoOp = await snapshot(app)
      assert.deepEqual(afterNoOp.colwidths, beforeNoOp.colwidths,
        `${scenario.name} no-op hold changed colwidth metadata`)
      assert.equal(afterNoOp.saveVisible, false,
        `${scenario.name} no-op hold left false source dirty state`)
      assert.equal(afterNoOp.coordinator.filter((entry) =>
        entry.phase === 'published' && entry.family === 'table-column-width'
      ).length, 1, `${scenario.name} no-op hold published a second width transaction`)
      assert.equal(afterNoOp.journalTrace.filter((entry) =>
        entry.phase === 'capture' && entry.ok === true
      ).length, 1, `${scenario.name} no-op hold captured a false journal`)
      assert.equal(afterNoOp.toasts.some((text) => warningPattern.test(text)), false)
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSourceView(source, scenario.name)
      assert.equal(await toggleSource(app), true, `${scenario.name} rich toggle failed`)
    }
    assert.equal(await readFile(file, 'utf8'), fixture, `${scenario.name} changed disk without source edit`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({ file, profile: `${scenario.name}-reopen`, port: port + 1 })
  try {
    const reopened = await targetColumnState(app)
    assert.equal(reopened.colwidths.every((value) => !value), true,
      `${scenario.name} fabricated Markdown persistence for colwidth metadata`)
    assert.equal(reopened.manual, false,
      `${scenario.name} cold reopen retained non-authored manual width state`)
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assertSourceView(source, `${scenario.name} cold reopen`)
    assert.equal(await readFile(file, 'utf8'), fixture)
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
  console.log('PASS transaction-owned table column width UI: real hold-drag publishes exactly one colwidth-only checkpoint through callback or canonical-unchanged forced flush, source/canonical/disk/dirty stay unchanged, and cold reopen remains GFM-authored')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
