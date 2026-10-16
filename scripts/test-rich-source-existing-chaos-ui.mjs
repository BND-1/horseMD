// Regression: non-linear edits against a pre-existing Markdown file with mixed
// list markers. This is deliberately different from a blank scratch document:
// untouched source bytes are authoritative and every new sibling must inherit
// the marker of its own list, not a global Crepe `*` default.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rich-source-existing-chaos-${process.pid}`
const file = join(root, 'existing-chaos.md')
const port = Number(process.env.CDP_PORT || 9818)
const delay = Number(process.env.CHAOS_KEY_DELAY || 65)
const burst = process.env.CHAOS_BURST === '1'
const source = [
  '# Existing Chaos',
  '',
  'single line A',
  'single line B',
  '',
  '- dash-one',
  '- dash-two',
  '',
  '+ plus-one',
  '+ plus-two',
  '',
  '* star-one',
  '* star-two',
  '',
  '1) paren-one',
  '2) paren-two',
  '',
  'tail paragraph',
  ''
].join('\n')
const expected = [
  '# Existing Chaos',
  '',
  'single line A',
  'single line B',
  '',
  '- dash-one',
  '- dash-two',
  '- dash-three',
  '',
  '+ plus-one',
  '+ plus-two',
  '+ plus-three',
  '',
  '* star-one',
  '',
  '1) paren-one',
  '2) paren-two',
  '',
  'tail paragraph',
  ''
].join('\n')

async function waitFor(check, message, attempts = 80) {
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
    const e = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const p = [...(e?.querySelectorAll('p, h1') || [])].find((node) => node.textContent === ${JSON.stringify(text)})
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { x: Math.max(r.left + 5, r.right - 3), y: r.top + Math.min(16, r.height / 2) }
  })()`)
  assert.ok(point, `missing visible text: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}
const enter = (send) => pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
const backspace = (send) => pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay })
const toggleSource = (evaluate) => evaluate(`(() => {
  const b = [...document.querySelectorAll('.status-btn')]
    .find((n) => n.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(n.title || n.textContent || ''))
  b?.click(); return !!b
})()`)
const visibleSource = (evaluate) => evaluate(`[
  ...document.querySelectorAll('textarea.source-editor')
].find((node) => node.offsetParent)?.value ?? null`)

async function assertSource(evaluate, stage) {
  const actual = await waitFor(() => visibleSource(evaluate), `${stage}: source textarea missing`)
  if (actual !== expected) {
    console.error(`--- ${stage} ACTUAL ---\n${actual}--- EXPECTED ---\n${expected}`)
  }
  assert.equal(actual, expected, `${stage}: authored markers or layout drifted`)
}

const waitForRichText = (evaluate, text) => waitFor(
  () => evaluate(`[
    ...document.querySelectorAll('.ProseMirror')
  ].find((node) => node.offsetParent)?.textContent.includes(${JSON.stringify(text)})`),
  `rich editor did not publish ${text}`
)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source)
  let app
  let completed = false
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-1'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(() => {
      const e = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return e?.textContent.includes('dash-two') && e?.textContent.includes('paren-two')
    })()`), 'existing Markdown did not finish mounting')

    // Modify a non-list paragraph, restoring its bytes afterwards. The
    // preceding single-line pair remains intentionally untouched raw Markdown.
    await clickTextEnd(evaluate, send, 'tail paragraph')
    await typeTextLikeUser(send, 'X', { delayMs: delay }); await backspace(send)

    // Add siblings to distinct marker styles. There is no literal marker in
    // either new item, so the source-preservation layer must inherit each
    // surrounding list's authored `-` and `+` rather than canonical `*`.
    await clickTextEnd(evaluate, send, 'dash-two')
    await enter(send); await typeTextLikeUser(send, 'dash-three', { delayMs: delay })
    if (!burst) await waitForRichText(evaluate, 'dash-three')
    await clickTextEnd(evaluate, send, 'plus-two')
    await enter(send); await typeTextLikeUser(send, 'plus-three', { delayMs: delay })
    if (!burst) await waitForRichText(evaluate, 'plus-three')

    // Delete an item from a third list, then revisit a later ordered list.
    await clickTextEnd(evaluate, send, 'star-two')
    for (const _character of 'star-two') await backspace(send)
    await enter(send)
    if (!burst) await waitFor(() => evaluate(`![
      ...document.querySelectorAll('.ProseMirror')
    ].find((node) => node.offsetParent)?.textContent.includes('star-two')`), 'rich editor did not remove star-two')
    await clickTextEnd(evaluate, send, 'paren-two')
    await typeTextLikeUser(send, 'X', { delayMs: delay }); await backspace(send)

    const richText = await evaluate(`[
      ...document.querySelectorAll('.ProseMirror')
    ].find((node) => node.offsetParent)?.textContent || ''`)
    assert.ok(richText.includes('plus-three'), 'rich editor lost the newly added plus-list item before source switch')
    assert.ok(!richText.includes('star-two'), 'rich editor did not remove the deleted star-list item')

    assert.equal(await toggleSource(evaluate), true, 'could not show source after non-linear edits')
    await assertSource(evaluate, 'first rich→source')
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich')
    assert.equal(await toggleSource(evaluate), true, 'could not reopen source')
    await assertSource(evaluate, 'second round-trip')
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich before save')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk differs from source view')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-2'), port: port + 1, appArgs: [file] })
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'reopened editor missing')
    assert.equal(await toggleSource(app.evaluate), true, 'could not open source after reopen')
    await assertSource(app.evaluate, 'full reopen')
    console.log(`PASS rich-source-existing-chaos (${delay}ms): mixed -, +, *, 1) lists survive edit/delete/save/reopen`)
    completed = true
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    if (completed) {
      try { await rm(root, { recursive: true, force: true }) } catch {}
    } else {
      console.error(`FAILED fixture retained at ${root}`)
    }
  }
}
run().catch((error) => { console.error(error); process.exit(1) })
