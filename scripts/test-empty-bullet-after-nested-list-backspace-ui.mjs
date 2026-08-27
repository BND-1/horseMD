import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs63-empty-bullet-after-nested-${process.pid}`
const file = join(root, 'rs-63.md')
const port = Number(process.env.CDP_PORT || 10763)
const fixture = '# RS63\n\n- sefsf \n- wefsfesf\n  * wfewff \n- \n'
const expected = '# RS63\n\n- sefsf \n- wefsfesf\n  * wfewff \n\n'
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
    nestedCount: topItems.reduce((count, item) => count + item.querySelectorAll('ul li').length, 0),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-500),
      canonical: String(entry.canonical || '').slice(-500)
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdown: String(markdown || '').slice(-500),
      previous: String(previous || '').slice(-500),
      next: String(next || '').slice(-500)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const focusLastEmptyTopBullet = async (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  const topList = [...editor.querySelectorAll('ul')].find((node) => !node.parentElement?.closest('ul'))
  if (!topList) return { ok: false, reason: 'no-top-list' }
  const topItems = [...topList.querySelectorAll('li')].filter((item) => item.closest('ul') === topList)
  const item = topItems.at(-1)
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
  return { ok: true, topItems: topItems.length, html: paragraph.outerHTML }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) =>
      node.offsetParent && (node.textContent || '').includes('wefsfesf') && (node.textContent || '').includes('wfewff')))`),
    'RS-63 fixture did not mount'
  )
  await sleep(500)
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
  assert.equal(focused.ok, true, `could not focus RS-63 empty top bullet: ${JSON.stringify(focused)}`)
  assert.ok(focused.topItems >= 3, `fixture did not retain the empty top bullet: ${JSON.stringify(focused)}`)

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmFlushTrace = []
  })()`)

  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'empty-list-item-merged-after-nested-list')`),
    'RS-63 Backspace did not hit dedicated nested-list continuation reason'
  )
  await sleep(750)

  const after = await diagnostics(app)
  console.log('RS63_AFTER_BACKSPACE:', JSON.stringify(after))
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, `RS-63 integrity failure: ${JSON.stringify(after.integrity)}`)
  assert.equal(after.toasts.some((text) => warningPattern.test(text)), false, `RS-63 showed source warning: ${JSON.stringify(after.toasts)}`)
  assert.equal(
    after.preserve.some((entry) => entry.reason === 'empty-list-item-merged-after-nested-list' && entry.preserved === true),
    true,
    `RS-63 dedicated preservation proof missing: ${JSON.stringify(after.preserve)}`
  )
  assert.equal(after.topItems.length, 2, `RS-63 did not remove the empty top bullet: ${JSON.stringify(after.topItems)}`)
  assert.ok(after.topItems[1].includes('wefsfesf') && after.topItems[1].includes('wfewff'), 'RS-63 changed the surviving parent/nested bullet text')
  assert.ok(after.nestedCount >= 1, 'RS-63 lost the nested bullet')

  assert.equal(await toggleSource(app), true, 'could not switch RS-63 to source mode')
  const source = await waitFor(() => visibleSource(app), 'RS-63 source textarea did not open')
  assert.equal(source, expected, `RS-63 source mismatch: ${JSON.stringify(source)}`)
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-63 leaked Crepe placeholder into source')

  assert.equal(await toggleSource(app), true, 'could not return RS-63 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-63 saved bytes differ from source view')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await diagnostics(app)
  assert.equal(reopened.topItems.length, 2, `RS-63 cold reopen changed top-level bullet count: ${JSON.stringify(reopened)}`)
  assert.ok(reopened.topItems[1].includes('wefsfesf') && reopened.topItems[1].includes('wfewff'), 'RS-63 cold reopen changed parent/nested text')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-63 reopened source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-63 reopened source missing'), expected)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-63 cold reopen changed disk bytes')

  console.log('PASS RS-63 empty bullet after nested list Backspace: integrity, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
