// Perf regression for the block-heavy-document preserve path (issue #126,
// redis reference doc: 333k chars, 394 fences, 642 list rows). The legacy
// list mappers re-built full-document line indexes, comparable forms and
// visible-stream maps PER CHANGED BLOCK — O(blocks × doc) — and a single
// one-character keystroke's preserve call measured 128 SECONDS (renderer
// wedged at 200% CPU, markdownUpdated throttled to one event per minute).
// The caches (markdownLines / comparableListLines / sourceVisibleIndex) and
// the anchor Map cut the same call to ~600ms. This test locks the budget:
// a quadratic regression lands in minutes and fails hard.
import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

// Synthetic doc mirroring the redis shape: fenced blocks + bullet lists +
// paragraphs, ~600 blocks / ~350k chars.
const buildDoc = (blockCount) => {
  const parts = ['# 性能回归基准文档\n']
  for (let index = 0; index < blockCount; index += 1) {
    parts.push(`\n## 命令 ${index}：第 ${index} 组参考命令与参数说明\n`)
    parts.push('```text\n' + Array.from({ length: 6 }, (_, row) =>
      `SET key-${index}-${row} value-with-argument-${row} EX 3600 NX`).join('\n') + '\n```')
    if (index % 3 === 0) {
      parts.push('\n- 参数一：将键的过期时间设置为指定秒数，等同于 SETEX 的行为组合。\n- 参数二：只在键不存在时才执行设置操作，等同于 SETNX 的语义。\n- 参数三：只在键已经存在时执行覆盖，常用于更新场景的守卫条件。')
    } else {
      parts.push('\n该命令把字符串值关联到键上，如果键已经持有其他值则直接覆写旧值并无视类型。当命令作用于一个带有生存时间的键时，原有的生存时间会被清除，后续需要重新设置过期参数。')
    }
  }
  return parts.join('\n')
}

const BLOCKS = 600
const authored = buildDoc(BLOCKS)
// The real redis-doc relationship (P7-style standing divergence): the authored
// source spells bullets `- `, the serializer's canonical spells them `* `, and
// the new state adds ONE typed character in a plain paragraph. Every keystroke
// then runs the full mapper chain across the whole diverged document.
const previousCanonical = authored.replace(/^- /gm, '* ')
const editFrom = previousCanonical.indexOf('该命令把值关联到键上')
const canonical = previousCanonical.slice(0, editFrom + 10) + 'x' + previousCanonical.slice(editFrom + 10)
const source = authored
assert.ok(source.length > 240000, `synthetic doc unexpectedly small: ${source.length}`)
assert.notEqual(source, previousCanonical, 'author/canonical spellings must diverge')
assert.ok((source.match(/^```/gm) || []).length >= BLOCKS * 2 - 2)

const t0 = performance.now()
let result = null
try {
  result = preserveRichMarkdownSource(source, previousCanonical, canonical)
} catch (err) {
  console.error('preserve threw:', err)
  process.exit(1)
}
const elapsedMs = performance.now() - t0

console.log(`doc=${source.length} chars, ${BLOCKS} fences → preserve ${Math.round(elapsedMs)}ms, preserved=${result.preserved}, reason=${result.reason}`)
assert.notEqual(result.reason, 'unchanged', 'test setup must exercise the mapper chain, not the unchanged early-out')
// Correctness stays owned by the behavior suites; here we only require the
// call to SUCCEED (a rejected preserve on the plain one-char edit would push
// this shape onto the fail-closed path and re-open the warning storm).
assert.equal(result.preserved, true, `one-char edit must preserve (reason=${result.reason})`)
// Budget: cached path runs ~0.6-1s on this hardware; the quadratic path took
// 128s at a SMALLER size. 15s catches any complexity regression with headroom
// for slow CI runners.
assert.ok(elapsedMs < 15000, `preserve took ${Math.round(elapsedMs)}ms — quadratic regression is back`)

console.log('\npreserve large-doc perf: PASS')
