import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const snapshotPath = path.join(root, 'docs/source-sync-direct-publication-audit.json')
const productionPaths = [
  'src/renderer/src/components/Editor.jsx',
  'src/renderer/src/components/editor-api.js'
]

const functionPattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|function\s+([A-Za-z_$][\w$]*)\s*\(/
const callbackMarkers = [
  ['markdownUpdated', /api\.markdownUpdated\s*\(/],
  ['createEditorApi', /createEditorApi\s*\(/],
  ['editor-ready', /onReady\?\.\(/]
]

const classifyContext = (lines, index) => {
  for (let cursor = index; cursor >= Math.max(0, index - 120); cursor -= 1) {
    for (const [name, pattern] of callbackMarkers) {
      if (pattern.test(lines[cursor])) return name
    }
    const match = lines[cursor].match(functionPattern)
    const name = match?.[1] || match?.[2]
    if (name) return name
  }
  return 'module-or-effect'
}

const patterns = [
  ['source-ref', /lastMarkdownRef\.current\s*=/],
  ['canonical-ref', /canonicalMarkdownRef\.current\s*=/],
  ['host-onChange', /onChange\?\.\(/]
]

const entries = []
for (const relativePath of productionPaths) {
  const fullPath = path.join(root, relativePath)
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      if (!pattern.test(line)) continue
      entries.push({
        path: relativePath,
        line: index + 1,
        kind,
        context: classifyContext(lines, index),
        statement: line.trim()
      })
    }
  })
}

const audit = {
  schemaVersion: 1,
  description: 'Remaining direct SourceSync publication/state writes. Every removal must be paired with a Coordinator/owner gate; new entries are forbidden unless explicitly reviewed.',
  entries
}
const serialized = `${JSON.stringify(audit, null, 2)}\n`

if (process.argv.includes('--write')) {
  fs.writeFileSync(snapshotPath, serialized)
  console.log(`WROTE ${path.relative(root, snapshotPath)} (${entries.length} entries)`)
} else {
  assert.ok(fs.existsSync(snapshotPath), 'publication audit snapshot is missing; run with --write after review')
  const expected = fs.readFileSync(snapshotPath, 'utf8')
  assert.equal(
    serialized,
    expected,
    'SourceSync direct-publication audit changed. Migrate the write through Coordinator or explicitly regenerate the reviewed debt snapshot.'
  )
  console.log(`PASS source sync publication audit: ${entries.length} registered direct writes, no unreviewed drift`)
}
