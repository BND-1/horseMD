// E0 P3b (0.13.180 trace 09:47:30): a Chinese IME commit inside a nested
// bullet followed by an IMMEDIATE Enter used to fall to the legacy list
// mapper, which published the new empty sibling at TOP level (`- `) instead
// of nested depth — the first divergence that later produced three
// source-sync warnings. The focused split owner now proves the pending-text
// chain + terminal splitListItem and publishes the authored nested row.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

// Real IME composition via CDP: pinyin keystrokes update the composition text
// (each dispatch is one PM pending-text transaction), then insertText commits
// the CJK run — the same lifecycle as the user trace.
const imeComposeAndCommit = async (app, pinyin, cjk) => {
  const replacementId = `nested-split-${Date.now()}`
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

const root = `/tmp/horsemd-nested-split-chain-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24520 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

// Mirrors the user trace: a saved file whose list block already carries an
// authored nested bullet under a long top-level item.
const fixture = [
  '- 查询某类商品淘客的热门成交品牌/价格带等',
  '',
  '  * 期看；妙可',
  '',
  '#### 特别说明',
  '- 当用户指定分析具体周期内的成交时，优先使用此工具',
  ''
].join('\n')
const expected = [
  '- 查询某类商品淘客的热门成交品牌/价格带等',
  '',
  '  * 期看；妙可蔷薇',
  '  * ',
  '',
  '#### 特别说明',
  '- 当用户指定分析具体周期内的成交时，优先使用此工具',
  ''
].join('\n')

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
  const nested = [...(editor?.querySelectorAll('ul ul') || [])]
  const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
  const directParagraph = (item) => item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
  const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  return {
    topTexts: topItems.map((item) => (directParagraph(item)?.textContent || '').trim()),
    nestedTexts: nested.flatMap((list) => [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
      .map((item) => directParagraph(item)?.textContent || ''))
  }
})()`)
const placeCaretAtEnd = async (app, target) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const item = [...(editor?.querySelectorAll('ul ul li') || [])].find((candidate) => {
      const p = candidate.querySelector(':scope > .children > .content-dom > p') || candidate.querySelector('p')
      return (p?.textContent || '') === ${JSON.stringify(target)}
    })
    const p = item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
    const text = [...(p?.childNodes || [])].find((node) => node.nodeType === Node.TEXT_NODE)
    if (!p || !text) return { ok: false }
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true }
  })()`)
  assert.equal(result?.ok, true, `caret at end of ${target} failed`)
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmListNestedBulletSplitTransactionTrace = []
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
  owner: (window.__hmListNestedBulletSplitTransactionTrace || []).slice(-40),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

const scenarios = [
  { name: 'callback', forced: false },
  { name: 'forced', forced: true }
]

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  const app = await launchBuiltElectron({
    profileDir: join(root, `${scenario.name}-edit`),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const shape = await listShape(app)
      return shape.topTexts?.[0]?.includes('查询某类') === true && shape.nestedTexts?.[0] === '期看；妙可'
    }, `${scenario.name} topology did not mount`)
    await sleep(400)

    await clearDiagnostics(app)
    await placeCaretAtEnd(app, '期看；妙可')
    // IME commit lands in the nested item, then an IMMEDIATE Enter — the exact
    // 09:47:30 sequence that produced the top-level marker drift.
    await imeComposeAndCommit(app, 'qiangwei', '蔷薇')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: scenario.forced ? 8 : 80 })

    let source = null
    if (scenario.forced) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assert.equal(source, expected, `${scenario.name} forced source mismatch`)
      assert.equal(await toggleSource(app), true)
      await sleep(600)
    } else {
      await sleep(900)
    }

    const shape = await listShape(app)
    assert.deepEqual(shape.nestedTexts, ['期看；妙可蔷薇', ''], `${scenario.name} nested topology`)
    const state = await snapshot(app)
    assert.equal(
      state.integrity.some((entry) => entry.ok === false),
      false,
      `${scenario.name} integrity: ${JSON.stringify(state.integrity)}`
    )
    assert.equal(
      state.toasts.some((text) => warningPattern.test(text)),
      false,
      `${scenario.name} warning: ${JSON.stringify(state.toasts)}`
    )
    const publications = state.owner.filter((entry) =>
      entry.phase === 'published' && entry.ok === true && entry.family === 'list-nested-bullet-item-split'
    )
    assert.equal(publications.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
    assert.ok(
      publications[0].proof?.pendingTextChain?.textStepCount >= 1 ||
        publications[0].chainLength >= 1,
      `${scenario.name} chain proof missing`
    )
    const preservation = state.preserve.find((entry) =>
      entry.reason === 'list-nested-bullet-item-split' &&
      entry.integrityProof?.kind === 'transaction-list-nested-bullet-split-proof'
    )
    assert.ok(preservation, `${scenario.name} proof: ${JSON.stringify(state.preserve)}`)

    if (!scenario.forced) {
      assert.equal(await toggleSource(app), true)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assert.equal(source, expected, `${scenario.name} source mismatch`)
      assert.equal(await toggleSource(app), true)
    }
    // Save + verify disk bytes keep the nested marker at depth 2.
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${scenario.name} save fab missing`)
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${scenario.name} save did not finish`)
    assert.equal(await readFile(file, 'utf8'), expected, `${scenario.name} disk bytes mismatch`)
    assert.equal((await readFile(file, 'utf8')).includes('  * '), true, `${scenario.name} nested marker lost`)
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
  console.log('PASS nested bullet split pending-chain UI: IME commit + immediate Enter inside a nested bullet publishes the authored nested empty row (depth-2 marker) through the focused owner — no top-level marker drift, zero warnings, save bytes preserved')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
