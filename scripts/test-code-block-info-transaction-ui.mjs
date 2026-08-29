import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-code-info-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13020 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const previousLanguage = 'JavaScript'
const nextLanguage = 'TypeScript'

const fixture = '\uFEFF' + [
  '# code info transaction',
  '',
  '- authored bullet',
  '',
  `~~~   ${previousLanguage}  `,
  'const value = 1',
  '~~~',
  '',
  '- following bullet',
  ''
].join('\r\n')

const expected = fixture.replace(
  `~~~   ${previousLanguage}  `,
  `~~~   ${nextLanguage}  `
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
      () => app.evaluate(`Boolean(${visibleEditor()}?.querySelector('.milkdown-code-block .language-button'))`),
      `code-info editor did not mount for ${profile}`
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

const clickVisible = async (app, selector, message) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const node = candidates.find((candidate) => candidate.offsetParent)
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`), message)
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

const chooseLanguage = async (app) => {
  await clickVisible(
    app,
    '.milkdown-code-block .language-button',
    'language button did not become visible'
  )
  await waitFor(() => app.evaluate(`Boolean(
    [...document.querySelectorAll('.language-picker .search-input')]
      .find((node) => node.offsetParent)
  )`), 'language picker did not open')
  await sleep(80)
  await typeTextLikeUser(app.send, nextLanguage, { delayMs: 3 })
  const itemSelector = `.language-list-item[data-language="${nextLanguage}"]`
  await clickVisible(app, itemSelector, 'TypeScript language item did not appear')
  await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const button = editor?.querySelector('.milkdown-code-block .language-button')
    return button?.textContent?.trim() === ${JSON.stringify(nextLanguage)}
  })()`), 'language picker did not update the code block')
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
  const codeBlock = editor?.querySelector('.milkdown-code-block')
  return {
    documentText: editor?.innerText || '',
    language: codeBlock?.querySelector('.language-button')?.textContent?.trim() || '',
    codeText: (codeBlock?.querySelector('.cm-content')?.textContent || '').replace(/\\u200B/g, ''),
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
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-60),
    ownerTrace: (window.__hmCodeBlockTransactionTrace || []).slice(-80),
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

const assertSourceView = (source, label) => {
  assert.equal(source, expected.replace(/\r\n/g, '\n'), `${label} source differs from info owner output`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes(`~~~   ${nextLanguage}  \n`), true, `${label} lost authored info padding`)
  assert.equal(source.includes('```'), false, `${label} canonicalized authored tilde fences`)
  assert.equal(source.includes('const value = 1'), true, `${label} changed code body`)
}

const assertPublication = (state, expectedBoundary, label) => {
  assert.equal(state.language, nextLanguage, `${label} rich language did not update`)
  assert.equal(state.codeText.includes('const value = 1'), true, `${label} changed code body`)
  assert.equal(state.documentText.includes('authored bullet'), true, `${label} changed preceding list`)
  assert.equal(state.documentText.includes('following bullet'), true, `${label} changed following list`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed source-sync warning: ${JSON.stringify(state.toasts)}`)

  const capture = state.journalTrace.find((entry) => entry.phase === 'capture' && entry.ok === true)
  assert.ok(capture, `${label} did not capture the AttrStep journal: ${JSON.stringify(state.journalTrace)}`)

  const preservation = state.preserve.find((entry) =>
    entry.reason === 'fenced-code-block-info-string-change' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-code-block-info-proof'
  )
  assert.ok(preservation, `${label} did not publish info owner: ${JSON.stringify(state.preserve)}`)
  assert.equal(preservation.integrityProof.family, 'code-block-info-string-change')
  assert.equal(preservation.integrityProof.previousLanguage, previousLanguage)
  assert.equal(preservation.integrityProof.nextLanguage, nextLanguage)
  assert.equal(preservation.integrityProof.transactionJournal?.journalId, capture.journalId)
  assert.equal(preservation.integrityProof.transactionJournal?.snapshotMatched, true)
  assert.equal(preservation.integrityProof.transactionJournal?.documentMatched, true)
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'fenced-code-block-info-string-change' &&
    entry.integrityProof?.kind !== 'transaction-code-block-info-proof'
  ), false, `${label} allowed a legacy info-string publication`)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'legacy' &&
    entry.reason === 'fenced-code-block-info-string-change'
  ), false, `${label} published code-block info through the legacy owner`)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'fenced-code-block-info-string-change' &&
    entry.semanticOk === true &&
    entry.listSlotsMatch === true &&
    entry.ok === true
  ), true, `${label} candidate was not fully equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'code-block-info-string-change' &&
    entry.boundary === expectedBoundary
  ), true, `${label} bypassed Coordinator boundary: ${JSON.stringify(state.coordinator)}`)

  assert.equal(state.ownerTrace.some((entry) =>
    entry.phase === 'published' &&
    entry.ok === true &&
    entry.family === 'code-block-info-string-change' &&
    entry.boundary === expectedBoundary
  ), true, `${label} did not emit info owner trace: ${JSON.stringify(state.ownerTrace)}`)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({ file, profile, port })
  try {
    const state = await snapshot(app)
    assert.equal(state.language, nextLanguage, `${label} cold reopen lost language`)
    assert.equal(state.codeText.includes('const value = 1'), true, `${label} cold reopen lost body`)
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
    await chooseLanguage(app)

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
    console.log(`${name.toUpperCase()}_AFTER_LANGUAGE_CHANGE:`, JSON.stringify(state))
    assertPublication(
      state,
      immediateFlush
        ? 'transaction-code-block-info-forced-flush'
        : 'transaction-code-block-info-markdown-updated',
      name
    )

    if (!immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not inspect source`)
      source = await waitFor(() => visibleSource(app), `${name} source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
    }

    await save(app, name)
    assert.equal(await readFile(file, 'utf8'), expected, `${name} saved bytes differ from info owner result`)
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
  console.log('PASS transaction-owned code info UI: language picker callback/forced flush preserve authored fence padding, BOM/CRLF, body, neighbours, source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
