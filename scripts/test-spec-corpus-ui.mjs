// The CommonMark 0.31.2 spec examples (652) and the GFM extension examples
// (24) as a corpus for the real Crepe editor (`__hmSourceReprintHarness`):
//
//   1. an unchanged document reprints to its exact bytes;
//   2. one character typed or deleted at the start / middle / end of every
//      text block reprints, verifies against the editor document, and
//      changes nothing outside the top-level block it is in;
//   3. (reported, not asserted) the full serialization of the document
//      parses back to it — what a new document / Copy as Markdown write.
//
// Fixtures: scripts/fixtures/commonmark-spec-0.31.2.json
// (https://spec.commonmark.org/0.31.2/spec.json) and
// scripts/fixtures/gfm-spec-extensions.json (the `example <ext>` blocks of
// https://github.com/github/cmark-gfm/blob/master/test/spec.txt), both
// CC BY-SA 4.0 (John MacFarlane; GitHub) — see scripts/fixtures/README.md.
//
//   ONLY=123    one CommonMark example (by number)
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const commonmark = JSON.parse(await readFile(new URL('./fixtures/commonmark-spec-0.31.2.json', import.meta.url), 'utf8'))
const gfm = JSON.parse(await readFile(new URL('./fixtures/gfm-spec-extensions.json', import.meta.url), 'utf8'))
const only = process.env.ONLY ? Number(process.env.ONLY) : null
const examples = [
  ...commonmark.filter((e) => only == null || e.example === only).map((e) => ({ id: `cm${e.example}`, section: e.section, markdown: e.markdown })),
  ...(only == null ? gfm.map((e, i) => ({ id: `gfm-${e.extension}-${i + 1}`, section: e.section, markdown: e.markdown })) : [])
]

const root = await mkdtemp(join(tmpdir(), 'horsemd-spec-corpus-'))
const file = join(root, 'doc.md')
await writeFile(file, 'x\n')
const port = 29790 + process.pid % 90
let app = null

const PAGE = String.raw`(examples) => {
  const H = globalThis.__hmSourceReprintHarness
  const out = []
  // Common prefix / suffix of two strings: the changed source range.
  const changed = (a, b) => {
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1
    let end = 0
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1
    return { from: start, to: a.length - end }
  }
  for (const example of examples) {
    const source = example.markdown
    const result = { id: example.id, section: example.section, fails: [], canonical: null }
    let base
    try { base = H.parse(source) } catch (e) { result.fails.push({ what: 'parse threw', why: String(e.message) }); out.push(result); continue }
    // 1. Unchanged.
    try {
      const r = H.reprint(source, base)
      if (!r.ok || r.markdown !== source) result.fails.push({ what: 'unchanged', why: r.reason || 'bytes changed', printed: String(r.markdown).slice(0, 300) })
    } catch (e) { result.fails.push({ what: 'unchanged threw', why: String(e.message) }) }
    // 3. Canonical round trip (reported).
    try {
      const md = H.serialize(base)
      result.canonical = H.equivalent(md, base) ? 'ok' : md.slice(0, 300)
    } catch (e) { result.canonical = 'threw ' + e.message }
    // The top-level block (doc child) around a position, and its source
    // range from the mdast of the source.
    let tree = null
    try { const r = H.remark(); tree = r.runSync(r.parse(source), source) } catch {}
    const topRanges = (tree?.children || []).map((n) => [n.position?.start?.offset, n.position?.end?.offset])
    // 2. Edits.
    const edits = []
    base.descendants((node, pos) => {
      if (!node.isTextblock) return true
      const size = node.content.size
      const at = [0, Math.floor(size / 2), size]
      for (const offset of new Set(at)) edits.push({ kind: 'insert', pos: pos + 1 + offset })
      if (size > 0) edits.push({ kind: 'delete', pos: pos + 1 + Math.floor(size / 2) })
      return false
    })
    for (const edit of edits) {
      let doc
      try {
        const tr = H.newTransform(base)
        if (edit.kind === 'insert') tr.insertText('Z', edit.pos)
        else {
          const $pos = tr.doc.resolve(edit.pos)
          const node = $pos.parent.childAfter($pos.parentOffset).node
          if (!node || !node.isText) continue
          tr.delete(edit.pos, edit.pos + 1)
        }
        doc = tr.doc
      } catch { continue }
      let r
      try { r = H.reprint(source, doc) } catch (e) { result.fails.push({ what: edit.kind + '@' + edit.pos, why: 'threw ' + e.message }); continue }
      if (!r.ok) { result.fails.push({ what: edit.kind + '@' + edit.pos, why: r.reason, printed: String(r.markdown || '').slice(0, 300) }); continue }
      if (!H.equivalentForReprint(r.markdown, doc)) { result.fails.push({ what: edit.kind + '@' + edit.pos, why: 'not equivalent', printed: r.markdown.slice(0, 300) }); continue }
      // Locality: the change stays inside the top-level block of the edit.
      const index = base.resolve(Math.min(edit.pos, base.content.size)).index(0)
      const range = topRanges[index]
      const diff = changed(source, r.markdown)
      if (range && Number.isInteger(range[0]) && diff.from < diff.to && (diff.from < range[0] || diff.to > range[1])) {
        result.fails.push({ what: edit.kind + '@' + edit.pos, why: 'changed outside its block [' + range + '] at [' + diff.from + ',' + diff.to + ']', printed: r.markdown.slice(0, 300) })
      }
    }
    out.push(result)
  }
  return out
}`

try {
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
  for (let i = 0; i < 150; i += 1) {
    if (await app.evaluate('!!globalThis.__hmSourceReprintHarness?.liveDoc()')) break
    await sleep(100)
  }
  await sleep(800)
  const results = []
  for (let i = 0; i < examples.length; i += 40) {
    results.push(...await app.evaluate(`(${PAGE})(${JSON.stringify(examples.slice(i, i + 40))})`))
  }
  const failing = results.filter((r) => r.fails.length)
  const canonicalBad = results.filter((r) => r.canonical !== 'ok')
  const out = join(tmpdir(), 'horsemd-spec-corpus.json')
  await writeFile(out, JSON.stringify({ failing, canonicalBad: canonicalBad.map((r) => ({ id: r.id, section: r.section, canonical: r.canonical })) }, null, 1))
  const bySection = failing.reduce((o, r) => ((o[r.section] = (o[r.section] || 0) + 1), o), {})
  console.log(`${results.length} examples; ${failing.length} with failures ${JSON.stringify(bySection)}; canonical round trip not exact: ${canonicalBad.length} (reported only); details: ${out}`)
  for (const r of failing.slice(0, 8)) console.log(' ', r.id, r.section, JSON.stringify(r.fails[0]).slice(0, 400))
  assert.equal(failing.length, 0, `${failing.length} spec examples fail`)
  console.log(`PASS spec corpus: ${results.length} CommonMark / GFM spec examples reprint unchanged to their bytes; typing / deleting at the start, middle and end of every text block reprints, verifies and stays inside its block`)
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
