import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs55-appended-literal-ordered-${process.pid}`
const file = join(root, 'rs-55.md')
const port = Number(process.env.CDP_PORT || 10393)
const initial = '# 你好\n\n1. 测试\n2. 哪里呢\n\n- \n'
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

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
  await sleep(500)
  return app
}

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const ordered = editor?.querySelector('ol')
  const topParagraphs = [...(editor?.querySelectorAll('p') || [])].filter((node) => !node.closest('li'))
  return {
    orderedItems: ordered?.querySelectorAll('li').length || 0,
    orderedTexts: [...(ordered?.querySelectorAll('li') || [])].map((node) => (node.textContent || '').trim()),
    topParagraphTexts: topParagraphs.map((node) => node.textContent || ''),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ parsed, expected, ...entry }) => entry)
  }
})()`)

async function clickEmptyBullet(app) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const ul = editor?.querySelector('ul')
    const p = [...(ul?.querySelectorAll('p') || [])].find((node) => !(node.textContent || '').trim())
    if (!p) return null
    const rect = p.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(point, 'could not find empty bullet')
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

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')
  app = await openApp('edit', port)
  await app.evaluate(`window.__hmSourceIntegrityTrace = []; window.__hmSourceIntegrityDiffTrace = []; window.__hmPreserveLog = []`)

  await clickEmptyBullet(app)
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
  await sleep(700)

  await typeTextLikeUser(app.send, '3.', { delayMs: 90 })
  await sleep(700)
  const literal = await snapshot(app)
  console.log('RS55_LITERAL_STAGE:', JSON.stringify(literal))
  assert.equal(literal.orderedItems, 2, 'typing literal 3. converted to list before Space')
  assert.equal(literal.topParagraphTexts.at(-1), '3.', 'literal 3. did not stay in trailing paragraph')
  assert.equal(literal.integrity.some((entry) => entry.ok === false), false, `literal stage integrity failed: ${JSON.stringify(literal.integrity)}`)
  assert.equal(literal.toasts.some((text) => warningPattern.test(text)), false, `literal stage showed warning: ${JSON.stringify(literal.toasts)}`)
  const literalIntegrity = [...literal.integrity].reverse().find((entry) => String(entry.canonical || '').includes('3\\.'))
  assert.ok(literalIntegrity, `missing literal ordered-marker integrity evidence: ${JSON.stringify(literal.integrity)}`)
  assert.ok(String(literalIntegrity.candidate || '').includes('3\\.'), `candidate lost protective escape: ${JSON.stringify(literalIntegrity)}`)

  const spaceKey = {
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...spaceKey })
  await app.send('Input.dispatchKeyEvent', {
    type: 'char',
    ...spaceKey,
    text: ' ',
    unmodifiedText: ' '
  })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spaceKey })
  await sleep(650)
  const listed = await snapshot(app)
  assert.equal(listed.orderedItems, 3, `Space did not convert literal marker into ordered item: ${JSON.stringify(listed)}`)
  assert.equal(listed.integrity.some((entry) => entry.ok === false), false, `list conversion integrity failed: ${JSON.stringify(listed.integrity)}`)

  await typeTextLikeUser(app.send, '第三项', { delayMs: 80 })
  await sleep(700)
  const filled = await snapshot(app)
  assert.equal(filled.orderedItems, 3, 'third ordered item disappeared after filling')
  assert.equal(filled.orderedTexts.at(-1)?.endsWith('第三项'), true, `third ordered item text mismatch: ${JSON.stringify(filled)}`)
  assert.equal(filled.integrity.some((entry) => entry.ok === false), false, `filled list integrity failed: ${JSON.stringify(filled.integrity)}`)
  assert.equal(filled.toasts.some((text) => warningPattern.test(text)), false, `filled list showed warning: ${JSON.stringify(filled.toasts)}`)

  assert.equal(await toggleSource(app), true, 'could not switch to source')
  const source = await waitFor(() => visibleSource(app), 'source textarea missing')
  assert.ok(source.includes('3. 第三项'), `source did not contain real third ordered item: ${JSON.stringify(source)}`)
  assert.equal(source.includes('3\\. 第三项'), false, 'protective escape survived after real list conversion')
  assert.equal(await toggleSource(app), true, 'could not return to rich')

  await save(app)
  assert.equal(await readFile(file, 'utf8'), source, 'saved bytes differ from inspected source')
  await stopBuiltElectron(app, { removeProfile: true })
  app = await openApp('reopen', port + 1)
  const reopened = await snapshot(app)
  assert.equal(reopened.orderedItems, 3, 'cold reopen lost third ordered item')
  assert.equal(reopened.orderedTexts.at(-1)?.endsWith('第三项'), true, 'cold reopen changed third item text')
  assert.equal(await readFile(file, 'utf8'), source, 'cold reopen changed source bytes')
  console.log('PASS RS-55 appended literal ordered marker: literal stage protected; Space conversion/save/reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
