import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs71-diverged-nested-ordered-enter-${process.pid}`
const file = join(root, 'rs-71.md')
const port = Number(process.env.CDP_PORT || 10871)
const fixture = [
  '# 无序列表测试',
  '',
  '- 可就是被科技部',
  '- 老板老板娘',
  '  - s 入了你看你了',
  '',
  '吗；啊嗯',
  '',
  '- 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '- u高科技',
  '- 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '   1. 微风',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  ''
].join('\n')
const expected = [
  '# 无序列表测试',
  '',
  '- 可就是被科技部',
  '- 老板老板娘',
  '  - s 入了你看你了',
  '',
  '吗；啊嗯',
  '',
  '- 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '- u高科技',
  '- 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '   1. 微风、',
  '   2. ',
  '',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  ''
].join('\n')
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 140) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function pressDunhao(app) {
  const common = {
    key: '、',
    code: 'Backslash',
    windowsVirtualKeyCode: 220,
    nativeVirtualKeyCode: 220
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await app.send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text: '、',
    unmodifiedText: '、'
  })
  await sleep(23)
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(23)
}

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

const state = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const parentParagraph = [...(editor?.querySelectorAll('p') || [])]
    .find((node) => (node.textContent || '') === '啊额法色饭')
  const parentItem = parentParagraph?.closest('li') || null
  const nestedList = parentItem
    ? [...parentItem.querySelectorAll('ol')].find((list) => list.closest('li') === parentItem) || null
    : null
  const nestedItems = nestedList
    ? [...nestedList.querySelectorAll('li')].filter((item) => item.closest('ol') === nestedList)
    : []
  return {
    parentExists: !!parentItem,
    nestedListTag: nestedList?.tagName || null,
    nestedCount: nestedItems.length,
    nestedText: nestedItems.map((item) => {
      const paragraph = [...item.querySelectorAll('p')]
        .find((node) => node.closest('li') === item)
      return paragraph?.textContent ?? ''
    }),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-24).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(0, 1200),
      canonical: String(entry.canonical || '').slice(0, 1200)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: String(markdown || '').slice(0, 1200)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const placeCaretAtNestedEnd = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const paragraph = [...(editor?.querySelectorAll('p') || [])]
    .find((node) => (node.textContent || '') === '微风')
  if (!editor || !paragraph) return false
  const item = paragraph.closest('li')
  const list = item?.closest('ol')
  const parentItem = list?.parentElement?.closest('li') || list?.closest('li') || null
  if (!item || !list || !parentItem) return false
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(false)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('微风')))`),
    'RS-71 fixture did not mount'
  )
  await sleep(500)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-71 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-71 save did not finish')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)

  assert.equal(await placeCaretAtNestedEnd(app), true, 'could not focus RS-71 nested ordered item')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  // PID 59363: punctuation keydown at 04:11:57.082, Enter at 04:11:57.128.
  // Two 23ms key phases reproduce that ~46ms cadence without an intermediate settle.
  await pressDunhao(app)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 23 })
  await sleep(950)

  const after = await state(app)
  console.log('RS71_AFTER_ENTER:', JSON.stringify(after))
  assert.equal(after.parentExists, true, `RS-71 lost parent ordered item: ${JSON.stringify(after)}`)
  assert.equal(after.nestedListTag, 'OL', `RS-71 nested list changed kind: ${JSON.stringify(after)}`)
  assert.equal(after.nestedCount, 2, `RS-71 did not keep two nested ordered siblings: ${JSON.stringify(after)}`)
  assert.deepEqual(after.nestedText, ['微风、', ''], `RS-71 nested ordered text/empty sibling mismatch: ${JSON.stringify(after.nestedText)}`)
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, `RS-71 produced transient integrity failure: ${JSON.stringify(after.integrity)}`)
  assert.equal(after.toasts.some((text) => warningPattern.test(text)), false, `RS-71 showed source warning: ${JSON.stringify(after.toasts)}`)
  assert.equal(
    after.preserve.some((entry) =>
      entry.reason === 'transaction-list-subtree' &&
      entry.preserved !== false &&
      entry.integrityProof?.kind === 'transaction-list-subtree-proof' &&
      entry.integrityProof?.family === 'list-subtree-replace' &&
      entry.integrityProof?.mapperReason === 'diverged-nested-list-change'
    ),
    true,
    `RS-71 was not owned by the generic transaction list subtree: ${JSON.stringify(after.preserve)}`
  )
  assert.equal(
    after.integrity.some((entry) =>
      entry.preservationReason === 'transaction-list-subtree' &&
      entry.ok === true && entry.semanticOk === true && entry.listSlotsMatch === true
    ),
    true,
    `RS-71 strict transaction/list integrity proof did not pass: ${JSON.stringify(after.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-71 source')
  const source = await waitFor(() => visibleSource(app), 'RS-71 source textarea missing')
  assert.equal(source, expected, `RS-71 source did not retain nested ordered indentation: ${JSON.stringify(source)}`)
  assert.match(source, /1\. 啊额法色饭\n   1\. 微风、\n   2\. /, 'RS-71 source missing nested `   2. ` sibling')
  assert.doesNotMatch(source, /1\. 啊额法色饭\n   1\. 微风、\n2\. /, 'RS-71 source promoted new sibling to top level')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-71 source leaked Crepe placeholder')

  assert.equal(await toggleSource(app), true, 'could not return RS-71 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-71 saved bytes differ from source view')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await state(app)
  assert.equal(reopened.nestedListTag, 'OL', `RS-71 cold reopen changed nested list kind: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.nestedCount, 2, `RS-71 cold reopen lost nested sibling: ${JSON.stringify(reopened)}`)
  assert.deepEqual(reopened.nestedText, ['微风、', ''], `RS-71 cold reopen changed nested rows: ${JSON.stringify(reopened.nestedText)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect RS-71 cold-reopen source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-71 cold-reopen source missing'), expected)

  console.log('PASS RS-71 transaction-owned nested ordered Enter: indentation, integrity, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
