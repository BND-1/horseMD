import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-code-block-backspace-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 14730 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = '\uFEFF' + [
  '# empty code block unwrap',
  '',
  'before block',
  '',
  '~~~js',
  '',
  '~~~',
  '',
  'after block',
  ''
].join('\r\n')
const fencedRaw = '~~~js\r\n\r\n~~~\r\n'
const expectedTextRaw = fixture.replace(fencedRaw, 'XY\r\n')
const expectedEmptyRaw = fixture.replace(fencedRaw, '\r\n')
const scenarios = [
  {
    name: 'coalesced-text',
    mode: 'coalesced-text',
    expectedRaw: expectedTextRaw,
    expectedBoundary: 'transaction-empty-code-block-unpack-markdown-updated',
    typeText: true
  },
  {
    name: 'forced-empty',
    mode: 'forced-empty',
    expectedRaw: expectedEmptyRaw,
    expectedBoundary: 'transaction-empty-code-block-unpack-forced-flush',
    typeText: false
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

const openApp = async ({ file, profile, port, expectCodeBlock }) => {
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
        if (!editor || !(editor.textContent || '').includes('after block')) return false
        const count = editor.querySelectorAll('.milkdown-code-block').length
        return ${expectCodeBlock ? 'count === 1' : 'count === 0'}
      })()`),
      `editor did not mount for ${profile}`
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
  window.__hmCodeBlockTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const clickEmptyCodeBlock = async (app) => {
  const point = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const content = editor?.querySelector('.milkdown-code-block .cm-content')
    const rect = content?.getBoundingClientRect()
    return rect ? {
      x: rect.left + Math.max(8, Math.min(30, rect.width / 2)),
      y: rect.top + Math.max(8, Math.min(18, rect.height / 2))
    } : null
  })()`)
  assert.ok(point, 'empty code block click target missing')
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'left', clickCount: 1, ...point
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'left', clickCount: 1, ...point
  })
  await sleep(60)
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

const diagnostics = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return {
    codeBlockCount: editor?.querySelectorAll('.milkdown-code-block').length || 0,
    documentText: editor?.innerText || '',
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
    journalTrace: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-100),
    codeOwnerTrace: (window.__hmCodeBlockTransactionTrace || []).slice(-100),
    flushTrace: (window.__hmFlushTrace || []).slice(-50),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const assertSource = (source, expectedRaw, label) => {
  const expected = expectedRaw.replace(/\r\n/g, '\n')
  assert.equal(source, expected, `${label} source textarea mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR bytes`)
  assert.equal(source.includes('~~~'), false, `${label} retained authored fence`)
  assert.equal(source.includes('<br'), false, `${label} leaked editor placeholder`)
  assert.equal(source.includes('before block'), true)
  assert.equal(source.includes('after block'), true)
}

const assertOwned = (state, scenario) => {
  assert.equal(state.codeBlockCount, 0, `${scenario.name} retained code block`)
  assert.equal(
    scenario.typeText ? /\nXY\n/.test(state.documentText) : !state.documentText.includes('XY'),
    true,
    `${scenario.name} rich text mismatch: ${JSON.stringify(state)}`
  )
  const publications = state.preserve.filter((entry) =>
    entry.reason === 'empty-fenced-code-block-backspace-unpack' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-empty-code-block-unpack-proof'
  )
  assert.equal(publications.length, 1,
    `${scenario.name} focused owner publications: ${JSON.stringify(state.preserve)}`)
  const proof = publications[0].integrityProof
  assert.equal(proof.family, 'empty-code-block-backspace-unpack')
  assert.equal(proof.mode, scenario.mode)
  assert.equal(proof.finalText, scenario.typeText ? 'XY' : '')
  assert.equal(proof.language, 'js')
  assert.equal(proof.sourceRange.char, '~')
  assert.equal(proof.previousRange.char, '`')
  assert.equal(proof.rawReplacement.replacement,
    scenario.typeText ? 'XY\r\n' : '\r\n')
  assert.equal(proof.transactionJournal.stepCount, scenario.typeText ? 3 : 1)
  assert.deepEqual(proof.transactionJournal.stepNames,
    Array(scenario.typeText ? 3 : 1).fill('ReplaceStep'))
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'paragraph-emptied' ||
    entry.reason === 'middle-empty-block-filled'
  ), false, `${scenario.name} fell back to legacy lifecycle mapping`)
  assert.equal(state.preserve.some((entry) =>
    entry.reason === 'empty-fenced-code-block-backspace-unpack' &&
    entry.integrityProof?.kind !== 'transaction-empty-code-block-unpack-proof'
  ), false, `${scenario.name} allowed a legacy empty-code-block publication`)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'legacy' &&
    entry.reason === 'empty-fenced-code-block-backspace-unpack'
  ), false, `${scenario.name} published empty-code-block unpack through legacy`)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${scenario.name} integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.integrity.some((entry) =>
    entry.ok === true && entry.semanticOk === true && entry.listSlotsMatch === true &&
    entry.preservationReason === 'empty-fenced-code-block-backspace-unpack' &&
    entry.validationSite === scenario.expectedBoundary
  ), true, `${scenario.name} missing full integrity success`)
  assert.equal(state.semanticDiff.length, 0,
    `${scenario.name} semantic diff: ${JSON.stringify(state.semanticDiff)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
  const coordinator = state.coordinator.filter((entry) =>
    entry.phase === 'published' && entry.owner === 'transaction' &&
    entry.family === 'empty-code-block-backspace-unpack'
  )
  assert.equal(coordinator.length, 1,
    `${scenario.name} Coordinator publications: ${JSON.stringify(coordinator)}`)
  assert.equal(coordinator[0].boundary, scenario.expectedBoundary)
  const ownerTrace = state.codeOwnerTrace.filter((entry) =>
    entry.phase === 'published' && entry.ok === true &&
    entry.family === 'empty-code-block-backspace-unpack'
  )
  assert.equal(ownerTrace.length, 1)
  assert.equal(ownerTrace[0].boundary, scenario.expectedBoundary)
  const captures = state.journalTrace.filter((entry) =>
    entry.phase === 'capture' && entry.ok === true
  )
  assert.equal(captures.length, scenario.typeText ? 3 : 1)
  if (scenario.typeText) {
    assert.equal(new Set(captures.map((entry) => entry.journalId)).size, 1,
      `${scenario.name} did not retain one journal`)
    assert.deepEqual(captures.at(-1).stepDetails.map((entry) => entry.name),
      ['ReplaceStep', 'ReplaceStep', 'ReplaceStep'])
  }
}

const saveCurrent = async (app, file, expectedRaw, label) => {
  await waitFor(
    () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
    `${label} save button missing`
  )
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    `${label} save did not settle`
  )
  assert.equal(await readFile(file, 'utf8'), expectedRaw, `${label} disk mismatch`)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({
    file,
    profile: `${scenario.name}-edit`,
    port,
    expectCodeBlock: true
  })
  try {
    await clearDiagnostics(app)
    await clickEmptyCodeBlock(app)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 5 })
    if (scenario.typeText) {
      await typeTextLikeUser(app.send, 'XY', { delayMs: 5 })
      await sleep(900)
    } else {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
    }

    const state = await diagnostics(app)
    assertOwned(state, scenario)
    if (scenario.typeText) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
    }
    const source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
    assertSource(source, scenario.expectedRaw, scenario.name)
    await saveCurrent(app, file, scenario.expectedRaw, scenario.name)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({
    file,
    profile: `${scenario.name}-reopen`,
    port: port + 1,
    expectCodeBlock: false
  })
  try {
    const state = await diagnostics(app)
    assert.equal(state.codeBlockCount, 0)
    assert.equal(
      scenario.typeText ? /\nXY\n/.test(state.documentText) : !state.documentText.includes('XY'),
      true,
      `${scenario.name} cold rich content mismatch`
    )
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assertSource(source, scenario.expectedRaw, `${scenario.name} cold reopen`)
    assert.equal(await readFile(file, 'utf8'), scenario.expectedRaw)
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
  console.log('PASS transaction-owned empty code block Backspace UI: rapid prose stays in one journal, forced-empty durability removes the entire fence without `<br />`, and both paths preserve BOM/CRLF through source, save and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
