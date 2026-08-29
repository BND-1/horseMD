import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-nested-list-enter-empty-sibling-${process.pid}`
const file = join(root, 'nested-list-enter.md')
const port = Number(process.env.CDP_PORT || 10869)
const fixture = [
  '# fixture',
  '',
  '- 阿瑟费说',
  '  * 1\\. 额啊飞啊发',
  '',
  '## after',
  '',
].join('\n')
const expected = [
  '# fixture',
  '',
  '- 阿瑟费说',
  '  * 1\\. 额啊飞啊发',
  '  * ',
  '',
  '## after',
  '',
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

const shape = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const firstNestedParagraph = [...(editor?.querySelectorAll('p') || [])]
    .find((node) => (node.textContent || '') === '1. 额啊飞啊发')
  const firstNestedItem = firstNestedParagraph?.closest('li') || null
  const nestedList = firstNestedItem?.closest('ul') || null
  const parentItem = nestedList?.parentElement?.closest('li') || nestedList?.closest('li') || null
  const outerList = parentItem?.closest('ul') || null
  const topItems = outerList
    ? [...outerList.querySelectorAll('li')].filter((item) => item.closest('ul') === outerList)
    : []
  const nestedItems = nestedList
    ? [...nestedList.querySelectorAll('li')].filter((item) => item.closest('ul') === nestedList)
    : []
  return {
    topCount: topItems.length,
    nestedCount: nestedItems.length,
    nestedText: nestedItems.map((item) => {
      const paragraph = [...item.querySelectorAll('p')]
        .find((node) => node.closest('li') === item)
      return paragraph?.textContent ?? ''
    }),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-500),
      canonical: String(entry.canonical || '').slice(-500),
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: String(markdown || '').slice(-500),
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
  }
})()`)

const placeCaretAtNestedEnd = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const paragraph = [...(editor?.querySelectorAll('p') || [])]
    .find((node) => (node.textContent || '') === '1. 额啊飞啊发')
  if (!paragraph) return { ok: false, reason: 'paragraph-missing', html: editor?.innerHTML.slice(0, 2400) || '' }
  const item = paragraph.closest('li')
  const list = item?.closest('ul')
  const parentItem = list?.parentElement?.closest('li') || list?.closest('li')
  if (!item || !list || !parentItem) {
    return {
      ok: false,
      reason: 'not-nested-list-item',
      itemTag: item?.tagName || null,
      listTag: list?.tagName || null,
      listParent: list?.parentElement?.tagName || null,
      html: paragraph.parentElement?.parentElement?.parentElement?.outerHTML.slice(0, 2400) || '',
    }
  }
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(false)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return { ok: true }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('额啊飞啊发')))`),
    'nested-list Enter fixture did not mount',
  )
  await sleep(450)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)

  const caret = await placeCaretAtNestedEnd(app)
  assert.equal(caret.ok, true, `could not place caret at nested item end: ${JSON.stringify(caret)}`)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
  await sleep(900)

  const afterEnter = await shape(app)
  console.log('NESTED_ENTER_AFTER:', JSON.stringify(afterEnter))
  assert.equal(afterEnter.topCount, 1, `Enter escaped nested sibling into a top-level bullet: ${JSON.stringify(afterEnter)}`)
  assert.equal(afterEnter.nestedCount, 2, `Enter did not create exactly one nested sibling: ${JSON.stringify(afterEnter)}`)
  assert.equal(afterEnter.nestedText[0], '1. 额啊飞啊发', `existing nested item changed: ${JSON.stringify(afterEnter.nestedText)}`)
  assert.equal(afterEnter.nestedText[1], '', `new nested sibling is not empty: ${JSON.stringify(afterEnter.nestedText)}`)
  assert.equal(afterEnter.integrity.some((entry) => entry.ok === false), false, `nested Enter failed integrity: ${JSON.stringify(afterEnter.integrity)}`)
  assert.equal(afterEnter.toasts.some((text) => warningPattern.test(text)), false, `nested Enter showed warning: ${JSON.stringify(afterEnter.toasts)}`)
  assert.equal(
    afterEnter.preserve.some((entry) =>
      entry.reason === 'transaction-list-subtree' &&
      entry.preserved !== false &&
      entry.integrityProof?.family === 'list-subtree-replace' &&
      entry.integrityProof?.mapperReason === 'diverged-nested-list-change' &&
      entry.integrityProof?.transactionJournal?.stepNames?.length === 1 &&
      entry.integrityProof?.transactionJournal?.stepNames?.[0] === 'ReplaceStep'
    ),
    true,
    `nested Enter was not owned by the transaction list subtree family: ${JSON.stringify(afterEnter.preserve)}`,
  )

  assert.equal(await toggleSource(app), true, 'could not inspect nested Enter source')
  const source = await waitFor(() => visibleSource(app), 'nested Enter source textarea missing')
  assert.equal(source, expected, `nested Enter source lost authored indentation: ${JSON.stringify(source)}`)
  assert.doesNotMatch(source, /\n\* \n/, 'nested empty sibling escaped to a top-level bullet in source')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'nested Enter source leaked Crepe placeholder')

  assert.equal(await toggleSource(app), true, 'could not return to rich mode before save')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'nested Enter disk bytes differ from expected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await shape(app)
  assert.equal(reopened.topCount, 1, `cold reopen changed top-level list count: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.nestedCount, 2, `cold reopen lost nested empty sibling: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.nestedText[0], '1. 额啊飞啊发')
  assert.equal(reopened.nestedText[1], '')
  assert.equal(await toggleSource(app), true, 'could not inspect cold-reopen source')
  assert.equal(await waitFor(() => visibleSource(app), 'cold-reopen source missing'), expected)

  console.log('PASS nested list Enter empty sibling: indentation, integrity, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
