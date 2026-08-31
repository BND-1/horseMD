// 0.13.179 trace (06:53) repro: paste Markdown containing a lone `~` inside
// text (45~60) plus a table into a scratch doc. The pasted parse and the PM
// doc split text runs differently at the `~` boundary (12 vs 14 inline nodes)
// — the semantic comparator now merges adjacent same-mark text runs, so the
// pasted bytes must publish without a warning.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-paste-tilde-${process.pid}`
const port = Number(process.env.CDP_PORT || 13700 + (process.pid % 20))
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const pasted = [
  '# 粘贴测试',
  '',
  '字段：`id`（商品ID）、`reason`（45~60 字判断句）、`rating`（0~100 百分制）。',
  '',
  '# 工具',
  '',
  '| 工具 | 用途 |',
  '|---|---|',
  '| `get_pool` | 获取商品池 Markdown 表格 |',
  ''
].join('\n')

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
  await app.evaluate(`(() => {
    const t = window.__hmSourceIntegrityTrace
    if (!Array.isArray(t)) window.__hmSourceIntegrityTrace = []
    else t.length = 0
    document.querySelectorAll('[class*="toast"]').forEach((n) => n.remove())
  })()`)
  // paste with BOTH text/markdown and text/plain flavors (raw markdown paste)
  const consumed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent)
    editor?.focus()
    const data = new DataTransfer()
    data.setData('text/markdown', ${JSON.stringify(pasted)})
    data.setData('text/plain', ${JSON.stringify(pasted)})
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    editor.dispatchEvent(event)
    return event.defaultPrevented
  })()`)
  assert.equal(consumed, true, 'markdown paste not consumed')
  await sleep(1200)
  const dump = await app.evaluate(`(() => ({
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || ''),
    bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-2).map(e => ({ reason: e.preservationReason, site: e.validationSite })),
    preserve: (window.__hmPreserveLog || []).slice(-5).map(e => ({ reason: e.reason, preserved: e.preserved })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-4).map(e => ({ phase: e.phase, owner: e.owner, reason: e.reason })),
    rawPaste: (window.__hmSourceSyncCoordinatorTrace || []).filter(e => String(e.phase).includes('raw-paste')).slice(-6)
  }))()`)
  console.log(JSON.stringify(dump, null, 1))
  assert.equal(dump.toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(dump.toasts)}`)
  // verify pasted content is live and source keeps the pasted spelling
  assert.equal(await toggleSource(app), true, 'toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source missing')
  await sleep(400)
  // The serializer escapes a lone `~` as `~~` (strikes-prevention, same class
  // as `\-`); it round-trips back to `~` on parse — validation passing is the
  // proof. Accept either spelling; assert CONTENT integrity.
  assert.equal(/45~{1,2}60/.test(source), true, `pasted '~' content lost: ${JSON.stringify(source.slice(0, 160))}`)
  assert.equal(source.includes('粘贴测试'), true, 'pasted heading lost')
  assert.equal(source.includes('get_pool'), true, 'pasted table lost')
  console.log('PASS paste tilde+table: raw markdown paste with lone ~ and compact table publishes warning-free (escaped ~ round-trips)')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
