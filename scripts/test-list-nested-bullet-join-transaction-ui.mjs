import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-nested-bullet-join-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24620 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const scenarios = [
  {
    name: 'two-callback',
    forced: false,
    target: 'delta',
    marker: '+',
    beforeItems: [['gamma'], ['delta']],
    afterItems: [['gamma', 'delta']],
    fixture: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n  + delta\r\n+ omega\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n+ alpha\r\n+ beta\r\n  + gamma\r\n\r\n    delta\r\n+ omega\r\n\r\nafter\r\n'
  },
  {
    name: 'middle-forced',
    forced: true,
    target: 'delta',
    marker: '-',
    beforeItems: [['gamma'], ['delta'], ['epsilon']],
    afterItems: [['gamma', 'delta'], ['epsilon']],
    fixture: '\uFEFFbefore\r\n\r\n- alpha\r\n- beta\r\n  - gamma\r\n  - delta\r\n  - epsilon\r\n- omega\r\n\r\nafter\r\n',
    expected: '\uFEFFbefore\r\n\r\n- alpha\r\n- beta\r\n  - gamma\r\n\r\n    delta\r\n  - epsilon\r\n- omega\r\n\r\nafter\r\n'
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
  const directParagraphs = (item) => [...(item?.querySelectorAll(':scope > .children > .content-dom > p') || [])]
    .map((p) => p.textContent || '')
  const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  const nestedList = [...(editor?.querySelectorAll('ul ul') || [])][0]
  const nestedItems = [...(nestedList?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  return {
    topTexts: topItems.map((item) => directParagraphs(item)[0] || ''),
    nestedItems: nestedItems.map((item) => directParagraphs(item)),
    nestedCount: editor?.querySelectorAll('ul ul').length || 0
  }
})()`)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const openApp = async ({ file, profile, port, expectedItems }) => {
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
      return same(current.topTexts, ['alpha', 'beta', 'omega']) && same(current.nestedItems, expectedItems) && current.nestedCount === 1
    }, `${profile} topology did not mount`)
    await sleep(350)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}
const placeCaretStart = async (app, target) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const item = [...(editor?.querySelectorAll('ul ul li') || [])].find((candidate) => {
      const ps = [...candidate.querySelectorAll(':scope > .children > .content-dom > p')]
      return ps.length === 1 && (ps[0].textContent || '') === ${JSON.stringify(target)}
    })
    const p = item?.querySelector(':scope > .children > .content-dom > p')
    const text = [...(p?.childNodes || [])].find((node) => node.nodeType === Node.TEXT_NODE)
    if (!text) return false
    const range = document.createRange()
    range.setStart(text, 0)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(result, true, `${target} caret placement failed`)
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmListNestedBulletJoinTransactionTrace = []
  window.__hmListNestedBulletSplitTransactionTrace = []
  window.__hmListNestedFirstChildBulletOutdentTransactionTrace = []
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
  owner: (window.__hmListNestedBulletJoinTransactionTrace || []).slice(-40),
  split: (window.__hmListNestedBulletSplitTransactionTrace || []).slice(-40),
  first: (window.__hmListNestedFirstChildBulletOutdentTransactionTrace || []).slice(-40),
  last: (window.__hmListNestedLastChildBulletOutdentTransactionTrace || []).slice(-40),
  single: (window.__hmListNestedSingleChildBulletOutdentTransactionTrace || []).slice(-40),
  broad: (window.__hmListSubtreeTransactionTrace || []).slice(-40),
  toasts: [...document.querySelectorAll('[class*="toast"]')].filter((node) => node.offsetParent).map((node) => node.textContent || '')
}))()`)
const save = async (app, label) => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${label} save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not finish`)
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, scenario.fixture, 'utf8')
  let app = await openApp({ file, profile: `${scenario.name}-edit`, port, expectedItems: scenario.beforeItems })
  try {
    await clearDiagnostics(app)
    await placeCaretStart(app, scenario.target)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: scenario.forced ? 8 : 80 })

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
    assert.deepEqual(current.topTexts, ['alpha', 'beta', 'omega'])
    assert.deepEqual(current.nestedItems, scenario.afterItems)
    assert.equal(current.nestedCount, 1)
    const state = await snapshot(app)
    assert.equal(state.integrity.some((entry) => entry.ok === false), false, `${scenario.name} integrity: ${JSON.stringify(state.integrity)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), false, `${scenario.name} warning: ${JSON.stringify(state.toasts)}`)
    const publication = state.owner.filter((entry) => entry.phase === 'published' && entry.ok === true && entry.family === 'list-nested-bullet-item-join')
    assert.equal(publication.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
    assert.equal(publication[0].boundary,
      scenario.forced ? 'transaction-list-nested-bullet-item-join-forced-flush' : 'transaction-list-nested-bullet-item-join-markdown-updated')
    const preservation = state.preserve.find((entry) => entry.reason === 'list-nested-bullet-item-joined' && entry.integrityProof?.kind === 'transaction-list-nested-bullet-join-proof')
    assert.ok(preservation, `${scenario.name} proof: ${JSON.stringify(state.preserve)}`)
    assert.equal(preservation.integrityProof.step?.name, 'ReplaceStep')
    assert.equal(preservation.integrityProof.step?.sliceSize, 0)
    assert.equal(preservation.integrityProof.targetSourceRow?.token, scenario.marker)
    assert.equal(preservation.integrityProof.rawReplacement?.replacement, '\r\n    ')
    assert.equal(state.split.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.first.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.last.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.single.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.broad.some((entry) => entry.phase === 'published' && entry.ok === true), false)
    assert.equal(state.coordinator.some((entry) => entry.phase === 'published' && entry.family === 'list-nested-bullet-item-join'), true)

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

  app = await openApp({ file, profile: `${scenario.name}-reopen`, port: port + 1, expectedItems: scenario.afterItems })
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
  for (let index = 0; index < scenarios.length; index += 1) await runScenario(scenarios[index], basePort + index * 10)
  completed = true
  console.log('PASS nested bullet join transaction UI: callback/forced physical Backspace joins any non-first nested sibling into a second paragraph, publishes focused-only, preserves marker/BOM/CRLF through continuation source, save, disk and cold reopen')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
