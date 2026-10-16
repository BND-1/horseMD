import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE || null
const root = `/tmp/horsemd-family-multicycle-${process.pid}`
const file = join(root, 'multicycle.md')
const port = Number(process.env.CDP_PORT || 10170)
const delay = Number(process.env.KEY_DELAY || 55)
const transactionPrimary = process.env.TRANSACTION_PRIMARY === '1'
const originalTail = '# 测试a f\n\n-\n\n1. 啊发我发\n2. 气氛 分\n'
const generatedFixture = '\uFEFF# 多轮源码保真回归\r\n\r\n' +
  '测试\r\n\r\n' +
  '- 1. 重复测试\r\n' +
  '- - 重复测试\r\n\r\n' +
  '## 重复文本锚点\r\n\r\n' +
  '测试\r\n\r\n测试\r\n\r\n' +
  originalTail
const roundOneTail = '# 测试a f\n\n-\n\n1. 啊发我发\n2. 气氛 分轮一追加ABC\n'
const roundTwoTail = [
  '# 测试a f',
  '',
  '-',
  '',
  '1. 啊发我发（修订）',
  '2. 气氛 分轮一追加',
  '3. 轮二续完成',
  '',
  '- 轮二无序',
  '',
  '```',
  'round_two();',
  '```',
  ''
].join('\n')
const roundThreeTail = [
  '# 测试a f',
  '',
  '-',
  '',
  '1. 啊发我发（修订）',
  '2. 气氛 分轮一追加',
  '3. 轮二续完成',
  '',
  '- 轮二无序继续',
  '- 轮三同级',
  '',
  '轮三正文',
  '',
  '```',
  'round_two();',
  '```',
  ''
].join('\n')
const roundFourTail = [
  '# 测试a f',
  '',
  '-',
  '',
  '1. 啊发我发（修订）',
  '2. 气氛 分轮一追加',
  '3. 轮二续完成',
  '',
  '- 轮二无序继续',
  '- 轮三同级',
  '',
  '轮三正文',
  '',
  '轮四正文',
  '',
  '1. 轮四有序',
  '2. 轮四续项',
  '',
  '轮四尾文',
  '',
  '```',
  'round_two();',
  '```',
  ''
].join('\n')

const normalizeForTextarea = (value) => value.replace(/\r\n?|\u2028|\u2029/g, '\n')
const occurrences = (text, needle) => text.split(needle).length - 1

async function waitFor(check, message, attempts = 160) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const pauseToasts = (evaluate) => evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text))
`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    `editor did not mount for ${profile}`
  )
  await sleep(700)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceTransactionLog = []
    window.__hmSourceTransactionTrace = []
    window.__hmListIntentTrace = []
    window.__hmTransactionSourcePrimary = ${transactionPrimary}
  })()`)
  return app
}

async function placeCaretAfter(app, needle) {
  const placed = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue !== ${JSON.stringify(needle)}) continue
      const range = document.createRange()
      range.setStart(node, node.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  })()`)
  assert.equal(placed, true, `could not place caret after ${needle}`)
  await sleep(120)
}

async function typeRawKey(app, key, code, keyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const typeBacktick = (app) => typeRawKey(app, '`', 'Backquote', 192)
const typeHyphen = (app) => typeRawKey(app, '-', 'Minus', 189)
const typePeriod = (app) => typeRawKey(app, '.', 'Period', 190)
const typeSpace = (app) => typeRawKey(app, ' ', 'Space', 32)

async function inspectSource(app, expected, checkpoint) {
  assert.equal(await toggleSource(app.evaluate), true, `${checkpoint}: source toggle failed`)
  const source = await waitFor(() => visibleSource(app.evaluate), `${checkpoint}: source textarea missing`)
    .catch(async (error) => {
      console.error(`${checkpoint} diagnostics`, JSON.stringify(await app.evaluate(`({
        preserve: (window.__hmPreserveLog || []).slice(-12).map((entry) => ({
          reason: entry.reason,
          preserved: entry.preserved,
          sourceTail: entry.source?.slice(-180),
          previousTail: entry.previous?.slice(-180),
          nextTail: entry.next?.slice(-180),
          markdownTail: entry.markdown?.slice(-180)
        })),
        transaction: (window.__hmSourceTransactionLog || []).slice(-12).map(({ ok, reason }) => ({ ok, reason })),
        transactionTrace: (window.__hmSourceTransactionTrace || []).slice(-12).map((entry) => ({
          phase: entry.phase,
          steps: entry.steps?.map((step) => step.type || step.stepType || step.constructor)
        })),
        listIntent: (window.__hmListIntentTrace || []).slice(-12).map(({ canonical, source, markdown, ...entry }) => ({
          ...entry,
          sourceTail: source?.slice(-120),
          canonicalTail: canonical?.slice(-120),
          markdownTail: markdown?.slice(-120)
        })),
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
      })`), null, 2))
      throw error
    })
  if (source !== normalizeForTextarea(expected)) {
    console.error(`${checkpoint} source mismatch`, JSON.stringify({
      actualTail: source.slice(-500),
      expectedTail: normalizeForTextarea(expected).slice(-500),
      evidence: await app.evaluate(`({
        preserve: (window.__hmPreserveLog || []).slice(-12).map((entry) => ({
          reason: entry.reason,
          preserved: entry.preserved,
          sourceTail: entry.source?.slice(-180),
          previousTail: entry.previous?.slice(-180),
          nextTail: entry.next?.slice(-180),
          markdownTail: entry.markdown?.slice(-180)
        })),
        transaction: (window.__hmSourceTransactionLog || []).slice(-12).map(({ ok, reason }) => ({ ok, reason })),
        transactionTrace: (window.__hmSourceTransactionTrace || []).slice(-12).map((entry) => ({
          phase: entry.phase,
          steps: entry.steps?.map((step) => step.type || step.stepType || step.constructor)
        })),
        listIntent: (window.__hmListIntentTrace || []).slice(-12).map(({ canonical, source, markdown, ...entry }) => ({
          ...entry,
          sourceTail: source?.slice(-120),
          canonicalTail: canonical?.slice(-120),
          markdownTail: markdown?.slice(-120)
        })),
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
      })`)
    }, null, 2))
  }
  if (source !== normalizeForTextarea(expected)) {
    throw new Error(`${checkpoint}: source differs from authored expectation`)
  }
  assert.deepEqual(await pauseToasts(app.evaluate), [], `${checkpoint}: source sync paused`)
  assert.doesNotMatch(source, /&#x20;/, `${checkpoint}: space entity leaked`)
  assert.doesNotMatch(source, /^\s*<br\s*\/?>(?:\n|$)/m, `${checkpoint}: empty paragraph placeholder leaked`)
  return source
}

async function toggleRoundTrip(app, expected, checkpoint) {
  assert.equal(await toggleSource(app.evaluate), true, `${checkpoint}: return to rich failed`)
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    `${checkpoint}: rich editor missing`
  )
  assert.equal(await toggleSource(app.evaluate), true, `${checkpoint}: second source toggle failed`)
  assert.equal(
    await waitFor(() => visibleSource(app.evaluate), `${checkpoint}: second source textarea missing`),
    normalizeForTextarea(expected),
    `${checkpoint}: a no-edit mode round trip changed source`
  )
  assert.equal(await toggleSource(app.evaluate), true, `${checkpoint}: final return to rich failed`)
  await sleep(350)
}

async function saveAndAssert(app, expected, checkpoint) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), `${checkpoint}: save button missing`)
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), `${checkpoint}: save did not finish`)
  assert.deepEqual(await pauseToasts(app.evaluate), [], `${checkpoint}: save paused`)
  await waitFor(
    async () => await readFile(file, 'utf8') === expected,
    `${checkpoint}: disk did not reach expected bytes`
  )
  assert.equal(await readFile(file, 'utf8'), expected, `${checkpoint}: disk bytes differ`)
}

async function assertRichShape(app, round) {
  const shape = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const directItems = (list) => [...(list?.children || [])]
      .filter((node) => node.matches('.milkdown-list-item-block'))
      .map((node) => node.querySelector(':scope > li > .children > [data-content-dom] > p')?.textContent || '')
    const ordered = [...(editor?.querySelectorAll('ol') || [])]
      .map((list) => directItems(list))
      .find((items) => items.some((text) => text.startsWith('啊发我发'))) || []
    const bullets = [...(editor?.querySelectorAll('ul') || [])]
      .map((list) => ({ list, items: directItems(list) }))
      .filter(({ items }) => items.some((text) => text.startsWith('轮二无序')))
    const code = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
      .filter((node) => node.textContent.includes('round_two();'))
    return {
      ordered,
      bulletCount: bullets.length,
      bulletNested: bullets.some(({ list }) => !!list.closest('li')),
      bulletItems: bullets.at(-1)?.items || [],
      codeCount: code.length,
      text: editor?.innerText || ''
    }
  })()`)
  if (round === 1) {
    assert.deepEqual(shape.ordered.slice(-2), ['啊发我发', '气氛 分轮一追加ABC'], 'round 1 rich ordered list differs')
    return
  }
  if (
    JSON.stringify(shape.ordered.slice(-3)) !== JSON.stringify(['啊发我发（修订）', '气氛 分轮一追加', '轮二续完成']) ||
    shape.bulletCount !== 1 ||
    shape.bulletNested ||
    shape.codeCount !== 1
  ) {
    console.error('round 2 rich shape mismatch', JSON.stringify(shape, null, 2))
  }
  assert.deepEqual(
    shape.ordered.slice(-3),
    ['啊发我发（修订）', '气氛 分轮一追加', '轮二续完成'],
    'round 2 rich ordered list differs'
  )
  assert.equal(shape.bulletCount, 1, 'round 2 bullet list missing or duplicated')
  assert.equal(shape.bulletNested, false, 'round 2 bullet list was nested unexpectedly')
  assert.equal(shape.codeCount, 1, 'round 2 code block missing or duplicated')
  if (round === 3) {
    assert.deepEqual(
      shape.bulletItems,
      ['轮二无序继续', '轮三同级'],
      'round 3 rich bullet list differs'
    )
    assert.equal(shape.text.includes('轮二无序继续'), true, 'round 3 first bullet edit missing')
    assert.equal(shape.text.includes('轮三同级'), true, 'round 3 continued bullet missing')
    assert.equal(shape.text.includes('轮三正文'), true, 'round 3 trailing prose missing')
  }
  if (round === 4) {
    assert.equal(shape.text.includes('轮四正文'), true, 'round 4 leading prose missing')
    assert.equal(shape.text.includes('轮四有序'), true, 'round 4 ordered item missing')
    assert.equal(shape.text.includes('轮四续项'), true, 'round 4 continued ordered item missing')
    assert.equal(shape.text.includes('轮四尾文'), true, 'round 4 trailing prose missing')
  }
  assert.equal(shape.text.includes('ABC'), false, 'deleted text ABC survived in rich view')
  assert.equal(shape.text.includes('轮二续写'), false, 'replaced text survived in rich view')
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  if (sourceFile) await copyFile(sourceFile, file)
  else await writeFile(file, generatedFixture, 'utf8')
  const original = await readFile(file, 'utf8')
  assert.equal(occurrences(original, originalTail), 1, '123321.md tail fixture is not unique')
  const originalPrefix = original.slice(0, original.lastIndexOf(originalTail))
  const originalCrLfCount = occurrences(original, '\r\n')
  const roundOne = originalPrefix + roundOneTail
  const roundTwo = originalPrefix + roundTwoTail
  const roundThree = originalPrefix + roundThreeTail
  const roundFour = originalPrefix + roundFourTail

  let app
  try {
    // Round 1: edit a persisted list item, inspect source twice, save, and cold reopen.
    app = await openApp('round-one', port)
    await placeCaretAfter(app, '气氛 分')
    await typeTextLikeUser(app.send, '轮一追加ABC', { delayMs: delay })
    await sleep(500)
    await assertRichShape(app, 1)
    await inspectSource(app, roundOne, 'round 1')
    await toggleRoundTrip(app, roundOne, 'round 1')
    await saveAndAssert(app, roundOne, 'round 1')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('round-two', port + 1)
    await assertRichShape(app, 1)
    assert.equal(await readFile(file, 'utf8'), roundOne, 'round 1 cold reopen changed disk')

    // Round 2: continue the persisted list, revise an earlier item, delete
    // persisted text, then create a sibling bullet list and a fenced block.
    await placeCaretAfter(app, '气氛 分轮一追加ABC')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '轮二续写', { delayMs: delay })
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: delay })
    await typeTextLikeUser(app.send, '完成', { delayMs: delay })

    await placeCaretAfter(app, '啊发我发')
    await typeTextLikeUser(app.send, '（修订）', { delayMs: delay })

    await placeCaretAfter(app, '气氛 分轮一追加ABC')
    for (let index = 0; index < 3; index += 1) {
      await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: delay })
    }

    await placeCaretAfter(app, '轮二续完成')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeHyphen(app)
    await typeSpace(app)
    await typeTextLikeUser(app.send, '轮二无序', { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    for (let index = 0; index < 3; index += 1) await typeBacktick(app)
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, 'round_two();', { delayMs: delay })
    await sleep(700)

    await assertRichShape(app, 2)
    await inspectSource(app, roundTwo, 'round 2')
    await toggleRoundTrip(app, roundTwo, 'round 2')
    await saveAndAssert(app, roundTwo, 'round 2')

    assert.equal(occurrences(await readFile(file, 'utf8'), '\r\n'), originalCrLfCount, 'mixed-EOL prefix was normalized')
    assert.equal((await readFile(file, 'utf8')).startsWith(originalPrefix), true, 'untouched prefix bytes changed')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('round-three', port + 2)
    await assertRichShape(app, 2)
    assert.equal(await readFile(file, 'utf8'), roundTwo, 'round 2 cold reopen changed disk')
    await inspectSource(app, roundTwo, 'round 2 cold reopen')
    assert.equal(await readFile(file, 'utf8'), roundTwo, 'no-edit source inspection changed disk')

    // Round 3: keep editing after the second cold reopen. This is the gap in
    // the former family matrix: it proved one save and one deletion, but not a
    // second persisted lineage where an existing list is continued again.
    assert.equal(await toggleSource(app.evaluate), true, 'round 3 return to rich failed')
    await placeCaretAfter(app, '轮二无序')
    await typeTextLikeUser(app.send, '继续', { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '轮三同级', { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '轮三正文', { delayMs: delay })
    await sleep(600)
    await assertRichShape(app, 3)
    await inspectSource(app, roundThree, 'round 3')
    await saveAndAssert(app, roundThree, 'round 3')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('round-four', port + 3)
    await assertRichShape(app, 3)
    assert.equal(await readFile(file, 'utf8'), roundThree, 'round 3 cold reopen changed disk')
    await inspectSource(app, roundThree, 'round 3 cold reopen')

    // Round 4: after another cold reopen, keep writing across prose → ordered
    // list → prose boundaries. This reproduces the user's report that the
    // first reopen can look correct while later ordinary editing diverges.
    assert.equal(await toggleSource(app.evaluate), true, 'round 4 return to rich failed')
    await placeCaretAfter(app, '轮三正文')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '轮四正文', { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '1', { delayMs: delay })
    await typePeriod(app)
    await typeSpace(app)
    await typeTextLikeUser(app.send, '轮四有序', { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '轮四续项', { delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeTextLikeUser(app.send, '轮四尾文', { delayMs: delay })
    await sleep(600)
    await assertRichShape(app, 4)
    await inspectSource(app, roundFour, 'round 4')
    await saveAndAssert(app, roundFour, 'round 4')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('round-five', port + 4)
    await assertRichShape(app, 4)
    assert.equal(await readFile(file, 'utf8'), roundFour, 'round 4 cold reopen changed disk')
    await inspectSource(app, roundFour, 'round 4 cold reopen')

    console.log(`PASS family multicycle (${transactionPrimary ? 'transaction-primary' : 'release-default'}): repeated edit/source/save/reopen remains exact`)
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
