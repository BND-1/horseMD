import assert from 'node:assert/strict'
import {
  PDF_DENSITY_PRESETS,
  PDF_DENSITY_VALUES,
  DEFAULT_PDF_OPTIONS,
  normalizePdfOptions
} from '../src/shared/pdf-options.js'
import { buildPdfPrintStyles } from '../src/main/pdf-print-styles.js'

// `standard` MUST equal the verbatim literals that were hardcoded in
// pdf-print-styles.js before density existed — otherwise every existing user's
// export silently changes. This is the no-op-baseline contract.
const s = PDF_DENSITY_VALUES.standard
assert.equal(s.lineHeight, 1.75)
assert.equal(s.para, 0.85)
assert.equal(s.headingTop, 1.6)
assert.equal(s.headingBottom, 0.6)
assert.equal(s.list, 0.8)
assert.equal(s.li, 0.32)
assert.equal(s.blockquote, 1.0)
assert.equal(s.blockquoteP, 0.3)
assert.equal(s.pre, 1.0)
assert.equal(s.figure, 1.1)
assert.equal(s.img, 1.0)
assert.equal(s.math, 1.1)
assert.equal(s.hr, 1.8)

// compact is uniformly tighter than standard on every spacing lever.
const c = PDF_DENSITY_VALUES.compact
for (const key of ['lineHeight', 'para', 'headingTop', 'headingBottom', 'list', 'li', 'blockquote', 'blockquoteP', 'pre', 'figure', 'img', 'math', 'hr']) {
  assert.ok(c[key] < s[key], `compact.${key} (${c[key]}) must be tighter than standard (${s[key]})`)
}

// comfort is uniformly looser than standard on spacing.
const f = PDF_DENSITY_VALUES.comfort
for (const key of ['lineHeight', 'para', 'headingTop', 'headingBottom', 'list', 'li', 'blockquote', 'blockquoteP', 'pre', 'figure', 'img', 'math', 'hr']) {
  assert.ok(f[key] > s[key], `comfort.${key} (${f[key]}) must be looser than standard (${s[key]})`)
}

// normalize: default + validation + round-trip.
assert.deepEqual(PDF_DENSITY_PRESETS, ['comfort', 'standard', 'compact'])
assert.equal(DEFAULT_PDF_OPTIONS.densityPreset, 'standard')
assert.equal(normalizePdfOptions({}).densityPreset, 'standard')
assert.equal(normalizePdfOptions({ densityPreset: 'compact' }).densityPreset, 'compact')
assert.equal(normalizePdfOptions({ densityPreset: 'bogus' }).densityPreset, 'standard')

// buildPdfPrintStyles emits the chosen density's CSS vars, and the BASE_PDF_CSS
// var() fallbacks are the standard literals (so any path missing the :root
// block still renders the pre-density defaults).
const page = { ...DEFAULT_PDF_OPTIONS, width: 210, height: 297, margins: { top: 20, right: 18, bottom: 20, left: 18 } }
const standardCss = buildPdfPrintStyles({ ...page, densityPreset: 'standard' })
const compactCss = buildPdfPrintStyles({ ...page, densityPreset: 'compact' })
assert.ok(standardCss.includes('--hm-pdf-line-height:1.75;'), 'standard :root must emit line-height 1.75')
assert.ok(compactCss.includes('--hm-pdf-line-height:1.4;'), 'compact :root must emit line-height 1.4')
assert.ok(standardCss.includes('var(--hm-pdf-line-height, 1.75)'), 'BASE_PDF_CSS must keep the standard literal as the var fallback')
assert.ok(standardCss.includes('var(--hm-pdf-para-margin, 0.85em)'), 'paragraph margin var fallback must be the standard literal')
// table cell reset invariant survives the var refactor
assert.ok(standardCss.includes('.doc th > p, .doc td > p'), 'table cell paragraph reset must remain')
assert.ok(standardCss.includes('line-height: 1.4'), 'table cell line-height stays hardcoded 1.4 (not a density lever)')

console.log('PASS pdf-density: standard == pre-density literals (no-op baseline), compact tighter, vars + fallbacks correct')
