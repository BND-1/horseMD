import {
  sourceRawFromVisibleIndex
} from '../../mode-visible-map.js'
import { LEADING_SPACE_SENTINEL } from '../markdown-leading-space.js'

export const commonChange = (previous, next) => {
  let start = 0
  const min = Math.min(previous.length, next.length)
  while (start < min && previous[start] === next[start]) start++

  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--
    nextEnd--
  }
  return { start, previousEnd, nextEnd }
}

export const rawOffsetAtVisible = (markdown, position) =>
  sourceRawFromVisibleIndex(markdown, position.visibleIndex, position.visibleAffinity)

export const lineAt = (markdown, offset) => {
  const safe = Math.max(0, Math.min(offset, markdown.length))
  const start = markdown.lastIndexOf('\n', Math.max(0, safe - 1)) + 1
  const next = markdown.indexOf('\n', safe)
  return { start, end: next < 0 ? markdown.length : next }
}

export const rawInsertionAtCanonicalLineEnd = ({
  source,
  previous,
  canonicalOffset,
  mappedSourceOffset,
  sourceVisibleMap
}) => {
  const previousLine = lineAt(previous, canonicalOffset)
  if (canonicalOffset !== previousLine.end) return null

  const sourceLine = lineAt(source, mappedSourceOffset)
  const hiddenTail = source.slice(mappedSourceOffset, sourceLine.end)
  let low = 0
  let high = sourceVisibleMap.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sourceVisibleMap[middle] < mappedSourceOffset) low = middle + 1
    else high = middle
  }
  if (sourceVisibleMap[low] < sourceLine.end) return null

  // Inline closers (``, **, ~~ and closing HTML) are not part of the visible
  // stream. At a line end the generic backward mapping lands before them.
  // Advance past syntax, but stay before authored hard-break whitespace.
  const trailingWhitespace = hiddenTail.match(/[ \t]*$/)?.[0] || ''

  // When the canonical line itself ends with whitespace, those bytes are
  // literal text the serializer kept (the user typed spaces and then kept
  // typing). The caret sits after them, so the new text must land at the real
  // source line end. Only source-only trailing whitespace — the authored
  // hard-break marker the canonical serializer dropped — must be preserved by
  // inserting before it.
  const canonicalLineText = previous.slice(previousLine.start, previousLine.end)
  if (/[ \t]$/.test(canonicalLineText)) return sourceLine.end

  return sourceLine.end - trailingWhitespace.length
}

export const lineEndingNear = (markdown, offset = 0) => {
  const next = markdown.indexOf('\n', Math.max(0, offset))
  if (next >= 0) return markdown[next - 1] === '\r' ? '\r\n' : '\n'
  const previous = markdown.lastIndexOf('\n', Math.max(0, offset - 1))
  if (previous >= 0) return markdown[previous - 1] === '\r' ? '\r\n' : '\n'
  return markdown.includes('\r\n') ? '\r\n' : '\n'
}

// remark-stringify 为保住 round-trip 语义会对部分字符做序列化转义：
//   - `&#x20;`：行首第一个空格（直接输出会被解析成缩进/列表语义）；
//   - `\~`：波浪线（防止被解析成 GFM 删除线 `~~…~~`）。
// ProseMirror 文本节点里存的是解码后的真实字符，这些只是 canonical 的序列化
// 拼写。所有 canonical 片段写入作者源码前必须还原为作者会打的字面字符，否则
// 用户的源文件会出现 HTML 实体或多余反斜杠（`       文字` 变成 `&#x20;     文字`、
// `0~9` 变成 `0\~9`）。
// 注意：`\\`（反斜杠）刻意不在其中——行尾 `\` 是硬换行语法，反转义会改变语义；
// 反斜杠形态需要独立的输入法级方案，见 docs/canonical-escape-audit.md。
const inlineLiteralRanges = (line) => {
  const ranges = []
  let index = 0
  while (index < line.length) {
    if (line[index] === '`') {
      let openEnd = index + 1
      while (line[openEnd] === '`') openEnd += 1
      const length = openEnd - index
      let cursor = openEnd
      while (cursor < line.length) {
        const candidate = line.indexOf('`', cursor)
        if (candidate < 0) break
        let closeEnd = candidate + 1
        while (line[closeEnd] === '`') closeEnd += 1
        if (closeEnd - candidate === length) {
          ranges.push({ start: index, end: closeEnd })
          index = closeEnd
          break
        }
        cursor = closeEnd
      }
      if (index === openEnd - length) index = openEnd
      continue
    }
    if (line.startsWith('<!--', index)) {
      const close = line.indexOf('-->', index + 4)
      const end = close < 0 ? line.length : close + 3
      ranges.push({ start: index, end })
      index = end
      continue
    }
    if (line[index] === '<') {
      const tag = line.slice(index).match(/^<(\/)?([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\s*(\/?)>/)
      if (tag) {
        const tagEnd = index + tag[0].length
        let end = tagEnd
        if (!tag[1] && !tag[3]) {
          const closePattern = new RegExp(`<\/${tag[2]}\\s*>`, 'ig')
          closePattern.lastIndex = tagEnd
          const close = closePattern.exec(line)
          if (close) end = close.index + close[0].length
        }
        ranges.push({ start: index, end })
        index = end
        continue
      }
    }
    index += 1
  }
  return ranges
}

const markdownEscapePunctuation = /[\\`*{}\[\]()#+\-.!_>~|]/

const translateInlineCanonicalEscapes = (line, restoreFreshPunctuation = false) => {
  const literals = inlineLiteralRanges(line)
  const hasVisibleTextBefore = (offset) => {
    let prefix = line.slice(0, offset).replace(/^[ \t]*/, '')
    // Block syntax is not visible paragraph text. Repeat because quote, list,
    // and heading prefixes can be nested (`> - `, `> ## `, etc.).
    for (;;) {
      const previous = prefix
      prefix = prefix.replace(/^>[ \t]*/, '')
      prefix = prefix.replace(/^(?:#{1,6}|[-+*]|\d{1,9}[.)])[ \t]+/, '')
      prefix = prefix.replace(/^[ \t]*/, '')
      if (prefix === previous) break
    }
    return /\S/.test(prefix)
  }
  let output = ''
  let index = 0
  while (index < line.length) {
    const literal = literals.find((range) => range.start === index)
    if (literal) {
      output += line.slice(literal.start, literal.end)
      index = literal.end
      continue
    }
    if (line.startsWith('&#x20;', index)) {
      // A real leading space cannot be written as plain ASCII Markdown:
      // 1–3 spaces are parser indentation and 4+ become an indented code
      // block. Typora solves the same problem by placing an invisible U+200B
      // before the authored spaces. Keep mid-line/trailing entities as normal
      // spaces, but use the sentinel when no visible text precedes the entity.
      output += hasVisibleTextBefore(index) ? ' ' : `${LEADING_SPACE_SENTINEL} `
      index += 6
      continue
    }
    if (line.startsWith('\\~', index)) {
      output += '~'
      index += 2
      continue
    }
    if (
      restoreFreshPunctuation &&
      line[index] === '\\' &&
      index + 1 < line.length &&
      markdownEscapePunctuation.test(line[index + 1])
    ) {
      const restoredChar = line[index + 1]
      const rest = line.slice(index + 2)
      // A leading escape is the serializer protecting a *literal* punctuation
      // character from becoming block syntax (a lone `-`/`*`/`+` line is an
      // empty bullet item, `#`/`>` start a heading/quote, three backticks open
      // a fence, a leading `|` starts a table row). Restoring the raw char
      // there changes document semantics and the integrity check fails
      // closed. Keep the escape when no visible text precedes it; mid-line
      // escapes remain plain serializer spelling and are restored.
      const restoresToBlockSyntax = !hasVisibleTextBefore(index) && (
        /^[-+*]/.test(restoredChar) && /^(?:\s|$)/.test(rest) ||
        /^\d/.test(restoredChar) && /^[.)](?:\s|$)/.test(rest) ||
        /^[#>|]/.test(restoredChar) ||
        (/^[`~]/.test(restoredChar) && /^[`~]{2}/.test(rest))
      )
      if (restoresToBlockSyntax) {
        output += line[index]
        index += 1
        continue
      }
      output += restoredChar
      index += 2
      continue
    }
    output += line[index]
    index += 1
  }
  return output
}

const htmlBlockStart = (line) => line.match(
  /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i
)?.[1]?.toLowerCase() || null

const genericHtmlBlockStart = (line) => /^ {0,3}<\/?[A-Za-z][\w:-]*(?:\s|\/?>|$)/.test(line)

// Canonical escapes are serializer spelling only in Markdown text. Literal
// regions are different: `&#x20;` and `\~` inside code/HTML are user data and
// must stay byte-for-byte. Keep the translator Markdown-context-aware rather
// than applying global string replacements to the whole document.
export const canonicalTextToSource = (text, { restoreFreshPunctuation = false } = {}) => {
  const input = String(text || '')
  const chunks = input.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || []
  let fence = null
  let htmlTag = null
  let htmlComment = false
  let htmlUntilBlank = false
  return chunks.map((chunk) => {
    const hasNewline = chunk.endsWith('\n')
    const line = hasNewline ? chunk.slice(0, -1) : chunk
    const newline = hasNewline ? '\n' : ''
    const trimmed = line.trim()

    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      return line + newline
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,}).*$/)
    if (open) {
      fence = { char: open[1][0], length: open[1].length }
      return line + newline
    }
    if (htmlComment) {
      if (line.includes('-->')) htmlComment = false
      return line + newline
    }
    if (htmlUntilBlank) {
      if (!trimmed) htmlUntilBlank = false
      return line + newline
    }
    if (line.includes('<!--')) {
      htmlComment = !line.includes('-->', line.indexOf('<!--') + 4)
      return line + newline
    }
    if (htmlTag) {
      if (new RegExp(`</${htmlTag}\\s*>`, 'i').test(line)) htmlTag = null
      return line + newline
    }
    const rawTag = htmlBlockStart(line)
    if (rawTag) {
      if (!new RegExp(`</${rawTag}\\s*>`, 'i').test(line)) htmlTag = rawTag
      return line + newline
    }
    if (genericHtmlBlockStart(line)) {
      htmlUntilBlank = true
      return line + newline
    }
    // Do not classify canonical lines as literal code from indentation alone.
    // Four spaces (or a tab) can be structural indentation for a list
    // continuation, and remark may still emit `&#x20;` immediately after that
    // prefix for a real leading space typed by the author. Treating the whole
    // line as literal leaked the serializer entity back into source. Real code
    // blocks produced by the rich serializer are fenced and are handled above;
    // localized edits inside authored literal regions are protected by
    // `literalSourceRegion` in `adaptCanonicalRegionToSource`.
    if (/^ {0,3}(?:<\?|<!\[CDATA\[|<![A-Z])/.test(line)) {
      return line + newline
    }
    if (!trimmed) return line + newline
    return translateInlineCanonicalEscapes(line, restoreFreshPunctuation) + newline
  }).join('')
}

// Use only for a region proven to be newly typed ProseMirror text. In that
// context canonical `\X` is serializer spelling for the character the user
// entered. Fenced/inline code and HTML ranges remain byte-exact through the
// context scanner above.
export const canonicalFreshTextToSource = (text) => canonicalTextToSource(text, {
  restoreFreshPunctuation: true
})

const fencedCodeAt = (markdown, offset) => {
  let fence = null
  for (const line of markdownLines(String(markdown || ''))) {
    if (line.start > offset) break
    if (fence) {
      const close = line.text.match(/^ {0,3}(`{3,}|~{3,})\s*\r?$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      continue
    }
    const open = line.text.match(/^ {0,3}(`{3,}|~{3,}).*\r?$/)
    if (open) fence = { char: open[1][0], length: open[1].length }
  }
  return Boolean(fence)
}

const literalSourceRegion = (source, region) => {
  if (fencedCodeAt(source, region.start)) return true
  const line = lineAt(source, region.start)
  if (region.end > line.end) return false
  const start = Math.max(0, region.start - line.start)
  const end = Math.max(start, region.end - line.start)
  return inlineLiteralRanges(source.slice(line.start, line.end))
    .some((range) => start >= range.start && end <= range.end)
}

export const adaptCanonicalRegionToSource = (replacement, source, region) => {
  const eol = lineEndingNear(source, region.start)
  let adapted = (literalSourceRegion(source, region)
    ? String(replacement || '')
    : canonicalTextToSource(replacement)).replace(/\r\n?|\n/g, eol)
  const sourceRegion = source.slice(region.start, region.end)
  if (region.start === 0 && source.startsWith('\uFEFF') && !adapted.startsWith('\uFEFF')) {
    adapted = '\uFEFF' + adapted
  }
  if (
    sourceRegion.endsWith('\r') &&
    source[region.end] === '\n' &&
    !adapted.endsWith('\r')
  ) {
    adapted += '\r'
  }
  return adapted
}

export const isTableLine = (line) => line.includes('|')

export const listMarker = (line) => line.match(/^(\s*)(?:[-+*]|\d{1,9}[.)])(?=[ \t]+|$)/)

export const markdownLines = (markdown) => {
  const lines = []
  let start = 0
  while (start <= markdown.length) {
    const next = markdown.indexOf('\n', start)
    const end = next < 0 ? markdown.length : next
    lines.push({ start, end, text: markdown.slice(start, end) })
    if (next < 0) break
    start = next + 1
  }
  return lines
}

export const lineIndexAt = (lines, offset) => {
  const safe = Math.max(0, offset)
  return lines.findIndex((line) => safe >= line.start && safe <= line.end)
}
