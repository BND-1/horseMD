// Follow a text node's value through the Markdown source it came from
// (pure; shared by the sub/superscript and highlight parses). A character
// written as a backslash escape or a character reference is not "plain":
// it never acts as a delimiter (CommonMark).

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const ENTITY = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

// value index -> { at: source offset, plain: written literally } for a text
// node, or null when the value cannot be followed through the source
// (entities, unusual continuation prefixes).
export function alignText(value, source, start, end) {
  const map = new Array(value.length)
  let at = start
  // A text written U+200B + space (the leading-space sentinel, markdown-leading-
  // space.js) reaches us with the U+200B already stripped and its position
  // unchanged. Before, nothing after it could be followed: U+200B + ` a \==g==`
  // reopened as a highlight (fuzz seed 2829).
  if (source[at] === '\u200B' && value[0] !== '\u200B' && (value[0] === ' ' || value[0] === '\t') && source[at + 1] === value[0]) at += 1
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\n') {
      if (source[at] === '\r' && source[at + 1] === '\n') at += 1
      if (source[at] !== '\n' && source[at] !== '\r') return null
      map[index] = { at, plain: true }
      at += 1
      // Continuation-line indentation and quote prefixes are not in the value.
      const next = value[index + 1]
      while (at < end && (source[at] === ' ' || source[at] === '\t' || (source[at] === '>' && next !== '>'))) at += 1
      continue
    }
    if (source[at] === '\\' && ASCII_PUNCT.test(source[at + 1] || '') && source[at + 1] === char) {
      map[index] = { at, plain: false }
      at += 2
      continue
    }
    // A character reference (`&#x65;` — the strong / emphasis handlers
    // encode a neighbour that way, a tab inside sub/sup is `&#x9;`).
    if (source[at] === '&') {
      const entity = ENTITY.exec(source.slice(at, at + 40))
      if (entity) {
        const decoded = entity[1] ? String.fromCodePoint(parseInt(entity[1], 16)) : entity[2] ? String.fromCodePoint(parseInt(entity[2], 10)) : NAMED[entity[3]]
        if (decoded && decoded === value.slice(index, index + decoded.length)) {
          for (let k = 0; k < decoded.length; k += 1) map[index + k] = { at: at + (k ? entity[0].length : 0), plain: false }
          index += decoded.length - 1
          at += entity[0].length
          continue
        }
      }
    }
    if (source[at] !== char) return null
    map[index] = { at, plain: true }
    at += 1
  }
  if (at > end) return null
  // Where the value ends in the source (after its last character).
  map.end = at
  return map
}

