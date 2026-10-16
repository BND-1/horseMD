import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-diverged-list-structure-${process.pid}`
const port = Number(process.env.CDP_PORT || 10010)

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const placeCaret = (evaluate, needle, offset = 0) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent && node.textContent.includes(${JSON.stringify(needle)}))
  if (!editor) return false
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const at = node.nodeValue.indexOf(${JSON.stringify(needle)})
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at + ${offset})
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

async function openApp(profile, appPort, file) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
    'editor did not open'
  )
  await sleep(1100)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

async function sourceAfter(app) {
  assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`),
    'source textarea did not appear'
  )
  return visibleSource(app.evaluate)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })

  const file = join(root, 'doc.md')
  const authored = [
    '# 检查',
    '',
    '## 目录',
    '',
    '- 1. 管理层（总经理）',
    '- 2. 综合行政部',
    '- 3. 人力资源部',
    '',
    '## 使用说明',
    '',
    '- 适用标准：**ISO 9001:2015**。'
  ].join('\n') + '\n'
  await writeFile(file, authored)

  let app
  try {
    app = await openApp('remove-inner-marker', port, file)

    // `- 2. 综合行政部` is parsed as an empty outer bullet item containing an
    // ordered-list item. Backspace at the start of its text removes the inner
    // ordered-list marker in the rich editor. The authored source must drop
    // only the literal `2. ` while retaining the outer `- ` marker.
    assert.equal(await placeCaret(app.evaluate, '综合行政部'), true, 'could not place caret at item start')
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
    await sleep(900)

    const rawAfterMarkerDelete = await sourceAfter(app)
    assert.equal(
      rawAfterMarkerDelete,
      authored.replace('- 2. 综合行政部', '- 综合行政部'),
      `removing the nested ordered marker must update only its authored row (got ${JSON.stringify(rawAfterMarkerDelete)})`
    )

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleep(500)
    await save(app)
    assert.equal(
      await readFile(file, 'utf8'),
      authored.replace('- 2. 综合行政部', '- 综合行政部'),
      'the removed marker must persist on disk'
    )

    // Continue editing the same list after the structural change. Enter at the
    // end of 综合行政部 creates a sibling bullet item, and slow committed input
    // must survive source switching and saving too.
    assert.equal(await placeCaret(app.evaluate, '综合行政部', '综合行政部'.length), true, 'could not place caret at item end')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
    await sleep(350)
    await typeTextLikeUser(app.send, '新增部门')
    await sleep(1000)

    const rawAfterAdd = await sourceAfter(app)
    assert.ok(rawAfterAdd.includes('- 综合行政部\n- 新增部门'), `the new sibling row must survive (got ${JSON.stringify(rawAfterAdd)})`)
    assert.ok(rawAfterAdd.includes('## 目录'), 'the heading before the list must remain byte-for-byte intact')

    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich mode after insertion')
    await sleep(500)

    // The earlier numbered rows keep the whole document in a diverged state.
    // Editing a later, ordinary list item that contains inline Markdown must
    // still update only that row and preserve its `**...**` spelling.
    assert.equal(await placeCaret(app.evaluate, '适用标准', '适用标准'.length), true, 'could not place caret in formatted list row')
    await typeTextLikeUser(app.send, 'X')
    await sleep(900)
    const rawAfterFormattedEdit = await sourceAfter(app)
    assert.ok(
      rawAfterFormattedEdit.includes('- 适用标准X：**ISO 9001:2015**。'),
      `formatted list-row edits must survive without normalizing inline Markdown (got ${JSON.stringify(rawAfterFormattedEdit)})`
    )
    assert.ok(rawAfterFormattedEdit.includes('- 综合行政部\n- 新增部门'), 'earlier structural edits must survive later list edits')

    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich mode after formatted edit')
    await sleep(500)
    await save(app)
    const savedAfterAdd = await readFile(file, 'utf8')
    assert.ok(savedAfterAdd.includes('- 综合行政部\n- 新增部门'), 'the new sibling row must persist on disk')
    assert.ok(savedAfterAdd.includes('- 适用标准X：**ISO 9001:2015**。'), 'the formatted list-row edit must persist on disk')

    await stopBuiltElectron(app, { removeProfile: true })
    app = null

    // Three consecutive Backspaces model the actual ProseMirror lift sequence
    // without an intervening source-mode reparse: remove `2.`, merge the lifted
    // paragraph into the outer list item, then remove the remaining `-`.
    // The paragraph text must survive while both authored markers disappear.
    const liftFile = join(root, 'lift.md')
    await writeFile(liftFile, authored)
    app = await openApp('lift-both-markers', port + 1, liftFile)
    assert.equal(await placeCaret(app.evaluate, '综合行政部'), true, 'could not place caret for two-level lift')
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
    await sleep(700)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
    await sleep(700)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
    await sleep(1000)

    const rawAfterLift = await sourceAfter(app)
    assert.equal(
      rawAfterLift,
      authored.replace('- 2. 综合行政部', '  综合行政部'),
      `removing both list levels must preserve the paragraph text (got ${JSON.stringify(rawAfterLift)})`
    )
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to rich mode after lift')
    await sleep(500)
    await save(app)
    assert.equal(
      await readFile(liftFile, 'utf8'),
      authored.replace('- 2. 综合行政部', '  综合行政部'),
      'the two-level marker removal must persist on disk'
    )

    console.log('PASS diverged list structure sync: marker deletion, full lift, and subsequent insertion survive source mode and save')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
