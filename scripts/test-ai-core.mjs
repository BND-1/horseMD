import assert from 'node:assert/strict'
import { assertProviderAdapter, createAiEvent, normalizeAiRequest } from '../src/shared/ai-contracts.js'
import { createContextSnapshot } from '../src/main/ai/context-snapshot.js'
import { applyChangeProposal, createChangeProposal, validateChangeProposal } from '../src/main/ai/change-proposal.js'

const request = normalizeAiRequest({
  provider: 'openai-compatible',
  model: 'local-model',
  messages: [{ role: 'user', content: '总结本文' }],
  timeoutMs: 1
})
assert.equal(request.timeoutMs, 5000)
assert.equal(createAiEvent('delta', { text: 'a' }).text, 'a')
assert.throws(() => createAiEvent('write-file'), /invalid-ai-event/)
assertProviderAdapter({ capabilities() {}, validateConfig() {}, invoke() {}, cancel() {} })
assert.throws(() => assertProviderAdapter({ invoke() {} }), /provider-adapter-missing/)

const markdown = '# 标题\n\n第一段\n\n## 小节\n\n第二段'
const selectionStart = markdown.indexOf('第一段')
const selection = createContextSnapshot({
  markdown,
  scope: 'selection',
  selection: { start: selectionStart, end: selectionStart + 3 }
})
assert.equal(selection.content, '第一段')
assert.equal(selection.truncated, false)

const truncated = createContextSnapshot({ markdown: 'x'.repeat(5000), scope: 'document', maxChars: 1000 })
assert.equal(truncated.content.length, 1000)
assert.equal(truncated.truncated, true)

const proposal = createChangeProposal({ markdown, start: selectionStart, end: selectionStart + 3, after: '修改后的段落' })
assert.equal(validateChangeProposal(markdown, proposal).ok, true)
assert.match(applyChangeProposal(markdown, proposal).markdown, /修改后的段落/)
assert.equal(validateChangeProposal(markdown + '新输入', proposal).reason, 'stale-revision')
assert.equal(applyChangeProposal(markdown + '新输入', proposal).ok, false)

console.log('AI core tests passed')

