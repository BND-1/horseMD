import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-list-exit-literal-ordered-fence-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11070 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = [
  '# 列表退出 literal marker 回归',
  '',
  '- u高科技',
  '- ',
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

const rawKey = async (app, key, code, keyCode, text = key) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
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
  await sleep(120)
}

const focusEmptyBullet = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && node.textContent.includes('u高科技') && node.textContent.includes('尼玛，吗了解'))
    if (!editor) return { ok: false, reason: 'editor' }
    const items = [...editor.querySelectorAll('li')]
    const target = items.find((li) => {
      const paragraph = li.querySelector('p')
      return paragraph && !(paragraph.textContent || '').trim()
    })
    const paragraph = target?.querySelector('p')
    if (!paragraph) return { ok: false, reason: 'empty-item', itemTexts: items.map((li) => li.textContent || '') }
    paragraph.scrollIntoView({ block: 'center' })
    const selection = getSelection()
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, itemTexts: items.map((li) => li.textContent || '') }
  })()`)
  assert.equal(result.ok, true, `could not focus empty bullet: ${JSON.stringify(result)}`)
  await sleep(220)
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    markdown: String(markdown || '').slice(0, 360)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(0, 420),
    canonical: String(entry.canonical || '').slice(0, 420)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  orderedLists: [...document.querySelectorAll('.ProseMirror ol')].filter((node) => node.offsetParent).map((node) => node.textContent || '')
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
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && node.textContent.includes('u高科技') && node.textContent.includes('尼玛，吗了解')))`),
    'fixture document did not mount'
  )
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
  })()`)

  await focusEmptyBullet(app)
  await rawKey(app, 'Enter', 'Enter', 13, '')
  await sleep(520)
  await rawKey(app, '1', 'Digit1', 49, '1')
  await rawKey(app, '.', 'Period', 190, '.')
  await sleep(950)

  const literalState = await diagnostics(app)
  console.log('LIST_EXIT_LITERAL_ORDERED_STATE:', JSON.stringify(literalState))
  assert.equal(
    literalState.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'typing literal 1. before the fence showed a source-sync warning'
  )
  assert.equal(
    literalState.integrity.some((entry) => entry.ok === false),
    false,
    'typing literal 1. before the fence failed source integrity'
  )
  assert.equal(
    literalState.preserve.some((entry) => entry.reason === 'middle-block-before-authored-fence' && entry.preserved === true),
    true,
    'fence preservation branch did not own the literal marker insertion'
  )
  assert.equal(
    literalState.integrity.some((entry) => entry.candidate.includes('\n1\\.\n')),
    true,
    'the intermediate authored candidate did not keep literal 1. escaped'
  )

  await rawKey(app, ' ', 'Space', 32, ' ')
  await sleep(1050)
  const listState = await diagnostics(app)
  console.log('LIST_EXIT_ORDERED_CONVERSION_STATE:', JSON.stringify(listState))
  assert.equal(
    listState.toasts.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text)),
    false,
    'converting literal 1. to an ordered list showed a source-sync warning'
  )
  assert.equal(
    listState.integrity.some((entry) => entry.ok === false),
    false,
    'converting literal 1. to an ordered list failed source integrity'
  )
  assert.equal(
    listState.orderedLists.length > literalState.orderedLists.length,
    true,
    'trailing space did not create a new ordered list'
  )

  const toggled = await toggleSource(app)
  assert.equal(toggled, true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  console.log('LIST_EXIT_LITERAL_ORDERED_SOURCE:', JSON.stringify(source))
  assert.match(source, /(?:^|\n)1\. (?=\n)/m, 'converted ordered item was not persisted as a real list marker')
  assert.match(source, /```txt\n尼玛，吗了解\n了几百块\n```/, 'authored fenced code block changed')
  assert.match(source, /-   1\. 二哥你来拿如果\n  - \u200B     就了解了呢\n  \* 如果可能老顾客/, 'unrelated authored nested-list spelling changed')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'editor-only br placeholder leaked into source')
  console.log('PASS list exit -> literal 1. -> ordered conversion stays source-equivalent before authored fence')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
