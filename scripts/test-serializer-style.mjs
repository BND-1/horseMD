import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import {
  applySerializerStyleToRemark,
  createSerializerStyleHolder,
  detectMarkdownListStyle
} from '../src/renderer/src/lib/serializer-style.js'

// ---------------------------------------------------------------------------
// Detection contracts
// ---------------------------------------------------------------------------
{
  const compact = detectMarkdownListStyle('- a\n- b\n1. x\n2. y\n')
  assert.deepEqual(
    { bullet: compact.bullet, ordered: compact.ordered, loose: compact.loose },
    { bullet: '-', ordered: '.', loose: false },
    'compact `-`/`1.` document detects tight dash style'
  )
}
{
  const loose = detectMarkdownListStyle('* a\n\n* b\n\n1) x\n')
  assert.deepEqual(
    { bullet: loose.bullet, ordered: loose.ordered, loose: loose.loose },
    { bullet: '*', ordered: ')', loose: true },
    'padded `*`/`1)` document detects loose star style'
  )
}
{
  const none = detectMarkdownListStyle('# title\n\ntext only\n')
  assert.equal(none.bullet, '-', 'no lists falls back to the Typora-like default')
  assert.equal(none.loose, false, 'no lists defaults to tight')
}
{
  const breaks = detectMarkdownListStyle('a  \nb\n\nc\\\nd\n')
  assert.equal(breaks.hardBreak, '  ', 'two-space hard breaks detected')
  const backslash = detectMarkdownListStyle('a\nb\n\nc\\\nd\n\ne\\\nf\n\ng  \nh\n')
  assert.equal(backslash.hardBreak, '\\', 'backslash hard breaks win when dominant')
}
{
  // Fence content must not count toward style detection.
  const fenced = detectMarkdownListStyle('- a\n- b\n\n```\n* x\n\n* y\n```\n')
  assert.equal(fenced.loose, false, 'fenced rows do not flip the loose detection')
}
console.log('ok detection')

// ---------------------------------------------------------------------------
// Serializer style application on a live remark instance
// ---------------------------------------------------------------------------
{
  const authored = [
    '# doc', '',
    'para  ', 'second line of para.', '',
    '- **a**：one.', '- **b**：two.', '',
    '1. first', '2. second', ''
  ].join('\n')
  const holder = createSerializerStyleHolder(authored)
  const remark = unified().use(remarkParse).use(remarkStringify).use(remarkGfm)
  const restore = applySerializerStyleToRemark(remark, holder)
  // Poison every list/listItem spread the way PM attr defaults would.
  const tree = remark.parse(authored)
  const poison = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'list' || node.type === 'listItem') node.spread = true
    ;(node.children || []).forEach(poison)
  }
  poison(tree)
  const canonical = remark.stringify(tree)
  assert.equal(canonical, authored,
    'styled canonical must be byte-identical to the authored compact spelling')

  // A genuinely multi-paragraph item stays loose (two paragraphs need the
  // blank line) even in a tight document — the P6c join shape.
  const joined = '- **a**：one.\n\n  second paragraph.\n- b\n'
  const holder2 = createSerializerStyleHolder(joined)
  const remark2 = unified().use(remarkParse).use(remarkStringify).use(remarkGfm)
  applySerializerStyleToRemark(remark2, holder2)
  const tree2 = remark2.parse(joined)
  const canonical2 = remark2.stringify(tree2)
  assert.equal(canonical2, joined, 'multi-paragraph items keep their loose spelling')

  // restore() puts the stock serializer back
  restore()
  const stock = remark.stringify(remark.parse('- a\n- b\n'))
  assert.equal(stock, '* a\n* b\n', 'restore returns the stock `*` serializer')
}
console.log('ok application')

// ---------------------------------------------------------------------------
// setFrom: source-mode replacement re-detects the style
// ---------------------------------------------------------------------------
{
  const holder = createSerializerStyleHolder('- a\n')
  assert.equal(holder.style.bullet, '-')
  holder.setFrom('* x\n\n* y\n')
  assert.equal(holder.style.bullet, '*', 're-detection after replaceMarkdown')
  assert.equal(holder.style.loose, true)
}
console.log('ok re-detection')

console.log('PASS serializer style: authored list/hard-break/strong spelling is detected and mirrored by the live remark serializer; multi-paragraph items stay loose; fenced rows are ignored; restore returns stock behavior')
