import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-blockquote-paragraph-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13120 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const originalText = 'quoted alpha'
const insertedText = 'XY'
const nextText = originalText + insertedText

const fixture = '\uFEFF' + [
  '# blockquote paragraph transaction',
  '',
  '- authored bullet',
  '',
  ' > quoted alpha',
  '',
  '- following bullet',
  ''
].join('\r\n')

const expected = fixture.replace(originalText, nextText)

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

const openApp = async ({ file, profile, port, expectedQuote = originalText }) => {
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
        return Boolean(
          editor &&
          (editor.textContent || '').includes('authored bullet') &&
          (editor.textContent || '').includes('following bullet') &&
          [...editor.querySelectorAll('blockquote p')]
            .some((node) => (node.textContent || '') === ${JSON.stringify(expectedQuote)})
        )
      })()`),
      `blockquote editor did not mount for ${profile}`
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
  window.__hmBlockquoteTransactionTrace = []
  window.__hmCodeBlockTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const focusEndOfQuoteParagraph = async (app, value) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const paragraph = [...(editor?.querySelectorAll('blockquote p') || [])]
      .find((node) => (node.textContent || '') === ${JSON.stringify(value)})
    if (!editor || !paragraph) return { ok: false, reason: 'quote-paragraph-not-found' }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const target = nodes.at(-1)
    if (!target) return { ok: false, reason: 'quote-text-node-not-found' }
    const range = document.createRange()
    range.setStart(target, target.nodeValue.length)
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
  assert.equal(result.ok, true, `could not focus quote paragraph: ${JSON.stringify(result)}`)
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
      validationSite: entry.validationSite
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-80),
    ownerTrace: (window.__hmBlockquoteTransactionTrace || []).slice(-80),
    flush: (window.__hmFlushTrace || []).slice(-30),
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
  assert.equal(source, expectedView, `${label} source differs from quote owner output`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes(` > ${nextText}\n`), true, `${label} lost authored quote prefix`)
  assert.equal(source.includes('> >'), false, `${label} introduced a nested quote prefix`)
  assert.equal(source.includes('- authored bullet'), true, `${label} changed preceding list`)
  assert.equal(source.includes('- following bullet'), true, `${label} changed following list`)
}

const assertPublication = (state, expectedBoundary, label) => {
  assert.deepEqual(state.quoteTexts, [nextText], `${label} rich quote differs: ${JSON.stringify(state.quoteTexts)}`)
  assert.equal(state.documentText.includes('authored bullet'), true, `${label} changed preceding list`)
  assert.equal(state.documentText.includes('following bullet'), true, `${label} changed following list`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed source-sync warning: ${JSON.stringify(state.toasts)}`)

  const captures = state.journalTrace.filter((entry) =>
    entry.phase === 'capture' && entry.ok === true
  )
  assert.equal(captures.length >= 2, true,
    `${label} did not capture both physical character transactions: ${JSON.stringify(state.journalTrace)}`)
  assert.equal(new Set(captures.map((entry) => entry.journalId)).size, 1,
    `${label} restarted the journal inside one callback window: ${JSON.stringify(captures)}`)
  const finalCapture = captures.at(-1)
  assert.equal(finalCapture.transactionCount >= 2, true,
    `${label} journal did not retain the rapid ReplaceStep chain: ${JSON.stringify(finalCapture)}`)

  const preservation = state.preserve.find((entry) =>
    entry.reason === 'blockquote-paragraph-text-change' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-blockquote-paragraph-proof'
  )
  assert.ok(preservation, `${label} did not publish quote owner: ${JSON.stringify(state.preserve)}`)
  assert.equal(preservation.integrityProof.family, 'blockquote-paragraph-text-replace')
  assert.equal(preservation.integrityProof.previousText, originalText)
  assert.equal(preservation.integrityProof.nextText, nextText)
  assert.equal(preservation.integrityProof.chainLength >= 2, true)
  assert.equal(preservation.integrityProof.transactionJournal?.journalId, finalCapture.journalId)
  assert.equal(preservation.integrityProof.transactionJournal?.snapshotMatched, true)
  assert.equal(preservation.integrityProof.transactionJournal?.documentMatched, true)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'blockquote-paragraph-text-change' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} quote candidate was not fully equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'blockquote-paragraph-text-replace' &&
    entry.boundary === expectedBoundary
  ), true, `${label} bypassed Coordinator quote boundary: ${JSON.stringify(state.coordinator)}`)

  const ownerPublication = state.ownerTrace.find((entry) =>
    entry.phase === 'published' &&
    entry.ok === true &&
    entry.family === 'blockquote-paragraph-text-replace' &&
    entry.boundary === expectedBoundary
  )
  assert.ok(ownerPublication,
    `${label} did not emit quote owner publication trace: ${JSON.stringify(state.ownerTrace)}`)
  assert.equal(ownerPublication.journalId, finalCapture.journalId)
  assert.equal(ownerPublication.baseRevision, finalCapture.baseRevision)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({ file, profile, port, expectedQuote: nextText })
  try {
    const state = await snapshot(app)
    assert.deepEqual(state.quoteTexts, [nextText], `${label} cold reopen lost quote text`)
    assert.equal(state.documentText.includes('authored bullet'), true, `${label} cold reopen changed preceding list`)
    assert.equal(state.documentText.includes('following bullet'), true, `${label} cold reopen changed following list`)
    assert.equal(await toggleSource(app), true, `${label} could not inspect cold-reopened source`)
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
    await focusEndOfQuoteParagraph(app, originalText)
    await typeTextLikeUser(app.send, insertedText, {
      delayMs: immediateFlush ? 1 : 8
    })

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
    console.log(`${name.toUpperCase()}_AFTER_QUOTE_CHANGE:`, JSON.stringify(state))
    assertPublication(
      state,
      immediateFlush
        ? 'transaction-blockquote-paragraph-forced-flush'
        : 'transaction-blockquote-paragraph-markdown-updated',
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
      `${name} saved bytes differ from quote owner output`)
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
  console.log('PASS transaction-owned blockquote paragraph UI: physical callback/forced flush preserve authored quote prefix, BOM/CRLF, neighbours, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
