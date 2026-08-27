import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs67-parent-empty-${process.pid}`
const file = join(root, 'rs-67.md')
const port = Number(process.env.CDP_PORT || 10867)
const fixture = '# RS67\n\n- u高科技\n- 1\\. 色粉色分\n\n1. 啊\n   1. 微风\n\n后文\n'
const expected = '# RS67\n\n- u高科技\n- 1\\. 色粉色分\n\n1. \n   1. 微风\n\n后文\n'
const warningPattern = /源码.*不一致|保存已暂停|无法安全映射|Save paused/i

async function waitFor(check, message, attempts = 140) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const state = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const parentP = [...(editor?.querySelectorAll('p') || [])].find((node) => {
    const li = node.closest('li')
    if (!li || node.closest('ol ol')) return false
    return [...li.querySelectorAll('ol li p')].some((child) => child.textContent === '微风')
  })
  const parentLi = parentP?.closest('li')
  const childP = [...(parentLi?.querySelectorAll('ol li p') || [])]
    .find((node) => node.textContent === '微风')
  return {
    parentText: parentP?.textContent ?? null,
    childText: childP?.textContent ?? null,
    parentExists: !!parentLi,
    childNested: !!(parentLi && childP && parentLi.contains(childP) && childP.closest('li') !== parentLi),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidate: String(entry.candidate || '').slice(-700),
      canonical: String(entry.canonical || '').slice(-700)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('微风') && (node.textContent || '').includes('后文')))`),
    'RS-67 fixture did not mount'
  )
  await sleep(650)
  return app
}

const placeCaretAfterParent = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const p = [...(editor?.querySelectorAll('p') || [])].find((node) => {
    if (node.textContent !== '啊') return false
    const li = node.closest('li')
    return li && [...li.querySelectorAll('ol li p')].some((child) => child.textContent === '微风')
  })
  if (!p) return false
  const text = [...p.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.includes('啊'))
  if (!text) return false
  const range = document.createRange()
  range.setStart(text, text.nodeValue.length)
  range.collapse(true)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  editor.focus()
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  assert.equal(await placeCaretAfterParent(app), true, 'could not place caret after RS-67 parent body')
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
  await sleep(950)

  const after = await state(app)
  console.log('RS67_AFTER_EMPTY:', JSON.stringify(after))
  assert.equal(after.parentExists, true, `RS-67 removed parent item: ${JSON.stringify(after)}`)
  assert.equal(after.parentText, '', `RS-67 parent paragraph not empty: ${JSON.stringify(after)}`)
  assert.equal(after.childText, '微风', `RS-67 changed child text: ${JSON.stringify(after)}`)
  assert.equal(after.childNested, true, `RS-67 promoted nested child: ${JSON.stringify(after)}`)
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, `RS-67 integrity failure: ${JSON.stringify(after.integrity)}`)
  assert.equal(after.toasts.some((text) => warningPattern.test(text)), false, `RS-67 warning toast: ${JSON.stringify(after.toasts)}`)
  assert.equal(after.integrity.some((entry) =>
    entry.preservationReason === 'nested-list-parent-body-emptied' &&
    entry.ok === true && entry.semanticOk === true && entry.listSlotsMatch === true
  ), true, `RS-67 dedicated proof missing: ${JSON.stringify(after.integrity)}`)

  assert.equal(await toggleSource(app), true, 'could not open RS-67 source mode')
  const source = await waitFor(() => visibleSource(app), 'RS-67 source textarea missing')
  console.log('RS67_SOURCE:', JSON.stringify(source))
  assert.equal(source, expected, `RS-67 source mismatch: ${JSON.stringify(source)}`)
  assert.equal(source.includes('<br'), false, 'RS-67 leaked editor placeholder into source')

  assert.equal(await toggleSource(app), true, 'could not return RS-67 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-67 disk bytes differ from source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await state(app)
  console.log('RS67_REOPENED:', JSON.stringify(reopened))
  assert.equal(reopened.parentExists, true, 'RS-67 reopen lost parent item')
  assert.equal(reopened.parentText, '', `RS-67 reopen restored parent text: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.childText, '微风', `RS-67 reopen changed child: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.childNested, true, `RS-67 reopen promoted child: ${JSON.stringify(reopened)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect reopened RS-67 source')
  assert.equal(await waitFor(() => visibleSource(app), 'reopened RS-67 source missing'), expected)

  console.log('PASS RS-67 nested parent body empty: marker, child depth, integrity, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
