// Real Electron regression for auto-save (#136): default off, enabled from
// Settings › Files, inactivity debounce in rich and source mode, and the
// external-change conflict guard (never overwrite a file changed on disk;
// an explicit save still may). Input is dispatched one character at a time.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-autosave-ui-${process.pid}`
const file = join(root, 'autosave.md')
const profile = join(root, 'profile')
const port = Number(process.env.CDP_PORT || 9760 + (process.pid % 60))
const original = '# Auto save\n\nFirst line\n'
let app = null

const disk = () => readFile(file, 'utf8')
const waitFor = async (check, message, attempts = 80) => {
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
// SaveFab renders only while the active tab is dirty (position:fixed, so
// offsetParent is always null — test presence, not offsetParent).
const dirty = () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)
const placeCaretAtParagraphEnd = async (text) => {
  const point = await app.evaluate(`((text) => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const p = [...(pm?.querySelectorAll('p') || [])].find((node) => node.textContent.startsWith(text))
    const rect = p?.getBoundingClientRect()
    return rect ? { x: Math.round(rect.left + 10), y: Math.round(rect.top + rect.height / 2) } : null
  })(${JSON.stringify(text)})`)
  assert.ok(point, `paragraph "${text}" not found`)
  await click(point)
  await sleep(150)
  await pressKey(app.send, { key: 'End' })
}
const toggleSource = () => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const clickByText = (selector, pattern) => app.evaluate(`(() => {
  const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((item) => item.offsetParent && ${pattern}.test(item.textContent.replace(/\\s+/g, ' ').trim()))
  node?.click()
  return Boolean(node)
})()`)

try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, original, 'utf8')
  app = await launchBuiltElectron({ profileDir: profile, port, appArgs: [file] })
  await app.send('Runtime.enable')
  // Watcher conflict notices use window.alert, which would block CDP.
  await app.evaluate(`window.__alerts = []; window.alert = (message) => { window.__alerts.push(String(message)) }`)
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent && node.textContent.includes('First line'))`),
    'fixture did not open in the rich editor'
  )

  // 1. Default is OFF: an edit stays dirty and the disk is untouched.
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' one')
  await sleep(4500)
  assert.equal(await disk(), original, 'auto-save must be off by default')
  assert.equal(await dirty(), true, 'edited tab must be dirty while auto-save is off')

  // 2. Enable 3 s from Settings › Files through the real UI.
  assert.ok(await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.offsetParent && /settings|设置/i.test(node.title || node.getAttribute('aria-label') || ''))
    button?.click()
    return Boolean(button)
  })()`), 'settings button not found')
  await sleep(300)
  assert.ok(await clickByText('.settings-nav-item', '/^(Files & images|文件与图片)$/'), 'files settings section not found')
  await sleep(200)
  assert.ok(await clickByText('.settings-segmented-option', '/^(3s|3 秒)$/'), 'auto-save 3s option not found')
  await sleep(200)
  assert.equal(await app.evaluate(`JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').autoSaveDelay`), 3)
  assert.ok(await clickByText('.tab', '/autosave\\.md/'), 'document tab not found')
  // Leaving the settings tab does not blur the window; the pending edit is
  // written once the 3 s inactivity timer fires.
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one\n', 'pending edit was not auto-saved after enabling', 60)
  await waitFor(async () => !(await dirty()), 'tab stayed dirty after auto-save')

  // 3. Debounce: continuous typing is not written mid-burst; idle writes it.
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' two', { delayMs: 400 })
  const midBurst = await disk()
  assert.equal(midBurst, '# Auto save\n\nFirst line one\n', 'auto-save fired before the inactivity delay elapsed')
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one two\n', 'rich edit was not auto-saved after idling', 60)
  await waitFor(async () => !(await dirty()), 'tab stayed dirty after the second auto-save')

  // 4. Source mode: textarea edits are auto-saved byte-exactly.
  assert.ok(await toggleSource(), 'source toggle not found')
  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`), 'source mode did not open')
  await app.evaluate(`(() => {
    const area = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  })()`)
  await typeTextLikeUser(app.send, 'Source tail')
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one two\nSource tail', 'source edit was not auto-saved', 80)
  assert.ok(await toggleSource(), 'rich toggle not found')
  await waitFor(() => app.evaluate(`![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`), 'rich mode did not return')
  await sleep(500)

  // 5. External change: auto-save must NOT overwrite the other app's version.
  // ("Source tail" is a soft-wrapped continuation of the same paragraph, so
  // End lands after it.)
  const external = '# Changed elsewhere\n\nExternal body\n'
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' three')
  await writeFile(file, external, 'utf8')
  await sleep(5000)
  assert.equal(await disk(), external, 'auto-save overwrote a file changed in another application')
  assert.equal(await dirty(), true, 'conflicted tab must stay dirty')
  const toast = await app.evaluate(`document.body.textContent`)
  assert.ok(/自动保存已暂停|Auto save paused/.test(toast), 'conflict notice was not shown')
  // Further typing stays paused (no retry overwrite).
  await typeTextLikeUser(app.send, '!')
  await sleep(4000)
  assert.equal(await disk(), external, 'auto-save retried and overwrote the external version')

  // 6. An explicit save is still allowed to overwrite, and auto-save resumes.
  assert.ok(await app.evaluate(`(() => { const fab = document.querySelector('.hm-save-fab'); fab?.click(); return Boolean(fab) })()`), 'save button not shown for conflicted tab')
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one two\nSource tail three!', 'explicit save did not write after conflict')
  await placeCaretAtParagraphEnd('First line')
  await typeTextLikeUser(app.send, ' four')
  await waitFor(async () => (await disk()) === '# Auto save\n\nFirst line one two\nSource tail three! four', 'auto-save did not resume after explicit save', 80)

  console.log('PASS auto-save: default off, settings enable, rich/source debounce, external-change guard, explicit-save resume')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: false })
  await rm(root, { recursive: true, force: true })
}
