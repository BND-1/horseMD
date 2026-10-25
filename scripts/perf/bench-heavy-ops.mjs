// Large-document latency of the operations users notice (Windows report on a
// 257K-char interview-notes export): switching to the large tab, typing and
// Backspace in a paragraph, and Bold / Italic / heading-level shortcuts.
// Each action is timed from the input event (capture phase) to two frames
// later (≈ on screen), plus the long tasks in the next second.
//
// usage: BENCH_DOC=<large.md> BENCH_NEEDLE='<phrase in a mid-document paragraph>' \
//   node scripts/perf/bench-heavy-ops.mjs <app binary> <label> [entrypoint]
// (entrypoint: `out/main/index.cjs` with the node_modules Electron binary;
// omit for a packaged HorseMD). PROFILE=1 writes a CPU profile per phase.
// TRACE=1 adds --horsemd-input-trace (users normally run without).
import { spawn } from 'node:child_process'
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, sleep } from '../lib/cdp.mjs'

const [bin, label, entry] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const run = join(here, `run-${label}-${Date.now()}`)
mkdirSync(run, { recursive: true })
const DOC = process.env.BENCH_DOC
const NEEDLE = process.env.BENCH_NEEDLE
if (!DOC || !NEEDLE) throw new Error('set BENCH_DOC and BENCH_NEEDLE')
const port = 9300 + Math.floor(Math.random() * 200)
copyFileSync(DOC, join(run, 'big.md'))
writeFileSync(join(run, 'small.md'), '# Small\n\nA short note.\n')
const args = [`--user-data-dir=${join(run, 'profile')}`, `--remote-debugging-port=${port}`]
if (entry) args.push(entry)
args.push(join(run, 'small.md'), join(run, 'big.md'))
if (process.env.TRACE === '1') args.push('--horsemd-input-trace')
const child = spawn(bin, args, { stdio: 'ignore' })
const result = { label, ok: false }
let app
const profiles = process.env.PROFILE === '1'

const send = (...a) => app.send(...a)
const key = async (k, { code, mods = 0, text, vk } = {}) => {
  const base = { key: k, code: code || k, modifiers: mods, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0 }
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const MOD = process.platform === 'darwin' ? 4 : 2
// Arms a one-shot timer on the next keydown / pointerdown.
const arm = (type) => app.evaluate(`(() => {
  window.__lat = null
  addEventListener(${JSON.stringify(type)}, () => {
    const t = performance.now()
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__lat = Math.round(performance.now() - t) }))
  }, { once: true, capture: true })
  window.__lt = []
  return true
})()`)
const read = async () => {
  for (let i = 0; i < 100 && (await app.evaluate('window.__lat')) == null; i++) await sleep(20)
  await sleep(1000)
  return app.evaluate(`({ ms: window.__lat, longTasks: window.__lt.slice(), longMax: Math.max(0, ...window.__lt) })`)
}
const stats = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b)
  return { n: v.length, p50: v[v.length >> 1], p90: v[Math.floor(v.length * 0.9)], max: v.at(-1) }
}
// TIMELINE=1: Chromium trace of a phase — native style / layout / paint time,
// and which JS call forced each synchronous layout or style recalc.
const timelines = process.env.TIMELINE === '1'
let traceEvents = null
const startTimeline = async () => {
  if (!timelines) return
  traceEvents = []
  app.ws.addEventListener('message', app.__traceListener ??= (event) => {
    const m = JSON.parse(event.data)
    if (m.method === 'Tracing.dataCollected' && traceEvents) traceEvents.push(...m.params.value)
    if (m.method === 'Tracing.tracingComplete') app.__traceDone?.()
  })
  await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack', transferMode: 'ReportEvents' })
}
const stopTimeline = async (name) => {
  if (!timelines) return
  const done = new Promise((resolve) => { app.__traceDone = resolve })
  await send('Tracing.end'); await done
  const main = traceEvents.filter((e) => e.ph === 'X' && e.dur)
  const byName = {}
  for (const e of main) if (['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Layerize', 'RunTask', 'FunctionCall', 'EventDispatch', 'HitTest', 'IntersectionObserverController::computeIntersections', 'ScheduleStyleRecalculation', 'ParseHTML'].includes(e.name)) byName[e.name] = (byName[e.name] || 0) + e.dur / 1000
  const forced = {}
  for (const e of main) {
    if (e.name !== 'Layout' && e.name !== 'UpdateLayoutTree') continue
    const st = e.args?.beginData?.stackTrace || e.args?.stackTrace
    const top = st?.[0]
    const key = `${e.name} ${top ? `${top.functionName || '(anon)'}:${top.lineNumber} ${String(top.url || '').split('/').pop()}` : '(frame)'}`
    forced[key] = (forced[key] || 0) + e.dur / 1000
  }
  const round = (o) => Object.fromEntries(Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => [k, Math.round(v)]))
  result.timeline ??= {}
  result.timeline[name] = { totals: round(byName), forced: round(forced) }
  traceEvents = null
}
const startProfile = async () => { if (profiles) { await send('Profiler.enable'); await send('Profiler.start') } }
const stopProfile = async (name) => {
  if (!profiles) return
  const { result: r } = await send('Profiler.stop')
  writeFileSync(join(run, `${name}.cpuprofile`), JSON.stringify(r.profile))
}
const clickAt = async (x, y, count = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count })
}
const tabPoint = (name) => app.evaluate(`(() => {
  const t = [...document.querySelectorAll('.tab')].find((n) => n.textContent.includes(${JSON.stringify(name)}))
  const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
const bigLoaded = () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((n) => n.offsetParent && n.textContent.length > 50000)`)

try {
  app = await connectCdp({ port, attempts: 160, intervalMs: 250 })
  await sleep(3000)
  // Experiments: BENCH_CSS injects a stylesheet, BENCH_FORCE_CV=1 adds hm-cv
  // to every editor scroller (as for documents above the CV threshold).
  if (process.env.BENCH_CSS) await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(process.env.BENCH_CSS || '')}; document.head.appendChild(s); return true })()`)
  if (process.env.BENCH_FORCE_CV === '1') await app.evaluate(`(() => { setInterval(() => document.querySelectorAll('.editor-scroll:not(.hm-cv)').forEach((n) => n.classList.add('hm-cv')), 100); return true })()`)
  await app.evaluate(`window.__lt=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))}).observe({type:'longtask'});true`)
  result.version = await app.evaluate('window.api?.appVersion || null').catch(() => null)

  // 1. Tab switches: small → big (first time = mount), then back and forth.
  result.tabSwitch = []
  const small = await tabPoint('small.md')
  await clickAt(small.x, small.y); await sleep(1500)
  for (let i = 0; i < 4; i++) {
    const big = await tabPoint('big.md')
    await arm('pointerdown')
    if (i === 1) { await startProfile(); await startTimeline() }
    const t0 = Date.now()
    await clickAt(big.x, big.y)
    for (let k = 0; k < 400 && !(await bigLoaded()); k++) await sleep(25)
    const ready = Date.now() - t0
    const r = await read()
    if (i === 1) { await stopProfile('tab-switch'); await stopTimeline('tab-switch') }
    result.tabSwitch.push({ i, toFrame: r.ms, toContent: ready, longMax: r.longMax, longTasks: r.longTasks })
    await sleep(i === 0 ? 4000 : 800)
    await clickAt(small.x, small.y); await sleep(1200)
  }
  const big = await tabPoint('big.md'); await clickAt(big.x, big.y)
  for (let k = 0; k < 400 && !(await bigLoaded()); k++) await sleep(25)
  await sleep(4000)

  // Caret at the end of the needle paragraph (scrolled into view).
  const place = async () => {
    const p = await app.evaluate(`(async () => {
      const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent && n.textContent.length > 50000)
      const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT); let node
      while ((node = w.nextNode())) if (node.data.includes(${JSON.stringify(NEEDLE)})) break
      const block = node.parentElement.closest('p, li, h1, h2, h3, h4') || node.parentElement
      block.scrollIntoView({ block: 'center' })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const range = document.createRange(); range.setStart(node, node.data.indexOf(${JSON.stringify(NEEDLE)}) + 2); range.setEnd(node, node.data.indexOf(${JSON.stringify(NEEDLE)}) + 3)
      const m = range.getBoundingClientRect()
      return { x: Math.round(m.left + 1), y: Math.round(m.top + m.height / 2) }
    })()`)
    await clickAt(p.x, p.y); await sleep(600)
    return p
  }
  // The caret must really be in the needle's text (content-visibility can
  // shift the page after scrolling); re-locate until it is.
  const caretInNeedle = () => app.evaluate(`(() => {
    const s = getSelection()
    const n = s.anchorNode
    const el = n && (n.nodeType === 1 ? n : n.parentElement)
    return Boolean(el && el.closest('.ProseMirror') && (el.closest('p, h1, h2, h3, h4')?.textContent || '').includes(${JSON.stringify(NEEDLE)}))
  })()`)
  let p = await place()
  for (let i = 0; i < 5 && !(await caretInNeedle()); i++) { await sleep(500); p = await place() }
  result.caretPlaced = await caretInNeedle()
  if (!result.caretPlaced) throw new Error('could not place the caret in the needle paragraph')

  // The block holding the caret (the needle text may occur more than once).
  const pmState = () => app.evaluate(`(() => {
    const pm = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent && n.textContent.length > 50000)
    const n = getSelection().anchorNode
    const block = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('p, h1, h2, h3, h4, h5, h6')
    return { tag: block?.tagName, text: block?.textContent.slice(0, 40), strong: block?.querySelectorAll('strong').length, em: block?.querySelectorAll('em').length, focused: pm.contains(document.activeElement) || pm === document.activeElement }
  })()`)
  // 2. Typing and Backspace, one key at a time, 150 ms apart.
  const perKey = async (name, fire, count = 12) => {
    const xs = []; const lt = []
    await startProfile(); await startTimeline()
    for (let i = 0; i < count; i++) {
      await arm('keydown'); await fire(i)
      for (let k = 0; k < 100 && (await app.evaluate('window.__lat')) == null; k++) await sleep(10)
      xs.push(await app.evaluate('window.__lat')); lt.push(...(await app.evaluate('window.__lt')))
      await sleep(150)
    }
    await sleep(1500); lt.push(...(await app.evaluate('window.__lt')))
    await stopProfile(name); await stopTimeline(name)
    return { ...stats(xs), longMax: Math.max(0, ...lt), longTotal: lt.reduce((a, b) => a + b, 0) }
  }
  const letters = 'abcdefghijkl'
  result.before = await pmState()
  result.typing = await perKey('typing', (i) => key(letters[i], { code: `Key${letters[i].toUpperCase()}`, text: letters[i], vk: letters[i].toUpperCase().charCodeAt(0) }))
  result.afterTyping = await pmState()
  await sleep(2500)
  result.backspace = await perKey('backspace', () => key('Backspace', { vk: 8 }))
  await sleep(2500)

  // 3. Shortcuts on a word: double-click selects it, then Mod+B / Mod+I,
  //    and heading level Mod+2 / back with Mod+0 (caret in the paragraph).
  const shortcut = async (name, k, code, vk, before) => {
    const xs = []; const lt = []
    await startProfile(); await startTimeline()
    for (let i = 0; i < 6; i++) {
      await before?.()
      await arm('keydown'); await key(k, { code, mods: MOD, vk })
      for (let j = 0; j < 100 && (await app.evaluate('window.__lat')) == null; j++) await sleep(10)
      xs.push(await app.evaluate('window.__lat'))
      await sleep(900); lt.push(...(await app.evaluate('window.__lt')))
    }
    await stopProfile(name); await stopTimeline(name)
    return { ...stats(xs), longMax: Math.max(0, ...lt), longTotal: lt.reduce((a, b) => a + b, 0) }
  }
  const selectWord = async () => {
    for (let i = 0; i < 4; i++) {
      await clickAt(p.x, p.y, 2); await sleep(300)
      if (await app.evaluate('getSelection().toString().length > 0') && await caretInNeedle()) return
      p = await place()
    }
    throw new Error('could not select a word in the needle paragraph')
  }
  result.afterBackspace = await pmState()
  result.bold = await shortcut('bold', 'b', 'KeyB', 66, selectWord)
  result.afterBold = await pmState()
  result.italic = await shortcut('italic', 'i', 'KeyI', 73, selectWord)
  result.afterItalic = await pmState()
  let level = 0
  result.heading = await shortcut('heading', '2', 'Digit2', 50, async () => {
    // alternate H2 / paragraph
    if (level++ % 2) { await key('0', { code: 'Digit0', mods: MOD, vk: 48 }); await sleep(900) }
    await clickAt(p.x, p.y); await sleep(300)
  })
  result.afterHeading = await pmState()
  // 4. Scrolling (BENCH_SCROLL=1): wheel through the document from the top in
  //    steps; frame intervals from requestAnimationFrame. Content-visibility
  //    trades layout work for height-estimate churn, so both are measured.
  if (process.env.BENCH_SCROLL === '1') {
    const scroller = `[...document.querySelectorAll('.editor-scroll')].find((n) => n.offsetParent && n.textContent.length > 50000)`
    await app.evaluate(`(${scroller}).scrollTop = 0`)
    await sleep(1500)
    const box = await app.evaluate(`(() => { const r = (${scroller}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await app.evaluate(`(() => { window.__fr = []; let last = performance.now(); const tick = (t) => { window.__fr.push(t - last); last = t; if (window.__frOn) requestAnimationFrame(tick) }; window.__frOn = true; requestAnimationFrame(tick); return true })()`)
    for (let i = 0; i < 120; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 240 })
      await sleep(16)
    }
    await sleep(800)
    result.scroll = await app.evaluate(`(() => {
      window.__frOn = false
      const f = window.__fr.slice(2)
      const sorted = [...f].sort((a, b) => a - b)
      return { frames: f.length, over33: f.filter((x) => x > 33).length, over50: f.filter((x) => x > 50).length, p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), max: Math.round(sorted.at(-1)), scrolled: Math.round((${scroller}).scrollTop) }
    })()`)
  }
  result.incStats = await app.evaluate('(globalThis.__hmIncrementalSerializeAll || []).map((e) => ({ children: e.children(), ...e.stats }))')
  result.mismatch = await app.evaluate(`[...document.querySelectorAll('[class*=toast]')].map(n=>n.innerText).filter(t=>/不一致/.test(t)).length`)
  result.ok = true
} catch (error) {
  result.error = String(error?.stack || error).slice(0, 800)
} finally {
  writeFileSync(join(here, `result-${label}.json`), JSON.stringify(result, null, 1))
  console.log(JSON.stringify(result, null, 1))
  try { app?.ws?.close() } catch {}
  try { process.kill(child.pid, 'SIGKILL') } catch {}
  process.exit(0)
}
