// Inline mark combinations, systematically (real Crepe parser / serializer /
// validator / source reprint, `__hmSourceReprintHarness`):
//
//   every pair of marks (bold, italic, strike, inline code, the three
//   highlights, link, <kbd>, <u>, <font>; sub/superscript with the setting
//   on) laid over each other in every shape — the same range, inside,
//   across the start / end, around, next to, the whole block — in paragraphs,
//   headings, list / task / nested items, quotes (and lists in quotes) and
//   table cells, over CJK text, ASCII words, CJK punctuation, other blanks
//   (U+3000, NBSP, tab) and emoji / digits; partial removal of a mark;
//   images / formulas / line breaks inside the marked text; random triples;
//   and a second edit on the saved result ("authored" Markdown).
//
// Each case must (1) serialize to Markdown that parses back to the same
// document (what reopening shows), (2) reprint the source and verify against
// the document (the sync's first path), (3) serialize stably (saving again
// writes the same bytes).
//
// Before 2026-11-04 3 003 of the first 22 680 pair cases failed: blanks
// moved across text inside crossing marks (Milkdown's #moveSpaces), a mark on
// a blank only wrote `****`, `~~` next to CJK punctuation stayed literal, a
// link around inline code lost the code, highlight / strike edge blanks
// failed the check (#173 was the highlight-over-bold member of the family).
//
//   FULL=1      every context × text (default: a subset, ~1 min)
//   SEED=n      triples seed (default 173)
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const FULL = process.env.FULL === '1'
const SEED = Number(process.env.SEED || 173)
const CAP = Number(process.env.CAP || 40)
// PHASE=pairs|atoms|subsup: only that phase.
const PHASE = process.env.PHASE || ''
const runs = (name) => !PHASE || PHASE === name

const TEXTS = {
  cjk: '前文中文内容甲乙丙丁后文',
  ascii: 'lead alpha beta gamma tail',
  punct: '说「重点」内容，(more) x.',
  blanks: 'ab　cd ef\tgh ij kl',
  emoji: '数字123😀表情abc 456'
}
const ATOM_TEXTS = {
  image: 'ab ![i](a.png) cd 中文 ef',
  math: '前文 $x^2$ 后文 more',
  break: 'ab cd\\\nef gh ij'
}
const CONTEXTS = {
  paragraph: (t) => t,
  heading: (t) => `## ${t}`,
  bullet: (t) => `- ${t}`,
  ordered: (t) => `1. ${t}`,
  task: (t) => `- [ ] ${t}`,
  nested: (t) => `- a\n  - ${t}`,
  quote: (t) => `> ${t}`,
  quoteList: (t) => `> - ${t}`,
  headerCell: (t) => `| ${t} | b |\n| --- | --- |\n| c | d |`,
  bodyCell: (t) => `| a | b |\n| --- | --- |\n| ${t} | d |`
}
const QUICK_CONTEXTS = ['paragraph', 'heading', 'task', 'quoteList', 'bodyCell']

const root = await mkdtemp(join(tmpdir(), 'horsemd-mark-combos-'))
const file = join(root, 'doc.md')
// The templates for marks that only parsing can make (attrs from the source).
await writeFile(file, 'x <kbd>k</kbd> <u>u</u> <font color="red">f</font>\n')
const port = 29700 + process.pid % 90
let app = null

// Runs in the page. `job`: { cases, texts, contexts, marks, triples, seed, twoStage }.
const PAGE = String.raw`(job) => {
  const H = globalThis.__hmSourceReprintHarness
  const schema = H.schema()
  // Mark factories; <kbd>/<u>/<font> are taken from the template paragraph.
  const live = H.liveDoc()
  const spanMarks = {}
  live.descendants((n) => { for (const m of n.marks) if (m.type.name === 'html_span') spanMarks[m.attrs.tag] = m; return true })
  const M = {
    strong: () => schema.marks.strong.create(),
    emphasis: () => schema.marks.emphasis.create(),
    strike: () => schema.marks.strike_through.create(),
    code: () => schema.marks.inlineCode.create(),
    yellow: () => schema.marks.highlight.create({ color: 'yellow' }),
    red: () => schema.marks.highlight.create({ color: 'red' }),
    blue: () => schema.marks.highlight.create({ color: 'blue' }),
    link: () => schema.marks.link.create({ href: 'https://e.com/x', title: null }),
    link2: () => schema.marks.link.create({ href: 'https://e.com/y', title: null }),
    kbd: () => spanMarks.kbd,
    u: () => spanMarks.u,
    font: () => spanMarks.font,
    sub: () => schema.marks.subscript.create(),
    sup: () => schema.marks.superscript.create()
  }
  const marks = job.marks.filter((name) => M[name] && M[name]())
  let seed = job.seed
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const runsOf = (block) => { const out = []; block.descendants((n) => { if (n.isLeaf) out.push([n.isText ? n.text : '<' + n.type.name + '>', n.marks.map((m) => m.type.name + (m.attrs.color ? ':' + m.attrs.color : '') + (m.attrs.tag ? ':' + m.attrs.tag : '')).sort().join('+')]); return true }); return JSON.stringify(out) }
  // The target text block and a char-offset → position map (atoms count 1).
  const target = (doc, text) => {
    let found = null
    doc.descendants((n, pos) => {
      if (found || !n.isTextblock) return !found
      const chars = []
      n.forEach((child, offset) => {
        if (child.isText) for (let i = 0; i < child.text.length; i += 1) chars.push(pos + 1 + offset + i)
        else chars.push(pos + 1 + offset)
      })
      const flat = n.textBetween(0, n.content.size, '', '￼')
      if (flat.includes(text.replace(/!\[i\]\(a\.png\)|\$x\^2\$|<br>/g, '￼').replace(/\\\n/g, '￼'))) {
        found = { pos, node: n, chars: [...chars, pos + 1 + n.content.size], len: chars.length }
      }
      return false
    })
    return found
  }
  const shapes = (L) => {
    const out = []
    const bases = [[2, 7], [0, 5], [Math.max(0, L - 5), L]]
    for (const [s, e] of bases) {
      for (const [k, l] of [[s, e], [s + 1, e - 1], [0, s + 2], [s + 2, e + 3], [0, e + 3], [0, s], [e, e + 2], [0, L], [s + 1, L], [Math.max(0, s - 1), e - 2]]) {
        const a = Math.max(0, Math.min(k, L)), b = Math.max(0, Math.min(l, L))
        if (b > a && e <= L) out.push([[s, e], [a, b]])
      }
    }
    return out
  }
  const fails = []
  let count = 0
  const check = (label, source, base, doc) => {
    count += 1
    let md = '', rt = false, rp = false, stable = false, why = ''
    try { md = H.serialize(doc); rt = H.equivalent(md, doc) } catch (e) { why += 'serialize ' + e.message + '; ' }
    let printed = ''
    try { const r = H.reprint(source, doc); printed = r?.markdown || ''; rp = Boolean(r && r.ok && H.equivalent(r.markdown, doc)); if (!rp) why += 'reprint ' + (r?.reason || 'not equivalent') + (r?.notes ? ' ' + JSON.stringify(r.notes).slice(0, 300) : '') + '; ' } catch (e) { why += 'reprint threw ' + e.message + '; ' }
    let again = ''
    try { again = rt ? H.serialize(H.parse(md)) : ''; stable = rt && again === md } catch (e) { why += 'reparse ' + e.message }
    if (rt && !stable) { try { why += 'again ' + JSON.stringify(again).slice(0, 200) + ' full ' + JSON.stringify(H.serializeFull(H.parse(md))).slice(0, 200) + ' sameDoc ' + (H.parse(md) === base) } catch {} }
    if (rt && rp && stable) return md
    if (fails.length < job.cap) {
      let back = ''
      try { back = runsOf(H.parse(md)) } catch {}
      fails.push({ label, rt, rp, stable, why, md: md.slice(0, 400), source: source.slice(0, 400), printed: printed.slice(0, 400), want: runsOf(doc), got: back })
    }
    return null
  }
  const apply = (doc, t, ops) => {
    const tr = H.newTransform(doc)
    for (const [kind, name, a, b] of ops) {
      const from = t.chars[a], to = t.chars[b]
      if (from == null || to == null || to <= from) continue
      if (kind === 'add') tr.addMark(from, to, M[name]())
      else tr.removeMark(from, to, M[name]().type)
    }
    // The editor keeps inline code off images / formulas (appendTransaction).
    H.stripCodeFromAtoms(tr)
    return tr.doc
  }
  for (const [contextName, textName, source, text] of job.cases) {
    const base = H.parse(source)
    const t = target(base, text)
    if (!t) { fails.push({ label: contextName + '/' + textName, why: 'target not found' }); continue }
    const L = t.len
    for (const A of marks) for (const B of marks) for (const [[s, e], [k, l]] of shapes(L)) {
      for (const op of A === B ? ['add', 'remove'] : ['add']) {
        const label = contextName + '/' + textName + ' ' + A + '[' + s + ',' + e + ') ' + (op === 'add' ? '+' : '-') + B + '[' + k + ',' + l + ')'
        const doc = apply(base, t, [['add', A, s, e], [op, B, k, l]])
        const md = check(label, source, base, doc)
        // A second edit on the saved Markdown: what an authored file sees.
        if (md && job.twoStage && rnd(4) === 0) {
          const base2 = H.parse(md)
          const t2 = target(base2, text)
          if (t2 && t2.len === L) {
            const C = marks[rnd(marks.length)]
            const a = rnd(L), b = Math.min(L, a + 1 + rnd(6))
            check(label + ' then +' + C + '[' + a + ',' + b + ')', md, base2, apply(base2, t2, [[rnd(3) ? 'add' : 'remove', C, a, b]]))
          }
        }
      }
    }
    // Random triples.
    for (let n = 0; n < job.triples; n += 1) {
      const ops = []
      for (let k = 0; k < 3; k += 1) {
        const a = rnd(L), b = Math.min(L, a + 1 + rnd(8))
        ops.push([rnd(5) ? 'add' : 'remove', marks[rnd(marks.length)], a, b])
      }
      check(contextName + '/' + textName + ' triple ' + JSON.stringify(ops), source, base, apply(base, t, ops))
    }
  }
  return { count, fails }
}`

const cases = (contexts, texts) => {
  const out = []
  for (const c of contexts) for (const [name, raw] of Object.entries(texts)) {
    // A table cell is one line: its line break is `<br>`.
    const text = /Cell$/.test(c) ? raw.replace('\\\n', '<br>') : raw
    out.push([c, name, `前一段\n\n${CONTEXTS[c](text)}\n\n后一段\n`, text])
  }
  return out
}
const run = async (job) => {
  const raw = await app.evaluate(`(${PAGE})(${JSON.stringify(job)})`)
  return raw
}
const report = async (name, result) => {
  const out = join(tmpdir(), `horsemd-mark-combos-${name}.json`)
  await rm(out, { force: true })
  if (!result.fails.length) return
  await writeFile(out, JSON.stringify(result.fails, null, 1))
  console.log(`${name}: ${result.fails.length}+ failures of ${result.count}, first ones:`)
  for (const f of result.fails.slice(0, 6)) console.log(' ', f.label, '| rt', f.rt, 'rp', f.rp, 'stable', f.stable, '|', f.why, '\n    md  ', JSON.stringify(f.md), '\n    want', f.want, '\n    got ', f.got)
  console.log(`  all: ${out}`)
}

const BASE_MARKS = ['strong', 'emphasis', 'strike', 'code', 'yellow', 'red', 'blue', 'link', 'link2', 'kbd', 'u', 'font']
try {
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
  for (let i = 0; i < 150; i += 1) {
    if (await app.evaluate('!!globalThis.__hmSourceReprintHarness?.liveDoc()')) break
    await sleep(100)
  }
  await sleep(800)
  const contexts = FULL ? Object.keys(CONTEXTS) : QUICK_CONTEXTS
  const total = { count: 0, fails: 0 }
  const results = {}
  // 1. Pairs (+ a second edit on a quarter of them) and triples.
  if (runs('pairs')) results.pairs = await run({ cases: cases(contexts, TEXTS), marks: BASE_MARKS, triples: FULL ? 400 : 120, seed: SEED, twoStage: true, cap: CAP })
  // 2. Images, formulas and line breaks inside the marked text.
  if (runs('atoms')) results.atoms = await run({ cases: cases(FULL ? ['paragraph', 'bullet', 'quote', 'bodyCell'] : ['paragraph', 'bullet'], ATOM_TEXTS), marks: BASE_MARKS, triples: 120, seed: SEED + 1, twoStage: false, cap: CAP })
  // 3. Subscript / superscript (Typora `H~2~O` / `x^2^`), off by default:
  // turned on through the real Settings page, then the pairs again with them.
  if (runs('subsup')) {
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.offsetParent && /settings|设置/i.test(node.title || node.getAttribute('aria-label') || ''))
    button?.click()
  })()`)
  await sleep(500)
  for (const label of ['/^(下标|Subscript)/', '/^(上标|Superscript)/']) {
    assert.ok(await app.evaluate(`(() => {
      const toggle = [...document.querySelectorAll('button[role=switch]')].find((node) => node.offsetParent && ${label}.test(node.getAttribute('aria-label') || ''))
      if (!toggle) return false
      if (toggle.getAttribute('aria-checked') !== 'true') toggle.click()
      return true
    })()`), `toggle ${label} not found`)
    await sleep(300)
  }
  await sleep(800)
  assert.equal(await app.evaluate("globalThis.__hmSourceReprintHarness.parse('H~2~O').firstChild.child(1).marks[0]?.type.name"), 'subscript', 'subscript on')
  results.subsup = await run({ cases: cases(FULL ? Object.keys(CONTEXTS) : ['paragraph', 'bullet', 'bodyCell'], TEXTS), marks: ['sub', 'sup', 'strong', 'emphasis', 'strike', 'code', 'yellow', 'link', 'kbd'], triples: 80, seed: SEED + 2, twoStage: true, cap: CAP })
  }
  for (const [name, result] of Object.entries(results)) {
    total.count += result.count
    total.fails += result.fails.length
    await report(name, result)
  }
  assert.equal(total.fails, 0, `${total.fails} mark combinations fail (details above)`)
  console.log(`PASS mark combinations: ${total.count} cases — every pair of 12 marks (bold, italic, strike, code, 3 highlights, 2 links, <kbd>, <u>, <font>; sub/superscript with the setting on) in ${contexts.length} contexts × ${Object.keys(TEXTS).length} kinds of text and ${Object.keys(ATOM_TEXTS).length} with images / formulas / breaks, partial removal, random triples, second edits on the saved text: round trip, source reprint and stable output`)
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
