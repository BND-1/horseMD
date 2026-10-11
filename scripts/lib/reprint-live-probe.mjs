// Edit in the live editor, then compare srcDoc vs liveDoc and run reprint.
import { open, sleep } from './probe-session.mjs'
const s = await open('reprint-live', process.env.DOC)
try {
  await s.app.evaluate(`globalThis.__probeInitialSource = globalThis.__hmSourceReprintHarness.liveSource()`)
  await s.clickText(process.env.CLICK ?? '5', Number(process.env.OFF ?? 1))
  for (const part of (process.env.TYPE ?? 'key:Backspace').split('|')) { if (part.startsWith('key:')) { await s.key(part.slice(4)); await sleep(150) } else await s.type(part) }
  await sleep(900)
  console.log(await s.app.evaluate(`(() => {
    const h = globalThis.__hmSourceReprintHarness
    const src = globalThis.__probeInitialSource; const live = h.liveDoc(); const parsed = h.parse(src)
    const diffs = []
    const walk = (a, b, path) => {
      if (!a || !b) { diffs.push(path + ' missing'); return }
      if (a.type.name !== b.type.name) { diffs.push(path + ' type ' + a.type.name + '/' + b.type.name); return }
      if (JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) diffs.push(path + ' attrs ' + JSON.stringify(a.attrs) + ' vs ' + JSON.stringify(b.attrs))
      if (a.isText) { if (a.text !== b.text || !a.sameMarkup(b)) diffs.push(path + ' text ' + JSON.stringify(a.text) + ' vs ' + JSON.stringify(b.text)); return }
      if (a.childCount !== b.childCount) diffs.push(path + ' count ' + a.childCount + '/' + b.childCount)
      for (let i = 0; i < Math.min(a.childCount, b.childCount); i++) walk(a.child(i), b.child(i), path + '/' + i + a.child(i).type.name)
    }
    walk(parsed, live, 'doc')
    const out = h.reprint(src, live)
    return JSON.stringify({ diffs: diffs.slice(0, 12), ok: out.ok, verified: out.verified, notes: out.notes, same: out.markdown === h.liveSource(), reprinted: out.markdown?.slice(Number(globalThis.__probeSlice||0)), current: h.liveSource().slice(Number(globalThis.__probeSlice||0)) }, null, 1)
  })()`))
} finally { await s.close() }
