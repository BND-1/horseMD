import assert from 'node:assert/strict'
import { PANDOC_FORMATS, buildPandocArgs, gfmSupportsMathDollars, parsePandocVersion, summarizePandocStderr } from '../src/main/pandoc-core.js'

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
assert.deepEqual(buildPandocArgs({ outputPath: '/tmp/a.wiki', to: PANDOC_FORMATS.mediawiki.to }), [
  '--from=gfm+tex_math_dollars',
  '--standalone',
  '--output',
  '/tmp/a.wiki',
  '--to=mediawiki'
])
// #167: Pandoc ≤ 2.10 rejects gfm+tex_math_dollars. `--list-extensions=gfm`
// output as printed by 2.10 (no math), 2.11 (listed off), 3.12 (on).
assert.equal(gfmSupportsMathDollars('+autolink_bare_uris\n+emoji\n+pipe_tables\n+raw_html\n+strikeout\n+task_lists\n'), false)
assert.equal(gfmSupportsMathDollars('+emoji\n-tex_math_dollars\n'), true)
assert.equal(gfmSupportsMathDollars('+emoji\r\n+tex_math_dollars\r\n+tex_math_gfm\r\n'), true)
assert.equal(gfmSupportsMathDollars(''), false)
assert.equal(buildPandocArgs({ outputPath: '/tmp/a.docx', mathDollars: false })[0], '--from=gfm')

assert.deepEqual(Object.keys(PANDOC_FORMATS), ['docx', 'epub', 'latex', 'odt', 'rtf', 'mediawiki', 'txt'])

console.log('pandoc core tests passed')
