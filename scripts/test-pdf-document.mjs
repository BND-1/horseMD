import assert from 'node:assert/strict'
import {
  buildPdfDocument,
  buildPdfCss,
  buildPdfHeaderFooter,
  buildPdfToc,
  normalizePdfOptions,
  resolvePdfPage
} from '../src/main/pdf-document.js'

const content = '<h1>HorseMD</h1><p>PDF export</p>'
const document = buildPdfDocument(content)
const defaultCss = buildPdfCss()

assert.ok(document.startsWith('<!doctype html>'))
assert.ok(document.includes('<meta charset="utf-8">'))
assert.ok(document.includes(`<style>${defaultCss}</style>`))
assert.ok(document.includes(`<main class="doc">${content}</main>`))
assert.ok(document.includes("default-src 'none'"))
assert.ok(defaultCss.includes('@page { size: 210mm 297mm;'))

const landscape = resolvePdfPage({ pageSize: 'A3', orientation: 'landscape' })
assert.equal(landscape.width, 420)
assert.equal(landscape.height, 297)
assert.deepEqual(landscape.printPageSize, { width: 16.5354, height: 11.6929 })

const custom = resolvePdfPage({
  pageSize: 'Custom',
  customWidth: 180,
  customHeight: 240,
  orientation: 'portrait'
})
assert.equal(custom.width, 180)
assert.equal(custom.height, 240)
assert.ok(buildPdfCss(custom).includes('size: 180mm 240mm'))

const headingCss = buildPdfCss({ pagination: 'h2' })
assert.ok(headingCss.includes('.doc h2:not(:first-child)'))
assert.ok(headingCss.includes('break-before: page'))
const dividerCss = buildPdfCss({ pagination: 'hr' })
assert.ok(dividerCss.includes('.doc hr'))
assert.ok(dividerCss.includes('break-after: page'))

const invalid = normalizePdfOptions({
  pageSize: '</style><script>alert(1)</script>',
  orientation: 'sideways',
  pagination: 'body{}',
  customWidth: -100,
  customHeight: 'not-a-number'
})
assert.equal(invalid.pageSize, 'A4')
assert.equal(invalid.orientation, 'portrait')
assert.equal(invalid.pagination, 'none')
assert.equal(invalid.customWidth, 50)
assert.equal(invalid.customHeight, 297)
assert.ok(!buildPdfDocument(content, invalid).includes('<script>alert(1)</script>'))

const narrowCss = buildPdfCss({ marginPreset: 'narrow' })
assert.ok(narrowCss.includes('margin: 10mm 10mm 10mm 10mm'))
const customMarginCss = buildPdfCss({
  marginPreset: 'custom',
  margins: { top: 11, right: 12, bottom: 13, left: 14 }
})
assert.ok(customMarginCss.includes('margin: 11mm 12mm 13mm 14mm'))

const headings = [
  { id: 'intro', level: 1, text: 'Introduction' },
  { id: 'unsafe', level: 2, text: '<script>unsafe</script>' },
  { id: 'deep', level: 4, text: 'Hidden at depth 3' }
]
const toc = buildPdfToc(headings, { includeToc: true, tocTitle: 'Contents & Index', tocDepth: 3, tocPageBreak: true })
assert.ok(toc.includes('class="pdf-toc break-after"'))
assert.ok(toc.includes('Contents &amp; Index'))
assert.ok(toc.includes('href="#intro"'))
assert.ok(toc.includes('&lt;script&gt;unsafe&lt;/script&gt;'))
assert.ok(!toc.includes('Hidden at depth 3'))
const withToc = buildPdfDocument({ html: content, headings, title: 'HorseMD guide' }, {
  includeToc: true,
  tocDepth: 3,
  documentTitle: 'HorseMD guide'
})
assert.ok(withToc.includes('<title>HorseMD guide</title>'))
assert.ok(withToc.indexOf('pdf-toc') < withToc.indexOf('class="doc"'))

const templates = buildPdfHeaderFooter({
  documentTitle: '<HorseMD>',
  headerEnabled: true,
  includeTitle: true,
  includeDate: true,
  footerEnabled: true,
  includePageNumbers: true
})
assert.equal(templates.displayHeaderFooter, true)
assert.ok(templates.headerTemplate.includes('&lt;HorseMD&gt;'))
assert.ok(templates.headerTemplate.includes('class="date"'))
assert.ok(templates.footerTemplate.includes('class="pageNumber"'))

assert.equal(normalizePdfOptions({ pageRanges: '1-3, 5, 8 - 10' }).pageRanges, '1-3, 5, 8-10')
assert.throws(() => normalizePdfOptions({ pageRanges: '3-1' }), /invalid-page-range/)

console.log('PASS PDF document: page setup, TOC, headers, ranges, CSP, and pagination')
