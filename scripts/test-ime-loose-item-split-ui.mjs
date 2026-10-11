// P6e (trace-38723 2026-09-12 10:16): a Chinese IME commit at the end of a
// loose list item's indented continuation paragraph, then Enter — the split
// publishes an empty top-level sibling row — then a second IME composition
// fills that empty sibling. The empty marker row contributes zero visible
// characters, so the legacy locally-aligned mapper drifted the fill into the
// PREVIOUS paragraph and the strict gate fail-closed with a warning. The
// list-empty-item-text-filled owner must publish the fill into the authored
// empty row: zero warnings, exact source bytes, disk and cold reopen stable.
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
  const replacementId = `loose-fill-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
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

const root = `/tmp/horsemd-ime-loose-fill-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24620 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

// Mirrors the incident region of the redis reference doc: a loose top-level
// bullet list whose last item carries an indented continuation paragraph,
// immediately followed by an authored fence.
const fixture = [
  'intro text',
  '',
  '- 可用版本：',
  '',
  '  >= 2.6.0',
  '',
  '- 时间复杂度：',
  '',
  '  O(1)',
  '',
  '- 返回值：',
  '',
  '  执行加法操作之后 `field` 域的值。',
  '',
  '```bash',
  'redis> HSET mykey field 10.50',
  '(integer) 1',
  '```',
  '',
  'after fence',
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
  const top = [...(editor?.querySelectorAll('ul') || [])].find((node) => !node.parentElement?.closest('ul'))
  const directParagraph = (item) => item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
  const topItems = [...(top?.querySelectorAll(':scope > .milkdown-list-item-block > li') || [])]
  return {
    itemTexts: topItems.map((item) => (directParagraph(item)?.textContent || '').trim()),
    paragraphTexts: topItems.map((item) =>
      [...(item?.querySelectorAll(':scope > .children > .content-dom > p') || [])]
        .map((p) => (p.textContent || '').trim()))
  }
})()`)
const placeCaretAtContinuationEnd = async (app, markerText) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const items = [...(editor?.querySelectorAll('ul') || [])]
      .filter((node) => !node.parentElement?.closest('ul'))[0]
      ?.querySelectorAll(':scope > .milkdown-list-item-block > li') || []
    const item = [...items].find((candidate) => {
      const p = candidate.querySelector(':scope > .children > .content-dom > p') || candidate.querySelector('p')
      return (p?.textContent || '').includes(${JSON.stringify(markerText)})
    })
    const paragraphs = [...(item?.querySelectorAll(':scope > .children > .content-dom > p') || [])]
    const p = paragraphs[paragraphs.length - 1]
    // The LAST text node: the incident paragraph ends with plain text after
    // an inline-code run, and the caret must land at the paragraph's true end.
    const text = [...(p?.childNodes || [])].reverse().find((node) => node.nodeType === Node.TEXT_NODE)
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
  assert.equal(result?.ok, true, 'caret at continuation end failed')
}
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmListEmptyItemTextFillTransactionTrace = []
})()`)
const snapshot = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-60).map(({ source, previous, next, markdown, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-60).map((entry) => ({
    ok: entry.ok,
    semanticOk: entry.semanticOk,
    listSlotsMatch: entry.listSlotsMatch,
    preservationReason: entry.preservationReason,
    validationSite: entry.validationSite
  })),
  owner: (window.__hmListEmptyItemTextFillTransactionTrace || []).slice(-60),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)

const scenarios = [
  { name: 'callback', settleAfterSplit: 900 },
  { name: 'forced', settleAfterSplit: 30 }
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
      return shape.itemTexts?.length === 3 &&
        shape.itemTexts?.[2]?.includes('返回值') === true &&
        shape.paragraphTexts?.[2]?.length === 2
    }, `${scenario.name} topology did not mount`)
    await sleep(400)

    await clearDiagnostics(app)
    // 1. IME commit at the end of the continuation paragraph.
    await placeCaretAtContinuationEnd(app, '返回值')
    await imeComposeAndCommit(app, 'kaishi', '开始')
    await sleep(scenario.name === 'callback' ? 400 : 40)
    // 2. Enter splits the loose item: an empty top-level sibling appears and
    //    its row must be published before the fill.
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 8 })
    await waitFor(async () => {
      const shape = await listShape(app)
      return shape.itemTexts?.length === 4 && shape.itemTexts?.[3] === ''
    }, `${scenario.name} empty sibling did not appear`)
    await sleep(scenario.settleAfterSplit)
    // 3. IME composition fills the empty sibling (the caret is inside it).
    await imeComposeAndCommit(app, 'sebufangjia', '色不放假')
    await sleep(1000)

    const shape = await listShape(app)
    assert.equal(shape.itemTexts?.length, 4, `${scenario.name} topology after fill`)
    assert.equal(shape.itemTexts?.[3], '色不放假', `${scenario.name} fill text: ${JSON.stringify(shape)}`)

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
    if (scenario.settleAfterSplit >= 400) {
      // The incident's failing call: the split already published, the fill is
      // its own pure-text journal — the focused owner must own it.
      const publications = state.owner.filter((entry) =>
        entry.phase === 'published' && entry.ok === true &&
        entry.family === 'list-empty-item-text-filled'
      )
      assert.equal(publications.length, 1, `${scenario.name} owner: ${JSON.stringify(state.owner)}`)
      const preservation = state.preserve.find((entry) =>
        entry.reason === 'list-empty-item-text-filled' &&
        entry.integrityProof?.kind === 'transaction-list-empty-item-text-filled-proof'
      )
      assert.ok(preservation, `${scenario.name} proof: ${JSON.stringify(state.preserve)}`)
      assert.equal(preservation.integrityProof?.finalText, '色不放假')
    } else {
      // No settle: split + fill coalesce into one journal; the owner stays out
      // (chain stage, plain reject) and the observable contract — zero
      // warnings, exact bytes — is what stays locked here.
      assert.equal(
        state.owner.some((entry) => entry.recognized === true),
        false,
        `${scenario.name} owner must not fail-close the coalesced shape: ${JSON.stringify(state.owner)}`
      )
    }

    // Source mode shows the fill inside the authored empty marker row.
    assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
    const source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
    assert.ok(
      /执行加法操作之后 `field` 域的值。开始\r?\n+- 色不放假/.test(source),
      `${scenario.name} source fill misplaced:\n${source}`
    )
    // The fence and every untouched byte survive.
    assert.ok(source.includes('```bash\nredis> HSET mykey field 10.50\n(integer) 1\n```'), 'fence lost')
    assert.ok(source.includes('- 可用版本：'), 'first item lost')
    assert.ok(!/羁?色不放假开始/.test(source), 'fill drifted into the continuation')
    assert.equal(await toggleSource(app), true)

    // Save + verify disk bytes.
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), `${scenario.name} save fab missing`)
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${scenario.name} save did not finish`)
    const disk = await readFile(file, 'utf8')
    assert.ok(/执行加法操作之后 `field` 域的值。开始\r?\n+- 色不放假/.test(disk), `${scenario.name} disk fill misplaced`)
    assert.ok(disk.includes('```bash'), `${scenario.name} disk fence lost`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Cold reopen with a FRESH profile: the saved file must restore the same
// four-item topology with the filled sibling and stay warning-free.
const runColdReopen = async (port) => {
  const file = join(root, 'callback.md')
  const app = await launchBuiltElectron({
    profileDir: join(root, 'reopen-profile'),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(async () => {
      const shape = await listShape(app)
      return shape.itemTexts?.length === 4 && shape.itemTexts?.[3] === '色不放假'
    }, 'cold reopen topology mismatch')
    const state = await snapshot(app)
    assert.equal(
      state.toasts.some((text) => warningPattern.test(text)),
      false,
      `cold reopen warning: ${JSON.stringify(state.toasts)}`
    )
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
  await runColdReopen(basePort + 50)
  completed = true
  console.log('PASS ime loose item split UI: IME commit + Enter split + IME fill of the empty sibling publishes the authored row through the focused owner — zero warnings, exact source bytes, disk and cold reopen stable')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
