import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import {
  normalizeLiteralTripleBacktickTextBlocks,
  remarkPreserveLiteralTripleBacktickTextBlocks
} from '../src/renderer/src/components/editor-literal-backticks.js'

const parse = (source) => unified().use(remarkParse).parse({ value: source })
const normalize = (source) => normalizeLiteralTripleBacktickTextBlocks(parse(source), source)

const literal = normalize('```你好```\n')
assert.equal(literal.children[0].type, 'paragraph')
assert.deepEqual(literal.children[0].children, [{
  type: 'text',
  value: '```你好```',
  position: literal.children[0].children[0].position
}])

const heading = normalize('# ```标题```\n')
assert.equal(heading.children[0].type, 'heading')
assert.equal(heading.children[0].children[0].type, 'text')
assert.equal(heading.children[0].children[0].value, '```标题```')

const multiple = normalize('before\n\n```alpha```\n\nafter\n')
assert.equal(multiple.children[1].children[0].type, 'text')
assert.equal(multiple.children[1].children[0].value, '```alpha```')

for (const source of [
  '`single`\n',
  '``double``\n',
  '````four````\n',
  'before ```embedded``` after\n'
]) {
  const tree = normalize(source)
  assert.ok(
    tree.children[0].children.some((node) => node.type === 'inlineCode'),
    `normal inline code was rewritten: ${JSON.stringify(source)}`
  )
}

for (const source of ['```', '```\n', '```\r\n']) {
  const tree = normalize(source)
  assert.equal(tree.children[0].type, 'paragraph')
  assert.equal(tree.children[0].children[0].type, 'text')
  assert.equal(tree.children[0].children[0].value, '```')
}

for (const source of [
  '```js\n',
  '```\ncode\n',
  '```\ncode\n```\n',
  '~~~\n',
  '``````\n'
]) {
  const tree = normalize(source)
  assert.equal(tree.children[0].type, 'code', `real/unsupported fence was rewritten: ${JSON.stringify(source)}`)
}

const escaped = normalize('\\`\\`\\`escaped\\`\\`\\`\n')
assert.equal(escaped.children[0].children[0].type, 'text')
assert.equal(escaped.children[0].children[0].value, '```escaped```')

const processor = unified().use(remarkParse).use(remarkPreserveLiteralTripleBacktickTextBlocks)
const pluginTree = processor.parse({ value: '```plugin```\n' })
const pluginResult = processor.runSync(pluginTree, { value: '```plugin```\n' })
assert.equal(pluginResult.children[0].children[0].type, 'text')
assert.equal(pluginResult.children[0].children[0].value, '```plugin```')

console.log('PASS literal triple-backtick parser: exact whole-paragraph triples stay prose; normal inline/fenced code is unchanged')
