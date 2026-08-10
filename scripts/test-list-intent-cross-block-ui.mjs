// Regression: a delayed list input-rule intent must not overwrite edits made
// in another block while the rule is pending. The list intent rebuilds only
// its own slot on top of the current source snapshot, never the whole document
// from the stale capture.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-intent-cross-block-${process.pid}`
const file = join(root, 'cross-block.md')
const port = Number(process.env.CDP_PORT || 9822)
const delay = Number(process.env.KEY_DELAY || 60)
const initial = 'Alpha\n\nOmega\n'
const expected = 'AlphaX\n\n- item\n\nOmegaY\n'

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.max(rect.left + 5, rect.right - 3), y: rect.top + Math.min(16, rect.height / 2) }
  })()`)
  assert.ok(point, `missing rich block: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

async function typeDelimiter(send, key, code) {
  const virtualKeyCode = key === '-' ? 189 : 32
  const common = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', {
    type: 'char', ...common, text: key, unmodifiedText: key
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
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

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, initial, 'utf8')
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-edit'),
      port,
      appArgs: [file]
    })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not open'
    )
    await evaluate(`(() => {
      window.__hmSourceTransactionTrace = []
      window.__hmSourceTransactionLog = []
      window.__hmPreserveLog = []
      window.__hmListIntentTrace = []
    })()`)

    // This regression proves the interaction between the transaction-first
    // mapper and the delayed list input-rule intent. In a default build the
    // mapper is not active, so the scenario is out of scope and must not fail.
    await clickTextEnd(evaluate, send, 'Alpha')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await sleep(300)
    const probe = await evaluate(`window.__hmSourceTransactionLog || []`)
    if (!probe.some((entry) => entry.ok && entry.reason === 'plain-text-transactions')) {
      console.log('SKIP list intent cross-block: transaction-first source sync is not active in this build')
      return
    }

    // Alpha → Enter → `- item` starts a list, but its deferred markdownUpdated
    // callback has not landed yet when Omega is edited in the same window.
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
    await typeDelimiter(send, '-', 'Minus')
    await typeDelimiter(send, ' ', 'Space')
    await typeTextLikeUser(send, 'item', { delayMs: delay })
    // No settle: immediately edit the other block, then switch source.
    await clickTextEnd(evaluate, send, 'Omega')
    await typeTextLikeUser(send, 'Y', { delayMs: delay })

    assert.equal(await toggleSource(evaluate), true, 'could not switch to source mode')
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea did not open')
    if (source !== expected) {
      console.error('TRANSACTION_TRACE', JSON.stringify(await evaluate(`({
        transactions: window.__hmSourceTransactionTrace || [],
        mapped: window.__hmSourceTransactionLog || [],
        preserved: window.__hmPreserveLog || [],
        intents: window.__hmListIntentTrace || []
      })`), null, 2))
    }
    assert.equal(
      source,
      expected,
      'a delayed list input-rule intent overwrote the cross-block edit'
    )
    assert.doesNotMatch(source, /<br\s*\/?\s*>/i, 'list placeholder leaked into source')
    assert.doesNotMatch(source, /\* item/, 'authored dash marker fell back to Crepe default')

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'save lost the cross-block edit or list marker')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-reopen'),
      port: port + 1,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'saved document did not reopen'
    )
    assert.equal(await toggleSource(app.evaluate), true, 'could not inspect reopened source')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'reopened source did not appear'),
      expected,
      'full reopen lost the cross-block edit or list marker'
    )
    console.log('PASS list intent cross-block: delayed input rule never overwrites later edits, save and reopen stay exact')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
