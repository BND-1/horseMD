import assert from 'node:assert/strict'
import { shouldUseRichContentVisibility } from '../src/renderer/src/paths.js'

const mediumCjk = [
  '# WhatIf 因果推断详细笔记',
  '',
  ...Array.from({ length: 580 }, (_, i) => `### ${i}\n\n${'这是中文密集段落，用于覆盖 Windows 富文本滚动性能回归。'.repeat(8)}`)
].join('\n\n')

assert.equal(mediumCjk.length > 20000, true, 'fixture should exceed the old char-only CV threshold')
assert.equal(shouldUseRichContentVisibility(mediumCjk), false, 'medium CJK docs should not enable hm-cv')

const manyBlocks = Array.from({ length: 1200 }, (_, i) => `paragraph ${i}`).join('\n\n')
assert.equal(shouldUseRichContentVisibility(manyBlocks), true, 'many-block rich docs still enable hm-cv')

const manyLines = Array.from({ length: 8000 }, (_, i) => `line ${i}`).join('\n')
assert.equal(shouldUseRichContentVisibility(manyLines), true, 'very long line-count docs still enable hm-cv')

console.log('PASS rich CV gating')
