// CPU profile of the rich->source sync on a large document (built app, out/).
// usage: node scripts/perf/profile-sync.mjs <file.md> <out.cpuprofile>
//   default: one warm-up burst, then three profiled bursts with 3 s pauses
//   COLD=1:  one profiled burst right after opening (first-edit cost)
// Prints the long tasks seen while profiling and the sync warm-up status.
// Summarize with: python3 scripts/perf/cpuprofile-summary.py <out.cpuprofile>
import { writeFileSync } from 'node:fs'
import { mkdtemp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const R = new URL('../lib/', import.meta.url).href
const { launchBuiltElectron, stopBuiltElectron } = await import(R + 'electron-test-app.mjs')
const { sleep } = await import(R + 'cdp.mjs')
const { typeTextLikeUser } = await import(R + 'human-input.mjs')
const root = await mkdtemp(join(tmpdir(), 'hm-sync-'))
const file = join(root, 'doc.md'); await copyFile(process.argv[2], file)
const out = process.argv[3]
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: 27100 + process.pid % 200, appArgs: process.env.TRACE ? [file, '--horsemd-input-trace'] : [file] })
const ed = "[...document.querySelectorAll('.ProseMirror')].find(e => e.offsetParent)"
try {
  for (let i = 0; i < 150; i++) { if (await app.evaluate(`(${ed})?.querySelectorAll('p').length > 200`)) break; await sleep(100) }
  await sleep(5000)
  const pt = await app.evaluate(`(() => { const ps=[...(${ed}).querySelectorAll(':scope > p')].filter(p=>p.textContent.length>30); const p=ps[Math.floor(ps.length/2)]; p.scrollIntoView({block:'center'}); const r=document.createRange(); r.selectNodeContents(p); const rs=r.getClientRects(); return {x:rs[rs.length-1].right-2,y:rs[rs.length-1].top+4} })()`)
  await sleep(500)
  for (const type of ['mousePressed','mouseReleased']) await app.send('Input.dispatchMouseEvent',{type,x:pt.x,y:pt.y,button:'left',clickCount:1})
  await sleep(500)
  if (!process.env.COLD) { await typeTextLikeUser(app.send, 'warm', { delayMs: 120 }); await sleep(3000) }
  await app.evaluate(`window.__lt=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))}).observe({type:'longtask'});true`)
  await app.send('Profiler.enable'); await app.send('Profiler.setSamplingInterval', { interval: 200 }); await app.send('Profiler.start')
  for (const w of (process.env.COLD ? ['abcdefghijklmnopqrst'] : ['abc', 'def', 'ghi'])) { await typeTextLikeUser(app.send, w, { delayMs: 120 }); await sleep(3000) }
  const r = await app.send('Profiler.stop'); writeFileSync(out, JSON.stringify(r.profile || r.result?.profile))
  console.log('warm', JSON.stringify(await app.evaluate('[globalThis.__hmSyncWarmup || null, globalThis.__hmSyncWarmupSize ?? null]')))
  const lt = await app.evaluate('window.__lt')
  const warn = await app.evaluate(`[...document.querySelectorAll('[class*=toast]')].map(n=>n.innerText).filter(t=>/不一致|未被覆盖/.test(t))`)
  console.log(JSON.stringify({ longtasks: lt, warn }))
} finally { await stopBuiltElectron(app, { removeProfile: true }) }
