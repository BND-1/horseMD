import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-quote-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const richEditorExists = (evaluate) => evaluate(`(
  !![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
)`)

const hasVisibleBlockquote = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return !!editor?.querySelector('blockquote')
})()`)

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

const selectQuoteText = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const text = editor?.querySelector('blockquote p')?.firstChild
  if (!editor || !text || text.nodeType !== Node.TEXT_NODE) return false
  const range = document.createRange()
  range.selectNodeContents(text)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  editor.focus()
  document.dispatchEvent(new Event('selectionchange'))
  return selection.toString()
})()`)

async function openApp(profile, appPort, { expectQuote = true } = {}) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(() => richEditorExists(app.evaluate), 'rich editor did not open')
  if (expectQuote) {
    await waitFor(() => hasVisibleBlockquote(app.evaluate), 'blockquote did not render')
  }
  await sleep(600)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const authored = 'before\n\n> quote\n\nafter\n'
  const expected = 'before\n\nafter\n'
  await writeFile(file, authored)

  let app
  try {
    app = await openApp('edit', port)
    assert.equal(await selectQuoteText(app.evaluate), 'quote', 'could not select quote text')

    // First Backspace removes the visible quote text. The empty blockquote is
    // still a real rich node at this point.
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleep(500)
    assert.equal(
      await hasVisibleBlockquote(app.evaluate),
      true,
      'clearing quote text should leave an empty blockquote before the second Backspace'
    )

    // Second Backspace removes the empty quote structure itself.
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleep(700)
    assert.equal(
      await hasVisibleBlockquote(app.evaluate),
      false,
      'the second Backspace must remove the blockquote from rich mode'
    )

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    const source = await waitFor(
      () => visibleSource(app.evaluate),
      'source textarea did not appear'
    )
    assert.equal(
      source,
      expected,
      'source mode must remove the syntax-only `>` row with the deleted quote'
    )

    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleep(400)
    assert.equal(await hasVisibleBlockquote(app.evaluate), false, 'quote must not return after a mode round-trip')

    await waitFor(
      () => app.evaluate(`!!document.querySelector('.hm-save-fab')`),
      'save button did not appear'
    )
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
      'save did not complete'
    )
    assert.equal(await readFile(file, 'utf8'), expected, 'saved file must not retain the deleted quote marker')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1, { expectQuote: false })
    await sleep(500)
    assert.equal(await hasVisibleBlockquote(app.evaluate), false, 'saved quote must not resurrect after full reopen')
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect reopened source')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'reopened source did not appear'),
      expected,
      'reopened source must remain byte-identical without the quote marker'
    )

    console.log('PASS empty blockquote removal: rich deletion reaches source, save, and full reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
