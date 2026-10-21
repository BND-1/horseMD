// #154: Typora themes such as LapisCV keep their rules behind a relative
// `@import "lapis-cv/styles/main.css"` and load an icon font as
// `iconfont.ttf?t=…`. The theme is injected into one <style> with no base URL,
// so the main process must inline local imports (each resolved against its
// own file) and keep url() queries; the renderer then scopes every selector
// to the writing area with one uniform extra ID of specificity.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadThemeCss, rewriteThemeUrls } from '../src/main/theme-css.js'
import { boostUserSelector, scopeThemeSelector } from '../src/renderer/src/customThemes.js'

const root = await mkdtemp(join(tmpdir(), 'horsemd-theme-css-'))
try {
  const fileUrl = (...parts) => pathToFileURL(join(root, ...parts)).href
  await mkdir(join(root, 'lapis', 'styles'), { recursive: true })
  await mkdir(join(root, 'lapis', 'fonts'), { recursive: true })
  await writeFile(join(root, 'lapis.css'), [
    '@charset "utf-8";',
    '@import "lapis/styles/main.css";',
    "@import url('https://fonts.example.com/x.css');",
    ':root { --text-size: 10pt; }',
    "@font-face { font-family: 'Icon'; src: url('lapis/fonts/icon.ttf?t=1727014108932') format('truetype'); }",
    '@import "../outside.css";',
    '@import "lapis/missing.css";'
  ].join('\n'))
  await writeFile(join(root, 'lapis', 'styles', 'main.css'), [
    '@import "print.css" print;',
    'h2 { color: var(--accent); }',
    'body { background: url("../fonts/bg.png#frag"); }'
  ].join('\n'))
  await writeFile(join(root, 'lapis', 'styles', 'print.css'), 'h1 { color: black; }\n@import "main.css";')
  await writeFile(join(root, '..', 'outside.css'), 'h3 { color: red; }').catch(() => {})

  const css = await loadThemeCss(join(root, 'lapis.css'), root)
  assert.ok(css.startsWith("@import url('https://fonts.example.com/x.css');"), 'remote @import is hoisted to the top')
  assert.equal((css.match(/@import/g) || []).length, 1, 'local imports are inlined, none left behind')
  assert.ok(css.includes('h2 { color: var(--accent); }'), 'imported rules are inlined')
  assert.ok(css.indexOf('h2 { color') < css.indexOf(':root { --text-size'), 'inlined rules keep the @import position')
  assert.ok(css.includes('@media print {\nh1 { color: black; }'), 'media-qualified import is wrapped in @media')
  assert.ok(css.includes(`url("${fileUrl('lapis', 'fonts', 'icon.ttf')}?t=1727014108932")`), 'url() query survives the rewrite')
  assert.ok(css.includes(`url("${fileUrl('lapis', 'fonts', 'bg.png')}#frag")`), 'imported file resolves url() against its own folder')
  assert.ok(!css.includes('h3 { color: red; }'), 'an import outside the themes folder is not read')
  assert.ok(!css.includes('@charset'), '@charset is dropped (not allowed mid-sheet)')
  assert.equal((css.match(/h2 \{ color/g) || []).length, 1, 'import cycles are read once')

  assert.equal(rewriteThemeUrls('a { b: url(https://x/y.png) }', root), 'a { b: url(https://x/y.png) }')
  assert.equal(rewriteThemeUrls('a { b: url(data:image/png;base64,AA) }', root), 'a { b: url(data:image/png;base64,AA) }')
  assert.equal(rewriteThemeUrls('a { b: url(#id) }', root), 'a { b: url(#id) }')
  assert.equal(rewriteThemeUrls('a { b: url("my%20font.ttf") }', root), `a { b: url("${fileUrl('my font.ttf')}") }`)
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(join(root, '..', 'outside.css'), { force: true })
}

const cases = [
  ['h2', '#write h2'],
  ['p:has(img[alt="avatar"])', '#write p:has(img[alt="avatar"])'],
  ['::before', '#write ::before'],
  ['ul ::marker', '#write ul ::marker'],
  ['#write', ':not(#hm-theme) #write'],
  ['#write h1', ':not(#hm-theme) #write h1'],
  ['.markdown-body table', ':not(#hm-theme) .markdown-body table'],
  ['#writer', '#write #writer'],
  ['html', 'html'],
  [':root', ':root'],
  ['body', 'body'],
  ['body.typora-dark', 'body.typora-dark'],
  ['body h2', ':not(#hm-theme) body h2'],
  ['body > #write', ':not(#hm-theme) body > #write'],
  ['html h2', 'html h2'],
  [':not(#hm-theme) #write', ':not(#hm-theme) #write']
]
for (const [input, expected] of cases) assert.equal(scopeThemeSelector(input), expected, input)

// Snippets: same +1 ID, no #write scoping (they may target the chrome).
for (const [input, expected] of [
  ['h1', ':not(#hm-theme) h1'],
  ['.milkdown .ProseMirror h2', ':not(#hm-theme) .milkdown .ProseMirror h2'],
  ['#write h1', ':not(#hm-theme) #write h1'],
  ['body', ':not(#hm-theme) body'],
  [':root', ':root'],
  ['html', 'html']
]) assert.equal(boostUserSelector(input), expected, `snippet ${input}`)

console.log('PASS theme css: local @import inlined per-file, url() queries kept, remote imports hoisted, selectors scoped to #write')
