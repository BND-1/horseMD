import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-table-row-insert-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13610 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const blankFromAuthoredLine = (line, values) => {
  let result = line
  let searchFrom = 0
  const spans = []
  for (const value of values) {
    const start = result.indexOf(value, searchFrom)
    assert.ok(start >= 0, `missing ${value} in authored row ${line}`)
    spans.push({ start, end: start + value.length })
    searchFrom = start + value.length
  }
  for (const span of spans.reverse()) {
    result = result.slice(0, span.start) + result.slice(span.end)
  }
  return result
}

const fixtureLines = [
  '# table row insert transaction',
  '',
  '| Key   | Value | Note     |',
  '| :---- | ----: | :------- |',
  '| alpha | one   | keep-a   |',
  '| same | beta | repeated |',
  '| same  | beta  | repeated  |',
  '| gamma | three | keep-g |',
  '',
  'after table',
  ''
]
const fixture = `\uFEFF${fixtureLines.join('\r\n')}`
const templateLine = fixtureLines[6]
const blankLine = blankFromAuthoredLine(templateLine, ['same', 'beta', 'repeated'])
const expectedLines = [...fixtureLines]
expectedLines.splice(7, 0, blankLine)
const expected = `\uFEFF${expectedLines.join('\r\n')}`

const rowsBefore = [
  ['Key', 'Value', 'Note'],
  ['alpha', 'one', 'keep-a'],
  ['same', 'beta', 'repeated'],
  ['same', 'beta', 'repeated'],
  ['gamma', 'three', 'keep-g']
]
const rowsAfter = [
  ['Key', 'Value', 'Note'],
  ['alpha', 'one', 'keep-a'],
  ['same', 'beta', 'repeated'],
  ['same', 'beta', 'repeated'],
  ['', '', ''],
  ['gamma', 'three', 'keep-g']
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
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point
  })
}

const openApp = async ({ file, profile, port, edited = false }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    const expectedRows = edited ? rowsAfter : rowsBefore
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        const rows = [...(editor?.querySelectorAll('table tr') || [])].map((row) =>
          [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
        )
        return Boolean(
          editor &&
          JSON.stringify(rows) === ${JSON.stringify(JSON.stringify(expectedRows))} &&
          (editor.textContent || '').includes('after table')
        )
      })()`),
      `table row insert editor did not mount for ${profile}`
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

const tableRows = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return [...(editor?.querySelectorAll('table tr') || [])].map((row) =>
    [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
  )
})()`)

const addTargetRow = async (app) => {
  let diagnostics = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
        .find((node) => node.offsetParent)
      const row = block?.querySelectorAll('tr')?.[3]
      const cell = row?.querySelectorAll('th,td')?.[1]
      cell?.scrollIntoView({ block: 'center' })
      const rect = cell?.getBoundingClientRect()
      if (!rect) return null
      const point = {
        x: Math.round((rect.left + rect.right) / 2),
        y: Math.round(rect.bottom - 4)
      }
      return cell.contains(document.elementFromPoint(point.x, point.y)) ? point : null
    })()`), 'target duplicate row was not hit-testable')

    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target })
    await sleep(280)
    const addPoint = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
        .find((node) => node.offsetParent)
      const handle = [...(block?.querySelectorAll('.line-handle') || [])]
        .find((node) => node.offsetParent &&
          node.dataset.role === 'x-line-drag-handle' &&
          node.dataset.show === 'true')
      const button = handle?.querySelector('.add-button')
      const rect = button?.getBoundingClientRect()
      if (!rect) return null
      const x = Math.round((rect.left + rect.right) / 2)
      const y = Math.round((rect.top + rect.bottom) / 2)
      return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null
    })()`)
    if (!addPoint) {
      diagnostics = await app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        const block = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
          .find((node) => node.offsetParent)
        return [...(block?.querySelectorAll('.line-handle') || [])].map((node) => ({
          role: node.dataset.role,
          show: node.dataset.show,
          display: getComputedStyle(node).display,
          text: node.textContent || ''
        }))
      })()`)
      continue
    }
    await click(app, addPoint)
    const inserted = await waitFor(async () => {
      const rows = await tableRows(app)
      return JSON.stringify(rows) === JSON.stringify(rowsAfter) ? rows : null
    }, 'row add UI did not insert one empty row after the selected duplicate row')
    if (inserted) return
  }
  throw new Error(`row add button did not complete after three attempts: ${JSON.stringify(diagnostics)}`)
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

const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return {
    rows: [...(editor?.querySelectorAll('table tr') || [])].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent || '').trim())
    ),
    documentText: editor?.innerText || '',
    preserve: (window.__hmPreserveLog || []).slice(-50).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-1300),
      previousTail: String(previous || '').slice(-1300),
      nextTail: String(next || '').slice(-1300),
      markdownTail: String(markdown || '').slice(-1300)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-50).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-50),
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-120),
    ownerTrace: (window.__hmTableTransactionTrace || []).slice(-120),
    tableActions: (window.__hmTableActionTrace || []).slice(-50),
    flush: (window.__hmFlushTrace || []).slice(-50),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const save = async (app, label) => {
  await waitFor(
    () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
    `${label} save button did not appear`
  )
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    `${label} save did not finish`
  )
}

const assertSourceView = (source, label) => {
  const expectedView = expected.replace(/\r\n/g, '\n')
  assert.equal(source, expectedView, `${label} source differs from selected row insertion`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes('| Key   | Value | Note     |'), true, `${label} changed header spacing`)
  assert.equal(source.includes('| :---- | ----: | :------- |'), true, `${label} changed alignment row`)
  assert.equal((source.match(/\| same \| beta \| repeated \|/g) || []).length, 1,
    `${label} changed first duplicate row occurrence`)
  assert.equal(source.includes(templateLine), true, `${label} changed template duplicate row`)
  assert.equal(source.includes(blankLine), true, `${label} missed author-style empty row`)
  assert.equal(/\|\s*<br\s*\/?>/i.test(source), false, `${label} leaked empty-cell <br>`)
  assert.equal(source.includes('| gamma | three | keep-g |'), true, `${label} changed following row`)
  assert.equal(source.includes('after table'), true, `${label} changed neighbour paragraph`)
}

const assertPublication = (state, boundary, label) => {
  assert.deepEqual(state.rows, rowsAfter, `${label} table DOM differs`)
  assert.equal(state.documentText.includes('after table'), true, `${label} changed neighbour paragraph`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed source-sync warning: ${JSON.stringify(state.toasts)}`)

  const captures = state.journalTrace.filter((entry) => entry.phase === 'capture' && entry.ok === true)
  assert.equal(captures.length, 1,
    `${label} did not capture exactly one row-insert transaction: ${JSON.stringify(state.journalTrace)}`)
  const capture = captures[0]

  const preservation = state.preserve.find((entry) =>
    entry.reason === 'table-row-inserted' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-table-row-insert-proof'
  )
  assert.ok(preservation, `${label} did not publish row-insert owner: ${JSON.stringify(state.preserve)}`)
  const proof = preservation.integrityProof
  assert.equal(proof.family, 'table-row-insert')
  assert.deepEqual(proof.tablePath, [1])
  assert.deepEqual(proof.insertedRowPath, [1, 4])
  assert.equal(proof.insertedRowIndex, 4)
  assert.deepEqual(proof.templateRowPath, [1, 3])
  assert.equal(proof.templateRowIndex, 3)
  assert.equal(proof.columnCount, 3)
  assert.equal(proof.stepDetail?.name, 'ReplaceStep')
  assert.equal(proof.stepRange?.from, proof.stepRange?.to)
  assert.equal(proof.stepRange?.sliceSize > 0, true)
  assert.equal(proof.sourceTemplateRange?.rawLine, templateLine)
  assert.equal(proof.sourceTemplateRange?.blankLine, blankLine)
  assert.equal(proof.sourceTemplateRange?.eol, '\r\n')
  assert.equal(proof.insertion?.placement, 'after-template-row')
  assert.equal(proof.insertion?.eol, '\r\n')
  assert.equal(proof.transactionJournal?.journalId, capture.journalId)
  assert.equal(proof.transactionJournal?.snapshotMatched, true)
  assert.equal(proof.transactionJournal?.documentMatched, true)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'table-row-inserted' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} row-insert candidate not equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'table-row-insert' &&
    entry.boundary === boundary
  ), true, `${label} bypassed Coordinator row-insert boundary: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.ownerTrace.some((entry) =>
    entry.phase === 'published' &&
    entry.ok === true &&
    entry.family === 'table-row-insert' &&
    entry.boundary === boundary
  ), true, `${label} missing row-insert owner trace: ${JSON.stringify(state.ownerTrace)}`)
  assert.equal(state.tableActions.some((entry) => /button/.test(entry.tagName?.toLowerCase?.() || '')), true,
    `${label} did not use the real Milkdown row add button: ${JSON.stringify(state.tableActions)}`)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({ file, profile, port, edited: true })
  try {
    const state = await snapshot(app)
    assert.deepEqual(state.rows, rowsAfter, `${label} cold reopen table differs`)
    assert.equal(await toggleSource(app), true, `${label} could not inspect cold source`)
    const source = await waitFor(() => visibleSource(app), `${label} cold source did not open`)
    assertSourceView(source, `${label} cold reopen`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const runScenario = async ({ name, immediateFlush, port }) => {
  const file = join(root, `${name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${name}-edit`, port })
  try {
    await clearDiagnostics(app)
    await addTargetRow(app)

    let source
    if (immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not trigger forced flush`)
      source = await waitFor(() => visibleSource(app), `${name} forced source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
      await sleep(650)
    } else {
      await sleep(1100)
    }

    const state = await snapshot(app)
    console.log(`${name.toUpperCase()}_AFTER_TABLE_ROW_INSERT:`, JSON.stringify(state))
    assertPublication(
      state,
      immediateFlush
        ? 'transaction-table-row-insert-forced-flush'
        : 'transaction-table-row-insert-markdown-updated',
      name
    )

    if (!immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not inspect source`)
      source = await waitFor(() => visibleSource(app), `${name} source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
    }

    await save(app, name)
    assert.equal(await readFile(file, 'utf8'), expected,
      `${name} saved bytes differ from selected row insertion`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  await reopenAndVerify({
    file,
    profile: `${name}-reopen`,
    port: port + 1,
    label: name
  })
}

let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await runScenario({ name: 'settled-reconcile', immediateFlush: false, port: basePort })
  await runScenario({ name: 'immediate-source-flush', immediateFlush: true, port: basePort + 10 })
  completed = true
  console.log('PASS transaction-owned table row insert UI: real Milkdown x-line add button inserts one author-style empty row after the selected duplicate row, preserves table spacing/alignment/BOM/CRLF/other rows/neighbour, settled dirty-reconcile/immediate-source flush, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
