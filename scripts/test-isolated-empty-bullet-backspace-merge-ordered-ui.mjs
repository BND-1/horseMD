import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-isolated-empty-bullet-merge-ordered-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11670 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = `# 空 bullet Backspace 并入 ordered 回归

- 看了呢分

2. 斛律v哦

- u高科技

\`\`\`
尼玛，吗了解
了几百块
\`\`\`

1

-   1. 二哥你来拿如果
  - ​     就了解了呢
  * 如果可能老顾客
`

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const key = async (app, keyValue, code, keyCode, text = '', after = 120) => {
  const common = { key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'char',
      ...common,
      text,
      unmodifiedText: text
    })
  }
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(0, 1400),
    canonical: String(entry.canonical || '').slice(0, 1400)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  selection: (() => {
    const selection = getSelection()
    return { text: selection?.toString() || '', offset: selection?.anchorOffset ?? -1 }
  })()
}))()`)

const focusStartOfBullet = async (app, text) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  for (const item of [...editor.querySelectorAll('ul li')]) {
    const paragraph = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
    if (!paragraph || (paragraph.textContent || '').trim() !== ${JSON.stringify('u高科技')}) continue
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, html: paragraph.outerHTML }
  }
  return { ok: false, reason: 'target-not-found', html: editor.innerHTML.slice(0, 1800) }
})()`)

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
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })

  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && node.textContent.includes('斛律v哦') && node.textContent.includes('二哥你来拿如果')))`),
    'fixture did not mount'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  const focused = await focusStartOfBullet(app, 'u高科技')
  console.log('EMPTY_BULLET_MERGE_FOCUS:', JSON.stringify(focused))
  assert.equal(focused.ok, true, `could not focus u高科技: ${JSON.stringify(focused)}`)

  // Human path from PID 65786: Enter at the start of u高科技 inserts an empty
  // bullet before it, then ArrowUp returns to that empty item.
  await key(app, 'Enter', 'Enter', 13, '', 220)
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.preserved === true && String(entry.markdown || '').includes('2. 斛律v哦'))`),
    'Enter did not publish the intermediate empty bullet'
  )
  await key(app, 'ArrowUp', 'ArrowUp', 38, '', 180)
  await sleep(500)
  const before = await diagnostics(app)
  console.log('EMPTY_BULLET_MERGE_BEFORE_BACKSPACE:', JSON.stringify(before))
  assert.equal(before.integrity.some((entry) => entry.ok === false), false, 'Enter/ArrowUp already failed integrity')
  assert.equal(before.toasts.some((text) => /保存已暂停|无法安全映射|Save paused/.test(text)), false, 'Enter/ArrowUp showed a warning')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await key(app, 'Backspace', 'Backspace', 8, '', 240)
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'diverged-isolated-empty-bullet-backspace-merge-ordered')`),
    'Backspace did not hit isolated empty bullet -> ordered merge mapper'
  )
  await sleep(700)

  const after = await diagnostics(app)
  console.log('EMPTY_BULLET_MERGE_AFTER_BACKSPACE:', JSON.stringify(after))
  assert.equal(
    after.preserve.some((entry) => entry.reason === 'diverged-isolated-empty-bullet-backspace-merge-ordered' && entry.preserved === true),
    true,
    'Backspace merge mapper did not preserve the transaction'
  )
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, 'Backspace merge produced an integrity failure')
  assert.equal(
    after.integrity.some((entry) => entry.preservationReason === 'diverged-isolated-empty-bullet-backspace-merge-ordered' &&
      entry.semanticOk === true && entry.listSlotsMatch === true),
    true,
    'Backspace merge candidate was not fully source-equivalent'
  )
  assert.equal(
    after.toasts.some((text) => /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'Backspace merge showed a source-sync warning'
  )

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('EMPTY_BULLET_MERGE_SOURCE:', JSON.stringify(source))
  assert.match(source, /2\. 斛律v哦\n\n3\. \n4\. u高科技/, 'target rows were not converted to consecutive authored ordered markers')
  assert.doesNotMatch(source, /(?:^|\n)-\s*(?:\n|$)/, 'transient empty bullet remained in source')
  assert.ok(source.includes('```\n尼玛，吗了解\n了几百块\n```'), 'authored fenced code changed')
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n  - ​     就了解了呢\n  * 如果可能老顾客'),
    'unrelated diverged nested-list spelling changed'
  )
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'Crepe placeholder leaked into source')
  console.log('PASS human cadence: Enter at bullet start -> ArrowUp -> Backspace merges empty bullet and right sibling into ordered source-equivalently')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
