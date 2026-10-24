// Issue #158: when another program changes an open document, HorseMD used to
// remount the editor, so the reader landed back at the top. Now a rich editor
// takes the new Markdown in place (same editor, same scroll, caret kept) and
// a textarea (source mode) is remounted with its scroll and caret restored.
// The reloaded text must be the new save baseline: an edit after the reload
// saves as disk + edit, with no source-sync mismatch.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-external-reload-${process.pid}`
const file = join(root, 'reload.md')
const port = Number(process.env.CDP_PORT || 9640 + (process.pid % 50))
const lines = Array.from({ length: 160 }, (_, i) => `Line ${i + 1} ${'text '.repeat(12).trim()}`)
const original = `# Reload\n\n${lines.join('\n\n')}\n`
let app = null

const waitFor = async (check, message, attempts = 100) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const click = async (point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
const dirty = () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)
// Mutates disk the way an external editor would; waits past mtime granularity.
const rewrite = async (transform) => {
  await sleep(1100)
  const next = transform(await readFile(file, 'utf8'))
  await writeFile(file, next, 'utf8')
  return next
}
const mismatchShown = () => app.evaluate(`[...document.querySelectorAll('.toast, .hm-toast, [role="alert"], [role="status"]')].some((n) => /不一致|mismatch/i.test(n.textContent))`)

try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, original, 'utf8')
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
  await app.send('Runtime.enable')
  await app.evaluate(`window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)) }`)
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((n) => n.offsetParent && n.textContent.includes('Line 160'))`),
    'fixture did not open in the rich editor'
  )

  // 1. Rich: scroll into the middle, put the caret in "Line 90".
  await app.evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    window.__hmPm = pm
    const p = [...pm.querySelectorAll('p')].find((n) => n.textContent.startsWith('Line 90 '))
    const scroller = pm.closest('.editor-scroll')
    scroller.scrollTop += p.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 200
  })()`)
  await sleep(300)
  const point = await app.evaluate(`(() => {
    const p = [...window.__hmPm.querySelectorAll('p')].find((n) => n.textContent.startsWith('Line 90 '))
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }
  })()`)
  await click(point)
  await sleep(300)
  const before = await app.evaluate(`window.__hmPm.closest('.editor-scroll').scrollTop`)
  assert.ok(before > 1000, `expected to be scrolled into the document, got ${before}`)

  // External change above (same height) and below the viewport.
  const changed = await rewrite((text) => text
    .replace('Line 3 text', 'Line 3 CHANGED')
    .replace('Line 150 text', 'Line 150 CHANGED'))
  await waitFor(
    () => app.evaluate(`window.__hmPm.textContent.includes('Line 150 CHANGED')`),
    'external change was not loaded'
  )
  await sleep(400)
  const after = await app.evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    const sel = window.getSelection()
    const p = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('p')
    return {
      samePm: pm === window.__hmPm,
      scrollTop: pm.closest('.editor-scroll').scrollTop,
      caretIn: p ? p.textContent.slice(0, 8) : null
    }
  })()`)
  console.log('rich', { before, ...after })
  assert.equal(after.samePm, true, 'the rich editor must not be remounted')
  assert.ok(Math.abs(after.scrollTop - before) <= 2, `scroll moved: ${before} → ${after.scrollTop}`)
  assert.equal(after.caretIn, 'Line 90 ', 'caret stays in the same paragraph')
  assert.equal(await dirty(), false, 'a reload is not an edit')

  // Undo steps back over the reload (the old text, now unsaved); redo
  // returns to the disk text. Neither may trip the source-sync check.
  const mod = process.platform === 'darwin' ? 4 : 2
  await pressKey(app.send, { key: 'z', code: 'KeyZ', modifiers: mod })
  await waitFor(() => app.evaluate(`window.__hmPm.textContent.includes('Line 150 text') && !window.__hmPm.textContent.includes('CHANGED')`), 'undo did not restore the old text')
  await waitFor(dirty, 'undo of the reload must leave the tab unsaved')
  await pressKey(app.send, { key: 'z', code: 'KeyZ', modifiers: mod | 8 })
  await waitFor(() => app.evaluate(`window.__hmPm.textContent.includes('Line 150 CHANGED')`), 'redo did not bring the disk text back')
  await waitFor(async () => !(await dirty()), 'after redo the tab matches the disk again')
  assert.equal(await mismatchShown(), false, 'no mismatch after undo/redo')
  await click(point)
  await sleep(200)

  // An edit after the reload saves on top of the new disk text.
  await typeTextLikeUser(app.send, 'Q')
  await waitFor(dirty, 'edit did not mark the tab dirty')
  await app.evaluate(`document.querySelector('.hm-save-fab').click()`)
  await waitFor(async () => !(await dirty()), 'save did not finish')
  const saved = await readFile(file, 'utf8')
  const expected = changed.replace('Line 90 text', 'Line 90 Qtext')
  assert.ok(saved === expected || saved === changed.replace(/Line 90 (text[^\n]*)/, (m, rest) => `Line 90 ${rest.slice(0, 3)}Q${rest.slice(3)}`) || saved.includes('Q'), 'saved text contains the edit')
  assert.ok(saved.includes('Line 3 CHANGED') && saved.includes('Line 150 CHANGED'), 'external change kept on save')
  assert.equal(saved.replace('Q', ''), changed, 'save = external text + the one typed character')
  assert.equal(await mismatchShown(), false, 'no source-sync mismatch notice')

  // 2. Source mode (textarea, remounted): scroll and caret come back.
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
  })()`)
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent))`), 'source mode did not open')
  await sleep(400)
  const sourceBefore = await app.evaluate(`(() => {
    const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
    const at = ta.value.indexOf('Line 100 ')
    ta.focus()
    ta.setSelectionRange(at + 5, at + 5)
    ta.scrollTop = 2500
    return { scrollTop: ta.scrollTop, caret: ta.selectionStart, at }
  })()`)
  await sleep(300)
  const changed2 = await rewrite((text) => text.replace('Line 2 text', 'Line 2 LONGER TEXT HERE'))
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].some((n) => n.offsetParent && n.value.includes('LONGER TEXT HERE'))`),
    'external change was not loaded in source mode'
  )
  await sleep(400)
  const sourceAfter = await app.evaluate(`(() => {
    const ta = [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)
    return { scrollTop: ta.scrollTop, caret: ta.selectionStart, at: ta.value.indexOf('Line 100 ') }
  })()`)
  console.log('source', { sourceBefore, sourceAfter })
  assert.ok(Math.abs(sourceAfter.scrollTop - sourceBefore.scrollTop) <= 2, 'source scroll kept')
  assert.equal(sourceAfter.caret - sourceAfter.at, sourceBefore.caret - sourceBefore.at, 'source caret mapped through the change')
  assert.equal(await dirty(), false)
  assert.equal(await readFile(file, 'utf8'), changed2)
  assert.deepEqual(await app.evaluate('window.__alerts'), [])
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log('PASS external reload position: rich editor updates in place, source mode keeps scroll and caret')
