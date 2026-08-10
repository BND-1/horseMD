// Family root-cause matrix: every reported symptom class x real user files x
// operation types, in one run. Each cell asserts:
//   - append reaches source, save completes without a pause toast
//   - delete reaches source (no resurrection), no pause toast
//   - no `&#x20;`, no standalone `<br />` line, no row glued onto the previous
//     line, reopen keeps everything
// Failures are grouped by symptom class so the shared root cause is visible.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const files = (process.env.FAMILY_FILES || '').split(',').filter(Boolean)
assert.ok(files.length, 'FAMILY_FILES required (comma separated)')
const operations = (process.env.FAMILY_OPS || 'ordered,unordered,plain,spaces,list-spaces').split(',').filter(Boolean)
const root = `/tmp/horsemd-family-matrix-${process.pid}`
const portBase = Number(process.env.CDP_PORT || 9900)
const delay = Number(process.env.KEY_DELAY || 50)

const failures = []

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
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
  if (!done) throw new Error('could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 30 })
  await sleep(150)
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

const toasts = (evaluate) => evaluate(`[...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent)`)

async function openApp(profile, appPort, file) {
  const app = await launchBuiltElectron({ profileDir: join(root, profile), port: appPort, appArgs: [file] })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(600)
  return app
}

async function saveAndWait(app) {
  const visible = await app.evaluate(`!!document.querySelector('.hm-save-fab')`)
  if (!visible) return { saved: true, toasts: [] }
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const finished = await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    'save did not finish',
    60
  ).catch(() => false)
  return { saved: Boolean(finished), toasts: await toasts(app.evaluate) }
}

async function runCell(file, op, marker) {
  const copy = join(root, `cell-${op}-${process.pid}.md`)
  await copyFile(file, copy)
  const port = portBase + (files.indexOf(file) * 10 + operations.indexOf(op))
  let app
  try {
    app = await openApp(`p-${op}`, port, copy)
    const { evaluate, send } = app
    await evaluate(`(() => { window.__hmPreserveLog = [] })()`)

    // Append. A real user starts a new line before typing a list marker:
    // Markdown list input rules fire only at line start, so typing `- ` right
    // after a paragraph's last character legitimately glues as plain text
    // (canonical and source agree). Start every cell from a fresh line to
    // exercise the actual list/paragraph-append mapping.
    await focusEnd(evaluate, send)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await sleep(delay)
    if (op === 'ordered') {
      for (const ch of ['1', '.', ' ']) await send('Input.insertText', { text: ch })
      await sleep(delay)
      await typeTextLikeUser(send, marker, { delayMs: delay })
    } else if (op === 'unordered') {
      for (const ch of ['-', ' ']) await send('Input.insertText', { text: ch })
      await sleep(delay)
      await typeTextLikeUser(send, marker, { delayMs: delay })
    } else if (op === 'spaces') {
      for (let i = 0; i < 4; i += 1) await send('Input.insertText', { text: ' ' })
      await sleep(delay)
      await typeTextLikeUser(send, marker, { delayMs: delay })
    } else if (op === 'list-spaces') {
      for (const ch of ['-', ' ']) await send('Input.insertText', { text: ch })
      await sleep(delay)
      for (let i = 0; i < 4; i += 1) await send('Input.insertText', { text: ' ' })
      await sleep(delay)
      await typeTextLikeUser(send, marker, { delayMs: delay })
    } else {
      await typeTextLikeUser(send, marker, { delayMs: delay })
    }
    await sleep(500)

    const appendToasts = await toasts(evaluate)
    if (appendToasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖/.test(t || ''))) {
      failures.push({ file, op, symptom: 'append-pause-toast', detail: appendToasts })
      return
    }

    // Source check after append.
    assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
    const afterAppend = await waitFor(() => visibleSource(evaluate), 'source missing').catch(() => null)
    if (!afterAppend) {
      failures.push({ file, op, symptom: 'source-locked-after-append' })
      return
    }
    if (!afterAppend.includes(marker)) {
      failures.push({ file, op, symptom: 'append-missing-in-source', detail: afterAppend.slice(-120) })
    } else {
      // The appended content must be an independent authored row, never glued
      // onto the previous line's tail (for example `负责1. 家族验证`).
      const markerLine = afterAppend.split('\n').find((line) => line.includes(marker)) || ''
      const beforeMarker = markerLine.slice(0, markerLine.indexOf(marker))
      const beforeContent = beforeMarker
        .replace(/[\u200B]/g, '')
        .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s*(?:[-+*]|\d{1,9}[.)])\s*/, '')
        .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s*/, '')
      if (/[^\s>|]/.test(beforeContent)) {
        failures.push({ file, op, symptom: 'append-glued-to-previous-line', detail: markerLine.slice(-80) })
      }
    }
    if (afterAppend.includes('&#x20;')) {
      failures.push({ file, op, symptom: 'entity-leak', detail: afterAppend.slice(-120) })
    }
    if (/^\s*<br\s*\/?>\s*$/m.test(afterAppend)) {
      failures.push({ file, op, symptom: 'br-leak', detail: afterAppend.slice(-120) })
    }
    assert.equal(await toggleSource(evaluate), true, 'back to rich failed')

    // Save + reopen.
    const saveResult = await saveAndWait(app)
    if (!saveResult.saved) {
      failures.push({ file, op, symptom: 'save-paused', detail: saveResult.toasts })
    }
    const disk = await readFile(copy, 'utf8')
    if (!disk.includes(marker)) {
      failures.push({ file, op, symptom: 'append-lost-on-save', detail: disk.slice(-120) })
    }

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp(`r-${op}`, port + 50, copy)
    const { evaluate: e2, send: s2 } = app
    await e2(`(() => { window.__hmPreserveLog = [] })()`)
    await focusEnd(e2, s2)
    await pressKey(s2, { key: 'End', code: 'End', delayMs: 30 })
    for (let i = 0; i < marker.length + 3; i += 1) {
      await pressKey(s2, { key: 'Backspace', code: 'Backspace', delayMs: delay })
    }
    await sleep(500)
    assert.equal(await toggleSource(e2), true, 'reopen source toggle failed')
    const afterDelete = await waitFor(() => visibleSource(e2), 'reopen source missing').catch(() => null)
    if (!afterDelete) {
      const log = await e2(`(window.__hmPreserveLog || []).slice(-4).map((entry) => ({
        reason: entry.reason,
        preserved: entry.preserved,
        previousTail: entry.previous?.slice(-90),
        nextTail: entry.next?.slice(-90)
      }))`)
      const pause = await toasts(e2)
      failures.push({ file, op, symptom: 'source-locked-after-delete', detail: { log, pause } })
      return
    }
    if (afterDelete.includes(marker)) {
      const log = await e2(`(window.__hmPreserveLog || []).slice(-4).map((entry) => ({
        reason: entry.reason,
        preserved: entry.preserved,
        previousTail: entry.previous?.slice(-90),
        nextTail: entry.next?.slice(-90)
      }))`)
      failures.push({ file, op, symptom: 'delete-resurrected', detail: { log, source: afterDelete.slice(-120) } })
    }
    const deleteToasts = await toasts(e2)
    if (deleteToasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖/.test(t || ''))) {
      failures.push({ file, op, symptom: 'delete-pause-toast', detail: deleteToasts })
    }
    console.log(`PASS ${op} on ${file.split('/').at(-1)}`)
  } catch (error) {
    failures.push({ file, op, symptom: 'cell-error', detail: error?.message })
  } finally {
    try {
      await stopBuiltElectron(app, { removeProfile: true })
    } catch {
      // best-effort cleanup
    }
    try {
      await rm(copy, { force: true })
    } catch {
      // Profile cleanup is best-effort; a still-exiting Electron process can
      // hold the directory briefly.
    }
  }
}

async function main() {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  await mkdir(root, { recursive: true })
  const marker = `家族验证${process.pid}`
  for (const file of files) {
    for (const op of operations) {
      await runCell(file, op, marker)
    }
  }
  if (failures.length) {
    const bySymptom = {}
    for (const failure of failures) {
      bySymptom[failure.symptom] = bySymptom[failure.symptom] || []
      bySymptom[failure.symptom].push(`${failure.op}@${failure.file.split('/').at(-1)}`)
    }
    console.error('FAMILY FAILURES by symptom:')
    for (const failure of failures) {
      console.error(`  ${failure.symptom}: ${failure.op}@${failure.file.split('/').at(-1)}`)
      if (failure.detail) {
        console.error('    detail:', JSON.stringify(failure.detail).slice(0, 1500))
      }
    }
    process.exit(1)
  }
  console.log('PASS family matrix: all files x operations x append/save/delete/reopen')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
