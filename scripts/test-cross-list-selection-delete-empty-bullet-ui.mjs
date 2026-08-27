import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-rs84-cross-list-selection-delete-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 12220 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

// Keep the same local shape and global source/canonical divergence as PID
// 90936. The selected range starts at the body of `看了呢分` and ends at the
// body of `u高科技`, crossing bullet -> ordered -> bullet top-level blocks.
const fixture = [
  '# RS84 跨列表选区删除',
  '',
  '- 可就是被科技部',
  '- 老板老板娘',
  '  - s 入了你看你了',
  '',
  '吗；啊嗯',
  '',
  '- 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '- u高科技',
  '- 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '   1. 微风',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1. 吗。不开机；口红',
  '',
  '2. 斯卡洛尼快乐',
  '3. 是干嘛的了；吗',
  '4. \u200B 热度三个代表',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  '',
  '后文',
  ''
].join('\n')

const selectedSource = '- 看了呢分\n\n2. 斛律v哦\n\n- u高科技\n'
const firstExpected = fixture.replace(selectedSource, '- \n')
const secondExpected = fixture.replace(selectedSource, '')

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const physicalBackspace = async (app, after = 180) => {
  const common = {
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await sleep(45)
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
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
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent &&
        (node.textContent || '').includes('1. 色粉色分') &&
        (node.textContent || '').includes('二哥你来拿如果')))`),
    'RS-84 fixture did not mount'
  )
  await sleep(450)
  return app
}

const selectCrossListBodies = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return { ok: false, reason: 'no-editor' }
  const directParagraph = (text) => [...editor.querySelectorAll('p')].find((paragraph) =>
    (paragraph.textContent || '').trim() === text &&
    ![...paragraph.querySelectorAll('p')].length
  )
  const startParagraph = directParagraph('看了呢分')
  const endParagraph = directParagraph('u高科技')
  if (!startParagraph || !endParagraph) {
    return {
      ok: false,
      reason: 'target-paragraphs',
      paragraphs: [...editor.querySelectorAll('p')].map((node) => node.textContent || '').slice(0, 30)
    }
  }
  const textNodes = (node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    return nodes
  }
  const startNode = textNodes(startParagraph)[0]
  const endNodes = textNodes(endParagraph)
  const endNode = endNodes.at(-1)
  if (!startNode || !endNode) return { ok: false, reason: 'text-nodes' }

  editor.focus()
  const selection = getSelection()
  selection.removeAllRanges()
  if (typeof selection.setBaseAndExtent === 'function') {
    // Match the real trace's backward selection: anchor at the right edge,
    // head at the left edge.
    selection.setBaseAndExtent(endNode, endNode.nodeValue.length, startNode, 0)
  } else {
    const range = document.createRange()
    range.setStart(startNode, 0)
    range.setEnd(endNode, endNode.nodeValue.length)
    selection.addRange(range)
  }
  document.dispatchEvent(new Event('selectionchange'))
  return {
    ok: true,
    text: selection.toString(),
    anchorText: selection.anchorNode?.parentElement?.textContent || '',
    focusText: selection.focusNode?.parentElement?.textContent || ''
  }
})()`)

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
})()`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const directText = (item) => {
    const paragraph = item?.querySelector(':scope > .children > .content-dom > p') || item?.querySelector('p')
    return (paragraph?.textContent || '').replace(/\\u200B/g, '').trim()
  }
  const literalItem = [...(editor?.querySelectorAll('li') || [])]
    .find((item) => directText(item) === '1. 色粉色分') || null
  const literalList = literalItem?.closest('ul') || null
  const literalItems = literalList
    ? [...literalList.querySelectorAll(':scope > .milkdown-list-item-block > li')]
    : []
  const literalIndex = literalItems.indexOf(literalItem)
  const previousItem = literalIndex > 0 ? literalItems[literalIndex - 1] : null
  return {
    selectedTextsGone: !['看了呢分', '斛律v哦', 'u高科技']
      .some((text) => (editor?.textContent || '').includes(text)),
    emptyBulletBeforeLiteral: !!previousItem && !directText(previousItem),
    literalSurvives: !!literalItem,
    topLevelEmptyParagraphs: [...(editor?.children || [])]
      .filter((node) => node.tagName === 'P' && !(node.textContent || '').replace(/\\u200B/g, '').trim())
      .length,
    preserve: (window.__hmPreserveLog || []).slice(-24)
      .map(({ source, previous, next, markdown, ...entry }) => ({
        ...entry,
        markdownHead: String(markdown || '').slice(0, 700)
      })),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-24)
      .map(({ parsed, expected, ...entry }) => ({
        ...entry,
        candidateHead: String(entry.candidate || '').slice(0, 700),
        canonicalHead: String(entry.canonical || '').slice(0, 700)
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
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'RS-84 save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'RS-84 save did not complete')
}

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)
  await clearDiagnostics(app)

  const selected = await selectCrossListBodies(app)
  assert.equal(selected.ok, true, `could not create RS-84 cross-list selection: ${JSON.stringify(selected)}`)
  assert.equal(selected.text.includes('看了呢分'), true, `selection missed first item: ${JSON.stringify(selected)}`)
  assert.equal(selected.text.includes('斛律v哦'), true, `selection missed ordered item: ${JSON.stringify(selected)}`)
  assert.equal(selected.text.includes('u高科技'), true, `selection missed final bullet: ${JSON.stringify(selected)}`)

  await physicalBackspace(app, 260)
  await sleep(800)
  const first = await snapshot(app)
  console.log('RS84_FIRST_BACKSPACE:', JSON.stringify(first))
  assert.equal(first.selectedTextsGone, true, `first Backspace did not delete the selected bodies: ${JSON.stringify(first)}`)
  assert.equal(first.emptyBulletBeforeLiteral, true, `first Backspace did not leave one empty bullet before the surviving literal item: ${JSON.stringify(first)}`)
  assert.equal(first.integrity.some((entry) => entry.ok === false), false, `first Backspace produced integrity failure: ${JSON.stringify(first.integrity)}`)
  assert.equal(first.toasts.some((text) => warningPattern.test(text)), false, `first Backspace showed warning: ${JSON.stringify(first.toasts)}`)
  assert.equal(
    first.preserve.some((entry) =>
      entry.reason === 'diverged-cross-list-selection-delete-to-empty-bullet' && entry.preserved === true),
    true,
    `first Backspace was not owned by the dedicated cross-list selection proof: ${JSON.stringify(first.preserve)}`
  )
  assert.equal(
    first.integrity.some((entry) =>
      entry.preservationReason === 'diverged-cross-list-selection-delete-to-empty-bullet' &&
      entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true),
    true,
    `first Backspace candidate was not strictly source-equivalent: ${JSON.stringify(first.integrity)}`
  )
  assert.equal(
    first.integrity.some((entry) => String(entry.candidate || '').startsWith(firstExpected)),
    true,
    `first Backspace source candidate was not the exact empty-bullet replacement: ${JSON.stringify(first.integrity)}`
  )

  await clearDiagnostics(app)
  await physicalBackspace(app, 220)
  await sleep(800)
  const second = await snapshot(app)
  console.log('RS84_SECOND_BACKSPACE:', JSON.stringify(second))
  assert.equal(second.selectedTextsGone, true, 'second Backspace resurrected selected text')
  assert.equal(second.emptyBulletBeforeLiteral, false, `second Backspace did not remove the transient empty bullet: ${JSON.stringify(second)}`)
  assert.equal(second.topLevelEmptyParagraphs >= 1, true, `second Backspace did not lift to a top-level empty paragraph: ${JSON.stringify(second)}`)
  assert.equal(second.integrity.some((entry) => entry.ok === false), false, `second Backspace produced integrity failure: ${JSON.stringify(second.integrity)}`)
  assert.equal(second.toasts.some((text) => warningPattern.test(text)), false, `second Backspace showed warning: ${JSON.stringify(second.toasts)}`)
  assert.equal(
    second.preserve.some((entry) => entry.reason === 'empty-list-item-removed' && entry.preserved === true),
    true,
    `second Backspace did not reuse empty-list-item-removed: ${JSON.stringify(second.preserve)}`
  )
  assert.equal(
    second.integrity.some((entry) =>
      entry.preservationReason === 'empty-list-item-removed' &&
      entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true),
    true,
    `second Backspace candidate was not strictly source-equivalent: ${JSON.stringify(second.integrity)}`
  )

  assert.equal(await toggleSource(app), true, 'could not inspect RS-84 source')
  const source = await waitFor(() => visibleSource(app), 'RS-84 source textarea missing')
  assert.equal(source, secondExpected, 'RS-84 source after two Backspaces differs from exact expected bytes')
  assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'RS-84 leaked Crepe placeholder into source')
  assert.ok(source.includes('- 1\\. 色粉色分'), 'surviving literal bullet changed')
  assert.ok(source.includes('```\n尼玛，吗了解\n了几百块\n```'), 'unrelated fence changed')
  assert.ok(
    source.includes('-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客'),
    'unrelated diverged nested-list spelling changed'
  )

  assert.equal(await toggleSource(app), true, 'could not return RS-84 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), secondExpected, 'RS-84 saved bytes differ from inspected source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await openApp('reopen', port + 1)
  const reopened = await snapshot(app)
  assert.equal(reopened.selectedTextsGone, true, 'RS-84 cold reopen resurrected deleted selection')
  assert.equal(reopened.emptyBulletBeforeLiteral, false, 'RS-84 cold reopen restored transient empty bullet')
  assert.equal(reopened.literalSurvives, true, 'RS-84 cold reopen lost surviving literal bullet')
  assert.equal(await toggleSource(app), true, 'could not inspect RS-84 reopened source')
  assert.equal(await waitFor(() => visibleSource(app), 'RS-84 reopened source missing'), secondExpected)
  assert.equal(await readFile(file, 'utf8'), secondExpected, 'RS-84 cold reopen changed disk bytes')

  console.log('PASS RS-84 cross-list selection delete: both Backspaces, integrity, source, save, and cold reopen stable')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
