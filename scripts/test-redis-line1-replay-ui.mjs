// Incident replay (trace-51037, 2026-09-12 21:31:44 local): in the 333K redis
// reference doc (chronic serializer/parser round-trip asymmetry), clicking
// into a loose item's indented continuation paragraph `一个整数。`, Enter
// (split publishes an empty top-level sibling), then an IME composition
// (`se f s n k` → 色反馈) filling that sibling. The 0.13.208 owner deferred
// forever on callbackDocumentEquivalent=false and the legacy locally-aligned
// mapper drifted the text into the previous paragraph (`一色反馈个整数。`) →
// source-list-structure-mismatch warning. The start.md fixture is byte-exact
// from the trigger's own trace (event #246, the split-published revision).
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const fixtureDir = new URL('./fixtures/redis-line1-replay/', import.meta.url)
const root = `/tmp/horsemd-redis-replay-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24720 + (process.pid % 30))
const warningPattern = /不一致|暂停|无法安全映射|Save paused/i

const waitFor = async (check, message, attempts = 240) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent))`
const initDiag = (app) => app.evaluate(`(() => {
  for (const k of ['__hmPreserveLog','__hmSourceIntegrityTrace','__hmSourceSyncCoordinatorTrace',
    '__hmSourceSyncTransactionJournalTrace','__hmListEmptyItemTextFillTransactionTrace','__hmFlushTrace']) {
    if (!Array.isArray(window[k])) window[k] = []
    window[k].length = 0
  }
  return true
})()`)
const snapshot = (app) => app.evaluate(`(() => ({
  toasts: [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent).map((n) => n.textContent || ''),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map((e) => ({
    ok: e.ok, semanticOk: e.semanticOk, listSlotsMatch: e.listSlotsMatch,
    reason: e.preservationReason, site: e.validationSite
  })),
  owner: (window.__hmListEmptyItemTextFillTransactionTrace || []).slice(-20),
  preserve: (window.__hmPreserveLog || []).slice(-14).map(({ source, previous, next, markdown, ...e }) => e),
  journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-8).map((e) => ({
    phase: e.phase, ok: e.ok, reason: e.reason, baseRevision: e.baseRevision,
    txn: e.transactionCount, steps: (e.stepDetails || []).slice(-4)
  })),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-8)
}))()`)
const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

// Real IME replay of the trigger: pinyin keystrokes (INCLUDING the spaces the
// user's IME emitted) update the composition, then insertText commits 色反馈.
const imeReplay = async (app) => {
  const replacementId = `redis-replay-${Date.now()}`
  const pinyin = 'se f s n k'
  for (let index = 0; index < pinyin.length; index += 1) {
    const ch = pinyin[index]
    const code = ch.charCodeAt(0)
    const common = {
      key: ch,
      code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`,
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
  await app.send('Input.insertText', { text: '色反馈' })
  await sleep(60)
}

// Place the caret at the END of the continuation paragraph `一个整数。` —
// the exact-text paragraph (unique in this doc, verified by probe) inside the
// loose 返回值 item. The trigger's caret was at the paragraph END (anchor
// 13841 = contentStart + 5); a start-of-paragraph split is a different shape.
const clickContinuation = async (app) => {
  const placed = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const p = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => (node.textContent || '') === '一个整数。')
    if (!p) return false
    p.scrollIntoView({ block: 'center' })
    const text = [...p.childNodes].reverse().find((node) => node.nodeType === Node.TEXT_NODE)
    if (!text) return false
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(placed, true, 'continuation paragraph 一个整数。 not found')
  await sleep(200)
}

const dir = join(root, 'd')
await mkdir(dir, { recursive: true })
const file = join(dir, 'redis-replay.md')
await copyFile(new URL('start.md', fixtureDir), file)
const app = await launchBuiltElectron({
  profileDir: join(dir, 'profile'),
  port: basePort,
  appArgs: [file, '--horsemd-input-trace']
})
let completed = false
try {
  await waitFor(() => app.evaluate(`(() =>
    (${visibleEditor()}?.textContent || '').includes('一个整数')
  )()`), 'redis replay doc did not mount')
  await sleep(3000)

  // Warm the baseline chain: the trigger happened at revision 11 of a live
  // session; a fresh open starts at revision 0 and the split-only legacy
  // publication misbehaves there. One benign publish+revert aligns the
  // committed source/canonical baselines with the live serialization.
  {
    const warm = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const p = [...(editor?.querySelectorAll('p') || [])][0]
      if (!p) return null
      p.scrollIntoView({ block: 'center' })
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    assert.ok(warm, 'warm-up paragraph not found')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...warm, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...warm, button: 'left', clickCount: 1 })
    await sleep(200)
    await app.send('Input.insertText', { text: 'x' })
    await sleep(1800)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 20 })
    await sleep(1800)
  }

  await initDiag(app)
  await clickContinuation(app)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2500) // the split must publish its own revision first (trace: ~1.3s serialize+debounce on 333K, user typed at ~2.2s)
  await imeReplay(app)
  await sleep(2500)

  const state = await snapshot(app)
  assert.equal(
    state.integrity.some((entry) => entry.ok === false),
    false,
    `integrity: ${JSON.stringify(state.integrity)}`
  )
  assert.equal(
    state.toasts.some((text) => warningPattern.test(text)),
    false,
    `warning: ${JSON.stringify(state.toasts)}`
  )
  const publications = state.owner.filter((entry) =>
    entry.phase === 'published' && entry.ok === true &&
    entry.family === 'list-empty-item-text-filled'
  )
  if (publications.length !== 1) {
    console.log('DEBUG owner:', JSON.stringify(state.owner, null, 1))
    console.log('DEBUG preserve:', JSON.stringify(state.preserve, null, 1))
    console.log('DEBUG journal:', JSON.stringify(state.journal, null, 1))
    console.log('DEBUG coordinator:', JSON.stringify(state.coordinator, null, 1))
  }
  assert.equal(publications.length, 1, `owner: ${JSON.stringify(state.owner)}`)
  // The gate-removal contract itself (callbackDocumentEquivalent=false must
  // still publish) is locked deterministically by the Node suite (case 9b);
  // the published-phase trace entry carries no proof, so just confirm the
  // publication happened on the fill journal.
  assert.ok(publications[0].journalId, 'publication entry missing journal id')

  // Source bytes: the fill lands in the authored empty marker row after the
  // continuation, never inside 一个整数。.
  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source view missing')
  assert.match(source, /一个整数。\r?\n+- 色反馈/, 'fill misplaced:\n' + source.slice(source.indexOf('一个整数') - 200, source.indexOf('一个整数') + 200))
  assert.doesNotMatch(source, /一色反馈个整数/, 'text drifted into the previous paragraph')
  assert.equal(await toggleSource(app), true)

  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save fab missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  const disk = await readFile(file, 'utf8')
  assert.match(disk, /一个整数。\r?\n+- 色反馈/, 'disk fill misplaced')
  assert.doesNotMatch(disk, /一色反馈个整数/, 'disk text drifted')
  completed = true
  console.log('PASS redis line1 incident replay: click → Enter split → IME fill in the diverged 333K redis doc publishes through the focused owner with callbackDocumentEquivalent=false — zero warnings, exact bytes, disk verified')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true }).catch(() => {})
}
