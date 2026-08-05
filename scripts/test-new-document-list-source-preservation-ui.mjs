import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-new-document-list-source-${process.pid}`
const file = join(root, 'new-document.md')
const port = Number(process.env.CDP_PORT || 9805)
const rapid = process.env.NEW_DOCUMENT_LIST_RAPID === '1'
const bodyFromTitleEnter = process.env.NEW_DOCUMENT_LIST_FROM_TITLE === '1'
const appendBulletAfterNestedList = process.env.NEW_DOCUMENT_LIST_WITH_BULLET === '1'
const immediateSourceSwitch = process.env.NEW_DOCUMENT_LIST_IMMEDIATE === '1'
const asciiBulletText = process.env.NEW_DOCUMENT_LIST_ASCII_BULLET === '1' ? 'bullet-item' : '无序项'
const deleteAndRecreateList = process.env.NEW_DOCUMENT_LIST_DELETE_RECREATE === '1'
const continueBulletList = process.env.NEW_DOCUMENT_LIST_BULLET_CONTINUATION === '1'
const inputDelay = rapid ? 35 : 100
const settleDelay = rapid ? 40 : 600
const listSettleDelay = rapid ? 40 : 500
const expected = [
  '# 测试文本',
  '',
  '这shi',
  '',
  '1. 第一项',
  '2. 第二项',
  '   1. 嵌套项',
  ...(appendBulletAfterNestedList && !deleteAndRecreateList
    ? [`- ${asciiBulletText}`, ...(continueBulletList ? ['- bullet-continued'] : [])]
    : []),
  ...(deleteAndRecreateList ? ['1. 重新有序项', '   1. 继续嵌套项'] : []),
  ''
].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function clickEditorBlock(evaluate, send, selector) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.min(18, rect.height / 2) }
  })()`)
  assert.ok(point, `editor block not found: ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function typeRawDelimiter(send, key, code, keyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    ...common,
    text: key,
    unmodifiedText: key
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(inputDelay)
}

const pressEnter = (send) => pressKey(send, { key: 'Enter', code: 'Enter', delayMs: inputDelay })
const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)
const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // An empty Markdown file takes the exact same synthetic H1 + body path as a
  // fresh scratch tab, while giving the background harness an isolated fixture.
  await writeFile(file, '')
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor?.querySelector('h1') && !!editor?.querySelector('p')
      })()`),
      'empty new document did not create its title and body blocks'
    )

    await clickEditorBlock(evaluate, send, 'h1')
    await typeTextLikeUser(send, '测试文本', { delayMs: inputDelay })
    await sleep(settleDelay)
    if (bodyFromTitleEnter) await pressEnter(send)
    else await clickEditorBlock(evaluate, send, 'p')
    await typeTextLikeUser(send, '这shi', { delayMs: inputDelay })
    await sleep(settleDelay)

    // Delimiters and special keys are raw events; text is committed one
    // character at a time. This catches the input-rule publication race that a
    // bulk insert or paste would hide.
    await pressEnter(send)
    await typeRawDelimiter(send, '1', 'Digit1', 49)
    await typeRawDelimiter(send, '.', 'Period', 190)
    await typeRawDelimiter(send, ' ', 'Space', 32)
    await typeTextLikeUser(send, '第一项', { delayMs: inputDelay })
    await sleep(listSettleDelay)
    await pressEnter(send)
    await typeTextLikeUser(send, '第二项', { delayMs: inputDelay })
    await sleep(listSettleDelay)
    await pressEnter(send)
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: inputDelay })
    await typeTextLikeUser(send, '嵌套项', { delayMs: inputDelay })
    if (appendBulletAfterNestedList) {
      // A real writer exits the nested item, then its parent list, before
      // entering a new unordered block below it. This was the user-reported
      // source-corruption trigger: the second input rule must not reuse the
      // stale ordered-list intent or merge the two list trees.
      await pressEnter(send)
      await pressEnter(send)
      await pressEnter(send)
      await typeRawDelimiter(send, '-', 'Minus', 189)
      await typeRawDelimiter(send, ' ', 'Space', 32)
      await typeTextLikeUser(send, asciiBulletText, { delayMs: inputDelay })
      if (continueBulletList && !deleteAndRecreateList) {
        // No new input rule fires here: this is the ordinary “press Enter and
        // keep writing the next bullet” path. It used to make the prior `-`
        // fall back to Crepe's `*` when the list gained one more row.
        await pressEnter(send)
        await typeTextLikeUser(send, 'bullet-continued', { delayMs: inputDelay })
      }
      if (deleteAndRecreateList) {
        // Continue editing the same fresh document like a real writer: remove
        // the unordered item, leave the list, then create and extend a new
        // ordered list. This is deliberately keyboard-only; source fidelity
        // must survive every intermediate empty-list transaction.
        for (const _character of [...asciiBulletText]) {
          await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: inputDelay })
        }
        // Enter on an empty list item is ProseMirror's native "leave list"
        // action. It is distinct from backspacing through a nested list tree
        // and gives this regression a deterministic top-level insertion point.
        await pressEnter(send)
        await typeRawDelimiter(send, '1', 'Digit1', 49)
        await typeRawDelimiter(send, '.', 'Period', 190)
        await typeRawDelimiter(send, ' ', 'Space', 32)
        await typeTextLikeUser(send, '重新有序项', { delayMs: inputDelay })
        await pressEnter(send)
        await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: inputDelay })
        await typeTextLikeUser(send, '继续嵌套项', { delayMs: inputDelay })
      }
    }
    // A real person can switch modes immediately after typing the first
    // unordered-list text. Do not wait for a deferred markdownUpdated event in
    // this branch: flushMarkdown must serialize the live ProseMirror document.
    if (!immediateSourceSwitch) await sleep(700)

    const listShape = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return [...editor?.querySelectorAll('ol > .milkdown-list-item-block') || []]
        .map((node) => node.querySelector(':scope > li > .children > [data-content-dom] > p')?.textContent)
    })()`)
    assert.deepEqual(
      listShape,
      deleteAndRecreateList
        ? ['第一项', '第二项', '嵌套项', '重新有序项', '继续嵌套项']
        : ['第一项', '第二项', '嵌套项'],
      'rich ordered-list hierarchy was not created'
    )
    if (appendBulletAfterNestedList) {
      const bulletShape = await evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return [...editor?.querySelectorAll('ul > .milkdown-list-item-block') || []]
          .map((node) => node.querySelector(':scope > li > .children > [data-content-dom] > p')?.textContent)
      })()`)
      assert.deepEqual(
        bulletShape,
        deleteAndRecreateList ? [] : [asciiBulletText, ...(continueBulletList ? ['bullet-continued'] : [])],
        'rich unordered list after nested ordered list was not created or deleted'
      )
    }

    assert.equal(await toggleSource(evaluate), true, 'could not switch the unsaved document to source mode')
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source textarea did not open'),
      expected,
      'new-document title/body/ordered-list source was merged or lost before save'
    )
    // A second no-edit mode chain proves that showing source does not repair
    // only the first snapshot while leaving a stale rich baseline behind.
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    assert.equal(await toggleSource(evaluate), true, 'could not reopen source mode')
    assert.equal(await waitFor(() => visibleSource(evaluate), 'source textarea did not reopen'), expected)

    // Save straight from source/rich mode and start a fresh process. The bug
    // used to become permanent only after this sequence, because a phantom
    // empty ordered row was written to disk.
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode before save')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'save wrote a different list structure than source mode showed')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-reopen'),
      port: port + 1,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'saved document did not reopen in rich mode'
    )
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect source after full reopen')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'source textarea did not open after full reopen'),
      expected,
      'full reopen changed the newly written ordered-then-bullet source'
    )

    console.log(`PASS new-document list source fidelity (${rapid ? 'continuous' : 'settled'}${bodyFromTitleEnter ? ', title-enter' : ''}${appendBulletAfterNestedList ? ', ordered-then-bullet' : ''}${deleteAndRecreateList ? ', delete-recreate-ordered' : ''}${immediateSourceSwitch ? ', immediate-switch' : ''}): H1, body, ordered list, nested list, source switch, save, and reopen`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    try { await rm(root, { recursive: true, force: true }) } catch { /* Chromium may release profile files shortly after shutdown */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
