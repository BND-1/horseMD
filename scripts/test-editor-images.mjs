import assert from 'node:assert/strict'
import { resolveToFileUrl } from '../src/renderer/src/components/editor-images.js'

assert.equal(
  resolveToFileUrl('/tmp/Horse MD', './images/local%20image.svg'),
  'file:///tmp/Horse%20MD/images/local%20image.svg'
)
assert.equal(
  resolveToFileUrl('/tmp/文档', './图片/示例.png'),
  'file:///tmp/%E6%96%87%E6%A1%A3/%E5%9B%BE%E7%89%87/%E7%A4%BA%E4%BE%8B.png'
)
assert.equal(
  resolveToFileUrl('C:\\Users\\Test User\\Docs', '.\\assets\\local%20image.png'),
  'file:///C:/Users/Test%20User/Docs/assets/local%20image.png'
)
assert.equal(
  resolveToFileUrl('/tmp/docs', './bad%escape.png'),
  'file:///tmp/docs/bad%25escape.png'
)

console.log('PASS editor images: relative paths are encoded exactly once on macOS and Windows')
