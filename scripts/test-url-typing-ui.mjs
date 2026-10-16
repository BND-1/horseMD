// Typing a URL in rich text used to fail closed on save ("原文件未被覆盖"):
// the typed text is plain in the editor but parses back as a GFM autolink
// literal, and no escape can prevent that. A link whose text is its own
// autolinkable URL now compares as plain text (design doc §5), and typing
// `<https://…>` becomes a link spelled back as the same autolink (Typora).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-url-typing-'))
const file = join(root, 'url.md')
const authored = [
  'A 自动链接 <https://a.com> 尾',
  'B 带空格 [官网](<https://a.com/x y>) 尾',
  'C 非法 <https://a.com/x y> 尾',
  'D 裸 https://a.com 尾',
  'E [官网](https://a.com) 尾'
]
const typed = [
  ['P1', ' https://a.com', 'P1 https://a.com'],
  ['P2', ' 见 https://a.com/x?y=1 完，www.a.com 和 a@b.com。', 'P2 见 https://a.com/x?y=1 完，www.a.com 和 a@b.com。'],
  ['P3', ' <https://a.com>', 'P3 <https://a.com>'],
  ['P4', ' <https://a.com/x y>', 'P4 <https://a.com/x y>'],
  ['P5', ' <mailto:a@b.com> 后', 'P5 <mailto:a@b.com> 后']
]
const source = [...authored, ...typed.map(([label]) => label)].join('\n\n') + '\n'
await writeFile(file, source)
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 29500 + process.pid % 400, appArgs: [file, '--horsemd-input-trace']
})
const send = app.send.bind(app)
const editor = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(label)
}
const typeAtEnd = async (start, text) => {
  const point = await app.evaluate(`(() => {
    const p = [...(${editor}).querySelectorAll(':scope > p')].find(n => n.textContent.startsWith(${JSON.stringify(start)}))
    p.scrollIntoView({block:'center'}); const r = p.getBoundingClientRect()
    return {x:r.right - 2, y:r.top + r.height / 2}
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  await sleep(150)
  await pressKey(send, { key: 'End' })
  await typeTextLikeUser(send, text)
  await sleep(400)
}
const linksIn = (start) => app.evaluate(`(() => {
  const p = [...(${editor}).querySelectorAll(':scope > p')].find(n => n.textContent.startsWith(${JSON.stringify(start)}))
  return [...p.querySelectorAll('a')].map(a => a.getAttribute('href') + '|' + a.textContent)
})()`)
try {
  await waitFor(() => app.evaluate(`(${editor})?.textContent.includes('P5')`), 'fixture did not open')
  await sleep(600)
  for (const [label, text] of typed) await typeAtEnd(label, text)
  assert.deepEqual(await linksIn('P3'), ['https://a.com|https://a.com'], 'typing <url> must become a link')
  assert.deepEqual(await linksIn('P5'), ['mailto:a@b.com|mailto:a@b.com'])
  assert.deepEqual(await linksIn('P4'), [], '<url with space> is not an autolink')
  // Edit every authored paragraph too: its link spelling must survive.
  for (const line of authored) await typeAtEnd(line.slice(0, 2), '改')

  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button not shown')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const saved = await waitFor(async () => {
    const text = await readFile(file, 'utf8')
    return text !== source && text
  }, 'save did not write')
  const toasts = await app.evaluate(`[...document.querySelectorAll('[class*="toast"]')].map(n => n.textContent || '')`)
  assert.equal(toasts.some((t) => warningPattern.test(t)), false, `warning shown: ${JSON.stringify(toasts)}`)
  assert.deepEqual(await app.evaluate('(globalThis.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).map(e => e.preservationReason)'), [])
  assert.equal(saved, [...authored.map((line) => `${line}改`), ...typed.map(([, , expected]) => expected)].join('\n\n') + '\n')
  console.log('PASS URL typing: bare URL / www / email / <url> / <url with space> save byte-exact without escapes or warnings; <url> becomes a link; authored link spellings survive edits')
} catch (error) {
  console.error('URL_DIAGNOSTIC', JSON.stringify(await app.evaluate(`({
    toasts: [...document.querySelectorAll('[class*="toast"]')].map(n => n.textContent || ''),
    bad: (window.__hmSourceIntegrityTrace || []).filter(e => e && e.ok === false).slice(-2).map(({ parsed, expected, ...e }) => ({ reason: e.preservationReason, candidate: e.candidate }))
  })`), null, 1).slice(0, 3000))
  throw error
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
