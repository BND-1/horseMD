import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs85-empty-ordered-before-nested-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 12380 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const expected = '# RS85\n\n1. 是共生共荣\n   1. 如何电话\n'
const warningPattern = /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key, delayMs = 70) => {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
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
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1
  })
  await sleep(180)
}

const focusEndOfParagraph = async (app, text) => {
  const result = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => (node.textContent || '') === ${JSON.stringify(text)})
    if (!editor || !paragraph) return { ok: false, reason: 'paragraph-not-found' }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const target = nodes.at(-1)
    if (!target) return { ok: false, reason: 'text-node-not-found' }
    editor.focus()
    const range = document.createRange()
    range.setStart(target, target.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return {
      ok: true,
      text: paragraph.textContent || '',
      offset: selection.anchorOffset
    }
  })()`)
  assert.equal(result.ok, true, `could not focus paragraph ${text}: ${JSON.stringify(result)}`)
  await sleep(180)
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
})()`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const outer = [...(editor?.querySelectorAll('ol') || [])]
    .find((list) => !list.closest('li')) || null
  const items = outer
    ? [...outer.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    : []
  const directParagraphs = (item) => [...(item?.querySelectorAll('p') || [])]
    .filter((paragraph) => paragraph.closest('li') === item)
  const directText = (item) => directParagraphs(item)
    .map((paragraph) => (paragraph.textContent || '').replace(/\\u200B/g, ''))
  const nested = outer?.querySelector('ol ol') || null
  return {
    outerItems: items.length,
    itemTexts: items.map(directText),
    firstDirectParagraphs: directParagraphs(items[0]).length,
    firstEmptyParagraphs: directParagraphs(items[0])
      .filter((paragraph) => !(paragraph.textContent || '').replace(/\\u200B/g, '').trim())
      .length,
    nestedOrderedLists: editor?.querySelectorAll('ol ol').length || 0,
    nestedText: nested?.textContent?.replace(/\\u200B/g, '').trim() || '',
    preserve: (window.__hmPreserveLog || []).slice(-20)
      .map(({ source, previous, next, markdown, ...entry }) => ({
        ...entry,
        source: String(source || '').slice(-700),
        previous: String(previous || '').slice(-700),
        next: String(next || '').slice(-700),
        markdown: String(markdown || '').slice(-700)
      })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20)
      .map(({ parsed, expected, ...entry }) => ({
        ...entry,
        candidate: String(entry.candidate || '').slice(-600),
        canonical: String(entry.canonical || '').slice(-600)
      })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

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

const save = async (app) => {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-85 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-85 save did not finish')
}

const openApp = async (profile, appPort) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`),
    'RS-85 editor did not mount'
  )
  await sleep(420)
  return app
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '', 'utf8')

  app = await openApp('edit', port)
  await clickBlock(app, 'h1')
  await typeTextLikeUser(app.send, 'RS85', { delayMs: 65 })
  await sleep(260)
  await clickBlock(app, 'p')

  await rawKey(app.send, '1', 'Digit1', 49)
  await rawKey(app.send, '.', 'Period', 190)
  await rawKey(app.send, ' ', 'Space', 32)
  await typeTextLikeUser(app.send, '是共生共荣', { delayMs: 65 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
  await typeTextLikeUser(app.send, '距离近', { delayMs: 65 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
  await pressKey(app.send, { key: 'Tab', code: 'Tab', delayMs: 90 })
  await typeTextLikeUser(app.send, '如何电话', { delayMs: 65 })
  await sleep(900)

  const fixture = await snapshot(app)
  assert.equal(fixture.outerItems, 2, `RS-85 fixture did not create two outer ordered items: ${JSON.stringify(fixture)}`)
  assert.equal(fixture.nestedOrderedLists, 1, `RS-85 fixture did not create one nested ordered child: ${JSON.stringify(fixture)}`)
  assert.ok(fixture.itemTexts[1]?.includes('距离近'), `RS-85 second parent body missing: ${JSON.stringify(fixture)}`)
  assert.ok(fixture.nestedText.includes('如何电话'), `RS-85 nested child text missing: ${JSON.stringify(fixture)}`)

  await focusEndOfParagraph(app, '距离近')
  for (let index = 0; index < 3; index += 1) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 150 })
  }
  await sleep(700)

  const emptied = await snapshot(app)
  assert.equal(emptied.outerItems, 2, `RS-85 body deletion removed the parent item too early: ${JSON.stringify(emptied)}`)
  assert.equal(emptied.itemTexts[1]?.[0] || '', '', `RS-85 parent body did not become empty: ${JSON.stringify(emptied)}`)
  assert.equal(emptied.nestedOrderedLists, 1, `RS-85 body deletion lost the nested child: ${JSON.stringify(emptied)}`)
  assert.equal(emptied.integrity.some((entry) => entry.ok === false), false, `RS-85 body deletion produced integrity failure: ${JSON.stringify(emptied.integrity)}`)

  await clearDiagnostics(app)
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 100 })
  await sleep(900)

  const merged = await snapshot(app)
  console.log('RS85_AFTER_STRUCTURAL_BACKSPACE:', JSON.stringify(merged))
  assert.equal(merged.outerItems, 1, `RS-85 did not merge the empty second ordered item into the first: ${JSON.stringify(merged)}`)
  assert.equal(merged.nestedOrderedLists, 1, `RS-85 lost the nested ordered child: ${JSON.stringify(merged)}`)
  assert.ok(merged.nestedText.includes('如何电话'), `RS-85 changed nested child text: ${JSON.stringify(merged)}`)
  assert.equal(merged.firstEmptyParagraphs, 1, `RS-85 live PM did not retain exactly one editor-owned empty paragraph before the nested child: ${JSON.stringify(merged)}`)
  assert.equal(merged.integrity.some((entry) => entry.ok === false), false, `RS-85 structural Backspace produced integrity failure: ${JSON.stringify(merged.integrity)}`)
  assert.equal(merged.toasts.some((text) => warningPattern.test(text)), false, `RS-85 showed source-sync warning: ${JSON.stringify(merged.toasts)}`)
  assert.equal(
    merged.preserve.some((entry) =>
      entry.reason === 'empty-ordered-item-merged-before-nested-list' && entry.preserved === true),
    true,
    `RS-85 did not use the dedicated empty-ordered-before-nested owner: ${JSON.stringify(merged.preserve)}`
  )
  assert.ok(
    merged.integrity.some((entry) =>
      entry.preservationReason === 'empty-ordered-item-merged-before-nested-list' &&
      entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true),
    `RS-85 candidate was not fully source-equivalent: ${JSON.stringify(merged.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-85 source')
  const source = await waitFor(() => visibleSource(app), 'RS-85 source textarea did not open')
  assert.equal(source, expected, 'RS-85 source did not delete only the empty parent row')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-85 leaked Crepe placeholder into source')

  assert.equal(await toggleSource(app), true, 'could not return RS-85 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-85 saved bytes differ from inspected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await snapshot(app)
  assert.equal(reopened.outerItems, 1, `RS-85 cold reopen restored the removed parent item: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.nestedOrderedLists, 1, `RS-85 cold reopen lost the nested ordered child: ${JSON.stringify(reopened)}`)
  assert.ok(reopened.nestedText.includes('如何电话'), 'RS-85 cold reopen changed nested child text')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-85 reopened source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-85 reopened source missing'), expected)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-85 cold reopen changed disk bytes')

  console.log('PASS RS-85 empty ordered parent before nested child Backspace: owner, integrity, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
