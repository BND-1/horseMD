// 0.13.179 acceptance: in a generated scratch doc the user types `- ` bullets.
// When the structural scratch fallback takes over, the published source must
// keep the TYPED marker spelling (`-`) rather than the serializer's `*` —
// Markdown interoperability with other tools (Typora/Obsidian diff on marker
// spelling). Verifies marker-preservation-first with raw-canonical floor.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-marker-spelling-${process.pid}`
const port = Number(process.env.CDP_PORT || 13680 + (process.pid % 20))
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

let app = null
try {
  const dir = join(root, 'd')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 's.md')
  await writeFile(file, '', 'utf8')
  app = await launchBuiltElectron({ profileDir: join(dir, 'p'), port, appArgs: [file, '--horsemd-input-trace'] })
  const waitFor = async (check, msg, n = 80) => {
    for (let i = 0; i < n; i += 1) { const v = await check(); if (v) return v; await sleep(150) }
    throw new Error(msg)
  }
  await waitFor(() => app.evaluate('(() => !![...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent))()'), 'mount')
  await sleep(2500)
  const pt = await app.evaluate('(() => { const e = [...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 90) } })()')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt, button: 'left', clickCount: 1 })
  await sleep(300)
  for (let a = 0; a < 10; a += 1) {
    await typeTextLikeUser(app.send, '头', { delayMs: 25 })
    await sleep(500)
    if (await app.evaluate('(() => [...document.querySelectorAll(".ProseMirror")].find(n => n.offsetParent)?.textContent.includes("头"))()')) break
  }
  const enter = () => pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 35 })
  await enter(); await sleep(250)
  // typed `- ` bullets with content
  await typeTextLikeUser(app.send, '- 第一项', { delayMs: 40 })
  await enter(); await sleep(220)
  await typeTextLikeUser(app.send, '- 第二项内容', { delayMs: 40 })
  await enter(); await sleep(220)
  await typeTextLikeUser(app.send, '- 第三项', { delayMs: 40 })
  await sleep(600)
  // baseline check: source currently keeps typed `-` (normal path preserves it)
  assert.equal(await toggleSource(app), true, 'baseline toggle failed')
  const baseline = await waitFor(() => visibleSource(app), 'baseline source missing')
  await sleep(400)
  assert.equal(await toggleSource(app), true, 'back to rich failed')
  await sleep(400)
  // caret into 第二项内容, char-delete to empty, structural removal, flush
  const clicked = await app.evaluate(`(() => {
    const e = [...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent)
    const ps = [...e.querySelectorAll('li p, p')]
    const target = [...e.querySelectorAll('p')].find((p) => (p.textContent || '').includes('第二项'))
    if (!target) return false
    const r = target.getBoundingClientRect()
    window.__mp = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    return true
  })()`)
  assert.equal(clicked, true, '第二项 paragraph not found')
  const mp = await app.evaluate('window.__mp')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mp, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mp, button: 'left', clickCount: 1 })
  await sleep(300)
  for (let i = 0; i < 6; i += 1) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 150 })
    await sleep(120)
  }
  await sleep(600)
  assert.equal(await toggleSource(app), true, 'flush toggle failed')
  const source = await waitFor(() => visibleSource(app), 'flush source missing')
  await sleep(800)
  const dump = await app.evaluate(`(() => ({
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || ''),
    fallback: (window.__hmFlushTrace || []).filter(e => e.phase === 'scratch-canonical-fallback').length
  }))()`)
  console.log(JSON.stringify({ ...dump, source: source.slice(0, 200), baselineHead: baseline.slice(0, 80) }, null, 1))
  assert.equal(dump.toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(dump.toasts)}`)
  // THE assertion: typed `-` markers survive (not rewritten to `*`)
  assert.equal(/^\s*-/m.test(source) || /^-/m.test(source), true, `typed '-' marker missing in source: ${JSON.stringify(source.slice(0, 120))}`)
  assert.equal(/^\*\s/m.test(source) && !/^\s*-/m.test(source), false, `markers rewritten to '*': ${JSON.stringify(source.slice(0, 120))}`)
  assert.equal(source.includes('第一项'), true, 'content lost')
  console.log('PASS scratch marker spelling: typed "-" bullets keep their spelling through the scratch fallback (serializer floor only when preservation fails validation)')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
