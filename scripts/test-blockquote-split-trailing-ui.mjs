import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

// E0 P3 acceptance — the 0.13.170 16:39:14 trace: Chinese IME composition in
// the LAST quote paragraph, commit, then an IMMEDIATE Enter at the paragraph
// end. The blockquote-split family must own the whole journal: the author's
// `> ` marker bytes/BOM/CRLF survive, the new empty trailing paragraph rides
// the path-scoped transient (no `<br />`), and source/save/cold-reopen stay
// warning-free.
const root = `/tmp/horsemd-blockquote-split-trailing-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 13220 + (process.pid % 30))
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = '\uFEFF' + [
  '# blockquote trailing split',
  '',
  '- authored bullet',
  '',
  '> first para',
  '>',
  '> beta',
  '',
  '- following bullet',
  ''
].join('\r\n')

const committed = 'beta请问'
// Enter at the end of the last quote paragraph appends the authored separator
// (`>` + EOL) plus the emptied trailing line (`> ` + EOL) before the blank
// line that precedes the following bullet.
const expected = fixture.replace(
  '> beta\r\n',
  `> ${committed}\r\n>\r\n> \r\n`
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

const openApp = async ({ file, profile, port, expectedQuotes }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace']
  })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        if (!editor) return false
        const quotes = [...editor.querySelectorAll('blockquote p')]
          .map((node) => node.textContent || '')
        return Boolean(
          (editor.textContent || '').includes('authored bullet') &&
          (editor.textContent || '').includes('following bullet') &&
          JSON.stringify(quotes) === ${JSON.stringify(JSON.stringify(expectedQuotes))}
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
    return { ok: true }
  })()`)
  assert.equal(result.ok, true, `could not focus quote paragraph: ${JSON.stringify(result)}`)
  await sleep(80)
}

// Real IME composition via CDP: pinyin keystrokes update the composition text
// (each dispatch is one PM pending-text transaction), then insertText commits
// the CJK run — the same lifecycle as the user trace.
const imeComposeAndCommit = async (app, pinyin, cjk) => {
  const replacementId = `split-trailing-${Date.now()}`
  for (let index = 0; index < pinyin.length; index += 1) {
    const ch = pinyin[index]
    const code = ch.charCodeAt(0)
    const common = {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code
    }
    await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    const value = pinyin.slice(0, index + 1)
    await app.send('Input.imeSetComposition', {
      text: value,
      selectionStart: value.length,
      selectionEnd: value.length,
      replacementId,
      location: 0
    })
    await sleep(18)
  }
  await app.send('Input.insertText', { text: cjk })
  await sleep(40)
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
    quoteTexts: [...(editor?.querySelectorAll('blockquote p') || [])]
      .map((node) => node.textContent || ''),
    preserve: (window.__hmPreserveLog || []).slice(-30).map((entry) => ({
      reason: entry.reason,
      preserved: entry.preserved,
      integrityProof: entry.integrityProof
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
  assert.equal(source, expectedView, `${label} source differs from split owner output`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} source lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed raw CR bytes`)
  assert.equal(source.includes(`> ${committed}\n>\n> \n`), true,
    `${label} lost the authored trailing quote line`)
  assert.equal(source.includes('<br />'), false, `${label} wrote a serializer break placeholder`)
  assert.equal(source.includes('- authored bullet'), true, `${label} changed preceding list`)
  assert.equal(source.includes('- following bullet'), true, `${label} changed following list`)
}

const assertSplitPublication = (state, expectedBoundary, label) => {
  assert.deepEqual(
    state.quoteTexts,
    ['first para', committed, ''],
    `${label} rich quote differs: ${JSON.stringify(state.quoteTexts)}`
  )
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} produced source-integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} showed source-sync warning: ${JSON.stringify(state.toasts)}`)

  const split = state.preserve.find((entry) =>
    entry.reason === 'blockquote-paragraph-split' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-blockquote-split-proof'
  )
  assert.ok(split, `${label} did not publish the trailing split owner: ${JSON.stringify(state.preserve)}`)
  assert.equal(split.integrityProof.family, 'blockquote-paragraph-split')
  assert.equal(split.integrityProof.trailingEmptySplit, true)
  assert.equal(split.integrityProof.rightText, '')
  assert.equal(split.integrityProof.leftText, committed)
  assert.equal(split.integrityProof.chainLength >= 2, true,
    `${label} journal did not retain the IME pending-text chain`)
  assert.deepEqual(split.integrityProof.transientBlockquotePath, [2])
  assert.equal(split.integrityProof.transactionJournal?.snapshotMatched, true)
  assert.equal(split.integrityProof.transactionJournal?.documentMatched, true)

  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'blockquote-paragraph-split' &&
    entry.semanticOk === true &&
    entry.ok === true
  ), true, `${label} trailing split candidate was not fully equivalent: ${JSON.stringify(state.integrity)}`)

  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'blockquote-paragraph-split' &&
    entry.reason === 'blockquote-paragraph-split' &&
    entry.boundary === expectedBoundary
  ), true, `${label} bypassed Coordinator split boundary: ${JSON.stringify(state.coordinator)}`)
}

const reopenAndVerify = async ({ file, profile, port, label }) => {
  const app = await openApp({
    file,
    profile,
    port,
    // The trailing empty paragraph is editor-owned: cold reopen shows the two
    // text paragraphs only.
    expectedQuotes: ['first para', committed]
  })
  try {
    const state = await snapshot(app)
    assert.deepEqual(state.quoteTexts, ['first para', committed],
      `${label} cold reopen quote differs: ${JSON.stringify(state.quoteTexts)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
      `${label} cold reopen showed source-sync warning: ${JSON.stringify(state.toasts)}`)
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
  const app = await openApp({
    file,
    profile: `${name}-edit`,
    port,
    expectedQuotes: ['first para', 'beta']
  })
  try {
    await clearDiagnostics(app)
    await focusEndOfQuoteParagraph(app, 'beta')
    await imeComposeAndCommit(app, 'qw', '请问')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 30 })

    if (immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not trigger forced flush`)
      const source = await waitFor(() => visibleSource(app), `${name} forced source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
      await sleep(700)
    } else {
      await sleep(1100)
    }

    const state = await snapshot(app)
    console.log(`${name.toUpperCase()}_AFTER_IME_ENTER:`, JSON.stringify(state))
    assertSplitPublication(
      state,
      immediateFlush
        ? 'transaction-blockquote-split-forced-flush'
        : 'transaction-blockquote-split-markdown-updated',
      name
    )

    if (!immediateFlush) {
      assert.equal(await toggleSource(app), true, `${name} could not inspect source`)
      const source = await waitFor(() => visibleSource(app), `${name} source did not open`)
      assertSourceView(source, name)
      assert.equal(await toggleSource(app), true, `${name} could not return to rich mode`)
    }

    await save(app, name)
    assert.equal(await readFile(file, 'utf8'), expected,
      `${name} saved bytes differ from split owner output`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
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
  console.log('PASS transaction-owned blockquote trailing split: IME composition + immediate Enter at the last quote paragraph end preserves authored markers/BOM/CRLF through source view, save and cold reopen without warnings')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
