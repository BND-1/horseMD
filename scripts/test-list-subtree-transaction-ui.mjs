import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-subtree-transaction-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 12840 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const parentText = '啊额法色饭'
const childText = '微'
const codeLineOne = '尼玛，吗了解'
const codeLineTwo = '了几百块'

const fixture = [
  '# List subtree transaction', '',
  '- authored marker',
  '- 1\\. literal', '',
  '1. 啊额法色饭',
  '   1. 微', '',
  '```txt',
  codeLineOne,
  codeLineTwo,
  '```', '',
  '后文', ''
].join('\n')
const expected = fixture.replace('1. 啊额法色饭\n   1. 微', '1. 啊额法色饭')

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const openApp = async ({ file, profile, port, requireChild = true }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent &&
          (node.textContent || '').includes(${JSON.stringify(parentText)}) &&
          (${JSON.stringify(requireChild)} === false ||
            (node.textContent || '').includes(${JSON.stringify(childText)})) &&
          (node.textContent || '').includes(${JSON.stringify(codeLineOne)})))`),
      `list-subtree editor did not mount for ${profile}`
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
  window.__hmListSubtreeTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const focusEndOfParagraph = async (app, value) => {
  const result = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => (node.textContent || '') === ${JSON.stringify(value)})
    if (!editor || !paragraph) return { ok: false, reason: 'paragraph-not-found' }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const target = nodes.at(-1)
    if (!target) return { ok: false, reason: 'text-node-not-found' }
    const range = document.createRange()
    range.setStart(target, target.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, text: paragraph.textContent || '', offset: selection.anchorOffset }
  })()`)
  assert.equal(result.ok, true, `could not focus nested paragraph: ${JSON.stringify(result)}`)
  await sleep(80)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const paragraphs = [...(editor?.querySelectorAll('p') || [])]
  const codeBlocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
  const topOrdered = [...(editor?.querySelectorAll('ol') || [])]
    .filter((node) => !node.closest('li')).length
  return {
    parentExists: paragraphs.some((node) => (node.textContent || '') === ${JSON.stringify(parentText)}),
    childExists: paragraphs.some((node) => (node.textContent || '') === ${JSON.stringify(childText)}),
    nestedOrdered: editor?.querySelectorAll('ol ol').length || 0,
    topOrdered,
    codeBlockCount: codeBlocks.length,
    codeTexts: codeBlocks.map((node) =>
      (node.querySelector('.cm-content')?.textContent || node.textContent || '').replace(/\\u200B/g, '')
    ),
    preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      sourceTail: String(source || '').slice(-700),
      previousTail: String(previous || '').slice(-700),
      nextTail: String(next || '').slice(-700),
      markdownTail: String(markdown || '').slice(-700)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite,
      candidateTail: String(entry.candidate || '').slice(-700),
      canonicalTail: String(entry.canonical || '').slice(-700)
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-50),
    ownerTrace: (window.__hmListSubtreeTransactionTrace || []).slice(-50),
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

const assertRichAndDiagnostics = (state, expectedBoundary, label) => {
  assert.equal(state.parentExists, true, `${label} lost the parent ordered item: ${JSON.stringify(state)}`)
  assert.equal(state.childExists, false, `${label} retained the deleted nested child: ${JSON.stringify(state)}`)
  assert.equal(state.nestedOrdered, 0, `${label} retained a nested ordered subtree: ${JSON.stringify(state)}`)
  assert.equal(state.topOrdered, 1, `${label} changed the top-level ordered list count: ${JSON.stringify(state)}`)
  assert.equal(state.codeBlockCount, 1, `${label} created or deleted a neighbouring code block: ${JSON.stringify(state)}`)
  assert.equal(state.codeTexts.some((value) => value.includes(codeLineOne) && value.includes(codeLineTwo)), true,
    `${label} changed the neighbouring code block body: ${JSON.stringify(state.codeTexts)}`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced a source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed a source-sync warning: ${JSON.stringify(state.toasts)}`)
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'transaction-list-subtree' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-list-subtree-proof' &&
    entry.integrityProof?.mapperReason === 'diverged-nested-list-change' &&
    entry.integrityProof?.chainLength >= 2
  ), true, `${label} did not publish the generic transaction-owned list subtree: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'transaction-list-subtree' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} transaction candidate was not fully equivalent: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'list-subtree-replace' &&
    entry.boundary === expectedBoundary
  ), true, `${label} bypassed the SourceSyncCoordinator transaction publication: ${JSON.stringify(state.coordinator)}`)
  const journalCaptures = state.journalTrace.filter((entry) =>
    entry.phase === 'capture' && entry.ok === true
  )
  assert.equal(journalCaptures.length >= 2, true,
    `${label} did not accumulate multiple physical dispatches in the shared journal: ${JSON.stringify(state.journalTrace)}`)
  assert.equal(new Set(journalCaptures.map((entry) => entry.journalId)).size, 1,
    `${label} restarted the journal inside one deferred callback window: ${JSON.stringify(journalCaptures)}`)
  const finalCapture = journalCaptures.at(-1)
  assert.equal(finalCapture.transactionCount >= 2, true,
    `${label} journal did not retain the structural transaction chain: ${JSON.stringify(finalCapture)}`)
  const ownerPublication = state.ownerTrace.find((entry) =>
    entry.phase === 'published' && entry.ok === true && entry.chainLength >= 2
  )
  assert.ok(ownerPublication,
    `${label} did not complete the list owner publication: ${JSON.stringify(state.ownerTrace)}`)
  assert.equal(ownerPublication.journalId, finalCapture.journalId,
    `${label} owner publication was not derived from the captured journal`)
  assert.equal(ownerPublication.baseRevision, finalCapture.baseRevision,
    `${label} owner publication silently rebound to another Coordinator revision`)
  assert.equal(state.preserve.some((entry) =>
    entry.integrityProof?.transactionJournal?.journalId === finalCapture.journalId &&
    entry.integrityProof?.transactionJournal?.baseRevision === finalCapture.baseRevision &&
    entry.integrityProof?.transactionJournal?.snapshotMatched === true &&
    entry.integrityProof?.transactionJournal?.documentMatched === true
  ), true, `${label} preservation proof did not embed the verified transaction journal`)
}

const assertExactSource = (source, label) => {
  assert.equal(source, expected, `${label} source bytes differ from the transaction-owned list result`)
  assert.equal((source.match(/^```(?:txt)?$/gm) || []).length, 2,
    `${label} introduced an empty or duplicate fenced code block`)
  assert.equal(source.includes('   1. 微'), false, `${label} retained the deleted nested row`)
  assert.equal(source.includes(`${codeLineOne}\n${codeLineTwo}`), true, `${label} changed code-block bytes`)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({ file, profile, port, requireChild: false })
  try {
    const state = await snapshot(app)
    assert.equal(state.parentExists, true, `${label} cold reopen lost the parent item`)
    assert.equal(state.childExists, false, `${label} cold reopen restored the deleted child`)
    assert.equal(state.nestedOrdered, 0, `${label} cold reopen restored the nested list`)
    assert.equal(state.codeBlockCount, 1, `${label} cold reopen changed code-block count`)
    assert.equal(await toggleSource(app), true, `${label} could not inspect reopened source`)
    const source = await waitFor(() => visibleSource(app), `${label} reopened source did not open`)
    assertExactSource(source, `${label} reopened`)
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
    await focusEndOfParagraph(app, childText)

    // One text deletion followed immediately by two structural Backspaces.
    // The complete oldDoc -> finalDoc list lifecycle must remain one pending
    // transaction checkpoint; no intermediate empty-list representation is a
    // publication boundary.
    for (let index = 0; index < 3; index += 1) {
      await pressKey(app.send, {
        key: 'Backspace',
        code: 'Backspace',
        delayMs: immediateFlush ? 1 : 8
      })
    }

    let source
    if (immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not trigger immediate source flush`)
      source = await waitFor(() => visibleSource(app), `${name} forced-flush source did not open`)
      assertExactSource(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
      await sleep(700)
    } else {
      await sleep(1100)
    }

    const state = await snapshot(app)
    console.log(`${name.toUpperCase()}_AFTER_DELETE:`, JSON.stringify(state))
    assertRichAndDiagnostics(
      state,
      immediateFlush
        ? 'transaction-list-subtree-forced-flush'
        : 'transaction-list-subtree-markdown-updated',
      name
    )

    if (!immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not inspect source`)
      source = await waitFor(() => visibleSource(app), `${name} source did not open`)
      assertExactSource(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
    }

    await save(app, name)
    assert.equal(await readFile(file, 'utf8'), expected, `${name} saved bytes differ from inspected source`)
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
  console.log('PASS transaction-owned list subtree UI: callback and immediate forced flush preserve the exact list range, neighbour code block, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
