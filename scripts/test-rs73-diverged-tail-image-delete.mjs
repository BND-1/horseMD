import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

// RS-73: the authored image is a standalone tail row, while remark/Crepe has
// attached the same image atom to the deepest ordered-list paragraph. The
// document is already permanently source/canonical-diverged because authored
// list indentation/tabs are intentionally preserved. Deleting the image atom
// in rich mode must remove only that authored image row.
const image = '![image.png](assets/image-20260811035152751.png)'
const source = [
  '阶段性计划：',
  '',
  '1. 资料汇总（并分类）',
  '2. 智能体：用 claude code （workbuddy\\Trae\\Zcode）打造标书demo：',
  '\t1. 招标信息',
  '\t2. 我们自己的知识库信息',
  '   3. 根据招标信息、组织知识库信息，形成一个标书demo（参考<https://biaoshu.lianqiai.cn/>）是的v啊是v',
  image,
  ''
].join('\n')
const previous = [
  '阶段性计划：',
  '',
  '1. 资料汇总（并分类）',
  '',
  '2. 智能体：用 claude code （workbuddy\\Trae\\Zcode）打造标书demo：',
  '',
  '   1. 招标信息',
  '   2. 我们自己的知识库信息',
  '   3. 根据招标信息、组织知识库信息，形成一个标书demo（参考<https://biaoshu.lianqiai.cn/>）是的v啊是v',
  `      ${image}`,
  '',
  ''
].join('\n')
const next = [
  '阶段性计划：',
  '',
  '1. 资料汇总（并分类）',
  '',
  '2. 智能体：用 claude code （workbuddy\\Trae\\Zcode）打造标书demo：',
  '',
  '   1. 招标信息',
  '   2. 我们自己的知识库信息',
  '   3. 根据招标信息、组织知识库信息，形成一个标书demo（参考<https://biaoshu.lianqiai.cn/>）是的v啊是v',
  '',
  ''
].join('\n')
const expected = source.slice(0, source.indexOf(image))

const result = preserveRichMarkdownSource(source, previous, next)
assert.equal(result.preserved, true, `RS-73 image delete stayed fail-closed: ${result.reason}`)
assert.equal(result.reason, 'diverged-tail-image-delete')
assert.equal(result.markdown, expected)
assert.equal(result.markdown.includes('image.png'), false)
assert.equal(result.markdown.includes('\t1. 招标信息'), true, 'authored tab indentation must remain byte-owned by source')
assert.equal(result.markdown.includes('   3. 根据招标信息'), true, 'authored mixed indentation must not be canonicalized')

// The owner must not guess when the same authored image target occurs twice.
const ambiguousSource = source.replace(image, `${image}\n${image}`)
const ambiguous = preserveRichMarkdownSource(ambiguousSource, previous, next)
assert.notEqual(ambiguous.reason, 'diverged-tail-image-delete')

// A non-tail image deletion is a different ownership family and stays closed.
const nonTailSource = source + '\n后文\n'
const nonTailPrevious = previous + '后文\n'
const nonTailNext = next + '后文\n'
const nonTail = preserveRichMarkdownSource(nonTailSource, nonTailPrevious, nonTailNext)
assert.notEqual(nonTail.reason, 'diverged-tail-image-delete')

console.log('PASS RS-73 diverged tail image delete: unique authored image row is removed without canonicalizing surrounding list bytes')
