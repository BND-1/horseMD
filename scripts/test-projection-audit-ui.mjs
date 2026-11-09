// Serializer keeps the meaning (docs/reprint-root-cause-plan.md, P2): every
// Markdown file in the repository and every CommonMark / GFM spec example is
// parsed, written by the editor's serializer and read back. The projection
// guard (lib/source-sync/projection.js) must accept each one: same block
// skeleton, same non-blank text and marks. A failure is a serializer bug —
// fix it there, never by an exception elsewhere.
//
// Found by it (2026-11-08): an autolink with a backslash (`<https://a?b=\*>`,
// spec 20 / 603) was written with the backslash escaped — another URL; a
// soft break in a table cell was written as a line ending, which ended the
// row and lost the rest of it; inline code across a line read back with a
// space where the serializer had written one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from './lib/probe-session.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const inputs = []
// The tracked files; without git (a copied test directory) every .md file
// outside dependencies and build output.
const listMarkdown = () => {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '*.md'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
  } catch {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
        if (/^(node_modules|out|dist|\.git)$/.test(entry.name)) continue
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.md')) found.push(path)
      }
    }
    walk('')
    return found
  }
}
const files = listMarkdown()
for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8').catch(() => null)
  if (source != null && source.length < 400000) inputs.push([file, source])
}
for (const name of ['commonmark-spec-0.31.2.json', 'gfm-spec-extensions.json']) {
  const data = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
  data.forEach((example, index) => inputs.push([`${name.slice(0, 3)} #${example.example ?? index}`, example.markdown]))
}

const session = await open('projection-audit', 'x\n', 9538)
const failures = []
try {
  for (let index = 0; index < inputs.length; index += 20) {
    const batch = inputs.slice(index, index + 20)
    let verdicts = await session.trace(`(() => { const h = globalThis.__hmSourceReprintHarness; return JSON.stringify(${JSON.stringify(batch)}.map(([name, source]) => {
      try {
        const doc = h.parse(source)
        const r = h.project(doc)
        if (!r.ok) return { name, reason: r.reason, before: r.before, after: r.after }
        // Opened and not edited, the file is written back byte for byte
        // (plan §4: unchanged files stay unchanged).
        const back = h.reprint(source, doc)
        if (!back?.ok) return { name, reason: 'reprint-failed-unedited-file', detail: back?.reason }
        if (back.markdown !== source) return { name, reason: 'reprint-changed-unedited-file', notes: back.notes }
        return null
      }
      catch (error) { return { name, reason: 'threw', error: String(error).slice(0, 200) } } })) })()`)
    while (typeof verdicts === 'string') verdicts = JSON.parse(verdicts)
    for (const verdict of verdicts) if (verdict) failures.push(verdict)
  }
} finally {
  await session.close()
}
for (const failure of failures.slice(0, 20)) console.log('FAIL', JSON.stringify(failure).slice(0, 400))
assert.equal(failures.length, 0, `${failures.length} of ${inputs.length} inputs change meaning when serialized`)
console.log(`PASS projection audit: ${inputs.length} inputs (${files.length} repo Markdown files, CommonMark + GFM spec examples) serialize and read back with the same blocks, text and marks; unedited, each reprints to its own bytes`)
