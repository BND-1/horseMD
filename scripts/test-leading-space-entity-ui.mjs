import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-leading-space-${process.pid}`
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

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const focusEditorContaining = (evaluate, needle) => evaluate(`(() => {
  const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
  const index = editors.findIndex((editor) => editor.textContent.includes(${JSON.stringify(needle)}))
  if (index < 0) return false
  editors[index].focus()
  return true
})()`)

// Place the caret right after `needle` inside the first editor that contains it.
const caretAfter = (evaluate, needle) => evaluate(`(() => {
  const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
  const editor = editors.find((ed) => ed.textContent.includes(${JSON.stringify(needle)}))
  if (!editor) return false
  editor.focus()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const i = node.nodeValue.indexOf(${JSON.stringify(needle)})
    if (i >= 0) {
      const range = document.createRange()
      range.setStart(node, i + ${JSON.stringify(needle)}.length)
      range.collapse(true)
      const sel = getSelection()
      sel.removeAllRanges(); sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
  }
  return false
})()`)

const caretDocEnd = (evaluate) => evaluate(`(() => {
  const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
  const editor = editors.find((ed) => ed.textContent.includes(${JSON.stringify('第一段')}))
  if (!editor) return false
  editor.focus()
  const sel = getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  sel.removeAllRanges(); sel.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

const typeSpaces = async (send, count, delayMs = 80) => {
  for (let i = 0; i < count; i += 1) {
    await send('Input.insertText', { text: ' ' })
    await sleepMs(delayMs)
  }
}

async function openApp(profile, appPort) {
  const installedExecutable = process.env.HORSEMD_EXECUTABLE || ''
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: installedExecutable || undefined,
    entrypoint: installedExecutable ? null : undefined
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
  await writeFile(file, '第一段正文。\n')
  let app
  try {
    app = await openApp('edit', port)

    // Scenario A: EXISTING document, new paragraph, leading spaces then text.
    assert.equal(await caretDocEnd(app.evaluate), true, 'could not focus the document end')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(300)
    await typeSpaces(app.send, 6)
    await typeTextLikeUser(app.send, '顶格文字')
    await sleepMs(700)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode (A)')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'source textarea did not appear (A)')
    const sourceA = await visibleSource(app.evaluate)
    assert.ok(
      !sourceA.includes('&#x20;'),
      `leading spaces must not leak as the &#x20; entity (got ${JSON.stringify(sourceA)})`
    )
    assert.equal(
      sourceA,
      '第一段正文。\n\n\u200B      顶格文字\n',
      'the authored source must keep the six literal leading spaces'
    )

    // Back to rich, then a fresh empty document: spaces typed BEFORE any text
    // go into the generated-scratch path and must also stay literal.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode (A)')
    await sleepMs(500)
    await app.evaluate(`(() => {
      const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
      const editor = editors.find((ed) => ed.textContent.includes('第一段'))
      if (!editor) return
      editor.focus()
      const sel = getSelection()
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      sel.removeAllRanges(); sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })()`)
    await sleepMs(200)
    // Select all and delete to empty the document.
    await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent && n.textContent.includes('第一段'))
      editor?.focus()
    })()`)
    await app.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
    })
    await app.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
    })
    await sleepMs(200)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(500)
    await typeSpaces(app.send, 8)
    await typeTextLikeUser(app.send, 'hello')
    await sleepMs(700)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode (B)')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'source textarea did not appear (B)')
    const sourceB = await visibleSource(app.evaluate)
    assert.ok(
      !sourceB.includes('&#x20;'),
      `the scratch-document path must also spell leading spaces literally (got ${JSON.stringify(sourceB)})`
    )

    // Scenario C: a typed `~` must not surface as the `\~` escape (GFM
    // strikethrough guard) in the authored source.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode (C)')
    await sleepMs(500)
    await app.evaluate(`(() => {
      const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
      const editor = editors.find((ed) => ed.textContent.includes('hello'))
      if (!editor) return
      editor.focus()
      const sel = getSelection()
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      sel.removeAllRanges(); sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })()`)
    await sleepMs(200)
    await app.send('Input.insertText', { text: '~' })
    await typeTextLikeUser(app.send, '波浪线')
    await sleepMs(700)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode (C)')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'source textarea did not appear (C)')
    const sourceC = await visibleSource(app.evaluate)
    assert.ok(
      sourceC.includes('~波浪线') && !sourceC.includes('\\~'),
      `a typed tilde must stay literal in source (got ${JSON.stringify(sourceC)})`
    )

    // Scenario D: a genuinely empty file opened in a fresh renderer exercises
    // the generated-scratch baseline. Scenario B empties an existing editor,
    // whose source-preservation lifecycle is intentionally different.
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    await writeFile(file, '')
    app = await openApp('true-scratch', port + 1)
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      editor?.focus()
      return !!editor
    })()`), true, 'could not focus the genuinely empty scratch editor')
    await typeSpaces(app.send, 8)
    await typeTextLikeUser(app.send, 'scratch')
    await sleepMs(700)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode (D)')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'source textarea did not appear (D)')
    const sourceD = await visibleSource(app.evaluate)
    assert.equal(sourceD, '# \u200B        scratch\n', 'true scratch typing must keep eight literal spaces after an invisible Markdown-safe sentinel')
    assert.ok(!sourceD.includes('&#x20;'), 'true scratch typing must never expose a serializer entity')
    assert.equal(
      await app.evaluate(`(() => {
        const save = document.querySelector('.hm-save-fab')
        save?.click()
        return !!save
      })()`),
      true,
      'save control was unavailable for the true scratch document'
    )
    await waitFor(async () => (await readFile(file, 'utf8')) === '# \u200B        scratch\n', 'true scratch document was not saved')
    assert.equal(
      await readFile(file, 'utf8'),
      '# \u200B        scratch\n',
      'saving a true scratch document must persist literal spaces, not an entity'
    )

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await openApp('true-scratch-reopen', port + 2)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch reopened scratch to source mode (D)')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'reopened source textarea did not appear (D)')
    assert.equal(
      await visibleSource(app.evaluate),
      '# \u200B        scratch\n',
      'a full reopen must retain the literal-space spelling byte-for-byte'
    )

    // Scenario E: exact real-user sequence. Two Enters leave an empty rich
    // paragraph before the next paragraph; a held Space key then publishes a
    // series of whitespace-only canonical snapshots. Each snapshot is delayed
    // long enough to force incremental markdownUpdated callbacks instead of a
    // single coalesced final callback.
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    await writeFile(file, '# test\n\nanchor\n')
    app = await openApp('held-space-sequence', port + 3)
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
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
    })()`), true, 'could not focus the held-space fixture end')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 90 })
    await sleepMs(300)
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 90 })
    await sleepMs(300)
    await typeSpaces(app.send, 8, 300)
    await typeTextLikeUser(app.send, 'abc', { delayMs: 120 })
    await sleepMs(800)
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch held-space fixture to source')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'held-space source textarea did not appear')
    const sourceE = await visibleSource(app.evaluate)
    assert.equal(
      sourceE,
      '# test\n\nanchor\n\n\u200B        abc\n',
      `held spaces must not merge into the previous paragraph or leave trailing garbage (got ${JSON.stringify(sourceE)})`
    )
    assert.ok(!sourceE.includes('&#x20;'), 'held spaces must not expose a serializer entity')
    assert.equal(
      await app.evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.selectionStart ?? -1)`),
      sourceE.length - 1,
      'the held-space source switch must keep the caret after the final typed character'
    )
    assert.equal(await toggleSource(app.evaluate), true, 'could not return held-space fixture to rich mode')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'held-space rich editor did not return')
    assert.equal(await toggleSource(app.evaluate), true, 'second held-space source switch was blocked')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'second held-space source textarea did not appear')
    assert.equal(await visibleSource(app.evaluate), sourceE, 'a rich/source round trip changed the held-space source')
    assert.equal(
      await app.evaluate(`([...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.selectionStart ?? -1)`),
      sourceE.length - 1,
      'the invisible sentinel must not move the caret during a rich/source round trip'
    )
    assert.equal(await app.evaluate(`(() => {
      const save = document.querySelector('.hm-save-fab')
      save?.click()
      return !!save
    })()`), true, 'held-space save control was unavailable')
    await waitFor(async () => (await readFile(file, 'utf8')) === sourceE, 'held-space source was not saved byte-for-byte')
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await openApp('held-space-reopen', port + 4)
    assert.equal(await toggleSource(app.evaluate), true, 'reopened held-space file could not enter source mode')
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'reopened held-space source textarea did not appear')
    assert.equal(await visibleSource(app.evaluate), sourceE, 'a full reopen changed the held-space source')

    console.log('PASS canonical escapes: normal, scratch, and held-space sequences preserve Markdown-safe leading spaces without entities or mode-switch corruption')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
