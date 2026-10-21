// Load a user theme's CSS for injection into one <style> tag (#154).
// The injected <style> has no base URL of its own, so anything relative to
// the theme file must be resolved here:
//   - url(...) becomes an absolute file:// URL, keeping any ?query / #hash
//     (LapisCV loads `iconfont.ttf?t=…`; encoding the `?` into the path
//     made the font 404);
//   - local @import rules are inlined recursively (LapisCV keeps every rule
//     in `@import "lapis-cv/styles/main.css"`), each file with its own base
//     directory. Remote imports are kept and hoisted to the top, since an
//     @import that follows other rules is ignored.
import { promises as fs } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_IMPORT_DEPTH = 8
const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi
const isAbsoluteRef = (ref) => /^(https?:|data:|file:|blob:)/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')

const splitRef = (ref) => {
  const index = ref.search(/[?#]/)
  return index < 0 ? [ref, ''] : [ref.slice(0, index), ref.slice(index)]
}

const safeDecode = (value) => {
  try { return decodeURI(value) } catch { return value }
}

const inside = (root, full) => full === root || full.startsWith(root + sep)

export function rewriteThemeUrls(css, baseDir) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote, ref) => {
    const target = (ref || '').trim()
    if (!target || isAbsoluteRef(target)) return match
    try {
      const [path, suffix] = splitRef(target)
      return `url("${pathToFileURL(resolve(baseDir, safeDecode(path))).href}${suffix}")`
    } catch {
      return match
    }
  })
}

async function loadCss(full, root, seen, depth, readFile) {
  if (seen.has(full) || depth > MAX_IMPORT_DEPTH) return { css: '', imports: [] }
  seen.add(full)
  const baseDir = dirname(full)
  const source = String(await readFile(full)).replace(/^﻿/, '').replace(/@charset\s+[^;]+;/gi, '')
  const remote = []
  const parts = []
  let cursor = 0
  for (const match of source.matchAll(IMPORT_RE)) {
    parts.push(rewriteThemeUrls(source.slice(cursor, match.index), baseDir))
    cursor = match.index + match[0].length
    const ref = (match[2] || match[4] || '').trim()
    const media = (match[5] || '').trim()
    if (!ref) continue
    if (isAbsoluteRef(ref)) {
      remote.push(match[0])
      continue
    }
    const target = resolve(baseDir, safeDecode(splitRef(ref)[0]))
    if (!inside(root, target) || !/\.css$/i.test(target)) continue
    let nested
    try {
      nested = await loadCss(target, root, seen, depth + 1, readFile)
    } catch {
      continue
    }
    remote.push(...nested.imports)
    parts.push(media ? `@media ${media} {\n${nested.css}\n}` : nested.css)
  }
  parts.push(rewriteThemeUrls(source.slice(cursor), baseDir))
  return { css: parts.join(''), imports: remote }
}

export async function loadThemeCss(full, root, { readFile = (path) => fs.readFile(path, 'utf8') } = {}) {
  const { css, imports } = await loadCss(resolve(full), resolve(root), new Set(), 0, readFile)
  return imports.length ? `${imports.join('\n')}\n${css}` : css
}
