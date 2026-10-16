// Reproduce the reported flow on the quote-heavy manual-test file: type an
// ordered list, then a table, then unordered lists, then Ctrl+S / save button
// and a source toggle. Any "save paused" toast or blocked source switch is a
// failure.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
assert.ok(sourceFile, 'FILE is required')
const marker = `序列验证${process.pid}`
const root = `/tmp/horsemd-real-seq-${process.pid}`
const file = join(root, basename(sourceFile))
const port = Number(process.env.CDP_PORT || 9860)
const delay = Number(process.env.KEY_DELAY || 60)

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function focusEnd(evaluate, send) {
  const done = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const selection = getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.ok(done, 'could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
}

async function typeDelimiter(send, key, code, keyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: ['+', '*', ')'].includes(key) ? 8 : 0
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

const delimiter = (character) => ({
  '-': { key: '-', code: 'Minus', keyCode: 189 },
  '+': { key: '+', code: 'Equal', keyCode: 187 },
  '*': { key: '*', code: 'Digit8', keyCode: 56 },
  '.': { key: '.', code: 'Period', keyCode: 190 },
  '|': { key: '|', code: 'Backslash', keyCode: 220 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 }
})[character]

const enter = (send) => pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })

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

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(700)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(sourceFile, file)
  const original = await readFile(file, 'utf8')
  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmTailDebug = []
    })()`)
    await focusEnd(evaluate, send)

    // 1. Ordered list via input rule.
    await typeDelimiter(send, '1', 'Digit1', 49)
    await typeDelimiter(send, '.', '.', 190)
    await typeDelimiter(send, ' ', ' ', 32)
    await typeTextLikeUser(send, `${marker}有序一`, { delayMs: delay })
    await enter(send)
    await typeTextLikeUser(send, '有序二', { delayMs: delay })
    await sleep(500)

    // 2. Table via Markdown input rule.
    await enter(send)
    await typeTextLikeUser(send, '| 表头A | 表头B |', { delayMs: delay })
    await enter(send)
    await typeTextLikeUser(send, '| --- | --- |', { delayMs: delay })
    await enter(send)
    await typeTextLikeUser(send, '| 甲 | 乙 |', { delayMs: delay })
    await sleep(700)

    // 3. Unordered lists.
    await enter(send)
    await typeDelimiter(send, '-', '-', 189)
    await typeDelimiter(send, ' ', ' ', 32)
    await typeTextLikeUser(send, '无序一', { delayMs: delay })
    await enter(send)
    await typeDelimiter(send, '-', '-', 189)
    await typeDelimiter(send, ' ', ' ', 32)
    await typeTextLikeUser(send, '无序二', { delayMs: delay })
    await sleep(600)

    const richText = await evaluate(`([...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)?.textContent || '')`)
    assert.ok(richText.includes(marker), `rich editor lost the typed sequence: ${JSON.stringify(richText.slice(-150))}`)
    assert.ok(richText.includes('表头A') && richText.includes('甲'), 'table content missing in rich editor')

    // 4. Save button — must complete, not pause.
    const saveViaShortcut = process.env.SAVE_VIA_SHORTCUT === '1'
    if (saveViaShortcut) {
      await pressKey(send, { key: 's', code: 'KeyS', modifiers: 4, delayMs: 60 })
    } else {
      await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing (edit not dirty?)')
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    }
    const saved = await waitFor(
      () => evaluate(`!document.querySelector('.hm-save-fab')`),
      'save did not finish (paused toast?)',
      60
    ).catch(async () => {
      const evidence = await evaluate(`(() => ({
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent),
        preserve: (window.__hmPreserveLog || []).map((entry) => ({
          reason: entry.reason,
          preserved: entry.preserved,
          sourceTail: entry.source?.slice(-120),
          previousTail: entry.previous?.slice(-120),
          nextTail: entry.next?.slice(-120),
          markdownTail: entry.markdown?.slice(-120)
        }))
      }))()`)
      console.error('save paused; evidence:', JSON.stringify(evidence, null, 2))
      return false
    })
    assert.ok(saved, 'save button did not finish')
    const toastsAfterSave = await evaluate(`[...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent)`)
    assert.ok(
      !toastsAfterSave.some((text) => /保存已暂停|无法安全映射|原文件未被覆盖/.test(text || '')),
      `save completed but a paused/warning toast appeared: ${JSON.stringify(toastsAfterSave)}`
    )
    const diskAfterSave = await readFile(file, 'utf8')
    assert.ok(diskAfterSave.includes(marker), 'disk lost the typed sequence after save')
    if (/\n- \d+\. \\\|/.test(diskAfterSave)) {
      const polluted = await evaluate(`(window.__hmPreserveLog || []).map((entry) => ({
        reason: entry.reason,
        preserved: entry.preserved,
        markdownTail: entry.markdown?.slice(-160)
      })).filter((entry) => /- \d+\. \\\\\|/.test(entry.markdownTail || ''))`)
      console.error('polluted entries:', JSON.stringify(polluted, null, 2))
      const tailDebug = await evaluate(`window.__hmTailDebug || []`)
      console.error('tail debug:', JSON.stringify(tailDebug.slice(-12), null, 2))
    }
    assert.ok(
      /^\s*\d+[.)] \\\| 表头A \| 表头B \|/m.test(diskAfterSave),
      `table rows must stay ordered-list rows in source: ${JSON.stringify(diskAfterSave.slice(-220))}`
    )
    assert.doesNotMatch(
      diskAfterSave,
      /\n- \d+\. \\\|/,
      'intermediate mapping must not prefix fresh canonical list rows with `- `'
    )

    // 5. Source toggle must open.
    assert.equal(await toggleSource(evaluate), true, 'source toggle failed after save')
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea missing', 60).catch(() => null)
    assert.ok(source !== null, 'source mode stayed blocked')
    assert.ok(source.includes(marker), 'source view lost the typed sequence')

    // 6. Full reopen.
    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'reopen source toggle failed')
    const reopened = await waitFor(() => visibleSource(app.evaluate), 'reopen source missing')
    assert.ok(reopened.includes(marker), 'reopen lost the typed sequence')
    console.log(`PASS real-file sequence (ordered list + table + unordered list): save, source, reopen for ${basename(sourceFile)}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
