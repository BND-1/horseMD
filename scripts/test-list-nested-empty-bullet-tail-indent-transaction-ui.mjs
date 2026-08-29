import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-nested-empty-tail-indent-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 21120 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n+ \r\n\r\nafter\r\n'
const expected = '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n\r\n  + \r\n\r\nafter\r\n'
const expectedTextarea = expected.replace(/\r\n/g, '\n')
const scenarios = [
  { name: 'callback', forced: false },
  { name: 'forced', forced: true }
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

const listShape = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
  const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  const nested = [...(editor?.querySelectorAll('ul ul') || [])]
  return {
    topCount: topItems.length,
    nestedCount: nested.length,
    hasAlpha: (editor?.textContent || '').includes('alpha'),
    hasBeta: (editor?.textContent || '').includes('beta')
  }
})()`)

const openApp = async ({ file, profile, port, indented }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const shape = await listShape(app)
      return shape.hasAlpha && shape.hasBeta && shape.topCount === (indented ? 2 : 3) && shape.nestedCount === (indented ? 1 : 0)
    }, `${profile} list topology did not mount`)
    await sleep(350)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const focusTailEmpty = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
    const items = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
    const p = items.at(-1)?.querySelector(':scope > .children > .content-dom > p') || items.at(-1)?.querySelector('p')
    if (!p || (p.textContent || '').replace(/\\u200B/g, '').trim()) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), 'tail empty bullet not hit-testable')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(50)
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
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
  owner: (window.__hmListNestedEmptyBulletTailIndentTransactionTrace || []).slice(-40),
  broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

const assertSource = (source, label) => {
  assert.equal(source, expectedTextarea, `${label} source mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR`)
  assert.ok(source.includes('+ beta\n\n  + \n'), `${label} authored + marker or parse-safe blank line drifted`)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i)
}

const save = async (app, label) => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${label} save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not finish`)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port, indented: false })
  try {
    await clearDiagnostics(app)
    await focusTailEmpty(app)
    await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: scenario.forced ? 8 : 80 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true, `${scenario.name} rich toggle failed`)
      await sleep(600)
    } else {
      await sleep(900)
    }

    const shape = await listShape(app)
    assert.equal(shape.topCount, 2)
    assert.equal(shape.nestedCount, 1)
    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `${scenario.name} integrity failure: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false, `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const publications = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-nested-empty-bullet-tail-indent'
    )
    assert.equal(publications.length, 1, `${scenario.name} focused publication mismatch: ${JSON.stringify(state.owner)}`)
    assert.equal(publications[0].boundary,
      scenario.forced
        ? 'transaction-list-nested-empty-bullet-tail-indent-forced-flush'
        : 'transaction-list-nested-empty-bullet-tail-indent-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-nested-empty-bullet-tail-indented' &&
      entry.integrityProof?.kind === 'transaction-list-nested-empty-bullet-tail-indent-proof'
    )
    assert.ok(preservation, `${scenario.name} proof missing: ${JSON.stringify(state.preserve)}`)
    assert.equal(preservation.integrityProof.movedSourceRow?.token, '+')
    assert.equal(preservation.integrityProof.parentSourceRow?.token, '+')
    assert.equal(preservation.integrityProof.rawInsertion?.insertion, '\r\n  ')
    assert.equal(preservation.integrityProof.step?.name, 'ReplaceAroundStep')
    assert.equal(preservation.integrityProof.step?.sliceSize, 3)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' && entry.family === 'list-nested-empty-bullet-tail-indent'
    ), true)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true)
    }
    await save(app, scenario.name)
    assert.equal(await readFile(file, 'utf8'), expected, `${scenario.name} disk bytes mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({ file, profile: `${scenario.name}-reopen`, port: port + 1, indented: true })
  try {
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
  console.log('PASS nested empty bullet tail indent transaction UI: callback/forced Tab sink preserves authored + marker, BOM/CRLF and parse-safe blank line through source, save, disk and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
