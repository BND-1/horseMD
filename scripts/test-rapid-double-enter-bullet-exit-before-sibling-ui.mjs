import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs86-rapid-double-enter-bullet-exit-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 12610 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const initial = '# RS86\n\n前文\n\n后文\n'
const warningPattern = /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (send, key, code, keyCode, text = key, delayMs = 55) => {
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
    return { ok: true, text: paragraph.textContent || '', offset: selection.anchorOffset }
  })()`)
  assert.equal(result.ok, true, `could not focus ${text}: ${JSON.stringify(result)}`)
  await sleep(180)
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
})()`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const topLists = [...(editor?.querySelectorAll('ul') || [])].filter((list) => !list.closest('li'))
  const directItems = (list) => [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
  const itemText = (item) => [...item.querySelectorAll('p')]
    .filter((paragraph) => paragraph.closest('li') === item)
    .map((paragraph) => (paragraph.textContent || '').replace(/\\u200B/g, ''))
    .join('')
    .trim()
  const topParagraphs = [...(editor?.querySelectorAll('p') || [])]
    .filter((paragraph) => !paragraph.closest('li'))
  return {
    topLists: topLists.length,
    listTexts: topLists.map((list) => directItems(list).map(itemText)),
    topLevelEmptyParagraphs: topParagraphs
      .filter((paragraph) => !(paragraph.textContent || '').replace(/\\u200B/g, '').trim())
      .length,
    preserve: (window.__hmPreserveLog || []).slice(-20)
      .map(({ source, previous, next, markdown, ...entry }) => ({
        ...entry,
        source: String(source || ''),
        previous: String(previous || ''),
        next: String(next || ''),
        markdown: String(markdown || '')
      })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20)
      .map(({ parsed, expected, ...entry }) => ({
        ...entry,
        candidate: String(entry.candidate || ''),
        canonical: String(entry.canonical || '')
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
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-86 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-86 save did not finish')
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
    'RS-86 editor did not mount'
  )
  await sleep(500)
  return app
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')

  app = await openApp('edit', port)
  await clearDiagnostics(app)

  // Build a clean three-item list through physical input rules. This control
  // intentionally serializes all live PM labels as `*`; the exact mixed `-` ->
  // `*` long-session state is covered by the PID 258 raw trace contract. The UI
  // proves RS-86 never steals the ordinary rapid-double-Enter path.
  await focusEndOfParagraph(app, '前文')
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 90 })
  await rawKey(app.send, '-', 'Minus', 189, '-', 80)
  await rawKey(app.send, ' ', 'Space', 32, ' ', 120)
  await typeTextLikeUser(app.send, 'u高科技', { delayMs: 70 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 90 })
  await typeTextLikeUser(app.send, '12312', { delayMs: 70 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 90 })
  await typeTextLikeUser(app.send, '后继项', { delayMs: 70 })
  await sleep(1100)

  const setup = await snapshot(app)
  console.log('RS86_SETUP:', JSON.stringify(setup))
  assert.equal(setup.integrity.some((entry) => entry.ok === false), false, `RS-86 setup failed integrity: ${JSON.stringify(setup.integrity)}`)
  assert.equal(setup.toasts.some((text) => warningPattern.test(text)), false, `RS-86 setup showed warning: ${JSON.stringify(setup.toasts)}`)
  assert.deepEqual(setup.listTexts, [['u高科技', '12312', '后继项']], `RS-86 setup list shape differs from the trace: ${JSON.stringify(setup.listTexts)}`)
  const setupPublication = setup.preserve.at(-1)
  assert.match(
    setupPublication?.next || '',
    /\* u高科技(?:\r?\n){1,2}\* 12312(?:\r?\n){1,2}\* 后继项/,
    `RS-86 clean control did not use the ordinary all-* live canonical: ${JSON.stringify(setupPublication)}`
  )
  assert.equal(await toggleSource(app), true, 'could not inspect RS-86 setup source')
  const setupSource = await waitFor(() => visibleSource(app), 'RS-86 setup source textarea did not open')
  assert.match(setupSource, /u高科技/, 'RS-86 setup source lost the first item')
  assert.match(setupSource, /12312/, 'RS-86 setup source lost the middle item')
  assert.match(setupSource, /后继项/, 'RS-86 setup source lost the successor')
  assert.doesNotMatch(setupSource, /<br\s*\/?\s*>/i, 'RS-86 setup leaked a placeholder')
  assert.equal(await toggleSource(app), true, 'could not return RS-86 setup to rich mode')

  await focusEndOfParagraph(app, '12312')
  await clearDiagnostics(app)

  // The trace used two physical Enters close enough that no source callback
  // published the intermediate empty bullet row. The deferred callback sees
  // only “non-empty item + successor” -> “top-level empty paragraph + successor”.
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 45 })
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 45 })
  await sleep(1050)

  const exited = await snapshot(app)
  console.log('RS86_AFTER_RAPID_DOUBLE_ENTER:', JSON.stringify(exited))
  assert.equal(exited.topLists, 2, `RS-86 did not split the bullet list around the empty paragraph: ${JSON.stringify(exited)}`)
  assert.deepEqual(
    exited.listTexts,
    [['u高科技', '12312'], ['后继项']],
    `RS-86 changed or removed the surviving sibling: ${JSON.stringify(exited.listTexts)}`
  )
  assert.equal(exited.topLevelEmptyParagraphs, 1, `RS-86 did not retain exactly one live top-level empty paragraph: ${JSON.stringify(exited)}`)
  assert.equal(exited.integrity.some((entry) => entry.ok === false), false, `RS-86 rapid double Enter produced integrity failure: ${JSON.stringify(exited.integrity)}`)
  assert.equal(exited.toasts.some((text) => warningPattern.test(text)), false, `RS-86 rapid double Enter showed warning: ${JSON.stringify(exited.toasts)}`)
  assert.equal(
    exited.preserve.some((entry) =>
      entry.reason === 'middle-empty-block-created' &&
      entry.preserved === true && entry.markdown === setupSource),
    true,
    `RS-86 clean control was stolen from middle-empty-block-created: ${JSON.stringify(exited.preserve)}`
  )
  assert.equal(
    exited.preserve.some((entry) => entry.reason === 'coalesced-empty-bullet-exit-before-sibling'),
    false,
    `RS-86 dedicated mixed-marker owner must not claim the ordinary all-* path: ${JSON.stringify(exited.preserve)}`
  )
  assert.equal(
    exited.integrity.some((entry) =>
      entry.preservationReason === 'middle-empty-block-created' &&
      entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true &&
      entry.candidate === setupSource),
    true,
    `RS-86 clean control candidate was not fully source-equivalent: ${JSON.stringify(exited.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-86 source')
  const source = await waitFor(() => visibleSource(app), 'RS-86 source textarea did not open')
  assert.equal(source, setupSource, 'RS-86 clean rapid double Enter changed authored source bytes')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-86 leaked Crepe placeholder into source')

  assert.equal(await toggleSource(app), true, 'could not return RS-86 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), setupSource, 'RS-86 saved bytes differ from inspected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await snapshot(app)
  assert.equal(reopened.listTexts.flat().includes('u高科技'), true, 'RS-86 cold reopen lost the left item')
  assert.equal(reopened.listTexts.flat().includes('12312'), true, 'RS-86 cold reopen lost the edited item')
  assert.equal(reopened.listTexts.flat().includes('后继项'), true, 'RS-86 cold reopen lost the surviving sibling')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-86 reopened source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-86 reopened source missing'), setupSource)
  assert.equal(await readFile(file, 'utf8'), setupSource, 'RS-86 cold reopen changed disk bytes')

  console.log('PASS RS-86 clean rapid double Enter control: existing owner, source, save, and reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
