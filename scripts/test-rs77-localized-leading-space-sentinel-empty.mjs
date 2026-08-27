import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

const source = '# 测试\n\n1. 我已经累了\n2. 这`av`asevsv测试`dzvsvd`\n\n```\naefaef\nsdvv\n```\n\n内容\n\n- 是的v\n- 色粉色\n- \u200B     色粉色分\n\n* \u200B    家族验证94262\n'
const previous = '# 测试\n\n1. 我已经累了\n2. 这`av`asevsv测试`dzvsvd`\n\n```\naefaef\nsdvv\n```\n\n内容\n\n* 是的v\n\n* 色粉色\n\n* &#x20;    色粉色分\n\n- &#x20;   家族验证94262\n\n'
const next = '# 测试\n\n1. 我已经累了\n2. 这`av`asevsv测试`dzvsvd`\n\n```\naefaef\nsdvv\n```\n\n内容\n\n* 是的v\n\n* 色粉色\n\n* &#x20;    色粉色分\n\n-   \n\n'

const result = preserveRichMarkdownSource(source, previous, next)
assert.equal(result.preserved, true)
assert.equal(result.reason, 'leading-space-sentinel-reconciled')
assert.equal(result.markdown.includes('\u200B    家族验证94262'), false)
assert.equal(result.markdown.includes('* \u200B  '), false, 'spaces-only list row must not retain U+200B')
assert.equal(result.markdown.endsWith('*   \n'), true, 'the authored bullet slot must remain as a plain spaces-only row')

console.log('PASS RS-77: localized list body deletion removes stale leading-space sentinel')
