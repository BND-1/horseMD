// Incremental parse (lib/source-reprint/incremental-parse.js) must give
// EXACTLY the full parse: same ProseMirror document, same mdast (positions
// included), same block counts. Seeded random edits — Markdown syntax that
// opens or closes constructs across blank lines (fences, `$$`, HTML blocks,
// lists, quotes, setext underlines, frontmatter, definitions, tables) — are
// applied in chains, each text parsed incrementally from the previous
// result, inside the real editor's remark pipeline. Also checks the
// per-block comparison memo against the full comparison.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const here = (path) => new URL(path, import.meta.url)
const constructs = [
  '---', 'title: x', '---', '',
  '# Heading', '', 'Para one line', 'second line', '', 'Setext', '===', '',
  '- a', '- b', '  - nested', '', '    indented after list', '', '1. one', '2. two', '',
  '> quote', 'lazy line', '', '> - quoted list', '', '```js', 'code', '', 'more', '```', '',
  '~~~', 'tilde', '~~~', '', '$$', 'x^2', '$$', '', '<div>', 'html block', '</div>', '',
  '<!-- comment', '', 'still comment -->', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '***', '', 'text <font color="red">red</font> and <span style="x">s</span>', '',
  '    indented code', '', '    more code', '', 'Para', '---', '', '- [ ] task', '- [x] done', '',
  '<pre>', 'pre', '', 'pre2', '</pre>', '', 'tail paragraph', ''
].join('\n')
const docs = {
  constructs,
  // Same constructs without the frontmatter (a file starting with `---` is
  // always parsed whole).
  body: constructs.split('\n').slice(4).join('\n'),
  redis: await readFile(here('./fixtures/redis-tight/start.md'), 'utf8'),
  yuque: await readFile(here('./fixtures/yuque-export/start.md'), 'utf8')
}
const tokens = ['a', '中', '\n', '\n\n', '# ', '- ', '1. ', '2. ', '> ', '```\n', '```', '~~~\n', '$$\n', '$$',
  '<div>\n', '</div>\n', '<!-- ', '-->', '<pre>\n', '</pre>', '---\n', '***\n', '===\n', '| a | b |\n|---|---|\n',
  '    ', '\t', '*', '**', '_', '`', '[x](y)', '<font color="red">', '</font>', '  \n', '[a]: http://x\n', '[^1]',
  '<br>', '\\', '&amp;', '+ ', ' ', '|', '![](i.png)', '\r\n', 'x\n---', '\n    code']

const root = await mkdtemp(join(tmpdir(), 'horsemd-incremental-parse-'))
const file = join(root, 'doc.md')
await writeFile(file, '# probe\n\ntext\n')
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: 29760 + process.pid % 30, appArgs: [file, '--horsemd-input-trace'] })
try {
  for (let i = 0; i < 150 && !(await app.evaluate('Boolean(globalThis.__hmSourceReprintHarness?.incrementalParseChain)')); i++) await sleep(100)
  assert.ok(await app.evaluate('Boolean(globalThis.__hmSourceReprintHarness?.incrementalParseChain)'), 'harness ready')
  let used = 0
  let full = 0
  const rounds = Number(process.env.ROUNDS || 60)
  for (const [name, text] of Object.entries(docs)) {
    for (let round = 0; round < rounds; round++) {
      const result = await app.evaluate(`(() => {
        let seed = ${round * 7919 + name.length * 104729}
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
        const tokens = ${JSON.stringify(tokens)}
        let text = ${JSON.stringify(text)}
        const texts = [text]
        for (let step = 0; step < 30; step++) {
          const at = Math.floor(rand() * (text.length + 1))
          const r = rand()
          if (r < 0.55) text = text.slice(0, at) + tokens[Math.floor(rand() * tokens.length)] + text.slice(at)
          else if (r < 0.8) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 12))
          else if (r < 0.9) { const s = text.lastIndexOf('\\n', at - 1) + 1; const e = text.indexOf('\\n', at); text = text.slice(0, s) + text.slice(e < 0 ? text.length : e + 1) }
          else { const s = text.lastIndexOf('\\n', at - 1) + 1; const e = text.indexOf('\\n', at); const line = text.slice(s, e < 0 ? text.length : e + 1); text = text.slice(0, s) + line + line + text.slice(e < 0 ? text.length : e + 1) }
          texts.push(text)
        }
        const out = globalThis.__hmSourceReprintHarness.incrementalParseChain(texts)
        return { used: out.used, full: out.full, mismatches: out.mismatches.slice(0, 2) }
      })()`)
      used += result.used
      full += result.full
      if (result.mismatches.length) {
        const first = result.mismatches[0]
        await writeFile(join(root, 'mismatch.json'), JSON.stringify(result.mismatches, null, 1))
        assert.fail(`${name} round ${round}: incremental parse differs from the full parse (${JSON.stringify({ ...first, previous: undefined, markdown: undefined })}); details in ${join(root, 'mismatch.json')}`)
      }
    }
  }
  assert.ok(used > rounds * 10, `incremental path exercised: ${used} incremental, ${full} full`)

  // Per-block comparison memo == full comparison, on edited documents.
  const memo = await app.evaluate(`(() => {
    const h = globalThis.__hmSourceReprintHarness
    const remark = h.remark(); const schema = h.schema()
    const texts = ${JSON.stringify(Object.values(docs))}
    let checked = 0
    for (const text of texts) {
      const a = h.parseTree(text)
      const variants = [text.replace('a', 'b'), text + '\\n\\n- x\\n', text.replace('\\n\\n', '\\n\\n\\n\\n'), text.replace('- ', '* ')]
      for (const variant of variants) {
        const b = h.parseTree(variant)
        for (const options of [{}, { ignoreAllTableColumnWidths: true, ignoreEmptyContainerParagraphs: true }, { inlineTextual: true }]) {
          if (!h.semanticMemoCheck(a, b, options) || !h.semanticMemoCheck(b, b, options) || !h.semanticMemoCheck(a, a, options)) return { ok: false, text: variant.slice(0, 200), options }
          checked += 3
        }
      }
    }
    return { ok: true, checked }
  })()`)
  assert.equal(memo.ok, true, `semantic memo agrees with the full comparison: ${JSON.stringify(memo)}`)
  console.log(`PASS incremental parse: ${used} incremental parses identical to full parses (${full} fell back to full); semantic memo ${memo.checked} checks`)
} finally {
  await stopBuiltElectron(app)
}
