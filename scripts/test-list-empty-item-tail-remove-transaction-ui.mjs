import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-empty-item-tail-remove-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 16120 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n- left\r\n- \r\n\r\nafter\r\n'
const expected = '\uFEFFbefore\r\n\r\n- left\r\n\r\nafter\r\n'
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

const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))`
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

const openApp = async ({ file, profile, port, expectedItems }) => {
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
      const list = [...(editor?.querySelectorAll('ul') || [])]
        .find((node) => node.offsetParent && (node.textContent || '').includes('left'))
      if (!list) return false
      const items = [...list.querySelectorAll('li')]
      const texts = items.map((item) => item.querySelector('p')?.textContent || '')
      return JSON.stringify(texts) === JSON.stringify(${JSON.stringify(expectedItems)})
    })()`), `${profile} list did not mount`)
    await sleep(400)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmListEmptyItemTailTransactionTrace = []
  window.__hmListEmptyItemTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)

const focusTailEmptyItem = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const list = [...(editor?.querySelectorAll('ul') || [])]
      .find((node) => node.offsetParent && (node.textContent || '').includes('left'))
    const items = [...(list?.querySelectorAll('li') || [])]
    const paragraph = items.at(-1)?.querySelector('p')
    if (!paragraph || (paragraph.textContent || '').trim()) return null
    const rect = paragraph.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), 'tail empty list item not found')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(80)
}

const snapshot = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-40).map(({ source, previous, next, markdown, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-40).map((entry) => ({
    ok: entry.ok,
    semanticOk: entry.semanticOk,
    listSlotsMatch: entry.listSlotsMatch,
    preservationReason: entry.preservationReason,
    validationSite: entry.validationSite
  })),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-40),
  owner: (window.__hmListEmptyItemTailTransactionTrace || []).slice(-40),
  interior: (window.__hmListEmptyItemTransactionTrace || []).slice(-40),
  broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

const assertSource = (source, label) => {
  assert.equal(source, expectedTextarea, `${label} source mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR bytes`)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({
    file,
    profile: `${scenario.name}-edit`,
    port,
    expectedItems: ['left', '']
  })
  try {
    await clearDiagnostics(app)
    await focusTailEmptyItem(app)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: scenario.forced ? 10 : 25 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true, `${scenario.name} rich toggle failed`)
      await sleep(650)
    } else {
      await sleep(950)
    }

    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false,
      `${scenario.name} integrity failure: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false)
    const publication = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-empty-item-tail-remove'
    )
    assert.equal(publication.length, 1, `${scenario.name} publication: ${JSON.stringify(state.owner)}`)
    assert.equal(publication[0].boundary,
      scenario.forced
        ? 'transaction-list-empty-item-tail-remove-forced-flush'
        : 'transaction-list-empty-item-tail-remove-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-empty-item-tail-removed' &&
      entry.integrityProof?.kind === 'transaction-list-empty-item-tail-remove-proof'
    )
    assert.ok(preservation, `${scenario.name} proof missing: ${JSON.stringify(state.preserve)}`)
    assert.equal(preservation.integrityProof.family, 'list-empty-item-tail-remove')
    assert.deepEqual(preservation.integrityProof.removedPath, [1, 1])
    assert.deepEqual(preservation.integrityProof.transientEmptyListItemPath, [1, 0])
    assert.deepEqual(preservation.integrityProof.transientEmptyParagraphPath, [1, 0, 1])
    assert.equal(state.interior.some((entry) => entry.phase === 'published'), false,
      `${scenario.name} interior owner unexpectedly published: ${JSON.stringify(state.interior)}`)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === false), false,
      `${scenario.name} broad owner failed first: ${JSON.stringify(state.broad)}`)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true)
    }

    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      `${scenario.name} save button missing`)
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`),
      `${scenario.name} save did not finish`)
    assert.equal(await readFile(file, 'utf8'), expected, `${scenario.name} disk bytes mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({
    file,
    profile: `${scenario.name}-reopen`,
    port: port + 1,
    expectedItems: ['left']
  })
  try {
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assertSource(source, `${scenario.name} cold reopen`)
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
  console.log('PASS list tail empty-item remove transaction UI: BOM/CRLF tail marker deletion publishes exactly once via callback or forced flush, saves exact bytes and cold reopens without the item or br placeholder')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
