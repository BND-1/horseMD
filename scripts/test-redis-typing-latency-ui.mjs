// Typing-latency measurement on the redis doc (P7c-latency acceptance).
// Types a run of characters into a continuation paragraph and measures the
// beforeinput→input lag per keystroke from the app's input trace — the proxy
// for main-thread availability between keystrokes. Before the typing-yield
// scheduling this sat at ~90ms/keystroke (pipeline saturating the main
// thread); with deferral it must fall back to the low tens of ms, and the
// document must still sync (a later markdownUpdated publishes, disk saves).
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const fixtureDir = new URL('./fixtures/redis-tight/', import.meta.url)
const root = `/tmp/horsemd-latency-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 24760 + (process.pid % 30))

const waitFor = async (check, message, attempts = 240) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent))`

const dir = join(root, 'd')
await mkdir(dir, { recursive: true })
const file = join(dir, 'latency.md')
await copyFile(new URL('start.md', fixtureDir), file)
const app = await launchBuiltElectron({
  profileDir: join(dir, 'profile'),
  port: basePort,
  appArgs: [file]  // latency measurement runs untraced: the input trace adds ~40ms/key of instrumentation overhead (4 events/key + transaction steps)
})
try {
  await waitFor(() => app.evaluate(`(() =>
    (${visibleEditor()}?.textContent || '').includes('一个整数')
  )()`), 'doc did not mount')
  await sleep(3500)
  const placed = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const p = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => (node.textContent || '') === '一个整数。')
    if (!p) return false
    p.scrollIntoView({ block: 'center' })
    const text = [...p.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE)
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    const s = getSelection()
    s.removeAllRanges(); s.addRange(range)
    editor.focus()
    return true
  })()`)
  assert.equal(placed, true, 'target paragraph not found')

  // Type a run of chars at a natural cadence; measure per-key input lag in
  // the renderer (beforeinput → input delta, rAF-free main-thread proxy).
  const typed = await app.evaluate(`(() => {
    window.__hmLatency = []
    const editor = ${visibleEditor()}
    editor.addEventListener('beforeinput', (e) => { window.__hmLastBefore = performance.now() })
    editor.addEventListener('input', () => {
      if (window.__hmLastBefore != null) {
        window.__hmLatency.push(Math.round(performance.now() - window.__hmLastBefore))
        window.__hmLastBefore = null
      }
    }, true)
    return true
  })()`)
  assert.equal(typed, true)
  await typeTextLikeUser(app.send, 'abcdefghijklmnopqrst', { delayMs: 90 })
  await sleep(4000) // let the deferred pipeline publish the tail
  const stats = await app.evaluate(`(() => {
    const l = window.__hmLatency || []
    const sorted = [...l].sort((a, b) => a - b)
    return { count: l.length, values: l, p50: sorted[Math.floor(sorted.length / 2)] ?? null }
  })()`)
  console.log('per-key input lags (ms):', JSON.stringify(stats.values))
  console.log('p50:', stats.p50, 'count:', stats.count)
  // Acceptance: median per-key lag well under the pre-fix ~90ms saturation.
  assert.ok(stats.count >= 15, `expected >=15 samples, got ${stats.count}`)
  assert.ok(stats.p50 <= 45, `median per-key lag too high: ${stats.p50}ms`)

  // The deferred pipeline must still have published: save and check disk.
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save fab missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  const disk = await readFile(file, 'utf8')
  assert.match(disk, /一个整数。abcdefghijklmnopqrst/, 'typed run missing on disk')
  assert.equal(
    (await app.evaluate(`(() =>
      [...document.querySelectorAll('[class*="toast"]')].filter((n) => n.offsetParent)
        .some((n) => /不一致|暂停/.test(n.textContent || ''))
    )()`)),
    false,
    'warning toast during typing'
  )
  console.log(`PASS typing latency: p50=${stats.p50}ms over ${stats.count} keys (pre-fix ~90ms), deferred pipeline published, disk verified`)
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
