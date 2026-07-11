import assert from 'node:assert/strict'
import { buildPdfDocument, PDF_CSS } from '../src/main/pdf-document.js'

const content = '<h1>HorseMD</h1><p>PDF export</p>'
const document = buildPdfDocument(content)

assert.ok(document.startsWith('<!doctype html>'))
assert.ok(document.includes('<meta charset="utf-8">'))
assert.ok(document.includes(`<style>${PDF_CSS}</style>`))
assert.ok(document.includes(`<div class="doc">${content}</div>`))
assert.ok(PDF_CSS.includes('@page { size: A4;'))

console.log('PASS PDF document: wrapper and print stylesheet')
