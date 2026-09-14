import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

// PID 25389: delete 粉色分 one character at a time, then remove the empty
// ordered item. Always edit an isolated COPY, never the supplied original.
const input = process.env.REDIS_INPUT_PATH || new URL('./fixtures/redis-tight/start.md', import.meta.url)
const original = await readFile(input, 'utf8')
const lines = original.split('\n')
const anchors = lines.map((line, index) => line.includes('该键原有的 TTL 将被清除。') ? index : -1).filter((index) => index >= 0)
assert.equal(anchors.length, 1, 'Redis setup anchor must be unique')
const anchor = anchors[0]
lines.splice(anchor + 1, 0, '', '1. 色粉色')
const initial = lines.join('\n')
const expected = initial
const root = await mkdtemp(join(tmpdir(), 'horsemd-redis-delete-tail-'))
const file = join(root, 'redis-copy.md')
await writeFile(file, initial)
const port = Number(process.env.CDP_PORT || 24800 + (process.pid % 100))
const editor = "([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent))"
const waitFor = async (check, label) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(label)
}
const launch = (profile, nextPort) => launchBuiltElectron({ profileDir: join(root, profile), port: nextPort, appArgs: [file, '--horsemd-input-trace'] })
let app = await launch('profile', port)
const failures = []
try {
  await waitFor(() => app.evaluate(`(${editor}?.textContent || '').includes('捐赠')`), 'complete Redis document did not mount')
  await sleep(2000)
  assert.equal(await app.evaluate(`(() => {
    for (const k of ['__hmSourceIntegrityTrace','__hmSourceIntegrityDiffTrace','__hmSourceSyncCoordinatorTrace','__hmPreserveLog']) window[k] = []
    const p = [...${editor}.querySelectorAll('li p')].find(n => n.textContent === '色粉色')
    if (!p?.firstChild) return false
    p.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.selectNodeContents(p); range.collapse(false)
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    ${editor}.focus()
    return true
  })()`), true)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2200)
  const pinyin = 'fensefen'
  for (let index = 1; index <= pinyin.length; index++) {
    await app.send('Input.imeSetComposition', { text: pinyin.slice(0, index), selectionStart: index, selectionEnd: index })
    await sleep(60)
  }
  await app.send('Input.insertText', { text: '粉色分' })
  await sleep(2200)
  for (let i = 0; i < 4; i++) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 20 })
    await sleep(2200)
    const state = await app.evaluate(`(() => ({
      integrity: window.__hmSourceIntegrityTrace.filter(e => e.ok === false).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
      coordinator: window.__hmSourceSyncCoordinatorTrace.filter(e => e.phase === 'rejected'),
      diffs: (window.__hmSourceIntegrityDiffTrace || []).slice(-4),
      text: ${editor}.textContent.slice(0, 500),
      toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent)
    }))()`)
    console.log('CHECKPOINT', i + 1, JSON.stringify(state))
    if (state.integrity.length || state.coordinator.length || state.toasts.some(t => /不一致|暂停|Save paused/i.test(t))) failures.push({ step: i + 1, ...state })
  }
  assert.equal(failures.length, 0, 'first divergence must be absent, not hidden by later recovery')
  assert.equal(await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find(n => n.offsetParent && /源码|Source/.test(n.title || n.textContent || ''))
    button?.click()
    return Boolean(button)
  })()`), true, 'source status button missing')
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find(n => n.offsetParent))`), 'source view did not open')
  const raw = await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find(n => n.offsetParent).value`)
  assert.ok(raw === expected, `source bytes differ: actual=${raw.length}, expected=${expected.length}`)
  await pressKey(app.send, { key: 's', code: 'KeyS', modifiers: 4, delayMs: 20 })
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
  const disk = await readFile(file, 'utf8')
  let firstDifferent = 0
  while (firstDifferent < Math.min(disk.length, expected.length) && disk[firstDifferent] === expected[firstDifferent]) firstDifferent++
  assert.ok(disk === expected, `full saved bytes differ: actual=${disk.length}, expected=${expected.length}, firstDifference=${firstDifferent}`)
  assert.equal(failures.length, 0, 'first divergence must be absent, not hidden by later recovery')
  await stopBuiltElectron(app, { removeProfile: true })
  app = await launch('cold-profile', port + 1)
  await waitFor(() => app.evaluate(`(${editor}?.textContent || '').includes('捐赠')`), 'cold reopen incomplete')
  assert.equal(await app.evaluate(`(() => {
    const matches = [...${editor}.querySelectorAll('li p')].filter(n => n.textContent.trim() === '色粉色')
    return matches.length === 1 && !${editor}.textContent.includes('粉色分')
  })()`), true, 'cold reopen must contain exactly the surviving list item')
  assert.equal(await readFile(input, 'utf8'), original, 'original Redis file changed during test')
  console.log('PASS Redis delete-tail: all four first-divergence checkpoints, exact full disk bytes, fresh-profile reopen, original untouched')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  console.log('Isolated test evidence retained:', root)
}
