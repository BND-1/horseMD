import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs64-empty-bullet-indent-${process.pid}`
const file = join(root, 'rs-64.md')
const port = Number(process.env.CDP_PORT || 10764)
const fixture = '# RS64\n\n- u高科技\n- 阿尔萨俄方\n- \n'
const afterTabExpected = '# RS64\n\n- u高科技\n- 阿尔萨俄方\n\n  * \n'
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

const diagnostics = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const topList = [...(editor?.querySelectorAll('ul') || [])]
    .find((node) => !node.parentElement?.closest('ul'))
  const topItems = topList
    ? [...topList.querySelectorAll('li')].filter((item) => item.closest('ul') === topList)
    : []
  return {
    topItems: topItems.map((item) => item.textContent || ''),
    nestedLists: editor?.querySelectorAll('ul ul').length || 0,
    nestedText: [...(editor?.querySelectorAll('ul ul li') || [])].map((item) => item.textContent || ''),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-500),
      canonical: String(entry.canonical || '').slice(-500)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: String(markdown || '').slice(-500)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const focusLastEmptyTopBullet = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  const topList = [...editor.querySelectorAll('ul')].find((node) => !node.parentElement?.closest('ul'))
  if (!topList) return { ok: false, reason: 'no-top-list' }
  const items = [...topList.querySelectorAll('li')].filter((item) => item.closest('ul') === topList)
  const item = items.at(-1)
  const paragraph = item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
  if (!item || !paragraph || (paragraph.textContent || '').trim()) {
    return { ok: false, reason: 'last-item-not-empty', html: topList.outerHTML.slice(-1800) }
  }
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(true)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return { ok: true, topItems: items.length }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) =>
      node.offsetParent && (node.textContent || '').includes('阿尔萨俄方')))`),
    'RS-64 fixture did not mount'
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

  const focused = await focusLastEmptyTopBullet(app)
  assert.equal(focused.ok, true, `could not focus RS-64 empty bullet: ${JSON.stringify(focused)}`)
  assert.equal(focused.topItems, 3, `fixture did not keep three top-level bullets: ${JSON.stringify(focused)}`)

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 80 })
  await sleep(850)

  const afterTab = await diagnostics(app)
  console.log('RS64_AFTER_TAB:', JSON.stringify(afterTab))
  assert.equal(afterTab.nestedLists, 1, `Tab did not create one nested bullet list: ${JSON.stringify(afterTab)}`)
  assert.equal(afterTab.topItems.length, 2, `Tab did not move the empty item under its previous sibling: ${JSON.stringify(afterTab.topItems)}`)
  assert.equal(afterTab.integrity.some((entry) => entry.ok === false), false, `RS-64 Tab failed integrity: ${JSON.stringify(afterTab.integrity)}`)
  assert.equal(afterTab.toasts.some((text) => warningPattern.test(text)), false, `RS-64 Tab showed warning: ${JSON.stringify(afterTab.toasts)}`)
  assert.equal(
    afterTab.integrity.some((entry) =>
      entry.preservationReason === 'transaction-list-subtree' &&
      entry.preservationProof?.family === 'list-subtree-replace' &&
      entry.preservationProof?.mapperReason === 'batched-list-block-changes' &&
      entry.ok === true
    ),
    true,
    `RS-64 did not finish on the transaction-owned batched-list candidate: ${JSON.stringify(afterTab.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-64 source after Tab')
  const sourceAfterTab = await waitFor(() => visibleSource(app), 'RS-64 source textarea missing after Tab')
  assert.equal(sourceAfterTab, afterTabExpected, `RS-64 source after Tab is not parse-safe: ${JSON.stringify(sourceAfterTab)}`)
  assert.doesNotMatch(sourceAfterTab, /<br\s*\/?\s*>/i, 'RS-64 leaked Crepe placeholder after Tab')
  assert.equal(await toggleSource(app), true, 'could not return RS-64 to rich mode after Tab')
  await sleep(250)

  await typeTextLikeUser(app.send, 's', { delayMs: 80 })
  await sleep(850)
  const afterText = await diagnostics(app)
  console.log('RS64_AFTER_TEXT:', JSON.stringify(afterText))
  assert.equal(afterText.integrity.some((entry) => entry.ok === false), false, `typing into RS-64 nested item failed integrity: ${JSON.stringify(afterText.integrity)}`)
  assert.equal(afterText.toasts.some((text) => warningPattern.test(text)), false, `typing into RS-64 nested item showed warning: ${JSON.stringify(afterText.toasts)}`)
  assert.equal(afterText.nestedLists, 1, 'typing into RS-64 nested item changed list depth')
  assert.equal(afterText.nestedText.some((text) => text.includes('s')), true, `nested item did not receive text: ${JSON.stringify(afterText.nestedText)}`)

  assert.equal(await toggleSource(app), true, 'could not inspect RS-64 source after nested text')
  const finalSource = await waitFor(() => visibleSource(app), 'RS-64 final source textarea missing')
  assert.match(finalSource, /^# RS64\n\n- u高科技\n- 阿尔萨俄方\n(?:\n)?  \* s\n$/m, `RS-64 final source lost nested item or changed untouched top-level rows: ${JSON.stringify(finalSource)}`)
  assert.doesNotMatch(finalSource, /<br\s*\/?\s*>/i, 'RS-64 final source leaked Crepe placeholder')
  assert.equal(await toggleSource(app), true, 'could not return RS-64 to rich mode before save')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), finalSource, 'RS-64 disk bytes differ from source view')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await diagnostics(app)
  assert.equal(reopened.nestedLists, 1, `RS-64 cold reopen lost nested list: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.nestedText.some((text) => text.includes('s')), true, 'RS-64 cold reopen lost nested item text')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-64 cold-reopen source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-64 cold-reopen source missing'), finalSource)

  console.log('PASS RS-64 empty bullet Tab indent: parse-safe source, continued typing, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
