// Adjacent-list merge replay (trace-14865, 2026-09-14 14:55): typing an
// input-rule bullet at the end of the paragraph directly ABOVE an existing
// list creates a SEPARATE single-item list node in the live ProseMirror doc,
// while CommonMark (and the source scanner) merges blank-separated same-kind
// lists into ONE list. The empty-item fill owner's row-count bijection
// compared the merged source block (5 rows) against the single PM list node
// (2 items after Enter) -> proof failure after family recognition ->
// fail-closed warning.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const fixtureDir = new URL('./fixtures/redis-tight/', import.meta.url)
const root = `/tmp/horsemd-adjmerge-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24780 + (process.pid % 30))
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
const caretAtEnd = async (app, contains) => {
  const placed = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const p = [...editor.querySelectorAll('p')].find((n) => (n.textContent || '').includes(${JSON.stringify(contains)}))
    if (!p) return false
    p.scrollIntoView({ block: 'center' })
    const text = [...p.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE)
    if (!text) return false
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    const s = getSelection(); s.removeAllRanges(); s.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(placed, true, `paragraph containing ${contains} not found`)
  await sleep(250)
}
const collect = (app) => app.evaluate(`(() => ({
  toasts: [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent).map((n) => n.textContent || ''),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map((e) => ({ ok: e.ok, reason: e.preservationReason, site: e.validationSite })),
  owner: (window.__hmListEmptyItemTextFillTransactionTrace || []).slice(-6).map((e) => ({ phase: e.phase, ok: e.ok, reason: e.reason }))
}))()`)
const imeCommit = async (app, pinyin, cjk) => {
  const rid = 'a' + Date.now()
  for (let i = 0; i < pinyin.length; i++) {
    const ch = pinyin[i]
    const common = { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0) }
    await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    const v = pinyin.slice(0, i + 1)
    await app.send('Input.imeSetComposition', { text: v, selectionStart: v.length, selectionEnd: v.length, replacementId: rid, location: 0 })
    await sleep(18)
  }
  await app.send('Input.insertText', { text: cjk })
  await sleep(60)
}

const dir = join(root, 'd')
await mkdir(dir, { recursive: true })
const file = join(dir, 'adjmerge.md')
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
  )()`), 'doc did not mount')
  await sleep(3500)

  // The incident gesture: caret at the end of the paragraph directly above
  // the document's first list, type "- " (input rule converts the paragraph
  // into a single-item PM list adjacent to the existing one), Enter (split
  // the new item), then IME-fill the fresh empty item.
  await caretAtEnd(app, '从 Redis 2.6.12 版本开始')
  await typeTextLikeUser(app.send, '- ', { delayMs: 90 })
  await sleep(1800) // let the input-rule publication settle
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2200)
  await imeCommit(app, 'niKuaiLe', '你快乐')
  await sleep(2500)

  const state = await collect(app)
  assert.equal(
    state.toasts.some((t) => warningPattern.test(t)),
    false,
    `warning: ${JSON.stringify(state.toasts)}`
  )
  const fillFails = state.owner.filter((e) => e.phase === 'plan' && e.ok === false && /row-count/.test(e.reason || ''))
  assert.equal(fillFails.length, 0, `owner row-count proof failed: ${JSON.stringify(state.owner)}`)

  // trace-21168 continuation: Enter (split the filled item) then Backspace
  // (remove the fresh empty item) — the tail-remove owner's row proof with
  // the same merged-adjacency state.
  await caretAtEnd(app, '你快乐')
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2200)
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
  await sleep(2000)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2200)
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
  await sleep(2000)
  const tailState = await collect(app)
  assert.equal(
    tailState.toasts.some((t) => warningPattern.test(t)),
    false,
    `tail warning: ${JSON.stringify(tailState.toasts)}`
  )
  const tailFails = tailState.integrity.filter((e) => e.ok === false && /tail-row-count/.test(e.reason || ''))
  assert.equal(tailFails.length, 0, `tail owner row-count failed: ${JSON.stringify(tailState.owner)}`)

  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save fab missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  const disk = await readFile(file, 'utf8')
  assert.match(disk, /你快乐/, 'IME fill missing on disk')
  assert.match(disk, /- `EX seconds`/, 'existing list lost')
  completed = true
  console.log('PASS adjacent-list merge fill: input-rule item above an existing list + Enter + IME fill stays warning-free with correct disk bytes')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true }).catch(() => {})
}
