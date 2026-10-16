// Air 0.13.243 report: prose ranges `约 5~30 行……累计 4~7 千行` rendered the
// text between the two single tildes struck through. Typora (and HorseMD now)
// strike only `~~x~~`: the parser runs remark-gfm with singleTilde:false and
// the strike input rule no longer fires on a single-tilde pair.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-single-tilde-'))
const file = join(root, 'tilde.md')
const range = '每轮写入约 5~30 行；表只追加不删，所以一天累计 4~7 千行、当日去重 150~220 个 `sign_last`。'
const source = ['# 单波浪线', '', range, '', '真删除线 ~~旧~~ 保留，单个 ~也~ 不划。', '', '尾段', ''].join('\n')
await writeFile(file, source)
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29000 + process.pid % 500, appArgs: [file, '--horsemd-input-trace']
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const struck = () => app.evaluate(`[...(${editor}).querySelectorAll('del, s')].map(n => n.textContent)`)
const paragraphStruck = (start) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent.startsWith(${JSON.stringify(start)}))
  return p ? [...p.querySelectorAll('del, s')].map(n => n.textContent) : null
})()`)
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('尾段')`), 'fixture did not open')
  assert.deepEqual(await struck(), ['旧'], 'only the double-tilde run may be struck')
  assert.equal(await app.evaluate(`(${editor}).textContent.includes('约 5~30 行；表只追加不删，所以一天累计 4~7 千行')`), true)

  // Type at the end of the last paragraph like a user.
  const end = await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll('p')].find(n => n.textContent === '尾段')
    p.scrollIntoView({block:'center'}); const r = p.getBoundingClientRect()
    return {x:r.right - 2, y:r.top + r.height / 2}
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...end })
  await sleep(200)
  await pressKey(app.send.bind(app), { key: 'End' })
  await typeTextLikeUser(app.send.bind(app), ' 约 ~30~ 行')
  await sleep(300)
  assert.deepEqual(await paragraphStruck('尾段'), [], 'typing a single-tilde pair struck the text')
  await typeTextLikeUser(app.send.bind(app), '，~~删~~')
  await sleep(300)
  assert.deepEqual(await paragraphStruck('尾段'), ['删'], 'typing ~~x~~ must still strike')
  assert.equal(await app.evaluate(`[...(${editor}).querySelectorAll('p')].find(n => n.textContent.startsWith('尾段')).textContent`), '尾段 约 ~30~ 行，删')

  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button not shown')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const saved = await waitFor(async () => {
    const text = await readFile(file, 'utf8')
    return text !== source && text
  }, 'save did not write')
  const toasts = await app.evaluate(`[...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || '')`)
  assert.equal(toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(toasts)}`)
  assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
  const lines = saved.split('\n')
  assert.equal(lines[2], range, 'untouched paragraph bytes changed')
  assert.equal(lines[4], '真删除线 ~~旧~~ 保留，单个 ~也~ 不划。', 'untouched paragraph bytes changed')
  assert.match(lines[6], /^尾段 约 \\?~30\\?~ 行，~~删~~$/, `typed paragraph saved wrong: ${JSON.stringify(lines[6])}`)
  console.log('PASS single tilde: `5~30 … 4~7` and `~x~` stay plain, `~~x~~` strikes (open + typing), untouched bytes kept, save warning-free')
} catch (error) {
  console.error('TILDE_DIAGNOSTIC', JSON.stringify(await app.evaluate(`({
    toasts: [...document.querySelectorAll('[class*="toast"]')].filter(n => n.offsetParent).map(n => n.textContent || ''),
    bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-3).map(({ parsed, expected, ...e }) => e),
    title: document.title, dirty: [...document.querySelectorAll('.tab')].map(n => n.className + ':' + n.textContent)
  })`), null, 1).slice(0, 4000))
  throw error
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
