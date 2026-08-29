import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-ordered-successor-chain-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 20420 + (process.pid % 20))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const scenarios = [
  {
    name: 'callback-order4-paren',
    forced: false,
    targetIndex: 1,
    fixture: '\uFEFFbefore\r\n\r\n4) alpha\r\n\r\n5) \r\n\r\n6) beta\r\n\r\n7) gamma\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n4) alpha\r\n\r\n5) beta\r\n\r\n6) gamma\r\n\r\nafter\r\n',
    initialTexts: ['alpha', '', 'beta', 'gamma'],
    finalTexts: ['alpha', 'beta', 'gamma'],
    removedIndex: 1,
    listOrder: 4,
    successorCount: 2,
    oldLabels: ['6.', '7.'],
    finalLabels: ['5.', '6.'],
    authoredNeedle: '4) alpha\n\n5) beta\n\n6) gamma'
  },
  {
    name: 'forced-index2',
    forced: true,
    targetIndex: 2,
    fixture: '\uFEFFbefore\r\n\r\n1. alpha\r\n\r\n2. beta\r\n\r\n3. \r\n\r\n4. gamma\r\n\r\n5. delta\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n1. alpha\r\n\r\n2. beta\r\n\r\n3. gamma\r\n\r\n4. delta\r\n\r\nafter\r\n',
    initialTexts: ['alpha', 'beta', '', 'gamma', 'delta'],
    finalTexts: ['alpha', 'beta', 'gamma', 'delta'],
    removedIndex: 2,
    listOrder: 1,
    successorCount: 2,
    oldLabels: ['4.', '5.'],
    finalLabels: ['3.', '4.'],
    authoredNeedle: '2. beta\n\n3. gamma\n\n4. delta'
  },
  {
    name: 'callback-three-successors',
    forced: false,
    targetIndex: 1,
    fixture: '\uFEFFbefore\r\n\r\n2. alpha\r\n\r\n3. \r\n\r\n4. beta\r\n\r\n5. gamma\r\n\r\n6. delta\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n2. alpha\r\n\r\n3. beta\r\n\r\n4. gamma\r\n\r\n5. delta\r\n\r\nafter\r\n',
    initialTexts: ['alpha', '', 'beta', 'gamma', 'delta'],
    finalTexts: ['alpha', 'beta', 'gamma', 'delta'],
    removedIndex: 1,
    listOrder: 2,
    successorCount: 3,
    oldLabels: ['4.', '5.', '6.'],
    finalLabels: ['3.', '4.', '5.'],
    authoredNeedle: '2. alpha\n\n3. beta\n\n4. gamma\n\n5. delta'
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
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`
const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

const openApp = async ({ file, profile, port, expectedTexts }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const list = [...(editor?.querySelectorAll(':scope > ol') || [])]
        .find((node) => node.offsetParent && (node.textContent || '').includes('alpha'))
      if (!list) return false
      const texts = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')].map((item) =>
        (item.querySelector(':scope > .children > .content-dom > p')?.textContent || '').replace(/\\u200B/g, '')
      )
      return JSON.stringify(texts) === JSON.stringify(${JSON.stringify(expectedTexts)})
    })()`), `${profile} ordered topology did not mount`)
    await sleep(320)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const focusEmpty = async (app, targetIndex) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const list = [...(editor?.querySelectorAll(':scope > ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const paragraph = items[${targetIndex}]?.querySelector(':scope > .children > .content-dom > p') || items[${targetIndex}]?.querySelector('p')
    if (!paragraph || (paragraph.textContent || '').replace(/\\u200B/g, '').trim()) return null
    const rect = paragraph.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), `ordered empty item ${targetIndex} not hit-testable`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(70)
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmListOrderedEmptySuccessorChainTransactionTrace = []
  window.__hmListOrderedEmptySuccessorLiftTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)
const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const list = [...(editor?.querySelectorAll(':scope > ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
  const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  return {
    preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-40).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
    chain: (window.__hmListOrderedEmptySuccessorChainTransactionTrace || []).slice(-40),
    single: (window.__hmListOrderedEmptySuccessorLiftTransactionTrace || []).slice(-40),
    broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
    itemCount: items.length,
    texts: items.map((item) => (item.querySelector(':scope > .children > .content-dom > p')?.textContent || '').replace(/\\u200B/g, '')),
    paragraphCounts: items.map((item) => item.querySelectorAll(':scope > .children > .content-dom > p').length),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const assertSource = (source, scenario, label) => {
  const expectedTextarea = scenario.expected.replace(/\r\n/g, '\n')
  assert.equal(source, expectedTextarea, `${label} source mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR`)
  assert.ok(source.includes(scenario.authoredNeedle), `${label} authored delimiter/ordinal bytes drifted`)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, scenario.fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port, expectedTexts: scenario.initialTexts })
  try {
    await clearDiagnostics(app)
    await focusEmpty(app, scenario.targetIndex)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: scenario.forced ? 8 : 24 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSource(source, scenario, scenario.name)
      assert.equal(await toggleSource(app), true)
      await sleep(600)
    } else {
      await sleep(950)
    }

    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, JSON.stringify(state.integrity))
    assert.equal(state.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false)
    assert.equal(state.itemCount, scenario.finalTexts.length)
    assert.deepEqual(state.texts, scenario.finalTexts)
    assert.equal(state.paragraphCounts[scenario.removedIndex - 1], 2, `${scenario.name} transient paragraph missing`)
    const publications = state.chain.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-ordered-empty-successor-chain-lift'
    )
    assert.equal(publications.length, 1, JSON.stringify(state.chain))
    assert.equal(publications[0].boundary,
      scenario.forced
        ? 'transaction-list-ordered-empty-successor-chain-lift-forced-flush'
        : 'transaction-list-ordered-empty-successor-chain-lift-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-ordered-empty-successor-chain-lifted' &&
      entry.integrityProof?.kind === 'transaction-list-ordered-empty-successor-chain-proof'
    )
    assert.ok(preservation, JSON.stringify(state.preserve))
    const proof = preservation.integrityProof
    assert.equal(proof.family, 'list-ordered-empty-successor-chain-lift')
    assert.equal(proof.removedIndex, scenario.removedIndex)
    assert.equal(proof.listOrder, scenario.listOrder)
    assert.equal(proof.successorCount, scenario.successorCount)
    assert.deepEqual(proof.successorOldLabels, scenario.oldLabels)
    assert.deepEqual(proof.successorFinalLabels, scenario.finalLabels)
    assert.equal(proof.firstStep?.name, 'ReplaceStep')
    assert.equal(proof.relabelSteps?.length, scenario.successorCount)
    assert.equal(proof.relabelSteps?.every((entry) => entry.step?.name === 'ReplaceAroundStep' && entry.step?.insert === 1), true)
    assert.deepEqual(proof.transientEmptyParagraphPath, [1, scenario.removedIndex - 1, 1])
    assert.equal(state.single.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.coordinator.filter((entry) =>
      entry.phase === 'published' && entry.family === 'list-ordered-empty-successor-chain-lift'
    ).length, 1)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSource(source, scenario, scenario.name)
      assert.equal(await toggleSource(app), true)
    }
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${scenario.name} save button missing`)
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${scenario.name} save did not finish`)
    assert.equal(await readFile(file, 'utf8'), scenario.expected, `${scenario.name} disk bytes mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({ file, profile: `${scenario.name}-reopen`, port: port + 1, expectedTexts: scenario.finalTexts })
  try {
    const paragraphCounts = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const list = [...(editor?.querySelectorAll(':scope > ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
      return [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
        .map((item) => item.querySelectorAll(':scope > .children > .content-dom > p').length)
    })()`)
    assert.equal(paragraphCounts.every((count) => count === 1), true, `${scenario.name} cold reopen retained transient paragraph`)
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assertSource(source, scenario, `${scenario.name} cold`)
    assert.equal(await readFile(file, 'utf8'), scenario.expected)
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
  console.log('PASS ordered empty successor-chain transaction UI: multi-successor callback/forced keeps authored )/BOM/CRLF, supports removedIndex 1/2, publishes focused-only, saves exact bytes and cold reopens without transient paragraphs')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
