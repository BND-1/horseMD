import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-ordered-successor-lift-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 19600 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n1) alpha\r\n\r\n2) \r\n\r\n3) beta\r\n\r\nafter\r\n'
const expected = '\uFEFFbefore\r\n\r\n1) alpha\r\n\r\n2) beta\r\n\r\nafter\r\n'
const expectedTextarea = expected.replace(/\r\n/g, '\n')
const scenarios = [
  { name: 'callback', forced: false },
  { name: 'forced', forced: true }
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
      const list = [...(editor?.querySelectorAll('ol') || [])]
        .find((node) => node.offsetParent && (node.textContent || '').includes('alpha') && (node.textContent || '').includes('beta'))
      if (!list) return false
      const texts = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')].map((item) =>
        (item.querySelector(':scope > .children > .content-dom > p')?.textContent || '').replace(/\\u200B/g, '')
      )
      return JSON.stringify(texts) === JSON.stringify(${JSON.stringify(expectedTexts)})
    })()`), `${profile} ordered topology did not mount`)
    await sleep(350)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const focusEmpty = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const list = [...(editor?.querySelectorAll('ol') || [])]
      .find((node) => (node.textContent || '').includes('alpha') && (node.textContent || '').includes('beta'))
    const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const paragraph = items[1]?.querySelector(':scope > .children > .content-dom > p') || items[1]?.querySelector('p')
    if (!paragraph || (paragraph.textContent || '').replace(/\\u200B/g, '').trim()) return null
    const rect = paragraph.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), 'middle empty ordered item not hit-testable')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(70)
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmListOrderedEmptySuccessorLiftTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)
const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const list = [...(editor?.querySelectorAll('ol') || [])]
    .find((node) => (node.textContent || '').includes('alpha') && (node.textContent || '').includes('beta'))
  const items = [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  return {
    preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, markdown, ...entry }) => entry),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-30),
    owner: (window.__hmListOrderedEmptySuccessorLiftTransactionTrace || []).slice(-30),
    broad: (window.__hmListSubtreeTransactionTrace || []).slice(-30),
    itemCount: items.length,
    paragraphCounts: items.map((item) => item.querySelectorAll(':scope > .children > .content-dom > p').length),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)
const assertSource = (source, label) => {
  assert.equal(source, expectedTextarea, `${label} source mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR`)
  assert.ok(source.includes('1) alpha\n\n2) beta'), `${label} authored ) delimiter not retained`)
  assert.doesNotMatch(source, /3\) beta/)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port, expectedTexts: ['alpha', '', 'beta'] })
  try {
    await clearDiagnostics(app)
    await focusEmpty(app)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: scenario.forced ? 8 : 24 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true)
      await sleep(600)
    } else {
      await sleep(950)
    }

    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, JSON.stringify(state.integrity))
    assert.equal(state.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false)
    assert.equal(state.itemCount, 2)
    assert.equal(state.paragraphCounts[0], 2, `${scenario.name} transient trailing paragraph missing`)
    const publications = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-ordered-empty-successor-lift'
    )
    assert.equal(publications.length, 1, JSON.stringify(state.owner))
    assert.equal(publications[0].boundary,
      scenario.forced
        ? 'transaction-list-ordered-empty-successor-lift-forced-flush'
        : 'transaction-list-ordered-empty-successor-lift-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-ordered-empty-successor-lifted' &&
      entry.integrityProof?.kind === 'transaction-list-ordered-empty-successor-lift-proof'
    )
    assert.ok(preservation, JSON.stringify(state.preserve))
    assert.equal(preservation.integrityProof.family, 'list-ordered-empty-successor-lift')
    assert.equal(preservation.integrityProof.firstStep?.name, 'ReplaceStep')
    assert.equal(preservation.integrityProof.secondStep?.name, 'ReplaceAroundStep')
    assert.equal(preservation.integrityProof.secondStep?.insert, 1)
    assert.deepEqual(preservation.integrityProof.transientEmptyParagraphPath, [1, 0, 1])
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true)
    }
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${scenario.name} save button missing`)
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${scenario.name} save did not finish`)
    assert.equal(await readFile(file, 'utf8'), expected, `${scenario.name} disk bytes mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({ file, profile: `${scenario.name}-reopen`, port: port + 1, expectedTexts: ['alpha', 'beta'] })
  try {
    const paragraphCounts = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const list = [...(editor?.querySelectorAll('ol') || [])].find((node) => (node.textContent || '').includes('alpha'))
      return [...(list?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
        .map((item) => item.querySelectorAll(':scope > .children > .content-dom > p').length)
    })()`)
    assert.deepEqual(paragraphCounts, [1, 1], `${scenario.name} cold reopen retained transient paragraph`)
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assertSource(source, `${scenario.name} cold`)
    assert.equal(await readFile(file, 'utf8'), expected)
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
  console.log('PASS ordered empty successor lift transaction UI: authored ) delimiter and BOM/CRLF survive callback or forced flush, exact middle-row deletion + successor renumber saves and cold reopens without the transient paragraph')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
