import assert from 'node:assert/strict'
import { buildHtmlDocument, buildHtmlToc } from '../src/main/html-document.js'
import { normalizeHtmlOptions } from '../src/shared/html-options.js'

const options = normalizeHtmlOptions({ theme: 'night', contentWidth: 'wide', fontSizePx: 19, lineHeight: 2, includeDocumentTitle: true, includeToc: true, tocDepth: 2, tocTitle: '目录' })
assert.equal(options.theme, 'night')
assert.equal(options.fontSizePx, 19)
assert.equal(normalizeHtmlOptions({ fontSizePx: 99 }).fontSizePx, 24)

const headings = [
  { id: 'h1', level: 1, text: '第一章' },
  { id: 'h2', level: 2, text: '细节' },
  { id: 'h3', level: 3, text: '隐藏' }
]
const toc = buildHtmlToc(headings, options)
assert.match(toc, /第一章/)
assert.match(toc, /细节/)
assert.doesNotMatch(toc, /隐藏/)

const html = buildHtmlDocument({ title: '<unsafe>', html: '<h1 id="h1">正文</h1>', headings }, options)
assert.match(html, /&lt;unsafe&gt;/)
assert.match(html, /Content-Security-Policy/)
assert.match(html, /script-src|default-src 'none'/)
assert.doesNotMatch(html, /<script/i)
assert.match(html, /--font-size:19px/)
assert.match(html, /<article class="doc"><h1 id="h1">正文<\/h1><\/article>/)

console.log('html document tests passed')

