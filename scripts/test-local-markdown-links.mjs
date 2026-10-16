import assert from 'node:assert/strict'
import {
  absolutePathToFileUrl,
  isAbsoluteLocalPath,
  resolveLocalLinkToFileUrl
} from '../src/renderer/src/components/editor-local-links.js'

assert.equal(isAbsoluteLocalPath('/Users/yangtingyi/vibe_everything/anletang/SEO-GEO-内容策略.md'), true)
assert.equal(isAbsoluteLocalPath('C:\\Users\\writer\\Notes\\plan.md'), true)
assert.equal(isAbsoluteLocalPath('\\\\server\\share\\plan.md'), true)
assert.equal(isAbsoluteLocalPath('./related.md'), false)
assert.equal(isAbsoluteLocalPath('https://example.com/note.md'), false)

assert.equal(
  absolutePathToFileUrl('/Users/yangtingyi/vibe everything/内容.md'),
  'file:///Users/yangtingyi/vibe%20everything/%E5%86%85%E5%AE%B9.md'
)
assert.equal(
  absolutePathToFileUrl('/Users/yangtingyi/vibe%20everything/内容.md'),
  'file:///Users/yangtingyi/vibe%20everything/%E5%86%85%E5%AE%B9.md',
  'authored percent escapes must not be double encoded'
)
assert.equal(
  absolutePathToFileUrl('C:\\Users\\writer\\My Notes\\plan.md'),
  'file:///C:/Users/writer/My%20Notes/plan.md'
)
assert.equal(
  absolutePathToFileUrl('\\\\server\\share\\My Notes\\plan.md'),
  'file://server/share/My%20Notes/plan.md'
)
assert.equal(
  resolveLocalLinkToFileUrl('/Users/yangtingyi/vibe_everything/anletang/SEO-GEO-内容策略.md'),
  'file:///Users/yangtingyi/vibe_everything/anletang/SEO-GEO-%E5%86%85%E5%AE%B9%E7%AD%96%E7%95%A5.md'
)
assert.equal(
  resolveLocalLinkToFileUrl('./assets/spec.md', '/Users/writer/project/readme.md'),
  'file:///Users/writer/project/assets/spec.md'
)
assert.equal(resolveLocalLinkToFileUrl('#part', '/Users/writer/project/readme.md'), null)
assert.equal(resolveLocalLinkToFileUrl('https://example.com', '/Users/writer/project/readme.md'), null)

console.log('PASS local Markdown links: POSIX, Windows drive, UNC and relative paths resolve to safe file URLs')
