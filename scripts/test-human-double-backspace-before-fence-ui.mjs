import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-human-double-backspace-before-fence-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11360 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = [
  '# 双 Backspace fence 回归', '',
  '- u高科技',
  '- 1\\. 是v粉丝v', '',
  '```', '尼玛，吗了解', '了几百块', '```', '',
  '1. 后续有序项', '',
  '- 后续 bullet', ''
].join('\n')

const waitFor = async (check, message, attempts = 180) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const physicalKey = async (app, { key, code, keyCode, text = '', hold = 90, after = 100 }) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await sleep(8)
    await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  }
  await sleep(hold)
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const focusTargetEnd = async (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent && node.textContent.includes('是v粉丝v') && node.textContent.includes('尼玛，吗了解'))
  if (!editor) return { ok: false, reason: 'editor' }
  const items = [...editor.querySelectorAll('li')]
  const li = items.find((node) => (node.querySelector('p')?.textContent || '').trim() === '1. 是v粉丝v')
  const paragraph = li?.querySelector('p')
  if (!paragraph) return { ok: false, reason: 'target', items: items.map((node) => node.textContent || '') }
  paragraph.scrollIntoView({ block: 'center' })
  const selection = getSelection(); selection.removeAllRanges()
  const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false); selection.addRange(range)
  editor.focus(); document.dispatchEvent(new Event('selectionchange'))
  return { ok: true }
})()`)

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-30).map(({ source, previous, next, ...entry }) => ({
    ...entry,
    markdown: String(entry.markdown || '').slice(0, 700)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-30).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(0, 900),
    canonical: String(entry.canonical || '').slice(0, 900)
  })),
  intents: (window.__hmListIntentTrace || []).slice(-30),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  selection: (() => {
    const sel = getSelection()
    return { text: sel?.anchorNode?.parentElement?.textContent || '', offset: sel?.anchorOffset ?? null }
  })()
}))()`)

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click(); return !!button
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
    .find((node) => node.offsetParent && node.textContent.includes('是v粉丝v') && node.textContent.includes('尼玛，吗了解')))`), 'fixture did not mount')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmListIntentTrace = []
  })()`)

  const focused = await focusTargetEnd(app)
  assert.equal(focused.ok, true, JSON.stringify(focused))

  // Human path from PID 44904: exit the list into the paragraph immediately
  // before the authored fence, then publish a literal dash before Space.
  await physicalKey(app, { key: 'Enter', code: 'Enter', keyCode: 13, hold: 80, after: 120 })
  await physicalKey(app, { key: 'Enter', code: 'Enter', keyCode: 13, hold: 80, after: 460 })
  await physicalKey(app, { key: '-', code: 'Minus', keyCode: 189, text: '-', hold: 95, after: 260 })
  await sleep(260)

  const literal = await diagnostics(app)
  assert.equal(literal.integrity.some((entry) => entry.ok === false), false, 'literal dash frame failed integrity')
  assert.equal(literal.preserve.some((entry) =>
    entry.markdown.includes('是v粉丝v') && entry.markdown.split('\n').includes('\\-')
  ), true, 'literal dash did not publish immediately before the authored fence')

  await physicalKey(app, { key: ' ', code: 'Space', keyCode: 32, text: ' ', hold: 105, after: 180 })
  await sleep(700)
  const bullet = await diagnostics(app)
  console.log('DOUBLE_BACKSPACE_BULLET_FRAME:', JSON.stringify(bullet))
  assert.equal(bullet.integrity.some((entry) => entry.ok === false), false, 'Space -> empty bullet failed integrity')

  await physicalKey(app, { key: 'Backspace', code: 'Backspace', keyCode: 8, hold: 90, after: 180 })
  await sleep(700)
  const firstBackspace = await diagnostics(app)
  console.log('DOUBLE_BACKSPACE_FIRST_FRAME:', JSON.stringify(firstBackspace))
  assert.equal(firstBackspace.integrity.some((entry) => entry.ok === false), false, 'first Backspace failed integrity')
  assert.equal(firstBackspace.preserve.some((entry) => entry.reason === 'empty-list-item-removed'), true,
    'first Backspace did not remove the empty list item')

  await physicalKey(app, { key: 'Backspace', code: 'Backspace', keyCode: 8, hold: 90, after: 180 })
  await sleep(900)
  const secondBackspace = await diagnostics(app)
  console.log('DOUBLE_BACKSPACE_SECOND_FRAME:', JSON.stringify(secondBackspace))
  assert.equal(secondBackspace.integrity.some((entry) => entry.ok === false), false,
    'second Backspace before authored fence failed source integrity')
  assert.equal(secondBackspace.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false,
    'second Backspace showed a source-sync warning')
  assert.equal(secondBackspace.preserve.some((entry) =>
    entry.reason === 'empty-paragraph-before-fence-removed' && entry.preserved === true
  ), true, 'dedicated empty-paragraph-before-fence handler did not own the second Backspace')

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('DOUBLE_BACKSPACE_SOURCE:', JSON.stringify(source))
  assert.match(source, /- u高科技\n- 1\\\. 是v粉丝v\n\n```\n尼玛，吗了解\n了几百块\n```/,
    'authored fence or preceding list changed after the second Backspace')
  assert.doesNotMatch(source, /```\n\n```\n尼玛/, 'second Backspace created a ghost empty fenced block')
  assert.equal((source.match(/^```$/gm) || []).length, 2, 'paired authored fence count changed')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'editor-only placeholder leaked into source')
  console.log('PASS human cadence: dash -> Space -> Backspace -> Backspace before authored fence keeps the fence byte-stable')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
