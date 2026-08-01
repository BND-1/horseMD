import assert from 'node:assert/strict'
import { PANDOC_FORMATS, buildPandocArgs, parsePandocVersion, summarizePandocStderr } from '../src/main/pandoc-core.js'

assert.equal(parsePandocVersion('pandoc 3.6.4\nFeatures: +server'), '3.6.4')
assert.equal(parsePandocVersion('not pandoc'), null)
assert.equal(summarizePandocStderr(''), null)
assert.equal(summarizePandocStderr('  warning: missing image  '), 'warning: missing image')
assert.equal(summarizePandocStderr('x'.repeat(120), 100), `${'x'.repeat(100)}…`)
assert.deepEqual(buildPandocArgs({ outputPath: '/tmp/a.docx', sourceDir: '/tmp/source dir' }), [
  '--from=gfm+tex_math_dollars',
  '--standalone',
  '--output',
  '/tmp/a.docx',
  '--resource-path=/tmp/source dir'
])
assert.deepEqual(Object.keys(PANDOC_FORMATS), ['docx', 'epub', 'latex', 'odt', 'rtf', 'txt'])

console.log('pandoc core tests passed')
