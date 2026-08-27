import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-isolated-empty-ordered-backspace-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11620 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = `# 孤立空 ordered Backspace 回归

- 1\\. 是人干v是v
- 

- u高科技

\`\`\`txt
尼玛，吗了解
了几百块
\`\`\`

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

const key = async (app, keyValue, code, keyCode, text = '', after = 100) => {
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
  html: [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.innerHTML.slice(0, 2200) || ''
}))()`)

const focusInitialEmptyBullet = async (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  for (const list of [...editor.querySelectorAll('ul')]) {
    const items = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    if (items.length < 2 || !(list.textContent || '').includes('是人干v是v')) continue
    for (const item of items) {
      const paragraph = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
      const text = (paragraph?.textContent || '').replace(/\\u200B/g, '').trim()
      if (!paragraph || text) continue
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return { ok: true, html: paragraph.outerHTML, listHtml: list.outerHTML.slice(0, 900) }
    }
  }
  return { ok: false, reason: 'target-not-found', html: editor.innerHTML.slice(0, 2200) }
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
      .find((node) => node.offsetParent && node.textContent.includes('是人干v是v') && node.textContent.includes('二哥你来拿如果')))`),
    'fixture did not mount'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  const focused = await focusInitialEmptyBullet(app)
  console.log('ISOLATED_EMPTY_ORDERED_INITIAL_BULLET_FOCUS:', JSON.stringify(focused))
  assert.equal(focused.ok, true, `could not focus initial empty bullet: ${JSON.stringify(focused)}`)

  await key(app, 'Enter', 'Enter', 13)
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'empty-list-item-removed' && entry.preserved === true)`),
    'Enter did not exit the initial empty bullet'
  )
  await key(app, '1', 'Digit1', 49, '1', 70)
  await key(app, '.', 'Period', 190, '.', 70)
  await key(app, ' ', 'Space', 32, ' ', 140)
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror ol')].some((list) => {
      const items = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
      if (items.length !== 1) return false
      const p = items[0].querySelector(':scope > .children > .content-dom > p') || items[0].querySelector('p')
      return p && !(p.textContent || '').replace(/\\u200B/g, '').trim()
    }))`),
    'typed 1. + Space did not create an empty ordered item'
  )
  await sleep(500)
  const created = await diagnostics(app)
  console.log('ISOLATED_EMPTY_ORDERED_CREATED:', JSON.stringify(created))
  assert.equal(created.integrity.some((entry) => entry.ok === false), false, 'creating the empty ordered item already failed integrity')
  assert.equal(created.toasts.some((text) => /保存已暂停|无法安全映射|Save paused/.test(text)), false, 'creating the empty ordered item showed a warning')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await key(app, 'Backspace', 'Backspace', 8)
  await sleep(900)

  const first = await diagnostics(app)
  console.log('ISOLATED_EMPTY_ORDERED_FIRST_BACKSPACE_OBSERVED:', JSON.stringify(first))
  assert.equal(
    first.preserve.some((entry) => entry.reason === 'diverged-isolated-empty-ordered-backspace-lift' && entry.preserved === true),
    true,
    'first Backspace was not owned by isolated empty ordered lift mapper'
  )
  console.log('ISOLATED_EMPTY_ORDERED_FIRST_BACKSPACE:', JSON.stringify(first))
  assert.equal(first.integrity.some((entry) => entry.ok === false), false, 'first Backspace produced an integrity failure')
  assert.equal(
    first.toasts.some((text) => /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'first Backspace showed a source-sync warning'
  )
  assert.equal(
    first.integrity.some((entry) => entry.preservationReason === 'diverged-isolated-empty-ordered-backspace-lift' &&
      entry.semanticOk === true && entry.listSlotsMatch === true),
    true,
    'first Backspace candidate was not fully source-equivalent'
  )
  assert.equal(
    first.integrity.some((entry) => entry.candidate.includes('- 1\\. 是人干v是v\n\n- \n\n- u高科技')),
    true,
    'first Backspace did not convert only the isolated empty ordered marker to an authored bullet'
  )

  await key(app, 'Backspace', 'Backspace', 8)
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'empty-list-item-removed' && entry.preserved === true)`),
    'second Backspace was not owned by empty-list-item-removed'
  )
  await sleep(600)

  const second = await diagnostics(app)
  console.log('ISOLATED_EMPTY_ORDERED_SECOND_BACKSPACE:', JSON.stringify(second))
  assert.equal(second.integrity.some((entry) => entry.ok === false), false, 'second Backspace produced an integrity failure')
  assert.equal(
    second.toasts.some((text) => /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'second Backspace showed a source-sync warning'
  )
  assert.equal(
    second.integrity.some((entry) => entry.preservationReason === 'empty-list-item-removed' &&
      entry.semanticOk === true && entry.listSlotsMatch === true),
    true,
    'second Backspace candidate was not fully source-equivalent'
  )

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('ISOLATED_EMPTY_ORDERED_SOURCE:', JSON.stringify(source))
  assert.match(source, /- 1\\\. 是人干v是v\n(?:\n)?- u高科技/, 'second Backspace did not remove the transient empty bullet')
  assert.doesNotMatch(source, /(?:^|\n)1\.\s*(?:\n|$)/, 'empty ordered row remained in source')
  assert.doesNotMatch(source, /(?:^|\n)-\s*(?:\n|$)/, 'transient empty bullet remained in source')
  assert.ok(source.includes('```txt\n尼玛，吗了解\n了几百块\n```'), 'authored fenced code changed')
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n  - ​     就了解了呢\n  * 如果可能老顾客'),
    'unrelated diverged nested-list spelling changed'
  )
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'Crepe placeholder leaked into source')
  console.log('PASS isolated empty ordered Backspace lift: first lift and second removal stay source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
