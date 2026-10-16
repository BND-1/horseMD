// Phase 2 + Phase 3: CDP integration test for CriticMarkup substitution rendering.
//
// Launch the DEV app first (DEV-only test hook is active in dev):
//   npm run dev -- --remote-debugging-port=9222
// Then:
//   node scripts/test-substitution.mjs
//
// Drives the REAL editor: CDP Input.insertText (triggers ProseMirror
// handleTextInput → the guard), the real 替换 command (applyReviewMarkup), and a
// parser-based paste (pasteMarkdown). Asserts via the rendered DOM + markdown.
import { connectCdp, sleep } from './lib/cdp.mjs'

const evals = (evaluate) => async (fn) => {
  try {
    return await evaluate(`(${fn})()`)
  } catch (error) {
    return { __error: error.message }
  }
}

async function type(send, text) {
  // Per-char so each keystroke is its own handleTextInput (real typing).
  for (const ch of String(text)) {
    await send('Input.insertText', { text: ch })
    await sleep(30)
  }
  await sleep(80)
}

async function pressEnter(send) {
  const common = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(120)
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`)
}

async function waitForEditor(ev) {
  for (let i = 0; i < 40; i++) {
    const ready = await ev(() => !!window.__horsemd)
    if (ready) return true
    // No editor mounted (Home screen)? Click the first doc tab to mount one.
    if (i % 5 === 4) {
      await ev(() => {
        const tab = document.querySelector('.tab')
        if (tab) tab.click()
        return true
      })
    }
    await sleep(500)
  }
  return false
}

async function main() {
  const { ws, send, evaluate } = await connectCdp({ intervalMs: 500 })
  await send('Runtime.enable')
  const ev = evals(evaluate)

  if (!(await waitForEditor(ev))) {
    console.error('FAIL: window.__horsemd never appeared (no editor mounted)')
    process.exit(1)
  }

  const hook = (fn) => ev(() => window.__horsemd && fn(window.__horsemd))
  const md = () => hook((h) => h.getMarkdown())
  const html = () => hook((h) => h.getHtml())
  const hasSub = (h) => h.includes('hm-review-sub-old') && h.includes('hm-review-sub-new')
  const delCount = (h) => (h.match(/<del\b/g) || []).length

  // ── Scenario 3: type the marker directly (purest guard test) ──────────────
  await hook((h) => h.clear())
  await hook((h) => h.focus())
  await hook((h) => h.cursorEnd())
  await type(send, '{~~old~>new~~}')
  {
    const m = await md()
    const h = await html()
    const ok = /{~~old~>new~~}/.test(m) && hasSub(h) && delCount(h) === 0
    record('S3 type marker renders as substitution', ok, `md=${JSON.stringify(m)} del=${delCount(h)} sub=${hasSub(h)}`)
  }

  // ── Scenario 1: select → 替换 command → type new text ─────────────────────
  await hook((h) => h.clear())
  await hook((h) => h.focus())
  await hook((h) => h.cursorEnd())
  await type(send, '旧')
  await hook((h) => h.selectRange(1, 2)) // select the just-typed char
  const applied = await hook((h) => h.applyReviewMarkup('substitution'))
  await type(send, '新') // REAL keystroke after the command — the bug path
  {
    const m = await md()
    const h = await html()
    const ok = applied && /{~~旧~>新~~}/.test(m) && hasSub(h) && delCount(h) === 0
    record('S1 select→替换→type renders as substitution', ok, `applied=${applied} md=${JSON.stringify(m)} del=${delCount(h)}`)
  }

  // ── Scenario 2: paste marker (parser path) → Enter keeps it rendering ─────
  await hook((h) => h.clear())
  await hook((h) => h.pasteMarkdown('\n{~~旧~>新~~}\n'))
  await sleep(150)
  const beforeEnter = await html()
  await hook((h) => h.cursorEnd())
  await pressEnter(send)
  await type(send, '尾') // type after Enter on the new line — must not corrupt
  {
    const m = await md()
    const h = await html()
    const ok = hasSub(beforeEnter) && hasSub(h) && /{~~旧~>新~~}/.test(m) && delCount(h) === 0
    record('S2 paste→Enter→type keeps rendering', ok, `md=${JSON.stringify(m)} del=${delCount(h)} subBefore=${hasSub(beforeEnter)}`)
  }

  // ── Regression: normal ~~strike~~ still becomes <del> ─────────────────────
  await hook((h) => h.clear())
  await hook((h) => h.focus())
  await hook((h) => h.cursorEnd())
  await type(send, '~~hit~~')
  {
    const h = await html()
    record('REG normal ~~strike~~ still strikes', delCount(h) >= 1, `del=${delCount(h)}`)
  }

  // ── Regression: other review markers render ───────────────────────────────
  for (const [label, marker, cls] of [
    ['addition', '{++add++}', 'hm-review-add'],
    ['deletion', '{--del--}', 'hm-review-del']
  ]) {
    await hook((h) => h.clear())
    await hook((h) => h.focus())
    await hook((h) => h.cursorEnd())
    await type(send, marker)
    const h = await html()
    record(`REG ${label} renders`, h.includes(cls), `has ${cls}=${h.includes(cls)}`)
  }

  ws.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('TEST_FAIL', e.message, e.stack)
  process.exit(1)
})
