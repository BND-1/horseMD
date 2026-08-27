import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-human-list-exit-dash-space-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11320 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

// Keep the exact local structure from PID 38820. The Chinese IME commit had
// already published before the first Enter, so this fixture starts from that
// proven checkpoint and then reproduces the human cadence byte-for-byte.
const fixture = [
  '# 无序列表测试', '',
  '- 看了呢分',
  '- 1\\. 当然会更多人', '',
  '2. 斛律v哦', '',
  '- u高科技', '',
  '```', '尼玛，吗了解', '了几百块', '```', '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客', ''
].join('\n')

const waitFor = async (check, message, attempts = 180) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const physicalKey = async (app, { key, code, keyCode, text = '', hold = 90, after = 90 }) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await sleep(8)
    await app.send('Input.dispatchKeyEvent', {
      type: 'char', ...common, text, unmodifiedText: text
    })
  }
  await sleep(hold)
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const focusSecondBulletEnd = async (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent && node.textContent.includes('当然会更多人') && node.textContent.includes('斛律v哦'))
  if (!editor) return { ok: false, reason: 'editor' }
  const items = [...editor.querySelectorAll('li')]
  const li = items.find((node) => (node.querySelector('p')?.textContent || '').trim() === '1. 当然会更多人')
  const paragraph = li?.querySelector('p')
  if (!paragraph) return { ok: false, reason: 'target', items: items.map((node) => node.textContent || '') }
  paragraph.scrollIntoView({ block: 'center' })
  const selection = getSelection(); selection.removeAllRanges()
  const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false); selection.addRange(range)
  editor.focus(); document.dispatchEvent(new Event('selectionchange'))
  return { ok: true }
})()`)

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, ...entry }) => ({
    ...entry,
    markdown: String(entry.markdown || '').slice(0, 520)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(0, 620),
    canonical: String(entry.canonical || '').slice(0, 620)
  })),
  intents: (window.__hmListIntentTrace || []).slice(-30),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  selection: (() => {
    const v = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const sel = getSelection()
    return { text: sel?.anchorNode?.parentElement?.textContent || '', active: !!v }
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
    .find((node) => node.offsetParent && node.textContent.includes('当然会更多人') && node.textContent.includes('斛律v哦')))`), 'fixture did not mount')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmListIntentTrace = []
  })()`)

  const focused = await focusSecondBulletEnd(app)
  assert.equal(focused.ok, true, JSON.stringify(focused))
  await sleep(440) // trace: IME sync -> first Enter ≈ 442 ms

  await physicalKey(app, { key: 'Enter', code: 'Enter', keyCode: 13, hold: 80, after: 108 })
  await physicalKey(app, { key: 'Enter', code: 'Enter', keyCode: 13, hold: 78, after: 123 })
  await sleep(1218) // total second Enter -> '-' keydown ≈ 1.54 s including key hold/tail

  await physicalKey(app, { key: '-', code: 'Minus', keyCode: 189, text: '-', hold: 100, after: 228 })

  // Critical frame previously omitted: the literal dash MUST publish first as
  // an escaped standalone source row before Space applies the input rule.
  const literal = await diagnostics(app)
  console.log('HUMAN_DASH_LITERAL_FRAME:', JSON.stringify(literal))
  assert.equal(literal.integrity.some((entry) => entry.ok === false), false, 'literal dash frame already failed integrity')
  assert.equal(literal.preserve.some((entry) =>
    entry.reason === 'middle-empty-block-filled' && entry.markdown.includes('\n\\-\n\n2. 斛律v哦')
  ), true, 'dash did not publish as the escaped literal frame seen in the real trace')

  await physicalKey(app, { key: ' ', code: 'Space', keyCode: 32, text: ' ', hold: 120, after: 170 })
  await sleep(900)

  const converted = await diagnostics(app)
  console.log('HUMAN_DASH_SPACE_FRAME:', JSON.stringify(converted))
  assert.equal(converted.integrity.some((entry) => entry.ok === false), false,
    'Space conversion after a published literal dash failed source integrity')
  assert.equal(converted.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)), false,
    'Space conversion showed a source-sync warning')
  assert.equal(converted.intents.some((entry) => entry.phase === 'apply' && entry.inputRuleApplied === true), true,
    'captured dash intent was not applied by the dedicated input-rule ownership path')

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('HUMAN_DASH_SPACE_SOURCE:', JSON.stringify(source))
  assert.match(source, /- 看了呢分\n- 1\\\. 当然会更多人\n\n- \n\n2\. 斛律v哦/,
    'new empty bullet was not inserted exactly once between the exited list and following ordered row')
  assert.equal((source.match(/- 看了呢分/g) || []).length, 1, 'previous bullet list was duplicated')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'editor-only placeholder leaked into source')
  console.log('PASS human cadence: exit list -> published literal dash -> Space creates one new bullet without duplicating prior list')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
