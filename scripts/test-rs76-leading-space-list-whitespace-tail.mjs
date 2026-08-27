import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'
import { preserveDivergedLeadingSpaceListWhitespaceTail } from '../src/renderer/src/lib/markdown-preservation/regions.js'

const source = '# t\n\n- authored-divergence\n\n* \u200B    家族验证\n'
const previous = '# t\n\n* canonical-divergence\n\n* &#x20;   家族验证\n\n'
const next = '# t\n\n* canonical-divergence\n\n*   \n\n'

const owned = preserveDivergedLeadingSpaceListWhitespaceTail({ source, previous, next })
assert.deepEqual(owned, {
  markdown: '# t\n\n- authored-divergence\n\n*   \n',
  preserved: true,
  reason: 'diverged-leading-space-list-whitespace-tail'
})
assert.equal(owned.markdown.includes('\u200B'), false, 'spaces-only list rows must not retain a parsed U+200B sentinel')

const facade = preserveRichMarkdownSource(source, previous, next)
assert.equal(facade.preserved, true)
assert.equal(facade.reason, 'diverged-leading-space-list-whitespace-tail')
assert.equal(facade.markdown, owned.markdown)

assert.equal(
  preserveDivergedLeadingSpaceListWhitespaceTail({
    source,
    previous,
    next: '# t\n\n* canonical-divergence\n\n* x\n\n'
  }),
  null,
  'non-whitespace replacement must not be claimed by the spaces-only tail owner'
)
assert.equal(
  preserveDivergedLeadingSpaceListWhitespaceTail({
    source: source.replace('\u200B', ''),
    previous,
    next
  }),
  null,
  'a source row without the exact leading-space sentinel lifecycle must fail closed'
)
assert.equal(
  preserveDivergedLeadingSpaceListWhitespaceTail({
    source,
    previous,
    next: '# changed-prefix\n\n*   \n\n'
  }),
  null,
  'the owner must reject edits that change anything before the final canonical row'
)

console.log('PASS RS-76: diverged sentinel-backed list tail maps to spaces-only row and fails closed otherwise')
