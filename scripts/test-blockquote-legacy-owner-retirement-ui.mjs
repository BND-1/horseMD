import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-blockquote-legacy-retirement-${process.pid}`
const file = join(root, 'syntax-sensitive.md')
const profile = join(root, 'profile')
const port = Number(process.env.CDP_PORT || 15420 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const originalText = 'quoted alpha'
const editedText = `${originalText}*`
const fixture = '\uFEFFbefore\r\n\r\n > quoted alpha\r\n\r\nafter\r\n'
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const openApp = async () => {
  const app = await launchBuiltElectron({
    profileDir: profile,
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        return [...(editor?.querySelectorAll('blockquote p') || [])]
          .some((node) => (node.textContent || '') === ${JSON.stringify(originalText)})
      })()`),
      'blockquote paragraph did not mount'
    )
    await sleep(500)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmBlockquoteTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const focusEndOfQuote = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const paragraph = [...(editor?.querySelectorAll('blockquote p') || [])]
      .find((node) => (node.textContent || '') === ${JSON.stringify(originalText)})
    if (!editor || !paragraph) return { ok: false, reason: 'quote-not-found' }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const target = nodes.at(-1)
    if (!target) return { ok: false, reason: 'text-not-found' }
    const range = document.createRange()
    range.setStart(target, target.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, offset: selection.anchorOffset }
  })()`)
  assert.equal(result.ok, true, `could not focus quote end: ${JSON.stringify(result)}`)
  await sleep(80)
}

const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return {
    quoteTexts: [...(editor?.querySelectorAll('blockquote p') || [])]
      .map((node) => node.textContent || ''),
    preserve: (window.__hmPreserveLog || []).slice(-80)
      .map(({ source, previous, next, markdown, ...entry }) => entry),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-80),
    owner: (window.__hmBlockquoteTransactionTrace || []).slice(-160),
    journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-160),
    flush: (window.__hmFlushTrace || []).slice(-80),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
    sourceVisible: Boolean(
      [...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)
    ),
    saveVisible: Boolean(document.querySelector('.hm-save-fab'))
  }
})()`)

let app = null
let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp()
  await clearDiagnostics(app)
  await focusEndOfQuote(app)
  await typeTextLikeUser(app.send, '*', { delayMs: 30 })
  await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    return [...(editor?.querySelectorAll('blockquote p') || [])]
      .some((node) => (node.textContent || '') === ${JSON.stringify(editedText)})
  })()`), 'syntax-sensitive star did not remain visible in the quote')
  await sleep(1400)

  const state = await snapshot(app)
  const blocked = state.owner.filter((entry) =>
    entry.phase === 'plan' &&
    entry.family === 'blockquote-paragraph-text-replace' &&
    entry.reason === 'syntax-sensitive-insert'
  )
  assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
  assert.equal(blocked.every((entry) =>
    entry.recognized === true && entry.legacyBlocked === true
  ), true, JSON.stringify(blocked))
  assert.deepEqual(state.quoteTexts, [editedText],
    `fail-closed edit disappeared from rich mode: ${JSON.stringify(state.quoteTexts)}`)
  assert.equal(state.preserve.some((entry) => [
    'blockquote-paragraph-text-change',
    'diverged-tail-block-append',
    'structural-line-change',
    'visible-mismatch-line-change'
  ].includes(entry.reason)), false,
  `recognized quote rejection reached legacy preservation: ${JSON.stringify(state.preserve)}`)
  assert.equal(state.coordinator.some((entry) =>
    entry.phase === 'published' &&
    (entry.family === 'blockquote-paragraph-text-replace' || entry.owner === 'legacy')
  ), false, `recognized quote rejection reached publication: ${JSON.stringify(state.coordinator)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), true,
    `fail-closed quote edit did not warn: ${JSON.stringify(state.toasts)}`)
  assert.equal(state.sourceVisible, false,
    'fail-closed callback exposed a stale source textarea')
  assert.equal(state.saveVisible, true,
    'visible rich edit did not remain marked as unsaved')
  assert.equal(await readFile(file, 'utf8'), fixture,
    'recognized quote rejection overwrote the authored file')

  completed = true
  console.log('PASS blockquote legacy retirement UI: a physical syntax-sensitive quote edit is recognized, blocks generic legacy fallback, remains visible in rich mode, warns, and leaves source/disk untouched')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
