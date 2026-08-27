import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-middle-codeblock-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 12920 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = '\uFEFF' + [
  '# code block transaction',
  '',
  '- authored bullet',
  '',
  '1. surrounding text',
  '',
  '~~~js',
  '',
  '~~~',
  '',
  '- following bullet',
  ''
].join('\r\n')

const expectedSource = (marker) => fixture.replace(
  '~~~js\r\n\r\n~~~',
  `~~~js\r\n${marker}\r\n~~~`
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

const openApp = async ({ file, profile, port }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(
      () => app.evaluate(`Boolean(${visibleEditor()}?.querySelector('.milkdown-code-block .cm-content'))`),
      `middle code-block editor did not mount for ${profile}`
    )
    await sleep(500)
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
  window.__hmCodeBlockTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const clickCodeBlock = async (app) => {
  const point = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const content = editor?.querySelector('.milkdown-code-block .cm-content')
    if (!content) return null
    const rect = content.getBoundingClientRect()
    return {
      x: rect.left + Math.max(8, Math.min(30, rect.width / 2)),
      y: rect.top + Math.max(8, Math.min(18, rect.height / 2))
    }
  })()`)
  assert.ok(point, 'empty middle code block was not rendered')
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
  const codeBlocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
  return {
    documentText: editor?.innerText || '',
    codeBlockCount: codeBlocks.length,
    codeTexts: codeBlocks.map((node) =>
      (node.querySelector('.cm-content')?.textContent || node.textContent || '').replace(/\\u200B/g, '')
    ),
    preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-500),
      previousTail: String(previous || '').slice(-500),
      nextTail: String(next || '').slice(-500),
      markdownTail: String(markdown || '').slice(-500)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite,
      candidateTail: String(entry.candidate || '').slice(-500),
      canonicalTail: String(entry.canonical || '').slice(-500)
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-60),
    codeOwnerTrace: (window.__hmCodeBlockTransactionTrace || []).slice(-60),
    listOwnerTrace: (window.__hmListSubtreeTransactionTrace || []).slice(-60),
    flush: (window.__hmFlushTrace || []).slice(-30),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const save = async (app, label) => {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), `${label} save button did not appear`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not finish`)
}

// A textarea exposes normalized LF logical text even when the backing source
// snapshot and saved file retain CRLF. Source-mode assertions therefore check
// semantic/raw spelling in the DOM view; the save assertion below remains a
// byte-for-byte BOM+CRLF comparison against the physical file.
const assertSourceView = (source, marker, label) => {
  const expected = expectedSource(marker).replace(/\r\n/g, '\n')
  assert.equal(source, expected, `${label} source view differs from the transaction-owned fenced result`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source view lost the authored BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed a non-normalized CR byte`)
  assert.equal(source.includes('~~~js\n'), true, `${label} changed the authored tilde fence or info string`)
  assert.equal(source.includes('```js'), false, `${label} replaced authored tilde fences with canonical backticks`)
  assert.equal(source.split(marker).length - 1, 1, `${label} duplicated or lost the code marker`)
}

const assertTransactionPublication = (state, marker, expectedBoundary, label) => {
  assert.equal(state.codeBlockCount, 1, `${label} created or deleted a code block: ${JSON.stringify(state)}`)
  assert.equal(state.codeTexts.some((value) => value.includes(marker)), true,
    `${label} rich code block does not contain ${marker}: ${JSON.stringify(state.codeTexts)}`)
  assert.equal(state.documentText.includes('authored bullet'), true, `${label} changed the preceding list`)
  assert.equal(state.documentText.includes('following bullet'), true, `${label} changed the following list`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced a source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed a source-sync warning: ${JSON.stringify(state.toasts)}`)

  const journalCaptures = state.journalTrace.filter((entry) => entry.phase === 'capture' && entry.ok === true)
  assert.equal(journalCaptures.length >= 2, true,
    `${label} did not accumulate multiple physical text dispatches: ${JSON.stringify(state.journalTrace)}`)
  assert.equal(new Set(journalCaptures.map((entry) => entry.journalId)).size, 1,
    `${label} restarted the shared journal before code publication: ${JSON.stringify(journalCaptures)}`)
  const finalCapture = journalCaptures.at(-1)
  assert.equal(finalCapture.transactionCount >= 2, true,
    `${label} journal did not retain the code transaction chain: ${JSON.stringify(finalCapture)}`)

  const preservation = state.preserve.find((entry) =>
    entry.reason === 'fenced-code-block-content-change' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-code-block-content-proof'
  )
  assert.ok(preservation,
    `${label} did not publish the code-block transaction owner: ${JSON.stringify(state.preserve)}`)
  assert.equal(preservation.integrityProof.family, 'code-block-content-replace')
  assert.equal(preservation.integrityProof.chainLength >= 2, true)
  assert.equal(preservation.integrityProof.transactionJournal?.journalId, finalCapture.journalId)
  assert.equal(preservation.integrityProof.transactionJournal?.baseRevision, finalCapture.baseRevision)
  assert.equal(preservation.integrityProof.transactionJournal?.snapshotMatched, true)
  assert.equal(preservation.integrityProof.transactionJournal?.documentMatched, true)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'fenced-code-block-content-change' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} transaction candidate was not fully equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'code-block-content-replace' &&
    entry.boundary === expectedBoundary
  ), true, `${label} bypassed the Coordinator transaction boundary: ${JSON.stringify(state.coordinator)}`)

  const ownerPublication = state.codeOwnerTrace.find((entry) =>
    entry.phase === 'published' &&
    entry.ok === true &&
    entry.family === 'code-block-content-replace'
  )
  assert.ok(ownerPublication,
    `${label} did not emit code owner publication trace: ${JSON.stringify(state.codeOwnerTrace)}`)
  assert.equal(ownerPublication.boundary, expectedBoundary)
  assert.equal(ownerPublication.journalId, finalCapture.journalId)
  assert.equal(ownerPublication.baseRevision, finalCapture.baseRevision)
}

const reopenAndVerify = async ({ file, marker, profile, port, label }) => {
  const app = await openApp({ file, profile, port })
  try {
    const state = await snapshot(app)
    assert.equal(state.codeBlockCount, 1, `${label} cold reopen changed code-block count`)
    assert.equal(state.codeTexts.some((value) => value.includes(marker)), true,
      `${label} cold reopen lost the code marker: ${JSON.stringify(state.codeTexts)}`)
    assert.equal(await toggleSource(app), true, `${label} could not inspect cold-reopened source`)
    const source = await waitFor(() => visibleSource(app), `${label} cold-reopened source did not open`)
    assertSourceView(source, marker, `${label} cold reopen`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const runScenario = async ({ name, immediateFlush, port }) => {
  const marker = `${name}_${process.pid}`
  const file = join(root, `${name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${name}-edit`, port })
  try {
    await clearDiagnostics(app)
    await clickCodeBlock(app)
    await typeTextLikeUser(app.send, marker, { delayMs: immediateFlush ? 1 : 3 })

    let source
    if (immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not trigger immediate source flush`)
      source = await waitFor(() => visibleSource(app), `${name} forced-flush source did not open`)
      assertSourceView(source, marker, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
      await sleep(800)
    } else {
      await sleep(1100)
    }

    const state = await snapshot(app)
    console.log(`${name.toUpperCase()}_AFTER_CODE_EDIT:`, JSON.stringify(state))
    assertTransactionPublication(
      state,
      marker,
      immediateFlush
        ? 'transaction-code-block-forced-flush'
        : 'transaction-code-block-markdown-updated',
      name
    )

    if (!immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not inspect source`)
      source = await waitFor(() => visibleSource(app), `${name} source did not open`)
      assertSourceView(source, marker, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
    }

    await save(app, name)
    assert.equal(await readFile(file, 'utf8'), expectedSource(marker), `${name} saved bytes differ from inspected source`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  await reopenAndVerify({
    file,
    marker,
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
  console.log('PASS transaction-owned code block UI: callback and immediate forced flush preserve authored tilde fence, BOM/CRLF, neighbours, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
