import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Schema } from '@milkdown/prose/model'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { createScopedMarkdownOffsetResolver } from '../src/renderer/src/components/editor-source-map-scope.js'
import { pmPosToMarkdownOffset } from '../src/renderer/src/components/editor-source-map.js'

let builds = 0
const scope = createScopedMarkdownOffsetResolver((markdown) => {
  builds++
  return markdown ? (pos) => markdown.length + pos : null
})
const request = { markdown: 'alpha', doc: {}, remark: {}, pmPos: 2 }
scope.run(() => {
  assert.equal(scope.resolve(request), 7)
  assert.equal(scope.resolve({ ...request, pmPos: 3 }), 8)
  assert.equal(builds, 1, 'same source/doc/remark must parse once')
  scope.resolve({ ...request, markdown: 'beta' })
  scope.resolve({ ...request, doc: {} })
  scope.resolve({ ...request, remark: {} })
  assert.equal(builds, 4, 'every identity dimension invalidates')
  scope.run(() => scope.resolve(request))
  assert.equal(builds, 5)
  scope.resolve(request)
  assert.equal(builds, 5, 'nested scope must restore outer map')
})
scope.run(() => scope.resolve(request))
assert.equal(builds, 6, 'next publication must build a fresh map')
assert.throws(() => scope.run(() => { scope.resolve(request); throw new Error('probe') }), /probe/)
scope.run(() => scope.resolve(request))
assert.equal(builds, 8, 'exception must not retain the failed scope')
scope.resolve(request)
scope.resolve(request)
assert.equal(builds, 10, 'unscoped calls must not reuse persistent state')
scope.run(() => {
  for (let index = 0; index < 6; index++) scope.resolve({ ...request, markdown: String(index) })
  scope.resolve({ ...request, markdown: '0' })
})
assert.equal(builds, 17, 'cache must evict entries beyond its four-entry bound')
scope.run(() => {
  assert.equal(scope.resolve({ ...request, markdown: '' }), null)
  assert.equal(scope.resolve({ ...request, markdown: '' }), null)
})
assert.equal(builds, 18, 'unmappable result is scoped too')

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } },
  paragraph: { content: 'text*', group: 'block' },
  text: {}
} })
const input = process.env.REDIS_INPUT_PATH
const markdown = input ? await readFile(input, 'utf8') : '# Redis 命令参考与功能文档\n\n基于Redis 5.0.X\n\n' + '普通正文。\n\n'.repeat(2000)
const doc = schema.node('doc', null, [
  schema.node('heading', { level: 1 }, schema.text('Redis 命令参考与功能文档')),
  schema.node('paragraph', null, schema.text('基于Redis 5.0.X'))
])
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
let parses = 0
const remark = { parse: (text) => { parses++; return processor.parse(text) }, runSync: (...args) => processor.runSync(...args) }
const positions = [1, 2, 3, 4, 5, 6, 7, 8]
let start = performance.now()
const original = positions.map((pos) => pmPosToMarkdownOffset(markdown, pos, doc, remark))
const beforeMs = performance.now() - start
assert.equal(parses, 8)
parses = 0
const actualScope = createScopedMarkdownOffsetResolver()
start = performance.now()
const cached = actualScope.run(() => positions.map((pmPos) => actualScope.resolve({ markdown, pmPos, doc, remark })))
const afterMs = performance.now() - start
assert.deepEqual(cached, original, 'prepared maps must preserve every scalar offset')
assert.ok(cached.every(Number.isFinite), 'heading offsets must be proven')
assert.equal(parses, 1, 'eight offset requests must parse full source once')
console.log('PASS source-map scope: identity isolation, nested scope, exception cleanup, bounded cache, null result, exact offsets')
console.log(JSON.stringify({ benchmark: 'full-source map construction, two-block target model (not UI latency)', characters: markdown.length, offsetRequests: 8, parsesBefore: 8, parsesAfter: 1, beforeMs: Math.round(beforeMs), afterMs: Math.round(afterMs) }))
