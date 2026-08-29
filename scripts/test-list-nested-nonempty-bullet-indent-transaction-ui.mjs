import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-nested-nonempty-indent-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 21720 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const scenarios = [
  {
    name: 'tail-callback',
    forced: false,
    marker: '+',
    target: 'gamma',
    targetIndex: 2,
    position: 'tail',
    fixture: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ gamma\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n\r\nafter\r\n'
  },
  {
    name: 'middle-forced',
    forced: true,
    marker: '-',
    target: 'beta',
    targetIndex: 1,
    position: 'middle',
    fixture: '\uFEFFbefore\r\n\r\n- alpha\r\n- beta\r\n- gamma\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n- alpha\r\n  - beta\r\n- gamma\r\n\r\nafter\r\n'
  }
]
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

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

const shape = (app, target) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
  const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  const nested = [...(editor?.querySelectorAll('ul ul') || [])]
  const nestedTexts = nested.flatMap((list) => [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    .map((item) => (item.querySelector('p')?.textContent || '').trim()))
  return {
    topCount: topItems.length,
    nestedCount: nested.length,
    nestedTexts,
    hasTarget: nestedTexts.includes(${JSON.stringify(target)}),
    hasAlpha: (editor?.textContent || '').includes('alpha'),
    hasGamma: (editor?.textContent || '').includes('gamma')
  }
})()`)

const openApp = async ({ file, profile, port, target, indented }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const current = await shape(app, target)
      return current.hasAlpha && current.hasGamma &&
        current.topCount === (indented ? 2 : 3) &&
        current.nestedCount === (indented ? 1 : 0) &&
        (!indented || current.hasTarget)
    }, `${profile} list topology did not mount`)
    await sleep(350)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const focusTarget = async (app, target) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
    const items = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const item = items.find((candidate) => {
      const p = candidate.querySelector(':scope > .children > .content-dom > p') || candidate.querySelector('p')
      return (p?.textContent || '').trim() === ${JSON.stringify(target)}
    })
    const p = item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
    if (!p) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), `${target} not hit-testable`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(50)
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmListNestedNonemptyBulletIndentTransactionTrace = []
  window.__hmListNestedEmptyBulletTailIndentTransactionTrace = []
  window.__hmListSubtreeTransactionTrace = []
})()`)
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
  owner: (window.__hmListNestedNonemptyBulletIndentTransactionTrace || []).slice(-40),
  empty: (window.__hmListNestedEmptyBulletTailIndentTransactionTrace || []).slice(-40),
  broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)
const save = async (app, label) => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${label} save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not finish`)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, scenario.fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port, target: scenario.target, indented: false })
  try {
    await clearDiagnostics(app)
    await focusTarget(app, scenario.target)
    await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: scenario.forced ? 8 : 80 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
      assert.equal(await toggleSource(app), true)
      await sleep(600)
    } else {
      await sleep(900)
    }

    const current = await shape(app, scenario.target)
    assert.equal(current.topCount, 2)
    assert.equal(current.nestedCount, 1)
    assert.equal(current.hasTarget, true)
    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `${scenario.name} integrity: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false, `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const publication = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-nested-nonempty-bullet-indent'
    )
    assert.equal(publication.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
    assert.equal(publication[0].boundary,
      scenario.forced
        ? 'transaction-list-nested-nonempty-bullet-indent-forced-flush'
        : 'transaction-list-nested-nonempty-bullet-indent-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-nested-nonempty-bullet-indented' &&
      entry.integrityProof?.kind === 'transaction-list-nested-nonempty-bullet-indent-proof'
    )
    assert.ok(preservation, `${scenario.name} proof: ${JSON.stringify(state.preserve)}`)
    assert.equal(preservation.integrityProof.position, scenario.position)
    assert.equal(preservation.integrityProof.targetIndex, scenario.targetIndex)
    assert.equal(preservation.integrityProof.movedSourceRow?.token, scenario.marker)
    assert.equal(preservation.integrityProof.rawInsertion?.insertion, '  ')
    assert.equal(preservation.integrityProof.step?.name, 'ReplaceAroundStep')
    assert.equal(preservation.integrityProof.step?.sliceSize, 3)
    assert.equal(state.empty.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' && entry.family === 'list-nested-nonempty-bullet-indent'
    ), true)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
      assert.equal(await toggleSource(app), true)
    }
    assert.equal(source.charCodeAt(0), 0xFEFF)
    assert.equal(source.includes('\r'), false)
    await save(app, scenario.name)
    assert.equal(await readFile(file, 'utf8'), scenario.expected, `${scenario.name} disk mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({ file, profile: `${scenario.name}-reopen`, port: port + 1, target: scenario.target, indented: true })
  try {
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} cold source missing`)
    assert.equal(source, scenario.expected.replace(/\r\n/g, '\n'))
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
  console.log('PASS nested nonempty bullet indent transaction UI: tail callback and middle forced Tab sink preserve authored marker/BOM/CRLF with only two-space target indentation through source, save, disk and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
