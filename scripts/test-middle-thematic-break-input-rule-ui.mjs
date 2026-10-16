import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs83-middle-thematic-break-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11980 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /源码.*不一致|富文本.*源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = [
  '# RS83 middle thematic break',
  '',
  '- authored marker',
  '- 1\\. literal',
  '',
  '1. 吗。不开机；口红',
  '',
  '2. 斯卡洛尼快乐',
  '',
  '3. ',
  '',
  '4. 是干嘛的了；吗',
  '',
  '5. \u200B 热度三个代表',
  '',
  '- 是v的；发布',
  '',
  '- 露娜了',
  '',
  '啊额绿化',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  ''
].join('\n')

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const physicalKey = async (app, { key, code, keyCode, text = '', hold = 55, after = 100 }) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) {
    await sleep(8)
    await app.send('Input.dispatchKeyEvent', {
      type: 'char', ...common, text, unmodifiedText: text
    })
  }
  await sleep(hold)
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const focusEmptyBeforeFollowing = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  for (const list of editor.querySelectorAll('ol')) {
    const items = [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    const followingIndex = items.findIndex((item) => {
      const p = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
      return (p?.textContent || '').includes('是干嘛的了；吗')
    })
    if (followingIndex <= 0) continue
    const item = items[followingIndex - 1]
    const p = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
    if (!p || (p.textContent || '').replace(/\\u200B/g, '').trim()) continue
    editor.focus()
    const range = document.createRange()
    range.setStart(p, 0)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, html: list.outerHTML.slice(0, 2600) }
  }
  return { ok: false, reason: 'target-not-found', html: editor.innerHTML.slice(0, 3200) }
})()`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const lists = [...(editor?.querySelectorAll('ol') || [])]
  const listTexts = lists.map((list) => [...list.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    .map((item) => {
      const p = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
      return (p?.textContent || '').replace(/\\u200B/g, '').trim()
    }))
  const firstList = lists.find((list) => (list.textContent || '').includes('3fresh')) || null
  const followingList = lists.find((list) => (list.textContent || '').includes('是干嘛的了；吗')) || null
  return {
    hrCount: editor?.querySelectorAll('hr').length || 0,
    separateOrderedLists: !!firstList && !!followingList && firstList !== followingList,
    listTexts,
    preserve: (window.__hmPreserveLog || []).slice(-24).map(({ source, previous, next, markdown, ...entry }) => ({
      ...entry,
      markdownTail: String(markdown || '').slice(-900)
    })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-24).map(({ parsed, expected, ...entry }) => ({
      ...entry,
      candidateTail: String(entry.candidate || '').slice(-900),
      canonicalTail: String(entry.canonical || '').slice(-900)
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

const openApp = async (profile, appPort) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('是干嘛的了；吗')))`),
    'RS-83 fixture did not mount'
  )
  await sleep(500)
  return app
}

const save = async (app) => {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-83 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-83 save did not complete')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)

  const focused = await focusEmptyBeforeFollowing(app)
  assert.equal(focused.ok, true, `could not focus RS-83 empty ordered item: ${JSON.stringify(focused)}`)
  await app.send('Input.insertText', { text: '3fresh' })
  await sleep(750)
  await physicalKey(app, { key: 'Enter', code: 'Enter', keyCode: 13, hold: 70, after: 320 })
  await physicalKey(app, { key: 'Enter', code: 'Enter', keyCode: 13, hold: 70, after: 780 })

  const setup = await snapshot(app)
  console.log('RS83_AFTER_LIST_EXIT:', JSON.stringify(setup))
  assert.equal(setup.integrity.some((entry) => entry.ok === false), false, `RS-83 setup already failed integrity: ${JSON.stringify(setup.integrity)}`)
  assert.equal(setup.toasts.some((text) => warningPattern.test(text)), false, `RS-83 setup already warned: ${JSON.stringify(setup.toasts)}`)

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  await physicalKey(app, { key: '-', code: 'Minus', keyCode: 189, text: '-', hold: 60, after: 280 })
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'middle-empty-block-filled' && String(entry.markdown || '').includes('\\\\-'))`),
    'RS-83 first dash did not publish as standalone escaped source'
  )
  const loneDash = await snapshot(app)
  console.log('RS83_AFTER_LONE_DASH:', JSON.stringify(loneDash))
  assert.equal(loneDash.integrity.some((entry) => entry.ok === false), false, `RS-83 lone dash already failed: ${JSON.stringify(loneDash)}`)
  assert.equal(loneDash.toasts.some((text) => warningPattern.test(text)), false, `RS-83 lone dash warned: ${JSON.stringify(loneDash.toasts)}`)

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)
  await physicalKey(app, { key: '-', code: 'Minus', keyCode: 189, text: '-', hold: 45, after: 45 })
  await physicalKey(app, { key: '-', code: 'Minus', keyCode: 189, text: '-', hold: 45, after: 300 })
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'escaped-standalone-thematic-break-input-rule')`),
    'RS-83 thematic-break callback did not hit the dedicated owner'
  )
  await sleep(700)

  const converted = await snapshot(app)
  console.log('RS83_AFTER_THEMATIC_BREAK:', JSON.stringify(converted))
  assert.equal(converted.hrCount >= 1, true, `RS-83 rich editor has no thematic break: ${JSON.stringify(converted)}`)
  assert.equal(converted.separateOrderedLists, true, `RS-83 ordered lists were merged: ${JSON.stringify(converted.listTexts)}`)
  assert.equal(converted.integrity.some((entry) => entry.ok === false), false, `RS-83 produced first-divergence integrity failure: ${JSON.stringify(converted.integrity)}`)
  assert.equal(converted.toasts.some((text) => warningPattern.test(text)), false, `RS-83 showed warning: ${JSON.stringify(converted.toasts)}`)
  assert.equal(
    converted.preserve.some((entry) => entry.reason === 'escaped-standalone-thematic-break-input-rule' && entry.preserved === true),
    true,
    `RS-83 dedicated owner did not publish: ${JSON.stringify(converted.preserve)}`
  )
  assert.equal(
    converted.integrity.some((entry) =>
      entry.preservationReason === 'escaped-standalone-thematic-break-input-rule' &&
      entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true),
    true,
    `RS-83 candidate did not pass strict semantic/list proof: ${JSON.stringify(converted.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-83 source')
  const source = await waitFor(() => visibleSource(app), 'RS-83 source textarea missing')
  assert.match(source, /3\. 3fresh\n\n---\n\n1\. 是干嘛的了；吗/, 'RS-83 source did not preserve the independent typed thematic break')
  assert.doesNotMatch(source, /3\. 3fresh(?:\*{3,}|-{3,}|_{3,})/, 'RS-83 glued the thematic break to the preceding item')
  assert.doesNotMatch(source, /(?:^|\n)\\-(?:\n|$)/, 'RS-83 left the escaped first-dash frame in source')
  assert.ok(source.includes('- authored marker\n- 1\\. literal'), 'RS-83 changed untouched authored marker spelling')
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客'),
    'RS-83 changed the untouched diverged nested-list tail'
  )

  assert.equal(await toggleSource(app), true, 'could not return RS-83 to rich mode')
  await save(app)
  const disk = await readFile(file, 'utf8')
  assert.equal(disk, source, 'RS-83 saved bytes differ from inspected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await snapshot(app)
  assert.equal(reopened.hrCount >= 1, true, `RS-83 cold reopen lost thematic break: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.separateOrderedLists, true, `RS-83 cold reopen merged ordered lists: ${JSON.stringify(reopened.listTexts)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect RS-83 reopened source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-83 reopened source missing'), disk)
  assert.equal(await readFile(file, 'utf8'), disk, 'RS-83 cold reopen changed disk bytes')

  console.log('PASS RS-83 middle thematic break: escaped frame, owner, integrity, source, save, and cold reopen')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
