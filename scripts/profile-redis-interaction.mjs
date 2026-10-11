import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { createTransactionTraceDecoder } from '../src/renderer/src/components/editor-transaction-trace.js'

const input = process.env.REDIS_INPUT_PATH || new URL('./fixtures/redis-tight/start.md', import.meta.url)
const original = await readFile(input, 'utf8')
const root = await mkdtemp(join(tmpdir(), 'horsemd-redis-profile-'))
const probe = 'HorseMD性能探针。'
const initial = probe + '\n\n' + original
const typed = 'abcdefghijklmnopqrstuvwx'
const editor = "([...document.querySelectorAll('.ProseMirror')].find(n => n.offsetParent))"
const modes = (process.env.TRACE_MODES || 'off,on').split(',')
const waitFor = async (check, label) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(label)
}
const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0)
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) }
}
for (let index = 0; index < modes.length; index++) {
  const mode = modes[index]
  const file = join(root, mode + '.md')
  await writeFile(file, initial)
  const app = await launchBuiltElectron({
    profileDir: join(root, 'profile-' + mode),
    port: Number(process.env.CDP_PORT || 25200 + process.pid % 200) + index,
    appArgs: [file, ...(mode === 'on' ? ['--horsemd-input-trace'] : [])]
  })
  try {
    await waitFor(() => app.evaluate(`(${editor}?.textContent || '').includes('捐赠')`), 'full document did not mount')
    await sleep(3000)
    assert.equal(await app.evaluate(`(() => {
      const e = ${editor}
      const p = [...e.querySelectorAll('p')].find(n => n.textContent === ${JSON.stringify(probe)})
      if (!p) return false
      p.scrollIntoView({ block: 'center' })
      const r = document.createRange(); r.selectNodeContents(p); r.collapse(false)
      const s = getSelection(); s.removeAllRanges(); s.addRange(r)
      e.focus()
      return true
    })()`), true)
    await sleep(600)
    const traceInfo = await app.evaluate('window.api.getInputTraceInfo()')
    const traceStartBytes = traceInfo.enabled ? (await stat(traceInfo.path)).size : 0
    await app.send('Performance.enable')
    await app.send('Profiler.enable')
    await app.send('Profiler.start')
    const metricsBefore = (await app.send('Performance.getMetrics')).result.metrics
    await app.evaluate(`(() => {
      const d = window.__redisProfile = { input: [], frame: [], gaps: [], longtasks: [], phases: [], last: performance.now() }
      const e = ${editor}
      e.addEventListener('beforeinput', () => { d.before = performance.now() }, true)
      e.addEventListener('input', () => {
        const start = d.before
        if (start == null) return
        d.input.push(performance.now() - start)
        requestAnimationFrame(() => { d.frame.push(performance.now() - start) })
      })
      d.timer = setInterval(() => { const now = performance.now(); d.gaps.push(now - d.last); d.last = now }, 16)
      d.observer = new PerformanceObserver(list => { for (const e of list.getEntries()) d.longtasks.push({ start: e.startTime, duration: e.duration }) })
      d.observer.observe({ type: 'longtask', buffered: false })
      d.started = performance.now()
      return true
    })()`)
    const roundtrips = []
    for (const character of typed) {
      const start = performance.now()
      await app.send('Input.insertText', { text: character })
      roundtrips.push(performance.now() - start)
      await sleep(90)
    }
    await app.evaluate('window.__redisProfile.typingEnded = performance.now()')
    await sleep(3000)
    const profile = (await app.send('Profiler.stop')).result.profile
    const metricsAfter = (await app.send('Performance.getMetrics')).result.metrics
    const measurements = await app.evaluate(`(() => {
      const d = window.__redisProfile
      clearInterval(d.timer); d.observer.disconnect()
      return { input: d.input, frame: d.frame, gaps: d.gaps, longtasks: d.longtasks, started: d.started, typingEnded: d.typingEnded, ended: performance.now(), domNodes: ${editor}.querySelectorAll('*').length }
    })()`)
    await writeFile(join(root, mode + '.cpuprofile'), JSON.stringify(profile))
    const byId = new Map(profile.nodes.map(n => [n.id, n]))
    const self = new Map()
    for (let i = 0; i < (profile.samples || []).length; i++) {
      const id = profile.samples[i]
      self.set(id, (self.get(id) || 0) + (profile.timeDeltas?.[i] || 0))
    }
    const hottest = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([id, us]) => {
      const f = byId.get(id).callFrame
      return { name: f.functionName, ms: Math.round(us / 1000), file: f.url.split('/').at(-1), line: f.lineNumber + 1 }
    })
    const before = Object.fromEntries(metricsBefore.map(m => [m.name, m.value]))
    const deltas = Object.fromEntries(metricsAfter.filter(m => /Duration|Count$/.test(m.name)).map(m => [m.name, +(m.value - (before[m.name] || 0)).toFixed(4)]))
    const traceBytes = traceInfo.enabled ? (await stat(traceInfo.path)).size - traceStartBytes : 0
    const result = { mode, characters: initial.length, domNodes: measurements.domNodes, inputMs: quantiles(measurements.input), nextRafMs: quantiles(measurements.frame), cdpRoundtripMs: quantiles(roundtrips), eventLoopGapMs: quantiles(measurements.gaps), longtasks: measurements.longtasks, metrics: deltas, traceBytesDuringEdit: traceBytes, hottest }
    console.log('MEASURE', JSON.stringify(result))
    await writeFile(join(root, mode + '.json'), JSON.stringify(result, null, 2))
    await waitFor(() => app.evaluate("Boolean(document.querySelector('.hm-save-fab'))"), 'save control missing')
    await app.evaluate("document.querySelector('.hm-save-fab').click()")
    const expected = initial.replace(probe, probe + typed)
    await waitFor(async () => (await readFile(file, 'utf8')) === expected, 'full disk bytes do not match intended edit')
    assert.equal(await readFile(input, 'utf8'), original, 'original document changed')
    if (traceInfo.enabled) {
      await app.evaluate("window.api.writeInputTrace({ type: 'profile-flush-barrier' })")
      const decode = createTransactionTraceDecoder()
      const previous = new Map()
      let reconstructed = 0
      for (const line of (await readFile(traceInfo.path, 'utf8')).split('\n').filter(Boolean)) {
        const event = decode(JSON.parse(line))
        if (event.type !== 'prosemirror-transactions') continue
        // Legacy logs have no editor identity; never join welcome-page and
        // document events under one synthetic identity. Current logs do.
        if (event.traceId) {
          const key = event.traceId
          if (previous.has(key)) assert.ok(isDeepStrictEqual(event.oldDoc, previous.get(key)), `trace document continuity lost for ${key}`)
          previous.set(key, event.newDoc)
        }
        reconstructed++
      }
      assert.ok(reconstructed >= typed.length, 'missing traced input transactions')
      console.log('TRACE_RECONSTRUCTED', reconstructed, 'complete consecutive document snapshots')
    }
    console.log('VERIFIED', mode, 'full disk bytes match; original unchanged')
  } finally {
    await stopBuiltElectron(app)
  }
}
console.log('Evidence retained:', root)
