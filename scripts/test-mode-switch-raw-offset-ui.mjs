// Regression for source/rich caret stability. It asserts the semantic text at
// the exact Markdown raw offset across both continuous switch chains. Keeping
// this test source-driven prevents duplicate text from hiding a wrong match.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-mode-switch-raw-offset'
const port = 9494
const fixture = join(root, 'raw-offset.md')

const markdown = `# Raw offset fixture

Before table paragraph with a unique caret target.

| Field | Value | Notes |
| --- | --- | --- |
| Model | Mac16,12 | unique-table-model-target |
| Shell | \`zsh\` | unique-table-shell-target |

- First list item
- unique-list-target with inline \`code\`

\`\`\`javascript
const uniqueCodeTarget = 'keep exact position'
\`\`\`

After table paragraph with a unique final target.
`

const targets = [
  { token: 'unique caret target', local: 7 },
  { token: 'unique-table-model-target', local: 12 },
  { token: 'unique-table-shell-target', local: 11 },
  { token: 'unique-list-target', local: 10 },
  { token: 'uniqueCodeTarget', local: 8 },
  { token: 'unique final target', local: 6 }
]

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const toggle = async (app) => {
  const point = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (!point) throw new Error('Source toggle button not found')
  await click(app.send, point)
  await sleep(700)
}

const sourceMode = (app) => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null))`)

const sourceCaret = (app) => app.evaluate(`(() => {
  const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null)
  if (!textarea) return null
  const offset = textarea.selectionStart
  return { offset, text: textarea.value.slice(Math.max(0, offset - 20), offset + 20) }
})()`)

const richCaret = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const selection = getSelection()
  if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return null
  const range = selection.getRangeAt(0).cloneRange()
  range.collapse(true)
  const before = document.createRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  const offset = before.toString().length
  const text = editor.textContent || ''
  const rect = range.getBoundingClientRect()
  const scroller = editor.closest('.editor-scroll')
  const host = scroller?.getBoundingClientRect()
  return {
    offset,
    text: text.slice(Math.max(0, offset - 20), offset + 20),
    visible: !!host && rect.top >= host.top - 2 && rect.bottom <= host.bottom + 2
  }
})()`)

const setSourceCaret = async (app, offset) => {
  const result = await app.evaluate(`((offset) => {
    const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent !== null)
    if (!textarea) return false
    textarea.focus()
    textarea.setSelectionRange(offset, offset)
    textarea.__horsemdSourceSelectionUser = true
    textarea.__horsemdSourceViewportMoved = false
    textarea.__horsemdSourceSelectionBaseline = '0:0'
    textarea.scrollTop = Math.max(0, textarea.scrollHeight * (offset / Math.max(1, textarea.value.length)) - textarea.clientHeight / 2)
    // Programmatic scroll is only used to make this test position visible. Mark
    // the explicit caret intent after it so the textarea's scroll handler
    // cannot turn this editing case into a reading case.
    textarea.__horsemdSourceSelectionAt = performance.now()
    textarea.__horsemdSourceViewportMoved = false
    return true
  })(${offset})`)
  assert.equal(result, true, 'Could not set source caret')
  await sleep(120)
}

const assertHasToken = (snapshot, token, stage) => {
  assert.ok(snapshot?.text.includes(token), `${stage}: caret no longer belongs to ${token}: ${JSON.stringify(snapshot)}`)
}

async function runChain(app, target) {
  const rawOffset = markdown.indexOf(target.token) + target.local
  assert.ok(rawOffset >= target.local, `Missing fixture token ${target.token}`)

  if (!await sourceMode(app)) await toggle(app)
  await setSourceCaret(app, rawOffset)
  const source0 = await sourceCaret(app)
  assert.equal(source0.offset, rawOffset, 'Source baseline offset')
  assertHasToken(source0, target.token, 'Source baseline')

  // source -> rich -> source -> rich
  await toggle(app)
  const rich1 = await richCaret(app)
  await toggle(app)
  const source2 = await sourceCaret(app)
  await toggle(app)
  const rich3 = await richCaret(app)
  assertHasToken(rich1, target.token, 'source->rich')
  assert.equal(source2.offset, rawOffset, 'source->rich->source raw offset')
  assertHasToken(rich3, target.token, 'source->rich->source->rich')
  assert.equal(rich1.visible, true, 'source->rich caret should stay visible')
  assert.equal(rich3.visible, true, 'source chain final caret should stay visible')

  // rich -> source -> rich -> source. Start from the exact rich selection left
  // by the previous chain, so this exercises PM -> Markdown mapping as well.
  await toggle(app)
  const source1 = await sourceCaret(app)
  await toggle(app)
  const rich2 = await richCaret(app)
  await toggle(app)
  const source3 = await sourceCaret(app)
  assert.equal(source1.offset, rawOffset, 'rich->source raw offset')
  assertHasToken(rich2, target.token, 'rich->source->rich')
  assert.equal(source3.offset, rawOffset, 'rich->source->rich->source raw offset')
  assert.equal(rich2.visible, true, 'rich chain caret should stay visible')
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, markdown, 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [fixture] })
  try {
    await waitFor(
      () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent !== null)`),
      'Rich editor did not render'
    )
    for (const target of targets) await runChain(app, target)
    console.log(`PASS mode-switch raw offset UI: ${targets.length} positions across both continuous chains`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
