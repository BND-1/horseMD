// Same-input editor benchmark: launch an Electron editor with a CDP port and a
// throwaway profile, open the same large document, then click / type / drag in
// the same paragraphs and read latency from inside the page (Event Timing +
// pointerdown→2 frames + long tasks). Also checks whether text inside a
// <font> wrapper can take a caret and a partial selection.
// usage: BENCH_DOC=<file.md> BENCH_NEEDLES='["para A","para B","para C"]' \
//   BENCH_FONT='text inside a <font>' node scripts/perf/bench-editors.mjs \
//   <horsemd|obsidian> <app binary> <label> [cpu throttle]
// The needles are short phrases of three mid-document paragraphs of the test
// file (and one inside a <font> wrapper); nothing of the file is in the repo.
// HorseMD runs without --horsemd-input-trace unless TRACE=1 (users run it
// without). Writes result-<label>.json next to the run directory.
// Copy this file with scripts/lib/{cdp,human-input}.mjs to run on another
// machine (e.g. Windows: schtasks /it so the window is in the desktop session).
import { spawn } from 'node:child_process'
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, sleep } from '../lib/cdp.mjs'
import { typeTextLikeUser } from '../lib/human-input.mjs'

const [kind, bin, label, thrArg] = process.argv.slice(2)
const thr = Number(thrArg || 1)
const here = dirname(fileURLToPath(import.meta.url))
const run = join(here, `run-${label}-${Date.now()}`)
mkdirSync(run, { recursive: true })
const port = 9500 + Math.floor(Math.random() * 300)
const DOC = process.env.BENCH_DOC
const PLAIN = JSON.parse(process.env.BENCH_NEEDLES || '[]')
const FONT = process.env.BENCH_FONT || ''
if (!DOC || PLAIN.length !== 3) throw new Error('set BENCH_DOC and three BENCH_NEEDLES')
let args
if (kind === 'obsidian') {
  const vault = join(run, 'vault'); mkdirSync(vault, { recursive: true })
  copyFileSync(DOC, join(vault, 'doc.md'))
  const profile = join(run, 'profile'); mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { benchvault0001: { path: vault, ts: Date.now(), open: true } } }))
  args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`]
} else {
  copyFileSync(DOC, join(run, 'doc.md'))
  args = [`--user-data-dir=${join(run, 'profile')}`, `--remote-debugging-port=${port}`, join(run, 'doc.md')]
  if (kind === 'horsemd' && process.env.TRACE === '1') args.push('--horsemd-input-trace')
}
const child = spawn(bin, args, { stdio: 'ignore', detached: false })
const result = { kind, label, thr, ok: false }
const done = () => { writeFileSync(join(here, `result-${label}.json`), JSON.stringify(result, null, 1)); console.log(JSON.stringify(result)) }
let app
try {
  app = await connectCdp({ port, attempts: 160, intervalMs: 250 })
  const t0 = Date.now()
  if (kind === 'obsidian') {
    for (let i = 0; i < 200 && !(await app.evaluate('Boolean(window.app?.workspace?.layoutReady)')); i++) await sleep(250)
    await app.evaluate(`app.workspace.openLinkText('doc', '', false)`)
  }
  // Editor root: the editable element holding the most text.
  const ROOT = `(() => [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent).sort((a, b) => b.textContent.length - a.textContent.length)[0])()`
  for (let i = 0; i < 300; i++) { if (await app.evaluate(`(${ROOT})?.textContent?.includes(${JSON.stringify(PLAIN[0].slice(0, 6))}) || (${ROOT})?.textContent?.length > 20000`)) break; await sleep(200) }
  result.openMs = Date.now() - t0
  await sleep(6000)
  result.info = await app.evaluate(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, elements: document.querySelectorAll('*').length, rootChars: (${ROOT})?.textContent.length })`)
  if (thr !== 1) await app.send('Emulation.setCPUThrottlingRate', { rate: thr })
  // Bring the target paragraph into the DOM and view; return click points.
  const locate = (needle) => app.evaluate(`(async () => {
    const needle = ${JSON.stringify(needle)}
    if (${kind === 'obsidian'}) {
      const ed = app.workspace.activeEditor?.editor
      for (let i = 0; i < ed.lineCount(); i++) if (ed.getLine(i).includes(needle)) { ed.scrollIntoView({ from: { line: i, ch: 0 }, to: { line: i, ch: 0 } }, true); break }
      await new Promise(r => setTimeout(r, 300))
    }
    const root = ${ROOT}
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walk.nextNode())) if (node.data.includes(needle)) break
    if (!node) return null
    const block = node.parentElement.closest('p, li, .cm-line, div') || node.parentElement
    block.scrollIntoView({ block: 'center' })
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const r = document.createRange(); r.selectNodeContents(block)
    const rects = [...r.getClientRects()].filter(x => x.width > 2)
    const first = rects[0], last = rects[rects.length - 1]
    const t = document.createRange(); t.setStart(node, node.data.indexOf(needle) + 3); t.setEnd(node, node.data.indexOf(needle) + 4)
    const mid = t.getBoundingClientRect()
    return { endX: last.right - 2, endY: last.top + last.height / 2, x: mid.left + 1, y: mid.top + mid.height / 2, startX: first.left + 30, startY: first.top + first.height / 2 }
  })()`)
  const frame = () => app.evaluate(`new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)))`)
  await app.evaluate(`window.__ev=[];window.__lt=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__ev.push({n:e.name,d:Math.round(e.duration)})}).observe({type:'event',durationThreshold:16});new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))}).observe({type:'longtask'});true`)
  const take = () => app.evaluate(`(()=>{const by={};for(const e of window.__ev)(by[e.n]??=[]).push(e.d);const s={};for(const k of ['pointerdown','keydown','beforeinput','input','pointermove']){const v=(by[k]||[]).sort((a,b)=>a-b);if(v.length)s[k]={n:v.length,p50:v[v.length>>1],p90:v[Math.floor(v.length*0.9)],max:v.at(-1)}};const lt=window.__lt;window.__ev=[];window.__lt=[];return {events:s,longTasks:lt.length,longTaskMs:lt.reduce((a,b)=>a+b,0),longTaskMax:Math.max(0,...lt)}})()`)
  const click = async (x, y) => {
    await app.evaluate(`window.__clk={};addEventListener('pointerdown',()=>{window.__clk.t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__clk.ms=Math.round(performance.now()-window.__clk.t)}))},{once:true,capture:true});true`)
    for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    await frame(); await sleep(300)
    return app.evaluate('window.__clk.ms ?? null')
  }
  // 1) click at end of a mid-document paragraph, type 20 letters
  let p = await locate(PLAIN[1]); await sleep(500)
  result.firstClick = await click(p.endX, p.endY); await sleep(600); await take()
  await typeTextLikeUser(app.send, 'abcdefghijklmnopqrst', { delayMs: 100 })
  await sleep(3000)
  result.typing = await take()
  result.typedLanded = await app.evaluate(`(${ROOT}).textContent.includes('abcdefghijklmnopqrst')`)
  // 2) far clicks + drags
  result.clicks = []; result.drags = []
  for (const needle of [PLAIN[0], PLAIN[2], PLAIN[1]]) {
    p = await locate(needle); await sleep(600)
    result.clicks.push(await click(p.startX, p.startY)); await sleep(400)
    const sx = p.startX + 40
    const t = Date.now()
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: p.startY, button: 'left', clickCount: 1 }); await frame()
    for (let k = 1; k <= 6; k++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + k * 30, y: p.startY, button: 'left', buttons: 1 }); await frame() }
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx + 180, y: p.startY, button: 'left', clickCount: 1 }); await frame()
    result.drags.push({ ms: Date.now() - t, selected: await app.evaluate('getSelection().toString().length') })
    await sleep(600)
  }
  await sleep(1500)
  result.clicking = await take()
  // 3) text inside <font>: caret + partial selection
  p = FONT ? await locate(FONT) : null
  if (p) {
    await sleep(500); await click(p.x, p.y); await sleep(300)
    result.fontClick = await app.evaluate(`(() => { const s = getSelection(); return { collapsed: s.isCollapsed, selectedChars: s.toString().length, anchorIsText: s.anchorNode?.nodeType === 3 } })()`)
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    for (let k = 1; k <= 4; k++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + k * 15, y: p.y, button: 'left', buttons: 1 }); await sleep(40) }
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 60, y: p.y, button: 'left', clickCount: 1 }); await sleep(300)
    result.fontDrag = await app.evaluate(`getSelection().toString().length`)
  } else result.fontClick = 'font paragraph not found'
  result.warn = await app.evaluate(`[...document.querySelectorAll('[class*=toast]')].map(n=>n.innerText).filter(t=>/不一致|未被覆盖/.test(t)).length`)
  result.ok = true
} catch (error) {
  result.error = String(error?.stack || error).slice(0, 800)
} finally {
  done()
  try { app?.ws?.close() } catch {}
  try { process.kill(child.pid, 'SIGKILL') } catch {}
  process.exit(0)
}
