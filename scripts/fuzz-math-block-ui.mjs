// Seeded random editing inside `$$` math blocks (user reports 2026-10-30:
// typing `\\` then Enter in a formula → 富文本与源码不一致). Each seed opens
// a short document, creates a 公式 block the way the user did (`$$` + Enter in
// rich mode), types a formula, then runs random steps a writer would: LaTeX
// tokens with backslashes / braces / spaces, Enter, Backspace, arrows (also
// out of the block and back, Shift+Arrow selection wrapped in braces), clicks
// on the rendered formula / 编辑 / the blank area below, idle pauses. After
// every step: no mismatch warning, no failed integrity check. At the end the
// saved file equals the editor's source and the live document serializes to
// Markdown that parses back to itself.
//
//   node scripts/fuzz-math-block-ui.mjs                 # seeds 1..8, 30 steps
//   SEEDS=1-40 STEPS=60 node scripts/fuzz-math-block-ui.mjs
//   SEED=17 node scripts/fuzz-math-block-ui.mjs          # one seed, verbose
//   EDIT_ONLY=1 …                                        # skip the end checks
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { pressKey } from './lib/human-input.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const range = (spec) => {
  const [a, b] = String(spec).split('-').map(Number)
  return Array.from({ length: (b || a) - a + 1 }, (_, i) => a + i)
}
const seeds = process.env.SEED ? [Number(process.env.SEED)] : range(process.env.SEEDS || '1-8')
const STEPS = Number(process.env.STEPS || 30)
const verbose = Boolean(process.env.SEED)
const mod = process.platform === 'darwin' ? 4 : 2

// mulberry32
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// LaTeX that also looks like Markdown (bullets, ordered markers, table pipes,
// HTML, escapes, `$`): a line pass that forgets $$ blocks rewrites it.
const TOKENS = ['\\\\', '\\\\', '\\', ' ', 'x', 'a_1', '^2', '{', '}', '\\frac{a}{b}', ' &= ', '\\pmod {p}', '\\\\ ', '+', 'E_2:',
  '* c', '- d', '1. e', '| a |', '<br />', '\\{a\\}', '\\_', '# h', '> q', '\\$', '~', '\\~']

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-fuzz-math-'))
const failures = []

async function runSeed(seed) {
  const random = rng(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const file = join(root, `seed-${seed}.md`)
  await fs.writeFile(file, '题目给了两条曲线\n')
  // Even seeds edit a NEW untitled document (its source is generated from the
  // editor's own serialization on every sync — the path the user's 54-char
  // document most likely took); odd seeds an existing file. UNTITLED=1/0 forces.
  const untitled = process.env.UNTITLED ? process.env.UNTITLED === '1' : seed % 2 === 0
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${seed}`), port: 9600 + (seed % 300), appArgs: untitled ? ['--horsemd-input-trace'] : [file, '--horsemd-input-trace'] })
  const evaluate = (expression) => app.evaluate(expression)
  const log = []
  const step = (text) => { log.push(text); if (verbose) console.log(`  ${log.length}. ${text}`) }
  const editor = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"
  const ins = async (text) => { for (const ch of [...text]) { await app.send('Input.insertText', { text: ch }); await sleep(25) } }
  const key = (k, modifiers = 0) => pressKey(app.send, { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, modifiers })
  const click = async (point) => {
    if (!point) return false
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    await sleep(150)
    return true
  }
  const problems = () => evaluate(`({
    toasts: [...document.querySelectorAll('.hm-toast-msg')].map((n) => n.textContent).filter((t) => /不一致|无法安全/.test(t)),
    fails: (globalThis.__hmSourceIntegrityTrace || []).filter((e) => e.ok === false).map((e) => [e.preservationReason || '?', e.validationSite || '?', 'semantic=' + e.semanticOk, 'canonicalFaithful=' + e.canonicalFaithful, 'listSlots=' + e.listSlotsMatch].join(' '))
  })`)
  const state = () => evaluate(`(() => {
    const e = ${editor}
    return [...e.children].map((c) => c.classList.contains('milkdown-code-block') ? '$$' + JSON.stringify([...c.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')) : c.tagName + JSON.stringify(c.textContent.slice(0, 20))).join(' | ')
  })()`)
  try {
    for (let i = 0; i < 80; i += 1) {
      if (await evaluate(`Boolean((${editor})?.pmViewDesc)`)) break
      await sleep(150)
    }
    await sleep(600)
    if (untitled) {
      // 新建文件 through the command palette (Cmd/Ctrl+N is a native menu
      // accelerator CDP keys never reach), then the first line.
      await evaluate(`[...document.querySelectorAll('button')].find((n) => /command palette|命令面板/i.test(n.title || n.getAttribute('aria-label') || ''))?.click()`)
      for (let i = 0; i < 40 && !(await evaluate(`Boolean(document.querySelector('.palette input'))`)); i += 1) await sleep(100)
      await evaluate(`document.querySelector('.palette input').focus()`)
      await app.send('Input.insertText', { text: '新建文件' })
      await sleep(250)
      await evaluate(`[...document.querySelectorAll('.palette-item')].find((n) => n.querySelector('.pi-title')?.textContent.trim() === '新建文件')?.click()`)
      for (let i = 0; i < 60 && !(await evaluate(`/未命名|Untitled/.test(document.querySelector('.tab.active')?.textContent || '') && Boolean((${editor})?.pmViewDesc)`)); i += 1) await sleep(100)
      await sleep(600)
      const box = await evaluate(`(() => { const b = (${editor}).getBoundingClientRect(); return { x: Math.round(b.left + 60), y: Math.round(b.top + 20) } })()`)
      await click(box)
      await ins('题目给了两条曲线')
      await sleep(400)
      step('new untitled document + first line')
    }
    // Caret at the end of the paragraph, Enter, `$$` + Enter (as the user did).
    const end = await evaluate(`(() => { const t = [...(${editor}).querySelectorAll('p, h1')].find((n) => n.textContent.includes('题目给了两条曲线')).firstChild; const r = document.createRange(); r.setStart(t, t.length); r.collapse(true); const b = r.getClientRects()[0]; return { x: Math.round(b.right - 2), y: Math.round(b.top + b.height / 2) } })()`)
    await click(end)
    await key('End')
    await sleep(200)
    await key('Enter'); await ins('$$'); await key('Enter'); await sleep(700)
    step('$$ + Enter')
    assert.ok(await evaluate(`Boolean((${editor}).querySelector('.milkdown-code-block .cm-content'))`), `seed ${seed}: $$ + Enter made no 公式 block: ${await state()}`)
    await ins('E_1:y^2 = x^3 + b'); await sleep(500)
    step('formula')
    const inFormula = () => evaluate(`(() => { const a = getSelection().anchorNode; const el = a?.nodeType === 1 ? a : a?.parentElement; return Boolean(el?.closest?.('.milkdown-code-block .cm-content') && document.activeElement?.closest?.('.cm-editor')) })()`)
    const lineEnd = async (which) => {
      const index = which === 'first' ? 0 : random()
      // Out of focus, a formula shows only its rendering: 编辑 shows the code.
      const toggle = await evaluate(`(() => { const block = (${editor}).querySelector('.milkdown-code-block'); const host = block?.querySelector('.codemirror-host'); if (!host || !host.classList.contains('hidden')) return null; const b = block.querySelector('.preview-toggle-button'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      if (toggle) {
        // Users click the rendered formula; 编辑 is the other way in.
        const preview = random() < 0.5 && await evaluate(`(() => { const p = (${editor}).querySelector('.milkdown-code-block .preview'); if (!p || !p.offsetParent) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
        if (preview) { await click(preview); step('click the rendered formula') } else { await click(toggle); step('编辑 (show the code)') }
        await sleep(300)
        const still = await evaluate(`Boolean((${editor}).querySelector('.milkdown-code-block .codemirror-host.hidden'))`)
        if (still) { await click(toggle); step('编辑 (show the code)'); await sleep(300) }
      }
      return evaluate(`((index) => { const lines = [...(${editor}).querySelectorAll('.milkdown-code-block .cm-line')]; const l = index === 0 ? lines[0] : lines[Math.floor(index * lines.length)]; if (!l || !l.offsetParent) return null; const r = document.createRange(); r.selectNodeContents(l); r.collapse(false); const b = r.getClientRects()[0] || l.getBoundingClientRect(); return { x: Math.round(b.right + 1), y: Math.round(b.top + b.height / 2) } })(${index})`)
    }
    for (let n = 0; n < STEPS; n += 1) {
      const r = random()
      if (r < 0.42) { const t = pick(TOKENS); await ins(t); step(`type ${JSON.stringify(t)}`) }
      else if (r < 0.58) { await key('Enter'); step('Enter') }
      else if (r < 0.66) { await key('Backspace'); step('Backspace') }
      else if (r < 0.70) {
        const n = 1 + Math.floor(random() * 3)
        for (let i = 0; i < n; i += 1) await key('ArrowLeft', 8)
        const t = pick(['{', '{', '(', '['])
        await ins(t); step(`Shift+ArrowLeft ×${n}, type ${JSON.stringify(t)}`)
      }
      else if (r < 0.72) { await sleep(2500 + Math.floor(random() * 3000)); step('pause') }
      else if (r < 0.84) { const k = pick(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']); await key(k); step(k) }
      else if (r < 0.92) { if (await click(await lineEnd('random'))) step('click a formula line end') }
      else {
        const pt = await evaluate(`(() => { const e = ${editor}; const b = e.lastElementChild.getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.bottom + 40) } })()`)
        await click(pt); step('click below')
        await sleep(300)
        const k = pick(['ArrowLeft', 'ArrowUp', 'click'])
        if (k === 'click') { if (await click(await lineEnd('first'))) step('click formula line 1 end') } else { await key(k); step(k) }
      }
      // Arrows / clicks can leave the formula: come back to it (the user
      // kept editing the same block).
      if (!(await inFormula())) {
        const pt = await lineEnd('random')
        if (verbose) console.log('     (left the formula →', JSON.stringify(pt), ')')
        if (await click(pt)) step('back into the formula')
      } else if (verbose) console.log('     (in formula:', await evaluate(`(() => { const a = getSelection().anchorNode; return (a?.nodeType === 1 ? a : a?.parentElement)?.className + ' / ' + document.activeElement?.className })()`), ')')
      if (!(await evaluate(`Boolean((${editor}).querySelector('.milkdown-code-block'))`))) { step('(the 公式 block was deleted — stop here)'); break }
      await sleep(250 + Math.floor(random() * 600))
      const p = await problems()
      if (p.toasts.length || p.fails.length) {
        await sleep(300)
        throw Object.assign(new Error(`seed ${seed}: ${p.fails.join(',') || 'warning'} after step ${log.length}`), { problems: p })
      }
    }
    await sleep(1200)
    const p = await problems()
    if (p.toasts.length || p.fails.length) throw Object.assign(new Error(`seed ${seed}: ${p.fails.join(',') || 'warning'} at the end`), { problems: p })
    // EDIT_ONLY=1: only the warnings while editing (to hunt them on a build
    // that still has a known end-state bug).
    if (process.env.EDIT_ONLY) return { ok: true }
    // The live document's full serialization parses back to it, and a save
    // writes the source the editor holds.
    const faithful = await evaluate(`(() => { const x = globalThis.__hmSourceReprintHarness; const doc = x.liveDoc(); const md = x.serialize(doc); return { md, same: x.equivalent(md, doc) } })()`)
    assert.ok(faithful.same, `seed ${seed}: full serialization changed the document: ${JSON.stringify(faithful.md)}`)
    if (untitled) {
      // No file to save: the generated source must still describe the document.
      const live = await evaluate(`(() => { const x = globalThis.__hmSourceReprintHarness; return x.equivalent(x.liveSource(), x.liveDoc()) })()`)
      assert.ok(live, `seed ${seed}: the untitled document's source does not describe it`)
      if (verbose) console.log('  final:', await state())
      return { ok: true }
    }
    await key('s', mod)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    for (let i = 0; i < 60 && await evaluate(`Boolean(document.querySelector('.hm-save-fab'))`); i += 1) await sleep(100)
    const saved = await fs.readFile(file, 'utf8')
    const live = await evaluate('globalThis.__hmSourceReprintHarness.liveSource()')
    assert.equal(saved, live, `seed ${seed}: saved bytes differ from the editor's source`)
    if (verbose) console.log('  final:', await state(), '\n  saved:', JSON.stringify(saved))
    return { ok: true }
  } catch (error) {
    if (verbose && error.problems) console.log('  problems:', JSON.stringify(error.problems, null, 1))
    failures.push({ seed, message: error.message, steps: log.slice(), state: await state().catch(() => '?'), source: await evaluate('globalThis.__hmSourceReprintHarness?.liveSource?.()').catch(() => '?') })
    return { ok: false }
  } finally {
    await stopBuiltElectron(app)
  }
}

try {
  for (const seed of seeds) {
    const result = await runSeed(seed)
    console.log(`seed ${seed}: ${result.ok ? 'ok' : 'FAIL'}`)
  }
  for (const f of failures) {
    console.log(`\n--- ${f.message}`)
    console.log('steps:', f.steps.map((s, i) => `${i + 1}. ${s}`).join('  '))
    console.log('editor:', f.state)
    console.log('source:', JSON.stringify(f.source))
  }
  if (failures.length) process.exitCode = 1
  else console.log(`PASS math block fuzz: ${seeds.length} seeds × ${STEPS} steps, no mismatch warning, full serialization faithful, saved = source`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
