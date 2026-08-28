import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-blockquote-exit-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13340 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const quoteText = 'alpha'
const exitedText = 'XY'

const fixture = '\uFEFF' + [
  '# blockquote exit transaction',
  '',
  '- holder',
  '',
  '  >   alpha',
  '',
  '- following',
  ''
].join('\r\n')

const expected = '\uFEFF' + [
  '# blockquote exit transaction',
  '',
  '- holder',
  '',
  '  >   alpha',
  '',
  '  XY',
  '',
  '- following',
  ''
].join('\r\n')

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

const openApp = async ({ file, profile, port, exited = false }) => {
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
        const quoteTexts = [...(editor?.querySelectorAll('blockquote p') || [])]
          .map((node) => node.textContent || '')
        const paragraphs = [...(editor?.querySelectorAll('p') || [])]
          .filter((node) => !node.closest('blockquote'))
          .map((node) => node.textContent || '')
        return Boolean(
          editor &&
          (editor.textContent || '').includes('holder') &&
          (editor.textContent || '').includes('following') &&
          JSON.stringify(quoteTexts) === ${JSON.stringify(JSON.stringify([quoteText]))} &&
          (${exited ? `paragraphs.includes(${JSON.stringify(exitedText)})` : `!paragraphs.includes(${JSON.stringify(exitedText)})`})
        )
      })()`),
      `blockquote exit editor did not mount for ${profile}`
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
  window.__hmBlockquoteTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const focusQuoteEnd = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const paragraph = [...(editor?.querySelectorAll('blockquote p') || [])]
      .find((node) => (node.textContent || '') === ${JSON.stringify(quoteText)})
    if (!editor || !paragraph) return { ok: false, reason: 'quote-paragraph-not-found' }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let target = null
    let node
    while ((node = walker.nextNode())) target = node
    if (!target) return { ok: false, reason: 'quote-text-node-not-found' }
    const range = document.createRange()
    range.setStart(target, target.nodeValue?.length || 0)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return {
      ok: true,
      text: paragraph.textContent || '',
      offset: selection.anchorOffset
    }
  })()`)
  assert.equal(result.ok, true, `could not focus quote tail: ${JSON.stringify(result)}`)
  assert.equal(result.offset, quoteText.length)
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
    documentText: editor?.innerText || '',
    quoteTexts: [...(editor?.querySelectorAll('blockquote p') || [])]
      .map((node) => node.textContent || ''),
    outsideParagraphs: [...(editor?.querySelectorAll('p') || [])]
      .filter((node) => !node.closest('blockquote'))
      .map((node) => node.textContent || ''),
    preserve: (window.__hmPreserveLog || []).slice(-50).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-800),
      previousTail: String(previous || '').slice(-800),
      nextTail: String(next || '').slice(-800),
      markdownTail: String(markdown || '').slice(-800)
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
    ownerTrace: (window.__hmBlockquoteTransactionTrace || []).slice(-120),
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
  assert.equal(source, expectedView, `${label} source differs from exit owner output`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes('  >   alpha\n\n  XY\n'), true,
    `${label} lost authored quote prefix or exited paragraph indentation`)
  assert.equal(source.includes('  >\n'), false, `${label} leaked transient empty quote paragraph`)
  assert.equal(source.includes('- holder'), true, `${label} changed parent list marker`)
  assert.equal(source.includes('- following'), true, `${label} changed following list marker`)
}

const assertPublication = (state, expectedBoundary, expectedMode, label) => {
  assert.deepEqual(state.quoteTexts, [quoteText],
    `${label} changed quote content: ${JSON.stringify(state.quoteTexts)}`)
  assert.equal(state.outsideParagraphs.includes(exitedText), true,
    `${label} did not create exited paragraph: ${JSON.stringify(state.outsideParagraphs)}`)
  assert.equal(state.documentText.includes('holder'), true, `${label} changed holder item`)
  assert.equal(state.documentText.includes('following'), true, `${label} changed following item`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed source-sync warning: ${JSON.stringify(state.toasts)}`)

  const captures = state.journalTrace.filter((entry) =>
    entry.phase === 'capture' && entry.ok === true
  )
  assert.equal(captures.length >= 3, true,
    `${label} did not capture exit + follow-up transactions: ${JSON.stringify(state.journalTrace)}`)
  const finalCapture = captures.at(-1)

  const preservation = state.preserve.find((entry) =>
    entry.reason === 'blockquote-paragraph-exit' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-blockquote-exit-proof'
  )
  assert.ok(preservation, `${label} did not publish exit owner: ${JSON.stringify(state.preserve)}`)
  assert.equal(preservation.integrityProof.family, 'blockquote-paragraph-exit')
  assert.equal(preservation.integrityProof.mode, expectedMode)
  assert.deepEqual(preservation.integrityProof.parentPath, [1, 0])
  assert.deepEqual(preservation.integrityProof.nodePath, [1, 0, 1])
  assert.deepEqual(preservation.integrityProof.insertedPath, [1, 0, 2])
  assert.equal(preservation.integrityProof.parentType, 'list_item')
  assert.equal(preservation.integrityProof.splitStepName, expectedMode === 'coalesced' ? 'ReplaceStep' : null)
  assert.equal(preservation.integrityProof.exitStepName, 'ReplaceAroundStep')
  assert.equal(preservation.integrityProof.exitedText, exitedText)
  assert.equal(preservation.integrityProof.quotePrefix, '  >   ')
  assert.equal(preservation.integrityProof.exitedPrefix, '  ')
  assert.equal(preservation.integrityProof.eol, '\r\n')
  assert.equal(preservation.integrityProof.transactionJournal?.snapshotMatched, true)
  assert.equal(preservation.integrityProof.transactionJournal?.documentMatched, true)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'blockquote-paragraph-exit' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} exit candidate was not fully equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'blockquote-paragraph-exit' &&
    entry.boundary === expectedBoundary
  ), true, `${label} bypassed Coordinator exit boundary: ${JSON.stringify(state.coordinator)}`)

  const ownerPublication = state.ownerTrace.find((entry) =>
    entry.phase === 'published' &&
    entry.ok === true &&
    entry.family === 'blockquote-paragraph-exit' &&
    entry.boundary === expectedBoundary
  )
  assert.ok(ownerPublication,
    `${label} did not emit exit owner trace: ${JSON.stringify(state.ownerTrace)}`)
  assert.equal(ownerPublication.journalId, finalCapture.journalId)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({ file, profile, port, exited: true })
  try {
    const state = await snapshot(app)
    assert.deepEqual(state.quoteTexts, [quoteText], `${label} cold reopen changed quote`)
    assert.equal(state.outsideParagraphs.includes(exitedText), true,
      `${label} cold reopen lost exited paragraph`)
    assert.equal(await toggleSource(app), true, `${label} could not inspect cold source`)
    const source = await waitFor(() => visibleSource(app), `${label} cold source did not open`)
    assertSourceView(source, `${label} cold reopen`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const runScenario = async ({ name, mode, immediateFlush, port }) => {
  const file = join(root, `${name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${name}-edit`, port })
  try {
    await clearDiagnostics(app)
    await focusQuoteEnd(app)
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: mode === 'staged' ? 8 : 1 })
    if (mode === 'staged') {
      await sleep(1100)
      const transient = await snapshot(app)
      assert.equal(transient.integrity.some((entry) => entry.ok === false), false,
        `${name} first Enter transient failed: ${JSON.stringify(transient.integrity)}`)
      assert.equal(transient.toasts.some((text) => warningPattern.test(text)), false,
        `${name} first Enter transient warned: ${JSON.stringify(transient.toasts)}`)
      const pending = transient.preserve.find((entry) =>
        entry.reason === 'trailing-empty-blockquote-paragraph-created' &&
        entry.preserved === true &&
        entry.integrityProof?.kind === 'transaction-blockquote-exit-pending-proof'
      )
      assert.ok(pending,
        `${name} first Enter bypassed exit pending owner: ${JSON.stringify(transient.preserve)}`)
      assert.equal(pending.integrityProof.mode, 'pending')
      assert.deepEqual(pending.integrityProof.nodePath, [1, 0, 1])
      assert.equal(pending.integrityProof.chainLength, 1)
      assert.equal(transient.integrity.some((entry) =>
        entry.preservationReason === 'trailing-empty-blockquote-paragraph-created' &&
        entry.semanticOk === true &&
        entry.listSlotsMatch === true &&
        entry.ok === true
      ), true, `${name} pending candidate was not fully equivalent: ${JSON.stringify(transient.integrity)}`)
      assert.equal(transient.coordinator.some((entry) =>
        entry.phase === 'published' &&
        entry.owner === 'transaction' &&
        entry.family === 'blockquote-paragraph-exit' &&
        entry.reason === 'trailing-empty-blockquote-paragraph-created' &&
        entry.boundary === 'transaction-blockquote-exit-markdown-updated'
      ), true, `${name} pending phase bypassed Coordinator: ${JSON.stringify(transient.coordinator)}`)
      await clearDiagnostics(app)
    }
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: immediateFlush ? 1 : 5 })
    await typeTextLikeUser(app.send, exitedText, { delayMs: immediateFlush ? 1 : 5 })

    let source
    if (immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not trigger forced flush`)
      source = await waitFor(() => visibleSource(app), `${name} forced source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
      await sleep(700)
    } else {
      await sleep(1200)
    }

    const state = await snapshot(app)
    console.log(`${name.toUpperCase()}_AFTER_BLOCKQUOTE_EXIT:`, JSON.stringify(state))
    assertPublication(
      state,
      immediateFlush
        ? 'transaction-blockquote-exit-forced-flush'
        : 'transaction-blockquote-exit-markdown-updated',
      mode,
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
      `${name} saved bytes differ from exit owner output`)
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
  await runScenario({
    name: 'coalesced-callback',
    mode: 'coalesced',
    immediateFlush: false,
    port: basePort
  })
  await runScenario({
    name: 'staged-callback',
    mode: 'staged',
    immediateFlush: false,
    port: basePort + 10
  })
  await runScenario({
    name: 'coalesced-forced-flush',
    mode: 'coalesced',
    immediateFlush: true,
    port: basePort + 20
  })
  completed = true
  console.log('PASS transaction-owned blockquote exit UI: physical double Enter + rapid text cover coalesced/staged journals, stable nested path, authored quote prefix, BOM/CRLF, neighbours, callback/forced flush, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
