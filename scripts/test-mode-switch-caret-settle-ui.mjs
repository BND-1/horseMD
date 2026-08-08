import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-caret-settle-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const sourceCaret = (evaluate) => evaluate(`(() => {
  const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
  return ta ? [ta.selectionStart, ta.selectionEnd] : null
})()`)

const richCaretInsideFileEditor = (evaluate) => evaluate(`(() => {
  const sel = getSelection()
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null
  const node = range?.startContainer
  if (!node) return null
  // The app may also hold the welcome tab; only the editor that contains the
  // selection is the one we toggled into.
  const editors = [...document.querySelectorAll('.ProseMirror')]
  const index = editors.findIndex((editor) => editor.contains(node))
  if (index < 0) return null
  const text = node.nodeType === 3 ? node.nodeValue : ''
  return { index, text, off: range.startOffset }
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
    'editor did not open'
  )
  await sleepMs(800)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // Authored source diverges from the canonical (`-` markers, mid-line `* `).
  const authored = '# 测试\n\n价格是 * 优惠价\n\n- 项一\n- 项二\n\n结尾。\n'
  await writeFile(file, authored)
  let app
  try {
    app = await openApp('edit', port)

    // Place the rich caret inside 项一, then switch to source: the source
    // caret lands at the mapped position and the restore baseline is written.
    const editorIndex = await app.evaluate(`(() => {
      const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
      const index = editors.findIndex((editor) => editor.textContent.includes('结尾'))
      if (index < 0) return -1
      editors[index].focus()
      const walker = document.createTreeWalker(editors[index], NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const i = node.nodeValue.indexOf('项一')
        if (i >= 0) {
          const range = document.createRange()
          range.setStart(node, i + 1)
          range.collapse(true)
          const sel = getSelection()
          sel.removeAllRanges(); sel.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
          break
        }
      }
      return index
    })()`)
    assert.ok(editorIndex >= 0, 'test document editor not found')
    await sleepMs(300)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    await waitFor(() => sourceCaret(app.evaluate) !== null, 'source textarea did not appear')
    await sleepMs(400)

    // Move the source caret WITHOUT any synthetic/user event: this is the
    // path where React's __horsemdSourceSelectionUser flag is never set
    // (keyboard/IME edge). The scheduled settle retries used to overwrite the
    // caret back to the baseline ~700ms later; they must now yield instead.
    await app.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
      const pos = ta.value.indexOf('结尾')
      ta.setSelectionRange(pos + 2, pos + 2)
    })()`)
    await sleepMs(300)
    const moved = await sourceCaret(app.evaluate)
    assert.ok(moved && moved[0] > 25, `caret must move to the 结尾 line (got ${JSON.stringify(moved)})`)
    const lineAt = await app.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
      const md = ta.value
      const ls = md.lastIndexOf('\\n', ta.selectionStart - 1) + 1
      const le = md.indexOf('\\n', ta.selectionStart)
      return md.slice(ls, le < 0 ? md.length : le)
    })()`)
    assert.ok(lineAt.includes('结尾'), `caret must be on the 结尾 line (got ${JSON.stringify(lineAt)})`)

    // Wait well past the settle-retry window (retries stop at ~3s).
    await sleepMs(2600)
    assert.deepEqual(
      await sourceCaret(app.evaluate),
      moved,
      'the settle retries must not overwrite a caret that moved without the synthetic-event flag'
    )

    // Switch to rich: the caret must map to the same text position.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleepMs(700)
    const rich = await richCaretInsideFileEditor(app.evaluate)
    assert.ok(rich && rich.index >= 0, `rich caret must live inside an editor (got ${JSON.stringify(rich)})`)
    assert.ok(
      (rich.text || '').slice(0, rich.off).includes('结尾'),
      `rich caret must land after 结尾 (got ${JSON.stringify(rich)})`
    )

    // And back to source: the position survives the round trip.
    assert.equal(await toggleSource(app.evaluate), true, 'could not return to source mode')
    await waitFor(() => sourceCaret(app.evaluate) !== null, 'source textarea did not reappear')
    await sleepMs(400)
    assert.deepEqual(
      await sourceCaret(app.evaluate),
      moved,
      'the source caret must survive the rich round trip unchanged'
    )

    console.log('PASS mode-switch caret settle: caret moves without the user-flag survive the retry window and map correctly')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
