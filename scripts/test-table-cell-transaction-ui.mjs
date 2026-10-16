import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-table-cell-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13410 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = '\uFEFF' + [
  '# table cell transaction',
  '',
  '| Key  | Value | Note     |',
  '| :--- | ----: | :------- |',
  '| same | alpha | repeated |',
  '| same | beta  | repeated |',
  '',
  'after table',
  ''
].join('\r\n')

const expected = fixture.replace(
  '| same | beta  | repeated |',
  '| same | beta  | repeatedXY |'
)

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

const expectedRowsBefore = [
  ['Key', 'Value', 'Note'],
  ['same', 'alpha', 'repeated'],
  ['same', 'beta', 'repeated']
]
const expectedRowsAfter = [
  ['Key', 'Value', 'Note'],
  ['same', 'alpha', 'repeated'],
  ['same', 'beta', 'repeatedXY']
]

const openApp = async ({ file, profile, port, edited = false }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    const expectedRows = edited ? expectedRowsAfter : expectedRowsBefore
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
      `table cell editor did not mount for ${profile}`
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

const focusTargetCellEnd = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const rows = [...(editor?.querySelectorAll('table tr') || [])]
    const cell = rows[2]?.querySelectorAll('th,td')?.[2]
    if (!editor || !cell || (cell.textContent || '').trim() !== 'repeated') {
      return { ok: false, reason: 'target-cell-not-found', rows: rows.length }
    }
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    let target = null
    let node
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || '').includes('repeated')) target = node
    }
    if (!target) return { ok: false, reason: 'target-text-node-not-found' }
    const offset = (target.nodeValue || '').indexOf('repeated') + 'repeated'.length
    const range = document.createRange()
    range.setStart(target, offset)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, text: cell.textContent || '', offset: selection.anchorOffset }
  })()`)
  assert.equal(result.ok, true, `could not focus table cell: ${JSON.stringify(result)}`)
  await sleep(80)
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
      sourceTail: String(source || '').slice(-900),
      previousTail: String(previous || '').slice(-900),
      nextTail: String(next || '').slice(-900),
      markdownTail: String(markdown || '').slice(-900)
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
  assert.equal(source, expectedView, `${label} source differs from cell owner output`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes('| Key  | Value | Note     |'), true, `${label} changed header spacing`)
  assert.equal(source.includes('| :--- | ----: | :------- |'), true, `${label} changed alignment row`)
  assert.equal(source.includes('| same | alpha | repeated |'), true, `${label} changed first duplicate cell`)
  assert.equal(source.includes('| same | beta  | repeatedXY |'), true, `${label} missed target cell`)
  assert.equal(source.includes('after table'), true, `${label} changed neighbour paragraph`)
}

const assertPublication = (state, boundary, label) => {
  assert.deepEqual(state.rows, expectedRowsAfter, `${label} table DOM differs`)
  assert.equal(state.documentText.includes('after table'), true, `${label} changed neighbour paragraph`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed source-sync warning: ${JSON.stringify(state.toasts)}`)

  const captures = state.journalTrace.filter((entry) => entry.phase === 'capture' && entry.ok === true)
  assert.equal(captures.length >= 2, true,
    `${label} did not capture X/Y transactions: ${JSON.stringify(state.journalTrace)}`)
  assert.equal(new Set(captures.map((entry) => entry.journalId)).size, 1,
    `${label} restarted table journal: ${JSON.stringify(captures)}`)
  const finalCapture = captures.at(-1)

  const preservation = state.preserve.find((entry) =>
    entry.reason === 'table-cell-plain-text-change' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-table-cell-proof'
  )
  assert.ok(preservation, `${label} did not publish table cell owner: ${JSON.stringify(state.preserve)}`)
  assert.equal(preservation.integrityProof.family, 'table-cell-plain-text-replace')
  assert.deepEqual(preservation.integrityProof.nodePath, [1, 2, 2])
  assert.deepEqual(preservation.integrityProof.tablePath, [1])
  assert.deepEqual(preservation.integrityProof.rowPath, [1, 2])
  assert.equal(preservation.integrityProof.rowIndex, 2)
  assert.equal(preservation.integrityProof.cellIndex, 2)
  assert.equal(preservation.integrityProof.previousText, 'repeated')
  assert.equal(preservation.integrityProof.nextText, 'repeatedXY')
  assert.equal(preservation.integrityProof.chainLength >= 2, true)
  assert.equal(preservation.integrityProof.transactionJournal?.journalId, finalCapture.journalId)
  assert.equal(preservation.integrityProof.transactionJournal?.snapshotMatched, true)
  assert.equal(preservation.integrityProof.transactionJournal?.documentMatched, true)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'table-cell-plain-text-change' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} table cell candidate not equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'table-cell-plain-text-replace' &&
    entry.boundary === boundary
  ), true, `${label} bypassed Coordinator table boundary: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.ownerTrace.some((entry) =>
    entry.phase === 'published' &&
    entry.ok === true &&
    entry.family === 'table-cell-plain-text-replace' &&
    entry.boundary === boundary
  ), true, `${label} missing table owner trace: ${JSON.stringify(state.ownerTrace)}`)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({ file, profile, port, edited: true })
  try {
    const state = await snapshot(app)
    assert.deepEqual(state.rows, expectedRowsAfter, `${label} cold reopen table differs`)
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
    await focusTargetCellEnd(app)
    await typeTextLikeUser(app.send, 'XY', { delayMs: immediateFlush ? 1 : 8 })

    let source
    if (immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not trigger forced flush`)
      source = await waitFor(() => visibleSource(app), `${name} forced source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
      await sleep(700)
    } else {
      await sleep(1100)
    }

    const state = await snapshot(app)
    console.log(`${name.toUpperCase()}_AFTER_TABLE_CELL:`, JSON.stringify(state))
    assertPublication(
      state,
      immediateFlush
        ? 'transaction-table-cell-forced-flush'
        : 'transaction-table-cell-markdown-updated',
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
      `${name} saved bytes differ from table cell owner output`)
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
  await runScenario({ name: 'callback', immediateFlush: false, port: basePort })
  await runScenario({ name: 'forced-flush', immediateFlush: true, port: basePort + 10 })
  completed = true
  console.log('PASS transaction-owned table cell UI: rapid text edits one duplicate GFM cell, preserves stable path/table layout/BOM/CRLF/other cells/neighbour, callback/forced flush, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
