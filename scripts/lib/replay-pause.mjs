// Replay a fuzz pause offline: rebuild the paused editor document from the
// report snapshot, run the reprint engine on the committed source, and show
// where the result differs.
//   node scripts/lib/replay-pause.mjs /tmp/horsemd-fuzz/<out>/seed-N
import { readFileSync } from 'node:fs'
import { open } from './probe-session.mjs'
const report = JSON.parse(readFileSync(`${process.argv[2]}/report.json`, 'utf8'))
const pause = report.firstPause
if (!pause?.liveDoc || typeof pause.liveSource !== 'string') {
  console.log('no snapshot in report')
  process.exit(0)
}
// Milkdown stores list_item.spread as a string at runtime; the schema check
// in nodeFromJSON wants a boolean. Spread is ignored by the engine anyway.
const normalizeJson = (node) => {
  if (!node || typeof node !== 'object') return node
  if (node.attrs && typeof node.attrs.spread === 'string') {
    node.attrs = { ...node.attrs, spread: node.attrs.spread === 'true' }
  }
  for (const child of node.content || []) normalizeJson(child)
  return node
}
normalizeJson(pause.liveDoc)
const s = await open('replay-pause', 'x\n', 9992)
try {
  const out = await s.app.evaluate(`((json, source) => {
    const h = globalThis.__hmSourceReprintHarness
    globalThis.__hmSourceIntegrityDiffTrace = []
    const doc = h.docFromJSON(json)
    const result = h.reprint(source, doc)
    const diff = globalThis.__hmSourceIntegrityDiffTrace.slice(-1)[0] || null
    // first differing region between source and attempt
    const a = source, b = result.markdown || ''
    let i = 0; while (i < a.length && a[i] === b[i]) i++
    let ea = a.length, eb = b.length; while (ea > i && eb > i && a[ea-1] === b[eb-1]) { ea--; eb-- }
    return JSON.stringify({ ok: result.ok, verified: result.verified, reason: result.reason, notes: result.notes,
      sourceWindow: a.slice(Math.max(0,i-80), ea+40), attemptWindow: b.slice(Math.max(0,i-80), eb+40), diff })
  })(${JSON.stringify(pause.liveDoc)}, ${JSON.stringify(pause.liveSource)})`)
  const parsed = JSON.parse(out)
  console.log('seed', report.seed, 'op', pause.opIndex, pause.op)
  console.log('result', parsed.ok, parsed.verified, parsed.reason, JSON.stringify(parsed.notes))
  console.log('source ', JSON.stringify(parsed.sourceWindow))
  console.log('attempt', JSON.stringify(parsed.attemptWindow))
  console.log('diff   ', JSON.stringify(parsed.diff))
} finally { await s.close() }
