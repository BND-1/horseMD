// Blanks next to which Markdown delimiters cannot open or close: CommonMark's
// "Unicode whitespace" (tab and the Zs category — space, NBSP, U+3000 …).
// lib/inline-serializer.js moves them out of mark edges; the validator
// (source-transaction-sync.js) and the source reprint (reprint.js) compare
// them without the marks they lose there. One class for all three.
export const BLANK_CLASS = '[\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]'
export const isBlankChar = (char) => new RegExp(`^${BLANK_CLASS}$`).test(char || '')
export const hasBlank = (text) => new RegExp(BLANK_CLASS).test(text || '')
export const isAllBlank = (text) => new RegExp(`^${BLANK_CLASS}+$`).test(text || '')
export const splitBlanks = (text) => String(text).split(new RegExp(`(${BLANK_CLASS}+)`))
