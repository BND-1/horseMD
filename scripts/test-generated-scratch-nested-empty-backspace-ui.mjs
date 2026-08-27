import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs56-nested-empty-backspace-${process.pid}`
const file = join(root, 'rs-56.md')
const port = Number(process.env.CDP_PORT || 10394)
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (app, key, code, keyCode, text = key, delayMs = 55) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await app.send('Input.dispatchKeyEvent', {
      type: 'char', ...common, text, unmodifiedText: text
    })
  }
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
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
  await sleep(160)
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
  const lists = [...(editor?.querySelectorAll('ul') || [])]
  const innerItem = [...(editor?.querySelectorAll('li') || [])]
    .reverse()
    .find((node) => (node.textContent || '').includes('inner'))
  const innerOwnedParagraphs = [...(innerItem?.querySelectorAll('p') || [])]
    .filter((node) => node.closest('li') === innerItem)
  return {
    listDepthCount: lists.length,
    innerParagraphs: innerOwnedParagraphs.length,
    innerText: innerOwnedParagraphs[0]?.textContent || '',
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      transitionOk: entry.transitionOk,
      listSlotsMatch: entry.listSlotsMatch,
      listTransitionOk: entry.listTransitionOk,
      preservationReason: entry.preservationReason,
      candidate: String(entry.candidate || '').slice(-900),
      canonical: String(entry.canonical || '').slice(-900),
      parsed: entry.parsed,
      expected: entry.expected
    })),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      source: String(source || '').slice(-900),
      previous: String(previous || '').slice(-900),
      next: String(next || '').slice(-900),
      markdown: String(markdown || '').slice(-900)
    }))
  }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'editor did not mount'
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
  await writeFile(file, '', 'utf8')

  app = await openApp('edit', port)
  await clickBlock(app, 'h1')
  await typeTextLikeUser(app.send, 'RS56', { delayMs: 65 })
  await sleep(250)
  await clickBlock(app, 'p')

  await rawKey(app, '-', 'Minus', 189)
  await rawKey(app, ' ', 'Space', 32)
  await typeTextLikeUser(app.send, 'outer', { delayMs: 65 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 65 })
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 80 })
  await typeTextLikeUser(app.send, 'inner', { delayMs: 65 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 65 })
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 80 })
  await typeTextLikeUser(app.send, '我', { delayMs: 65 })
  await sleep(900)

  const before = await diagnostics(app)
  assert.equal(before.listDepthCount, 3, `fixture did not reach three bullet levels: ${JSON.stringify(before)}`)

  await app.evaluate(`(() => {
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmPreserveLog = []
  })()`)

  // Real trace cadence: delete the final character, then hit Backspace again
  // roughly 120 ms later while the first markdown callback may still settle.
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 40 })
  await sleep(80)
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 55 })
  await sleep(1000)

  const after = await diagnostics(app)
  console.log('RS56_AFTER_RAPID_BACKSPACE:', JSON.stringify(after))
  const failures = after.integrity.filter((entry) => entry.ok === false)
  assert.equal(
    failures.length,
    0,
    `RS-56 rapid nested Backspace produced integrity failure: ${JSON.stringify(failures)}`
  )
  assert.equal(
    after.toasts.some((text) => warningPattern.test(text)),
    false,
    `RS-56 rapid nested Backspace showed source-sync warning: ${JSON.stringify(after.toasts)}`
  )
  assert.equal(after.listDepthCount, 2, `deepest empty bullet did not retreat exactly one level: ${JSON.stringify(after)}`)
  assert.equal(after.innerText, 'inner', 'nested parent text changed during retreat')
  assert.ok(after.innerParagraphs >= 2, `retreat did not leave the editor-owned trailing empty paragraph: ${JSON.stringify(after)}`)

  assert.equal(await toggleSource(app), true, 'could not switch RS-56 document to source mode')
  const source = await waitFor(() => visibleSource(app), 'RS-56 source textarea did not open')
  assert.match(source, /outer/, 'outer bullet text disappeared from source')
  assert.match(source, /inner/, 'nested bullet text disappeared from source')
  assert.equal(source.includes('我'), false, 'deleted deepest text survived in source')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-56 leaked Crepe placeholder into source')
  assert.equal(await toggleSource(app), true, 'could not return RS-56 document to rich mode')

  await save(app)
  assert.equal(await readFile(file, 'utf8'), source, 'RS-56 saved bytes differ from inspected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await diagnostics(app)
  assert.equal(reopened.listDepthCount, 2, `cold reopen changed nested-list depth: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.innerText, 'inner', 'cold reopen changed nested parent text')
  assert.equal(await readFile(file, 'utf8'), source, 'cold reopen changed RS-56 source bytes')

  console.log('PASS RS-56 generated scratch nested empty Backspace: rapid delete/retreat, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
