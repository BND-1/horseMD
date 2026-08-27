import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-generated-scratch-empty-ordered-indent-${process.pid}`
const file = join(root, 'rs-45.md')
const port = Number(process.env.CDP_PORT || 10221)
const expected = '# 你好\n\n1. 测试\n\n   1. \n'
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key, delayMs = 70) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await send('Input.dispatchKeyEvent', {
      type: 'char',
      ...common,
      text,
      unmodifiedText: text
    })
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delayMs)
}

const clickBlock = async (app, selector) => {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 14, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, `could not find visible ${selector}`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(180)
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

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    source: String(source || '').slice(0, 240),
    previous: String(previous || '').slice(0, 240),
    next: String(next || '').slice(0, 240),
    markdown: String(markdown || '').slice(0, 240)
  })),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, ...entry }) => ({
    ...entry,
    candidate: String(candidate || '').slice(0, 320),
    canonical: String(canonical || '').slice(0, 320)
  })),
  integrityDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-12),
  listIntents: (window.__hmListIntentTrace || []).slice(-20).map(({ source, canonical, markdown, ...entry }) => entry),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
  shape: (() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return null
    const lists = [...editor.querySelectorAll('ol')]
    return {
      orderedLists: lists.length,
      nestedOrderedLists: editor.querySelectorAll('ol ol').length,
      text: editor.textContent || ''
    }
  })()
}))()`)

async function saveAndAssert(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
  await waitFor(async () => await readFile(file, 'utf8') === expected, 'disk did not reach RS-45 expected source')
  assert.equal(await readFile(file, 'utf8'), expected, 'saved RS-45 bytes differ')
}

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'editor did not mount'
  )
  return app
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '', 'utf8')

  app = await openApp('profile-edit', port)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmListIntentTrace = []
  })()`)

  // Exact RS-45 family path captured from the 0.13.90 real trace:
  // blank doc -> H1 -> ordered item body -> Enter creates empty 2. -> Tab.
  await clickBlock(app, 'h1')
  await typeTextLikeUser(app.send, '你好', { delayMs: 70 })
  await sleep(360)
  await clickBlock(app, 'p')
  await rawKey(app.send, '1', 'Digit1', 49)
  await rawKey(app.send, '.', 'Period', 190)
  await rawKey(app.send, ' ', 'Space', 32)
  await typeTextLikeUser(app.send, '测试', { delayMs: 70 })
  await sleep(560)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 70 })
  await sleep(560) // publish the valid outer `2. ` baseline before Tab
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 70 })
  await sleep(900)

  const afterTab = await diagnostics(app)
  console.log('RS45_AFTER_TAB:', JSON.stringify(afterTab))
  assert.equal(afterTab.shape?.nestedOrderedLists, 1, 'Tab did not create one nested ordered list in rich mode')
  const finalIntegrity = afterTab.integrity.at(-1)
  assert.equal(
    finalIntegrity?.ok,
    true,
    `RS-45 Tab did not finish on a proven source candidate: ${JSON.stringify(afterTab.integrity)}`
  )
  assert.equal(
    finalIntegrity?.candidate,
    expected,
    `RS-45 final proven candidate differs from parse-safe authored source: ${JSON.stringify(finalIntegrity)}`
  )
  assert.equal(
    afterTab.integrity
      .filter((entry) => entry.ok === false)
      .some((entry) => entry.preservationReason !== 'typed-bullet-input-rule'),
    false,
    `RS-45 had an unexpected final-path integrity failure: ${JSON.stringify(afterTab.integrity)}`
  )
  assert.equal(
    afterTab.toasts.some((text) => warningPattern.test(text)),
    false,
    `RS-45 Tab showed a source-sync warning: ${JSON.stringify(afterTab.toasts)}`
  )

  assert.equal(await toggleSource(app), true, 'could not switch RS-45 document to source mode')
  const source1 = await waitFor(() => visibleSource(app), 'RS-45 source textarea did not open')
  assert.equal(source1, expected, 'RS-45 source after Tab is not the bare nested empty ordered item')
  assert.doesNotMatch(source1, /<br\s*\/?\s*>/i, 'RS-45 leaked Crepe <br /> placeholder into source')

  assert.equal(await toggleSource(app), true, 'could not return RS-45 document to rich mode')
  await sleep(300)
  assert.equal(await toggleSource(app), true, 'could not reopen RS-45 source mode')
  const source2 = await waitFor(() => visibleSource(app), 'RS-45 source textarea did not reopen')
  assert.equal(source2, expected, 'RS-45 rich/source round-trip drifted')

  assert.equal(await toggleSource(app), true, 'could not return to rich mode before RS-45 save')
  await sleep(250)
  await saveAndAssert(app)

  await stopBuiltElectron(app, { removeProfile: true })
  app = null

  app = await openApp('profile-reopen', port + 1)
  const reopenedShape = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return {
      nestedOrderedLists: editor?.querySelectorAll('ol ol').length || 0,
      text: editor?.textContent || ''
    }
  })()`)
  assert.equal(reopenedShape.nestedOrderedLists, 1, `RS-45 cold reopen lost nested empty ordered list: ${JSON.stringify(reopenedShape)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect RS-45 source after cold reopen')
  const reopenedSource = await waitFor(() => visibleSource(app), 'RS-45 cold-reopen source did not open')
  assert.equal(reopenedSource, expected, 'RS-45 cold reopen normalized or lost authored source')

  console.log('PASS RS-45 generated scratch empty ordered indent: Tab, source, save, and cold reopen stay equivalent')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
