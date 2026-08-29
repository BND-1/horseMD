import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-isolated-ordered-lift-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 18540 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n+ literal\r\n\r\n1) \r\n\r\n- right\r\n\r\nafter\r\n'
const expected = '\uFEFFbefore\r\n\r\n+ literal\r\n\r\n+ \r\n\r\n- right\r\n\r\nafter\r\n'
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

const waitInitialShape = (app, label) => waitFor(() => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const children = [...(editor?.children || [])]
  const orderedIndex = children.findIndex((node) => node.tagName === 'OL')
  if (orderedIndex < 1 || orderedIndex + 1 >= children.length) return false
  const ordered = children[orderedIndex]
  const previous = children[orderedIndex - 1]
  const following = children[orderedIndex + 1]
  const item = ordered.querySelector('li')
  const paragraph = item?.querySelector('p')
  return previous?.tagName === 'UL' && following?.tagName === 'UL' &&
    (previous.textContent || '').includes('literal') &&
    (following.textContent || '').includes('right') &&
    ordered.querySelectorAll('li').length === 1 &&
    !(paragraph?.textContent || '').replace(/\\u200B/g, '').trim()
})()`), `${label} initial isolated ordered topology did not mount`)

const focusEmptyOrdered = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const ordered = [...(editor?.children || [])].find((node) => node.tagName === 'OL')
    const paragraph = ordered?.querySelector('li p')
    if (!paragraph || (paragraph.textContent || '').replace(/\\u200B/g, '').trim()) return null
    const rect = paragraph.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), 'empty ordered paragraph not hit-testable')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(70)
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmListIsolatedEmptyOrderedLiftTransactionTrace = []
  window.__hmListEmptyItemFirstTransactionTrace = []
  window.__hmListEmptyItemTailTransactionTrace = []
  window.__hmListEmptyItemTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const direct = [...(editor?.children || [])]
  const topOrdered = direct.filter((node) => node.tagName === 'OL').length
  const bulletItems = direct.filter((node) => node.tagName === 'UL').flatMap((list) =>
    [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
      .map((item) => item.querySelector('p')?.textContent || '')
  )
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
    owner: (window.__hmListIsolatedEmptyOrderedLiftTransactionTrace || []).slice(-40),
    first: (window.__hmListEmptyItemFirstTransactionTrace || []).slice(-40),
    tail: (window.__hmListEmptyItemTailTransactionTrace || []).slice(-40),
    interior: (window.__hmListEmptyItemTransactionTrace || []).slice(-40),
    broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
    topOrdered,
    bulletItems,
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const assertSource = (source, label) => {
  assert.equal(source, expectedTextarea, `${label} source mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR bytes`)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i)
  assert.ok(source.includes('+ literal\n\n+ \n\n- right'), `${label} marker/boundary spelling drifted`)
}

const open = async ({ file, profile, port, initial = false }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    if (initial) await waitInitialShape(app, profile)
    else await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      return editor && !(editor.querySelector(':scope > ol')) &&
        (editor.textContent || '').includes('literal') && (editor.textContent || '').includes('right')
    })()`), `${profile} cold topology did not mount`)
    await sleep(350)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await open({ file, profile: `${scenario.name}-edit`, port, initial: true })
  try {
    await clearDiagnostics(app)
    await focusEmptyOrdered(app)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: scenario.forced ? 8 : 24 })

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
    assert.equal(state.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false,
      `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const publication = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-isolated-empty-ordered-lift'
    )
    assert.equal(publication.length, 1, `${scenario.name} publication: ${JSON.stringify(state.owner)}`)
    assert.equal(publication[0].boundary,
      scenario.forced
        ? 'transaction-list-isolated-empty-ordered-lift-forced-flush'
        : 'transaction-list-isolated-empty-ordered-lift-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-isolated-empty-ordered-lifted' &&
      entry.integrityProof?.kind === 'transaction-list-isolated-empty-ordered-lift-proof'
    )
    assert.ok(preservation, `${scenario.name} proof missing: ${JSON.stringify(state.preserve)}`)
    assert.equal(preservation.integrityProof.family, 'list-isolated-empty-ordered-lift')
    assert.equal(preservation.integrityProof.orderedSourceRow.token, '1)')
    assert.equal(preservation.integrityProof.sourceBulletToken, '+')
    assert.equal(preservation.integrityProof.orderedStart, 1)
    assert.equal(preservation.integrityProof.previousToken, '1)')
    assert.equal(preservation.integrityProof.nextToken, '+')
    assert.equal(preservation.integrityProof.step.name, 'ReplaceStep')
    assert.equal(state.topOrdered, 0, `${scenario.name} ordered list still present after lift`)
    assert.equal(state.bulletItems.includes('literal'), true)
    assert.equal(state.bulletItems.includes(''), true)
    assert.equal(state.bulletItems.includes('right'), true)
    assert.equal(state.first.some((entry) => entry.phase === 'published'), false)
    assert.equal(state.tail.some((entry) => entry.phase === 'published'), false)
    assert.equal(state.interior.some((entry) => entry.phase === 'published'), false)
    assert.equal(state.broad.some((entry) => entry.phase === 'published'), false)

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

  app = await open({ file, profile: `${scenario.name}-reopen`, port: port + 1, initial: false })
  try {
    const cold = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const items = [...(editor?.querySelectorAll('ul li') || [])]
        .map((item) => item.querySelector('p')?.textContent || '')
      return { ordered: editor?.querySelectorAll(':scope > ol').length || 0, items }
    })()`)
    assert.equal(cold.ordered, 0, `${scenario.name} cold reopen restored ordered list`)
    assert.equal(cold.items.includes('literal'), true)
    assert.equal(cold.items.includes(''), true)
    assert.equal(cold.items.includes('right'), true)
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
  console.log('PASS isolated empty ordered lift transaction UI: authored 1) marker becomes the preceding + bullet through callback or forced flush, with BOM/CRLF source, save, disk and cold reopen intact')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
