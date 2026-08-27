import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-empty-bullet-backspace-removal-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11240 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = [
  '# 删除空 bullet 回归', '',
  '- 啊v擦',
  '- u高科技', '',
  '```txt', '尼玛，吗了解', '了几百块', '```', '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客', ''
].join('\n')

const waitFor = async (check, message, attempts = 160) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (app, key, code, keyCode, text = '') => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(150)
}

const focusBulletEnd = async (app, text) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent && node.textContent.includes('啊v擦') && node.textContent.includes('u高科技'))
  if (!editor) return { ok: false, reason: 'editor' }
  const items = [...editor.querySelectorAll('li')]
  const li = items.find((node) => {
    const p = node.querySelector('p')
    return p && (p.textContent || '').trim() === ${JSON.stringify('啊v擦')}
  })
  const p = li?.querySelector('p')
  if (!p) return { ok: false, reason: 'bullet', itemTexts: items.map((node) => node.textContent || '') }
  const selection = getSelection(); selection.removeAllRanges()
  const range = document.createRange(); range.selectNodeContents(p); range.collapse(false); selection.addRange(range)
  editor.focus(); document.dispatchEvent(new Event('selectionchange'))
  return { ok: true }
})()`)

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(0, 900),
    canonical: String(entry.canonical || '').slice(0, 900)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
}))()`)

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent && node.textContent.includes('啊v擦') && node.textContent.includes('u高科技')))`), 'fixture did not mount')
  await app.evaluate(`(() => { window.__hmPreserveLog = []; window.__hmSourceIntegrityTrace = [] })()`)

  const focused = await focusBulletEnd(app, '啊v擦')
  assert.equal(focused.ok, true, JSON.stringify(focused))
  await rawKey(app, 'Enter', 'Enter', 13)
  await sleep(900)
  const entered = await diagnostics(app)
  console.log('EMPTY_BULLET_AFTER_ENTER:', JSON.stringify(entered))
  assert.equal(entered.integrity.some((entry) => entry.ok === false), false, 'Enter creating empty bullet failed integrity')
  assert.equal(entered.integrity.some((entry) => entry.candidate.includes('- 啊v擦\n- \n- u高科技')), true, 'Enter did not persist the empty bullet between siblings')

  await rawKey(app, 'Backspace', 'Backspace', 8)
  await sleep(1050)
  const removed = await diagnostics(app)
  console.log('EMPTY_BULLET_AFTER_BACKSPACE:', JSON.stringify(removed))
  assert.equal(removed.integrity.some((entry) => entry.ok === false), false, 'Backspace deleting empty bullet failed source integrity')
  assert.equal(removed.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false, 'Backspace deleting empty bullet showed warning')
  assert.equal(removed.preserve.some((entry) => entry.reason === 'empty-list-item-removed' && entry.preserved === true), true, 'empty-list-item-removed branch did not own the deletion')
  assert.equal(removed.integrity.some((entry) => entry.preservationReason === 'empty-list-item-removed' && entry.semanticOk === true && entry.listSlotsMatch === true), true, 'empty-list-item-removed candidate was not fully equivalent')
  assert.equal(removed.integrity.some((entry) => entry.candidate.includes('- 啊v擦\n- u高科技')), true, 'deleted empty bullet remained in authored source')
  assert.equal(removed.integrity.some((entry) => /<br\s*\/?\s*>/i.test(entry.candidate)), false, 'editor-only br placeholder leaked into source')

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('EMPTY_BULLET_BACKSPACE_SOURCE:', JSON.stringify(source))
  assert.match(source, /- 啊v擦\n- u高科技\n\n```txt\n尼玛，吗了解\n了几百块\n```/)
  assert.match(source, /-   1\. 二哥你来拿如果\n  - \u200B     就了解了呢\n  \* 如果可能老顾客/)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i)
  console.log('PASS Enter empty bullet -> Backspace removal ignores only the editor-owned trailing placeholder')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
