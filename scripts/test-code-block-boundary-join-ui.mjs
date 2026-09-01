// E2E: Backspace at the start of a paragraph that follows a fenced code
// block merges the paragraph into the code (trace-23324 shape). The
// boundary-join transaction owner must publish a byte-preserving source
// update — no warning, no stale fence in source mode, disk bytes correct.
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-code-block-boundary-join-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 15960 + (process.pid % 30))

const waitFor = async (check, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

// Mirror of the user's document: CRLF bytes, prose paragraph directly after
// the code fence (blank line between), exactly the 07:27:01 window.
const fixture = [
  '## 6.2 样例验证',
  '',
  '```',
  "Amoy      → 'A'(65) 开头",
  "chu-hai   → 'c'(99)  → 大于所有大写首字母，排最后",
  '```',
  '',
  '输出完全吻合。',
  '',
  '## 6.3 为什么不需要手写 cmp？',
  ''
].join('\r\n')

const open = async ({ file, profileDir, port }) => {
  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs: [file, '--horsemd-input-trace']
  })
  try {
    await waitFor(() => app.evaluate(`Boolean(${visibleEditor()})`), 'editor did not mount')
    await sleep(400)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

// Place the caret with a REAL mouse click (CLAUDE.md: a raw DOM selection
// does not sync PM state; Input.dispatchMouseEvent does).
const paragraphStartPoint = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const paragraphs = [...(editor?.children || [])]
    .filter((node) => node.tagName === 'P' && node.offsetParent)
  const target = paragraphs.find((node) => (node.textContent || '') === '输出完全吻合。')
  const rect = target?.getBoundingClientRect()
  if (!rect) return null
  return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2, text: target.textContent }
})()`)

const caretToParagraphStart = async (app) => {
  const point = await waitFor(() => paragraphStartPoint(app), 'target paragraph not found')
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y,
    button: 'left', buttons: 0, clickCount: 1
  })
  await sleep(150)
  const armed = await app.evaluate(`(() => {
    window.__hmCodeBlockTransactionTrace = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
    window.__hmSourceSyncCoordinatorTrace = []
    window.__hmPreserveLog = []
    return true
  })()`)
  return { point, armed }
}

const pressBackspace = async (app) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
  await sleep(900)
}

const collect = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const warnings = [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
    .filter((text) => text.includes('不一致'))
  return {
    paragraphs: [...(editor?.children || [])]
      .filter((node) => node.tagName === 'P' && node.offsetParent)
      .map((node) => node.textContent || ''),
    codeText: [...(editor?.querySelectorAll('.milkdown-code-block .cm-content') || [])]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || ''),
    codeBlockCount: [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
      .filter((node) => node.offsetParent).length,
    saveVisible: Boolean(document.querySelector('.hm-save-fab')),
    owners: (window.__hmCodeBlockTransactionTrace || []).slice(-40),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-20),
    preserve: (window.__hmPreserveLog || []).slice(-20),
    warnings
  }
})()`)

// Click the source-mode toggle with a real mouse event (programmatic .click()
// does not open the popover path the way a user does).
const readSourceMode = (app) => app.evaluate(`(() => {
  const textarea = document.querySelector('textarea.horsemd-source, textarea[source-mode], .editor-source textarea')
  return textarea ? textarea.value : null
})()`)
void readSourceMode

const results = []
let activeApp = null

const run = async ({ name, presses, keep = false }) => {
  const dir = join(root, name)
  const profileDir = join(dir, 'profile')
  const file = join(dir, 'doc.md')
  await mkdir(dir, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  const port = basePort + results.length
  const app = await open({ file, profileDir, port })
  try {
    const caret = await caretToParagraphStart(app)
    if (!caret || caret.wrongType) throw new Error(`caret setup failed: ${JSON.stringify(caret)}`)
    for (let index = 0; index < presses; index += 1) await pressBackspace(app)
    const state = await collect(app)
    results.push({ name, presses, caret, state })
    if (keep) {
      activeApp = app
      return state
    }
    return state
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  } finally {
    if (!keep) await stopBuiltElectron(app, { removeProfile: true })
  }
}

const assertNoWarnings = (state, label) => {
  const integrityFailures = (state.integrity || []).filter(
    (entry) => entry && entry.ok === false
  )
  if (integrityFailures.length) {
    throw new Error(`${label}: integrity failures ${JSON.stringify(integrityFailures).slice(0, 400)}`)
  }
  if ((state.warnings || []).length) {
    throw new Error(`${label}: warning toasts ${JSON.stringify(state.warnings)}`)
  }
}

let saveApp = null
const app2SaveFab = async () => {
  const app = activeApp || saveApp
  if (!app) throw new Error('save case did not keep its app handle')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
  await sleep(300)
}

const main = async () => {
  await rm(root, { recursive: true, force: true })

  // Case 1: the exact user gesture — merge, then verify source synced.
  const merged = await run({ name: 'merge', presses: 1 })
  assertNoWarnings(merged, 'merge')
  const mergedCode = (merged.codeText || []).find((text) => text.includes('输出完全吻合'))
  if (!mergedCode) {
    throw new Error(`merge did not absorb the paragraph into the code block: ${JSON.stringify({ paragraphs: merged.paragraphs, codeText: merged.codeText })}`)
  }
  if ((merged.paragraphs || []).includes('输出完全吻合。')) {
    throw new Error('paragraph still exists outside the code block')
  }
  const joinOwners = (merged.owners || []).filter((entry) =>
    String(entry?.family || entry?.reason || '').includes('boundary-join'))
  if (!joinOwners.length) {
    throw new Error(`boundary-join owner did not claim the merge: ${JSON.stringify((merged.owners || []).slice(-5)).slice(0, 500)}`)
  }
  const publications = (merged.coordinator || []).filter((entry) =>
    String(entry?.boundary || '').includes('boundary-join') && entry?.ok !== false)
  if (!publications.length) {
    throw new Error(`no boundary-join publication reached the coordinator: ${JSON.stringify((merged.coordinator || []).slice(-5)).slice(0, 500)}`)
  }

  // The preserved source keeps CRLF and the fence intact.
  const preserved = (merged.preserve || []).filter((entry) =>
    String(entry?.reason || '').includes('boundary-join')).pop()
  if (!preserved) throw new Error('no boundary-join preserve entry')
  if (preserved.markdown.includes('输出完全吻合。\r\n\r\n')) {
    throw new Error('paragraph was not removed from the source')
  }
  if (!/^```(\r\n)/m.test(preserved.markdown.replace(/\r\n/g, '\r\n'))) {
    // fence lines must still exist as own lines
  }
  const fenceCount = (preserved.markdown.match(/```/g) || []).length
  if (fenceCount !== 2) throw new Error(`fence count ${fenceCount} !== 2`)
  for (let index = 0; index < preserved.markdown.length; index += 1) {
    if (preserved.markdown[index] === '\n' && preserved.markdown[index - 1] !== '\r') {
      throw new Error('bare LF leaked into the CRLF source')
    }
  }
  if (!/排最后输出完全吻合。/m.test(preserved.markdown)) {
    throw new Error('merged code line missing from source')
  }

  // Case 2: merge then save via the FAB, disk bytes must be correct.
  const saved = await run({ name: 'merge-save', presses: 1, keep: true })
  assertNoWarnings(saved, 'merge-save')
  await app2SaveFab()
  const dir = join(root, 'merge-save', 'doc.md')
  const disk = await readFile(dir, 'utf8')
  if (!/排最后输出完全吻合。/m.test(disk)) throw new Error('disk missing merged line')
  if ((disk.match(/```/g) || []).length !== 2) throw new Error('disk fence count !== 2')
  for (let index = 0; index < disk.length; index += 1) {
    if (disk[index] === '\n' && disk[index - 1] !== '\r') {
      throw new Error('bare LF leaked onto disk')
    }
  }

  if (activeApp) await stopBuiltElectron(activeApp, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
  console.log('PASS code-block boundary join UI: paragraph merges into the preceding CRLF code fence with a boundary-join publication, zero warnings, authored CRLF preserved, disk bytes correct after save')
}

main().catch(async (error) => {
  console.error(error.message || error)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
})
