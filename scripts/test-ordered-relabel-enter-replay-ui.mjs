// Ordered-relabel replay (trace-9817, 2026-09-14 14:43): Enter splitting the
// FIRST item of a huge ordered list makes ProseMirror re-label every
// successor item (ReplaceAroundSteps spread across the document). The raw
// .eq() window computation counted those label-only changes as content, the
// window ballooned across code fences, the broad cross-fence owner claimed a
// split it cannot represent, and its candidate failed semantic validation →
// warning. The window now treats label/listType/spread-only deltas as
// unchanged, the cross-fence owner declines, and the split publishes through
// its regular path.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-relabel-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24770 + (process.pid % 30))
const warningPattern = /不一致|暂停|无法安全映射|Save paused/i

// An ordered list whose first item carries an indented continuation; later
// items embed fenced code (so a ballooned window would contain fences).
// Loose spacing between items mirrors the redis reference doc.
const fixture = [
  'intro paragraph.',
  '',
  '1. **返回值：**',
  '',
  '   一个整数。',
  '',
  '2. second item text',
  '',
  '   ```bash',
  '   redis> HLEN db',
  '   (integer) 2',
  '   ```',
  '',
  '3. third item text',
  '',
  '   ```bash',
  '   redis> HSET db redis redis.com',
  '   (integer) 1',
  '   ```',
  '',
  '4. fourth item text',
  '',
  '   tail paragraph of item four.',
  ''
].join('\n')

const waitFor = async (check, message, attempts = 240) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent))`
const collect = (app) => app.evaluate(`(() => ({
  toasts: [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent).map((n) => n.textContent || ''),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map((e) => ({ ok: e.ok, reason: e.preservationReason, site: e.validationSite }))
}))()`)
const imeCommit = async (app, pinyin, cjk) => {
  const rid = 'r' + Date.now()
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
const file = join(dir, 'relabel.md')
await writeFile(file, fixture, 'utf8')
const app = await launchBuiltElectron({
  profileDir: join(dir, 'profile'),
  port: basePort,
  appArgs: [file, '--horsemd-input-trace']
})
let completed = false
try {
  await waitFor(() => app.evaluate(`(() =>
    (${visibleEditor()}?.textContent || '').includes('一个整数')
  )()`), 'fixture did not mount')
  await sleep(2500)

  // Caret at the end of item 1's continuation paragraph, then IME + Enter —
  // the incident gesture. The split renumbers items 2..4 (label-only steps).
  const placed = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const p = [...editor.querySelectorAll('p')].find((n) => (n.textContent || '') === '一个整数。')
    if (!p) return false
    p.scrollIntoView({ block: 'center' })
    const text = [...p.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE)
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    const s = getSelection(); s.removeAllRanges(); s.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(placed, true, 'continuation paragraph not found')

  await imeCommit(app, 'laLiao', '拉了')
  await sleep(1200)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 20 })
  await sleep(2500) // deferred pipeline settles
  await typeTextLikeUser(app.send, 'kv', { delayMs: 80 })
  await sleep(2500)

  const state = await collect(app)
  assert.equal(
    state.toasts.some((t) => warningPattern.test(t)),
    false,
    `warning: ${JSON.stringify(state.toasts)}`
  )
  const bad = state.integrity.filter((e) => e.ok === false && e.site === 'transaction-cross-fence-span-markdown-updated')
  assert.equal(bad.length, 0, `cross-fence claimed/failed: ${JSON.stringify(bad)}`)

  // Structure: the split added a new first-item sibling; ordered numbering in
  // source stays authored; save verifies disk.
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save fab missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  const disk = await readFile(file, 'utf8')
  assert.match(disk, /一个整数。拉了/, 'IME text lost')
  // Insertion at position 2 correctly renumbers successors: 3./4./5.
  assert.match(disk, /2\. kv/, 'new sibling item missing')
  assert.match(disk, /3\. second item text/, 'successors not renumbered')
  assert.match(disk, /5\. fourth item text/, 'tail item wrong')
  assert.match(disk, /```bash/, 'fence lost')
  completed = true
  console.log('PASS ordered relabel Enter replay: split inside item 1 of a big ordered list stays warning-free, cross-fence declines the label-only balloon, disk bytes verified')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true }).catch(() => {})
}
