// Incident replay (trace-62663, 2026-09-12 21:55 local): the third family —
// after Enter-splitting a loose item's continuation and filling the new
// sibling (的韩国), the user deletes the text, deletes the now-empty item,
// and the NEXT Backspace is a joinBackward structural step. Its legacy
// candidates failed the transition proof because the changed window touched
// the document's chronic inline asymmetries (autolink brackets, mark splits)
// → source-document-mismatch warnings. The transition channel now compares
// windows with inline-textual normalization (P7b); the whole chain must stay
// warning-free with correct bytes.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const fixtureDir = new URL('./fixtures/redis-line1-replay/', import.meta.url)
const root = `/tmp/horsemd-redis-join-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24730 + (process.pid % 30))
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
const collect = (app) => app.evaluate(`(() => ({
  toasts: [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent).map((n) => n.textContent || ''),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map((e) => ({
    ok: e.ok, listSlotsMatch: e.listSlotsMatch, reason: e.preservationReason, site: e.validationSite
  })),
  editorText: (${visibleEditor()}?.innerText || '').slice(0, 160)
}))()`)
const backspace = (app, n = 1) => Promise.resolve().then(async () => {
  for (let i = 0; i < n; i += 1) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 120 })
    await sleep(220)
  }
})
const imeCommit = async (app, pinyin, cjk) => {
  const replacementId = `join-${Date.now()}`
  for (let index = 0; index < pinyin.length; index += 1) {
    const ch = pinyin[index]
    const code = ch.charCodeAt(0)
    const common = { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
    await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    const value = pinyin.slice(0, index + 1)
    await app.send('Input.imeSetComposition', {
      text: value, selectionStart: value.length, selectionEnd: value.length, replacementId, location: 0
    })
    await sleep(18)
  }
  await app.send('Input.insertText', { text: cjk })
  await sleep(60)
}
const caretAtEnd = async (app, exactText) => {
  const placed = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const p = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => (node.textContent || '') === ${JSON.stringify(exactText)})
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
  assert.equal(placed, true, `paragraph ${exactText} not found`)
  await sleep(200)
}
const assertClean = (state, label) => {
  const bad = state.integrity.filter((entry) => entry.ok === false)
  assert.equal(bad.length, 0, `${label} integrity: ${JSON.stringify(bad)}`)
  assert.equal(
    state.toasts.some((text) => warningPattern.test(text)),
    false,
    `${label} warning: ${JSON.stringify(state.toasts)}`
  )
}

const dir = join(root, 'd')
await mkdir(dir, { recursive: true })
const file = join(dir, 'redis-join.md')
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
  )()`), 'redis doc did not mount')
  await sleep(3000)

  // Warm the baseline chain (fresh open vs live-session revision history).
  {
    const warm = await app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      const p = [...(editor?.querySelectorAll('p') || [])][0]
      if (!p) return null
      p.scrollIntoView({ block: 'center' })
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    assert.ok(warm, 'warm-up paragraph missing')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...warm, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...warm, button: 'left', clickCount: 1 })
    await sleep(200)
    await app.send('Input.insertText', { text: 'x' })
    await sleep(1800)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 20 })
    await sleep(1800)
  }

  await initDiag(app)
  // 1. Split the loose item at the continuation end (trace: Enter @13483).
  await caretAtEnd(app, '一个整数。')
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2000) // split publishes its own revision first
  // 2. Fill the empty sibling (trace: IME 的韩国).
  await imeCommit(app, 'de han guo', '的韩国')
  await sleep(1500)
  let state = await collect(app)
  assertClean(state, 'after fill')

  // 2b. Keep IME-editing the now-filled row (trace-89456 stall shape: the
  // in-row composition replacement previously fell to legacy and stalled the
  // whole chain with visible-stream no-op holds; the list-item-paragraph
  // owner must now publish it).
  await caretAtEnd(app, '的韩国')
  await imeCommit(app, ' de', '的韩国地')
  await sleep(1500)
  state = await collect(app)
  assertClean(state, 'after in-row retype')

  // 3. Type === then delete it back (trace: transient punctuation).
  await typeTextLikeUser(app.send, '===', { delayMs: 60 })
  await sleep(900)
  state = await collect(app)
  assertClean(state, 'after ===')

  // 4. Delete the text char by char (trace: diverged-nested-list-change ×3).
  await backspace(app, 3)
  state = await collect(app)
  assertClean(state, 'after === deletion')

  // 5. Delete 的韩国地 char by char.
  await backspace(app, 4)
  state = await collect(app)
  assertClean(state, 'after text deletion')

  // 6. Delete the now-empty item (trace: empty-list-item-removed).
  await backspace(app, 1)
  await sleep(900)
  state = await collect(app)
  assertClean(state, 'after empty item removal')

  // 7. THE INCIDENT STEP: joinBackward (trace: ReplaceStep 13479→13481
  //    structure:true slice=0 — previously warned here).
  await backspace(app, 1)
  await sleep(1500)
  state = await collect(app)
  assertClean(state, 'after joinBackward')

  // 8. Keep typing afterwards (trace: 阿道夫…).
  await typeTextLikeUser(app.send, '阿道夫', { delayMs: 70 })
  await sleep(2000)
  state = await collect(app)
  assertClean(state, 'after post-join typing')
  const postJoinText = await app.evaluate(`(${visibleEditor()}?.textContent || '').includes('阿道夫')`)
  assert.equal(postJoinText, true, 'post-join text landed')

  // Save and verify disk bytes: the continuation intact, the transient item
  // gone, no drifted duplicates.
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save fab missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  const disk = await readFile(file, 'utf8')
  assert.match(disk, /一个整数。/, 'continuation lost')
  assert.doesNotMatch(disk, /的韩国/, 'deleted text resurrected')
  assert.equal((disk.match(/阿道夫/g) || []).length >= 1, true, 'post-join text missing on disk')
  completed = true
  console.log('PASS redis joinBackward incident replay: split → IME fill → delete text → delete empty item → joinBackward → keep typing stays warning-free across the whole chain, disk bytes verified')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true }).catch(() => {})
}
