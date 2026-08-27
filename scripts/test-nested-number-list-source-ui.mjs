import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-nested-number-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 120) {
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

const caretAfter = (evaluate, needle, offset = 0) => evaluate(`(() => {
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
      range.setStart(node, i + ${JSON.stringify(needle)}.length + ${offset})
      range.collapse(true)
      const sel = getSelection()
      sel.removeAllRanges(); sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
  }
  return false
})()`)

async function openApp(profile, appPort, content) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
    'editor did not open'
  )
  await sleepMs(900)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // `- 1. 甲乙` is parsed by remark as a NESTED ordered list (`1. 甲`, `2. 乙`),
  // so the canonical visible stream drops the `1. ` item text. Any list edit
  // used to fall back to the OLD source and the user's typing vanished.
  const authored = '- 1. 甲乙\n- 丙丁\n'
  await writeFile(file, authored)
  let app
  try {
    app = await openApp('edit', port)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    // Split the first item mid-text with Enter, then type.
    assert.equal(await caretAfter(app.evaluate, '甲', 0), true, 'could not place the caret after 甲')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    await typeTextLikeUser(app.send, '新')
    await sleepMs(900)

    // The typed text must reach source with the authored spelling intact.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    await sleepMs(900)
    const sourceSwitchDiagnostics = await app.evaluate(`(() => ({
      sourceVisible: !![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent),
      preserve: (window.__hmPreserveLog || []).slice(-12).map(({ source, previous, next, markdown, ...entry }) => ({
        ...entry,
        source: String(source || '').slice(0, 220),
        previous: String(previous || '').slice(0, 220),
        next: String(next || '').slice(0, 220),
        markdown: String(markdown || '').slice(0, 220)
      })),
      integrity: (window.__hmSourceIntegrityTrace || []).slice(-12).map(({ candidate, canonical, ...entry }) => ({
        ...entry,
        candidate: String(candidate || '').slice(0, 260),
        canonical: String(canonical || '').slice(0, 260)
      })),
      integrityDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-12),
      toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
    }))()`)
    console.log('NESTED_NUMBER_SOURCE_SWITCH:', JSON.stringify(sourceSwitchDiagnostics))
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`), 'source textarea did not appear')
    const raw = await visibleSource(app.evaluate)
    assert.ok(
      raw.includes('新'),
      `the typed text must survive the mode switch (got ${JSON.stringify(raw)})`
    )
    assert.ok(
      raw.startsWith('- 1. 甲\n  2. 新乙'),
      `the Entered split must remain a nested ordered sibling under the same outer bullet (got ${JSON.stringify(raw)})`
    )

    // Back to rich, save, reopen: the edit must be durable.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleepMs(600)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    assert.equal(saved, '- 1. 甲\n  2. 新乙\n- 丙丁\n', 'the typed text and nested ordered structure must persist on disk')

    console.log('PASS nested-number list source sync: edits inside `- 1. …` rows survive switch, save, and reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
