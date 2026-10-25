// Differential test of the incremental serializer (lib/incremental-serialize.js)
// in the real editor: seeded random edits to large documents (built with a
// ProseMirror Transform, not dispatched), and after every step the editor's
// serializer (memo → incremental) must return exactly the bytes of a full
// serialization. Covers: text insert / delete, cross-block delete, split,
// join, heading level, bold / italic, whole-block insert / delete (start,
// middle, end), wrapping in a list, adjacent lists of the same and different
// kinds, an empty paragraph at the end, and re-serializing older documents.
// Also checks that the incremental path was really used and never disabled.
// Extra document: HM_INCREMENTAL_SERIALIZE_DOC=<file.md> (e.g. a real export).
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-incremental-serialize-${process.pid}`
const port = Number(process.env.CDP_PORT || 9560 + (process.pid % 40))
const STEPS = Number(process.env.STEPS || 300)
const SEEDS = (process.env.SEEDS || '1,2,3').split(',').map(Number)

const fixture = () => {
  const out = ['# 大文档 fixture', '']
  for (let i = 0; i < 40; i += 1) {
    out.push(`## 第 ${i} 节 Section`, '')
    out.push(`<font style="color:rgb(0, 0, 0);">第 ${i} 段 **加粗** 和 *斜体*，还有 \`code ${i}\` 与 [链接](https://example.com/${i})。</font>`, '')
    out.push(`Plain paragraph ${i} with ==mark== and ~~del~~ text.`, '')
    if (i % 3 === 0) out.push(`- item a${i}`, `- item b${i}`, '', `1. one ${i}`, `2. two ${i}`, '')
    if (i % 4 === 1) out.push(`- [ ] task ${i}`, `- [x] done ${i}`, '')
    if (i % 5 === 2) out.push('| A | B |', '| --- | --- |', `| ${i} | x |`, '')
    if (i % 6 === 3) out.push('```js', `const v${i} = ${i}`, '```', '')
    if (i % 7 === 4) out.push(`> quote ${i}`, '> second line', '')
    if (i % 8 === 5) out.push(`![img ${i}](https://example.com/${i}.png)`, '')
    if (i % 9 === 6) out.push('<div align="center">html block</div>', '')
    if (i % 5 === 0) out.push('<br />', '')
    if (i % 10 === 7) out.push('---', '')
  }
  out.push('最后一段。', '')
  return out.join('\n')
}

// In-page: seeded random edit chain; returns comparison counts.
const chain = (seed, steps) => `(async () => {
  const h = globalThis.__hmSourceReprintHarness
  let s = ${seed} >>> 0
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const schema = h.schema()
  let doc = h.liveDoc()
  const history = [doc]
  const textPositions = (d) => { const xs = []; d.descendants((n, pos) => { if (n.isTextblock && n.type.name !== 'code_block') xs.push({ pos: pos + 1, end: pos + 1 + n.content.size, node: n }) }); return xs }
  const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
  const list = (type) => { const li = schema.nodes.list_item.create(null, para('new ' + type)); return schema.nodes[type].create(null, li) }
  const ops = [
    ['insert-text', (tr) => { const t = pick(textPositions(tr.doc)); if (!t) return; const at = t.pos + Math.floor(rnd() * (t.end - t.pos + 1)); const $at = tr.doc.resolve(at); tr.insert(at, schema.text(pick(['x', '中', ' ', '*', '<', '1. ', '#', '\\\\', '_']), $at.marks())) }],
    ['delete-text', (tr) => { const t = pick(textPositions(tr.doc)); if (!t || t.end === t.pos) return; const a = t.pos + Math.floor(rnd() * (t.end - t.pos)); tr.delete(a, Math.min(t.end, a + 1 + Math.floor(rnd() * 3))) }],
    ['cross-delete', (tr) => { const xs = textPositions(tr.doc); if (xs.length < 3) return; const i = Math.floor(rnd() * (xs.length - 2)); const a = xs[i].end - Math.min(2, xs[i].end - xs[i].pos); const b = xs[i + 1].pos + Math.min(1, xs[i + 1].end - xs[i + 1].pos); try { tr.delete(a, b) } catch {} }],
    ['split', (tr) => { const t = pick(textPositions(tr.doc)); if (!t) return; try { tr.split(t.pos + Math.floor(rnd() * (t.end - t.pos + 1))) } catch {} }],
    ['heading', (tr) => { const t = pick(textPositions(tr.doc)); if (!t) return; const $p = tr.doc.resolve(t.pos); if ($p.depth !== 1) return; const toHeading = t.node.type.name === 'paragraph'; try { tr.setBlockType(t.pos, t.pos, toHeading ? schema.nodes.heading : schema.nodes.paragraph, toHeading ? { level: 1 + Math.floor(rnd() * 3) } : null) } catch {} }],
    ['mark', (tr) => { const t = pick(textPositions(tr.doc)); if (!t || t.end - t.pos < 2) return; const a = t.pos + Math.floor(rnd() * (t.end - t.pos - 1)); const m = pick(['strong', 'emphasis']); const type = schema.marks[m]; if (!type) return; if (rnd() < 0.5) tr.addMark(a, a + 2, type.create()); else tr.removeMark(t.pos, t.end, type) }],
    ['insert-block', (tr) => { const n = tr.doc.childCount; const i = pick([0, n, Math.floor(rnd() * (n + 1))]); let pos = 0; for (let k = 0; k < i; k += 1) pos += tr.doc.child(k).nodeSize; tr.insert(pos, pick([para('inserted'), para(''), list('bullet_list'), list('ordered_list')])) }],
    ['delete-block', (tr) => { const n = tr.doc.childCount; if (n < 4) return; const i = pick([0, n - 1, Math.floor(rnd() * n)]); let pos = 0; for (let k = 0; k < i; k += 1) pos += tr.doc.child(k).nodeSize; const c = 1 + Math.floor(rnd() * 2); let end = pos; for (let k = i; k < Math.min(n - 1, i + c); k += 1) end += tr.doc.child(k).nodeSize; if (end > pos) tr.delete(pos, end) }],
    ['wrap-list', (tr) => { const t = pick(textPositions(tr.doc)); if (!t) return; const $p = tr.doc.resolve(t.pos); if ($p.depth !== 1 || t.node.type.name !== 'paragraph') return; const range = $p.blockRange(); if (!range) return; try { tr.wrap(range, [{ type: schema.nodes[pick(['bullet_list', 'ordered_list'])] }, { type: schema.nodes.list_item }]) } catch {} }],
    ['adjacent-list', (tr) => { let pos = 0; for (let k = 0; k < tr.doc.childCount; k += 1) { const c = tr.doc.child(k); pos += c.nodeSize; if (/_list$/.test(c.type.name) && rnd() < 0.3) { tr.insert(pos, list(pick(['bullet_list', 'ordered_list']))); return } } }],
    ['empty-end', (tr) => { tr.insert(tr.doc.content.size, para('')) }],
    ['type-at-end', (tr) => { const last = tr.doc.lastChild; if (last?.isTextblock) tr.insert(tr.doc.content.size - 1, schema.text('末')) }]
  ]
  let compared = 0
  const bad = []
  const counts = {}
  for (let step = 0; step < ${steps}; step += 1) {
    const [name, apply] = pick(ops)
    const tr = h.newTransform(doc)
    try { apply(tr) } catch (error) { continue }
    if (!tr.docChanged) continue
    counts[name] = (counts[name] || 0) + 1
    doc = tr.doc
    history.push(doc)
    const target = rnd() < 0.08 && history.length > 3 ? history[history.length - 2 - Math.floor(rnd() * Math.min(5, history.length - 2))] : doc
    const wideBefore = h.incrementalSerializeStats().wideWindows || 0
    const got = h.serialize(target)
    if ((h.incrementalSerializeStats().wideWindows || 0) > wideBefore) (globalThis.__wideOps ??= []).push({ step, name, older: target !== doc })
    const want = h.serializeFull(target)
    compared += 1
    if (got !== want) {
      let d = 0; while (d < got.length && got[d] === want[d]) d += 1
      bad.push({ step, name, at: d, got: JSON.stringify(got.slice(Math.max(0, d - 40), d + 60)), want: JSON.stringify(want.slice(Math.max(0, d - 40), d + 60)) })
      if (bad.length >= 3) break
    }
    if (step % 3 === 0) await new Promise((r) => setTimeout(r, 120)) // idle time, as between real edits
  }
  return { compared, bad, counts, stats: h.incrementalSerializeStats(), wideOps: (globalThis.__wideOps || []).slice(0, 12) }
})()`

let app = null
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const docs = [['fixture.md', fixture()]]
  if (process.env.HM_INCREMENTAL_SERIALIZE_DOC) docs.push(['real.md', await readFile(process.env.HM_INCREMENTAL_SERIALIZE_DOC, 'utf8')])
  for (const [name, text] of docs) await writeFile(join(root, name), text)
  let total = 0
  let incremental = 0
  for (const [name] of docs) {
    app = await launchBuiltElectron({ profileDir: join(root, `profile-${name}`), port, appArgs: [join(root, name)] })
    await app.send('Runtime.enable')
    for (let i = 0; i < 100 && !(await app.evaluate('Boolean(globalThis.__hmSourceReprintHarness?.liveDoc()?.childCount > 64)')); i++) await sleep(200)
    // Serialize once, then wait for the idle bootstrap.
    await app.evaluate('globalThis.__hmSourceReprintHarness.serialize(globalThis.__hmSourceReprintHarness.liveDoc()), true')
    for (let i = 0; i < 100 && !((await app.evaluate('globalThis.__hmSourceReprintHarness.incrementalSerializeStats().bootstraps')) > 0); i++) await sleep(100)
    for (const seed of SEEDS) {
      // Each seed restarts from the live document: serialize it (it is the
      // primary document, so the serializer rebases on it) and let the
      // idle bootstrap finish, as after opening the file.
      const before = await app.evaluate('globalThis.__hmSourceReprintHarness.incrementalSerializeStats().bootstraps || 0')
      if (seed !== SEEDS[0]) await app.evaluate('globalThis.__hmSourceReprintHarness.incrementalSerializeRebase()')
      for (let i = 0; i < 100 && (await app.evaluate('globalThis.__hmSourceReprintHarness.incrementalSerializeStats().bootstraps || 0')) <= before && seed !== SEEDS[0]; i++) await sleep(100)
      const r = await app.evaluate(chain(seed, STEPS))
      console.log(name, 'seed', seed, JSON.stringify({ compared: r.compared, stats: r.stats }), JSON.stringify(r.counts))
      if (process.env.SHOW_WIDE === '1') console.log('wide ops', JSON.stringify(r.wideOps))
      assert.deepEqual(r.bad, [], `${name} seed ${seed}: incremental != full\n${JSON.stringify(r.bad, null, 1)}`)
      assert.equal(r.stats.enabled, true, 'incremental serializer was disabled')
      total += r.compared
      incremental = r.stats.incremental
      // Correct is not enough: windows must stay local (wide segments are
      // re-split at idle time). 20%, not less: the adjacent-list op stacks
      // lists into long runs, which never split (bullets alternate across
      // adjacent lists); real documents have short runs (≤ 8 in a 250 K-char
      // export). Catches segments that are never refined (every window the
      // whole document).
      if (process.env.NO_WIDE_ASSERT !== '1') assert.ok((r.stats.wideWindows || 0) <= r.stats.incremental * 0.2, `too many wide windows: ${r.stats.wideWindows} of ${r.stats.incremental}`)
    }
    assert.ok(incremental > total / 4, `incremental path barely used (${incremental} of ${total})`)
    await stopBuiltElectron(app)
    app = null
  }
  console.log(`PASS incremental serialize: ${total} comparisons, identical to full serialization`)
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
