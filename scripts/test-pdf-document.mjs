import assert from 'node:assert/strict'
import {
  buildPdfDocument,
  buildPdfCss,
  normalizePdfOptions,
  PDF_CSS,
  resolvePdfPage
} from '../src/main/pdf-document.js'

const content = '<h1>HorseMD</h1><p>PDF export</p>'
const document = buildPdfDocument(content)

assert.ok(document.startsWith('<!doctype html>'))
assert.ok(document.includes('<meta charset="utf-8">'))
assert.ok(document.includes(`<style>${PDF_CSS}</style>`))
assert.ok(document.includes(`<div class="doc">${content}</div>`))
assert.ok(PDF_CSS.includes('@page { size: 210mm 297mm;'))

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
assert.deepEqual(invalid, {
  pageSize: 'A4',
  orientation: 'portrait',
  pagination: 'none',
  customWidth: 50,
  customHeight: 297
})
assert.ok(!buildPdfDocument(content, invalid).includes('<script>alert(1)</script>'))

console.log('PASS PDF document: wrapper, validated page sizes, and pagination styles')
