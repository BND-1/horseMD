// Tight-list replay (trace-26116, post-normalization, 2026-09-13 13:12):
// on the normalized redis doc (lists now TIGHT), typing into a split sibling,
// Cmd+Z undo, then Backspacing the text away, deleting the empty item, and
// one more Backspace warned twice: list-empty-item-tail-authored-row-unproven
// then source-list-structure-mismatch. The owners' authored-row byte proofs
// were tuned on the loose layout (marker rows separated by blank lines).
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const fixtureDir = new URL('./fixtures/redis-tight/', import.meta.url)
const root = `/tmp/horsemd-redis-tight-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24740 + (process.pid % 30))
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
    '__hmSourceSyncTransactionJournalTrace','__hmFlushTrace']) {
    if (!Array.isArray(window[k])) window[k] = []
    window[k].length = 0
  }
  return true
})()`)
const collect = (app) => app.evaluate(`(() => ({
  toasts: [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent).map((n) => n.textContent || ''),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map((e) => ({
    ok: e.ok, semanticOk: e.semanticOk, listSlotsMatch: e.listSlotsMatch,
    reason: e.preservationReason, site: e.validationSite
  })),
  diffs: (window.__hmSourceIntegrityDiffTrace || []).slice(-6),
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...e }) => e),
  rawTail: (window.__hmPreserveLog || []).slice(-4)
}))()`)
const backspace = (app, n = 1) => Promise.resolve().then(async () => {
  for (let i = 0; i < n; i += 1) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 400 })
    await sleep(500)
  }
})
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
  await sleep(250)
}
const assertClean = async (app, state, label) => {
  const bad = state.integrity.filter((entry) => entry.ok === false)
  if (bad.length) {
    await app.evaluate(`(() => {
      const owners = {}
      for (const key of Object.keys(window)) {
        if (!key.startsWith('__hm') || !Array.isArray(window[key])) continue
        const tail8 = window[key].slice(-6).map((e) => e && { phase: e.phase, family: e.family, ok: e.ok, reason: e.reason, recognized: e.recognized, legacyBlocked: e.legacyBlocked })
        if (tail8.some((e) => e && e.phase === 'plan')) owners[key] = tail8
      }
      const blob = JSON.stringify({ integrity: (window.__hmSourceIntegrityTrace || []).slice(-8), diffs: (window.__hmSourceIntegrityDiffTrace || []).slice(-8), owners, preserve: (window.__hmPreserveLog || []).slice(-4).map(({ source, previous, next, markdown, ...e }) => e) })
      window.__hmTightFailBlob = blob
      return true
    })()`)
    console.log('FAILDUMP captured in window.__hmTightFailBlob (len below); retrieve via evaluate')
    const blob = await app.evaluate(`window.__hmTightFailBlob || ''`)
    const { writeFile: wf } = await import('node:fs/promises')
    await wf('/tmp/tight-fail-blob.json', blob, 'utf8')
    console.log('FAILDUMP written to /tmp/tight-fail-blob.json, length', blob.length)
  }
  globalThis.__tightFailures = globalThis.__tightFailures || []
  globalThis.__tightFailures.push({ label, bad, toasts: state.toasts })
  console.log(`${bad.length ? '*** ' : ''}${label}: integrityFails=${bad.length} toasts=${JSON.stringify(state.toasts.slice(-2))}`)
}

const dir = join(root, 'd')
await mkdir(dir, { recursive: true })
const file = join(dir, 'tight.md')
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

  // Incident gesture (trace 26116): split at the continuation end, type junk
  // into the new sibling, UNDO, then backspace the item away.
  await initDiag(app)
  await caretAtEnd(app, '一个整数。')
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2200)
  await typeTextLikeUser(app.send, '啊发开发', { delayMs: 60 })
  await sleep(1200)
  let state = await collect(app)
  await assertClean(app, state, 'after junk typing')

  await pressKey(app.send, { key: 'z', code: 'KeyZ', modifiers: 4, delayMs: 20 })
  await sleep(1500)
  state = await collect(app)
  await assertClean(app, state, 'after undo')

  // Backspace the remaining text away, then the empty item, then one more
  // (the join) — trace warned exactly here.
  await backspace(app, 1)
  state = await collect(app)
  await assertClean(app, state, 'after bs1')
  await backspace(app, 1)
  state = await collect(app)
  await assertClean(app, state, 'after bs2 (empty item removal)')
  await backspace(app, 1)
  await sleep(600)
  state = await collect(app)
  await assertClean(app, state, 'after bs3 (join)')

  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save fab missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  const disk = await readFile(file, 'utf8')
  assert.match(disk, /一个整数/, 'continuation lost')  // the join's 3rd Backspace legally ate the trailing 。
  assert.doesNotMatch(disk, /啊发开发/, 'undone text leaked to disk')
  completed = true
  console.log('PASS tight-list backspace replay: split → type → undo → backspace chain on the normalized (tight) redis doc is warning-free with verified disk bytes')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true }).catch(() => {})
}
