import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs51-empty-bullet-backspace-${process.pid}`
const file = join(root, 'rs-51.md')
const port = Number(process.env.CDP_PORT || 10391)
const afterBackspaceExpected = '# 测试\n\n- 离婚了\n\n'
const finalExpected = '# 测试\n\n- 离婚了\n\n后续\n'
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (app, key, code, keyCode, text = key, delayMs = 70) => {
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
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => ({
    ...entry,
    candidate: String(entry.candidate || '').slice(-500),
    canonical: String(entry.canonical || '').slice(-500)
  })),
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, markdown, ...entry }) => ({
    ...entry,
    source: String(source || '').slice(-500),
    previous: String(previous || '').slice(-500),
    next: String(next || '').slice(-500),
    markdown: String(markdown || '').slice(-500)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || ''),
  shape: (() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const ul = [...(editor?.querySelectorAll('ul') || [])]
      .find((node) => (node.textContent || '').includes('离婚了'))
    const items = [...(ul?.querySelectorAll('li') || [])]
    const listItem = items.find((node) => (node.textContent || '').includes('离婚了')) || items[0]
    const topParagraphs = [...(editor?.querySelectorAll('p') || [])].filter((node) => !node.closest('li'))
    return {
      bullets: items.length,
      listText: listItem?.textContent?.trim() || '',
      listParagraphs: listItem?.querySelectorAll('p').length || 0,
      followingParagraph: topParagraphs.at(-1)?.textContent || ''
    }
  })()
}))()`)

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
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmListIntentTrace = []
  })()`)

  await clickBlock(app, 'h1')
  await typeTextLikeUser(app.send, '测试', { delayMs: 70 })
  await sleep(320)
  await clickBlock(app, 'p')
  await rawKey(app, '-', 'Minus', 189)
  await rawKey(app, ' ', 'Space', 32)
  await typeTextLikeUser(app.send, '离婚了', { delayMs: 70 })
  await sleep(600)
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 70 })
  await sleep(650)

  const beforeBackspace = await diagnostics(app)
  assert.equal(beforeBackspace.shape?.bullets, 2, `Enter did not create empty second bullet: ${JSON.stringify(beforeBackspace)}`)

  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 70 })
  await sleep(900)

  const afterBackspace = await diagnostics(app)
  console.log('RS51_AFTER_BACKSPACE:', JSON.stringify(afterBackspace))
  assert.equal(afterBackspace.shape?.bullets, 1, 'Backspace did not remove/merge the empty second bullet')
  assert.equal(afterBackspace.shape?.listText, '离婚了', 'Backspace changed surviving bullet text')
  assert.equal(
    afterBackspace.integrity.some((entry) => entry.ok === false),
    false,
    `RS-51 Backspace produced an integrity failure: ${JSON.stringify(afterBackspace.integrity)}`
  )
  assert.equal(
    afterBackspace.toasts.some((text) => warningPattern.test(text)),
    false,
    `RS-51 Backspace showed a source-sync warning: ${JSON.stringify(afterBackspace.toasts)}`
  )
  const finalIntegrity = afterBackspace.integrity.at(-1)
  assert.equal(finalIntegrity?.ok, true, `RS-51 did not finish on a proven candidate: ${JSON.stringify(afterBackspace.integrity)}`)
  assert.equal(finalIntegrity?.preservationReason, 'empty-list-item-removed', `RS-51 did not reuse the proven empty-list-item-removed contract: ${JSON.stringify(finalIntegrity)}`)
  assert.equal(finalIntegrity?.candidate, afterBackspaceExpected, 'RS-51 candidate lost the post-list empty block slot')

  assert.equal(await toggleSource(app), true, 'could not switch RS-51 document to source mode')
  const sourceAfterBackspace = await waitFor(() => visibleSource(app), 'RS-51 source textarea did not open')
  assert.equal(sourceAfterBackspace, afterBackspaceExpected, 'RS-51 source after Backspace differs from expected')
  assert.doesNotMatch(sourceAfterBackspace, /<br\s*\/?\s*>/i, 'RS-51 leaked Crepe placeholder into source')

  assert.equal(await toggleSource(app), true, 'could not return RS-51 document to rich mode')
  await sleep(250)
  const postListPoint = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraphs = [...(editor?.querySelectorAll('p') || [])].filter((node) => !node.closest('li'))
    const node = paragraphs.at(-1)
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 14, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
  })()`)
  assert.ok(postListPoint, 'could not find post-list paragraph')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...postListPoint, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...postListPoint, button: 'left', clickCount: 1 })
  await sleep(180)
  await typeTextLikeUser(app.send, '后续', { delayMs: 70 })
  await sleep(850)

  const afterFollowingText = await diagnostics(app)
  console.log('RS51_AFTER_FOLLOWING:', JSON.stringify(afterFollowingText))
  assert.equal(afterFollowingText.shape?.followingParagraph, '后续', `post-list paragraph was not filled: ${JSON.stringify(afterFollowingText.shape)}`)
  assert.equal(afterFollowingText.integrity.some((entry) => entry.ok === false), false, `post-list text caused a new integrity failure: ${JSON.stringify(afterFollowingText.integrity)}`)
  assert.equal(afterFollowingText.toasts.some((text) => warningPattern.test(text)), false, 'post-list text showed a source warning')

  assert.equal(await toggleSource(app), true, 'could not inspect RS-51 final source')
  const finalSource = await waitFor(() => visibleSource(app), 'RS-51 final source textarea did not open')
  assert.equal(finalSource, finalExpected, 'post-list text glued into the bullet or changed source')
  assert.equal(await toggleSource(app), true, 'could not return to rich mode before save')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), finalExpected, 'RS-51 saved bytes differ from expected')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await diagnostics(app)
  assert.equal(reopened.shape?.bullets, 1, `cold reopen changed bullet count: ${JSON.stringify(reopened.shape)}`)
  assert.equal(reopened.shape?.listText, '离婚了', 'cold reopen changed bullet text')
  assert.equal(reopened.shape?.followingParagraph, '后续', 'cold reopen lost or glued post-list paragraph')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-51 cold-reopen source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-51 cold-reopen source missing'), finalExpected)

  console.log('PASS RS-51 generated scratch empty bullet Backspace: integrity, source slot, save, and cold reopen stay stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
