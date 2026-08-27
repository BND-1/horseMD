import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-ordered-enter-fence-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11020 + (process.pid % 40))

const fixture = [
  '# 有序列表代码块回归',
  '',
  '- u高科技',
  '',
  '1. 了离开你了；',
  '',
  '```txt',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  ''
].join('\n')

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const focusTargetEnd = async (app) => {
  const ok = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor || !editor.textContent.includes('了离开你了；')) return false
    const paragraph = [...editor.querySelectorAll('p')]
      .find((node) => (node.textContent || '').includes('了离开你了；'))
    if (!paragraph) return false
    paragraph.scrollIntoView({ block: 'center' })
    paragraph.focus()
    const selection = getSelection()
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(ok, true, 'could not focus ordered item before fence')
  await sleep(220)
}

const pressEnter = async (app) => {
  const common = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

const imeCommitNi = async (app) => {
  await app.send('Input.imeSetComposition', {
    text: 'n',
    selectionStart: 1,
    selectionEnd: 1,
    replacementId: 'ordered-fence-ime',
    location: 0
  })
  await sleep(100)
  await app.send('Input.insertText', { text: '你' })
  await sleep(180)
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    markdown: String(markdown || '').slice(0, 420)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, parsed, expected, ...entry }) => entry),
  integrityDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-12),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
}))()`)

const toggleSource = async (app) => app.evaluate(`(() => {
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
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && node.textContent.includes('了离开你了；') && node.textContent.includes('尼玛，吗了解')))`),
    'fixture document did not mount'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await focusTargetEnd(app)
  await imeCommitNi(app)
  await pressEnter(app)
  await sleep(1200)

  const before = await diagnostics(app)
  console.log('ORDERED_ENTER_FENCE_DIAGNOSTICS:', JSON.stringify(before))
  assert.equal(
    before.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'ordered Enter before fence showed a source-sync warning'
  )
  assert.equal(
    before.integrity.some((entry) => entry.ok === false),
    false,
    'ordered Enter before fence failed source integrity'
  )
  assert.equal(
    before.preserve.some((entry) => entry.reason === 'middle-block-before-authored-fence' && entry.preserved === true),
    true,
    'target preservation branch did not handle ordered continuation before fence'
  )

  const toggled = await toggleSource(app)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('ORDERED_ENTER_FENCE_SOURCE:', JSON.stringify(source))

  assert.match(source, /(?:^|\n)1\. 了离开你了；你\n2\. (?=\n)/m, 'new empty ordered item did not keep canonical ordinal 2')
  assert.doesNotMatch(source, /(?:^|\n)1\. 了离开你了；你\n1\. (?=\n)/m, 'new ordered item incorrectly reused ordinal 1')
  assert.match(source, /```txt\n尼玛，吗了解\n了几百块\n```/, 'authored fenced code block changed')
  assert.match(source, /-   1\. 二哥你来拿如果\n  - \u200B     就了解了呢\n  \* 如果可能老顾客/, 'unrelated authored nested-list spelling changed')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'editor-only br placeholder leaked into source')
  console.log('PASS ordered Enter before fenced code keeps canonical ordinal and authored syntax')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
