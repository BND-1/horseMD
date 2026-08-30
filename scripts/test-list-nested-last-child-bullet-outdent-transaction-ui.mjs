import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-nested-last-child-outdent-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 22820 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const scenarios = [
  {
    name: 'two-child-callback',
    forced: false,
    marker: '+',
    target: 'delta',
    beforeTop: ['alpha', 'beta', 'omega'],
    beforeNested: ['gamma', 'delta'],
    afterTop: ['alpha', 'beta', 'delta', 'omega'],
    afterNested: ['gamma'],
    nestedCount: 2,
    targetIndex: 1,
    fixture: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n+ delta\r\n+ omega\r\n\r\nafter\r\n'
  },
  {
    name: 'three-child-forced',
    forced: true,
    marker: '-',
    target: 'delta',
    beforeTop: ['alpha', 'omega'],
    beforeNested: ['beta', 'gamma', 'delta'],
    afterTop: ['alpha', 'delta', 'omega'],
    afterNested: ['beta', 'gamma'],
    nestedCount: 3,
    targetIndex: 2,
    fixture: '\uFEFFbefore\r\n\r\n- alpha\r\n  - beta\r\n  - gamma\r\n  - delta\r\n- omega\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n- alpha\r\n  - beta\r\n  - gamma\r\n- delta\r\n- omega\r\n\r\nafter\r\n'
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
const shape = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
  const directParagraph = (item) => item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
  const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  const nested = [...(editor?.querySelectorAll('ul ul') || [])]
  return {
    topTexts: topItems.map((item) => (directParagraph(item)?.textContent || '').trim()),
    nestedTexts: nested.flatMap((list) => [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
      .map((item) => (directParagraph(item)?.textContent || '').trim())),
    nestedCount: nested.length
  }
})()`)
const sameArray = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const openApp = async ({ file, profile, port, expectedTop, expectedNested }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const current = await shape(app)
      return sameArray(current.topTexts, expectedTop) &&
        sameArray(current.nestedTexts, expectedNested) &&
        current.nestedCount === (expectedNested.length ? 1 : 0)
    }, `${profile} topology did not mount`)
    await sleep(350)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}
const focusNestedTarget = async (app, target) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const item = [...(editor?.querySelectorAll('ul ul li') || [])]
      .find((candidate) => (candidate.querySelector('p')?.textContent || '').trim() === ${JSON.stringify(target)})
    const p = item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
    if (!p) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`), `${target} nested item not hit-testable`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(50)
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmListNestedLastChildBulletOutdentTransactionTrace = []
  window.__hmListNestedSingleChildBulletOutdentTransactionTrace = []
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
  owner: (window.__hmListNestedLastChildBulletOutdentTransactionTrace || []).slice(-40),
  single: (window.__hmListNestedSingleChildBulletOutdentTransactionTrace || []).slice(-40),
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
  let app = await openApp({
    file,
    profile: `${scenario.name}-edit`,
    port,
    expectedTop: scenario.beforeTop,
    expectedNested: scenario.beforeNested
  })
  try {
    await clearDiagnostics(app)
    await focusNestedTarget(app, scenario.target)
    await pressKey(app.send, { key: 'Tab', code: 'Tab', modifiers: 8, delayMs: scenario.forced ? 8 : 80 })

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

    const current = await shape(app)
    assert.deepEqual(current.topTexts, scenario.afterTop)
    assert.deepEqual(current.nestedTexts, scenario.afterNested)
    assert.equal(current.nestedCount, 1)
    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `${scenario.name} integrity: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false, `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const publication = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-nested-last-child-bullet-outdent'
    )
    assert.equal(publication.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
    assert.equal(publication[0].boundary,
      scenario.forced
        ? 'transaction-list-nested-last-child-bullet-outdent-forced-flush'
        : 'transaction-list-nested-last-child-bullet-outdent-markdown-updated')
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-nested-last-child-bullet-outdented' &&
      entry.integrityProof?.kind === 'transaction-list-nested-last-child-bullet-outdent-proof'
    )
    assert.ok(preservation, `${scenario.name} proof: ${JSON.stringify(state.preserve)}`)
    assert.equal(preservation.integrityProof.nestedCount, scenario.nestedCount)
    assert.equal(preservation.integrityProof.targetIndex, scenario.targetIndex)
    assert.equal(preservation.integrityProof.movedSourceRow?.token, scenario.marker)
    assert.equal(preservation.integrityProof.rawRemoval?.removed, '  ')
    assert.equal(preservation.integrityProof.step?.name, 'ReplaceAroundStep')
    assert.equal(preservation.integrityProof.step?.sliceSize, 2)
    assert.equal(preservation.integrityProof.step?.openStart, 2)
    assert.equal(preservation.integrityProof.step?.insert, 2)
    assert.equal(state.single.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' && entry.family === 'list-nested-last-child-bullet-outdent'
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

  app = await openApp({
    file,
    profile: `${scenario.name}-reopen`,
    port: port + 1,
    expectedTop: scenario.afterTop,
    expectedNested: scenario.afterNested
  })
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
  console.log('PASS nested last-child bullet outdent transaction UI: 2-child callback and 3-child forced physical Shift+Tab remove only the last target two-space indent, preserve prior nested siblings plus authored marker/BOM/CRLF through source, save, disk and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
