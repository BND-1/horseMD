// Pure-logic tests for the workspace search core (issue #120). No Electron.
// Locks: query parsing (space-separated AND), case-insensitive matching,
// CRLF/lone-CR line accounting, exact occIdx semantics vs find.js
// matchIndices, snippet windowing, and the truncation caps.
import assert from 'node:assert/strict'
import {
  SEARCH_LIMITS,
  parseSearchQuery,
  searchContent,
  searchFiles
} from '../src/main/globalsearch-core.js'

const matchIndices = (text, query) => {
  // Mirror of src/renderer/src/find.js matchIndices (the FindBar backend).
  const out = []
  if (!text || !query) return out
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let idx = lower.indexOf(q)
  while (idx !== -1) {
    out.push(idx)
    idx = lower.indexOf(q, idx + query.length)
  }
  return out
}

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}`)
    throw err
  }
}

// ---------------------------------------------------------------- parsing
check('parseSearchQuery splits whitespace, dedupes case-insensitively', () => {
  assert.deepEqual(parseSearchQuery('  苹果   香蕉 苹果 BANANA 香蕉 '), ['苹果', '香蕉', 'banana'])
})

check('parseSearchQuery drops empty/whitespace queries', () => {
  assert.deepEqual(parseSearchQuery('   '), [])
  assert.deepEqual(parseSearchQuery(null), [])
})

check('parseSearchQuery caps the term count', () => {
  const terms = parseSearchQuery('a b c d e f g h i j k')
  assert.equal(terms.length, SEARCH_LIMITS.maxTerms)
})

// ---------------------------------------------------------------- AND semantics
check('multi-term requires EVERY term in the file (AND)', () => {
  const both = searchContent('苹果很甜\n香蕉很长\n', ['苹果', '香蕉'])
  assert.equal(both.matched, true)
  const one = searchContent('苹果很甜\n', ['苹果', '香蕉'])
  assert.equal(one.matched, false)
})

check('searchFiles keeps only AND-matching files, in scan order', () => {
  const entries = [
    { path: '/w/a.md', name: 'a.md', rel: 'a.md', content: 'apple banana' },
    { path: '/w/b.md', name: 'b.md', rel: 'b.md', content: 'apple only' },
    { path: '/w/c.md', name: 'c.md', rel: 'c.md', content: 'banana cherry apple' }
  ]
  const { files } = searchFiles(entries, 'apple banana')
  assert.deepEqual(files.map((f) => f.name), ['a.md', 'c.md'])
})

check('searchFiles with an empty query returns nothing', () => {
  const { files, terms } = searchFiles([{ path: 'x', name: 'x', rel: 'x', content: 'hi' }], '  ')
  assert.deepEqual(files, [])
  assert.deepEqual(terms, [])
})

// ---------------------------------------------------------------- line/range basics
check('matches carry 1-based line/col, term, fileOffset and snippet ranges', () => {
  const content = '# 标题\n\n正文包含 苹果 一个。\n第二行没有。\n再来 苹果 香蕉。\n'
  const { matches, matched } = searchContent(content, ['苹果'])
  assert.equal(matched, true)
  assert.equal(matches.length, 2)
  const [m1, m2] = matches
  assert.equal(m1.line, 3)
  // Line 3 is `正文包含 苹果 一个。` — 苹 is the 6th char of the line.
  assert.equal(m1.col, 6)
  assert.equal(m1.term, '苹果')
  assert.equal(m1.fileOffset, content.indexOf('苹果'))
  assert.ok(m1.text.includes('苹果'))
  assert.equal(m1.ranges.length, 1)
  const [range] = m1.ranges
  assert.equal(m1.text.slice(range.start, range.end), '苹果')
  assert.equal(m2.line, 5)
})

check('matching is case-insensitive and every term occurrence on a line is highlighted', () => {
  const { matches } = searchContent('Cat and CAT and dog\n', ['cat'])
  const [m] = matches
  assert.equal(m.ranges.length, 2)
  for (const range of m.ranges) assert.equal(m.text.slice(range.start, range.end).toLowerCase(), 'cat')
})

check('multi-term lines highlight occurrences of all terms', () => {
  const { matches } = searchContent('苹果 香蕉 苹果\n', ['苹果', '香蕉'])
  const [m] = matches
  assert.equal(m.ranges.length, 3)
  assert.equal(m.term, '苹果')
})

// ---------------------------------------------------------------- EOL handling
check('CRLF and lone-CR documents report correct lines and offsets', () => {
  const crlf = 'alpha\r\nbeta\r\nalpha gamma\r\n'
  const { matches } = searchContent(crlf, ['alpha'])
  assert.deepEqual(matches.map((m) => m.line), [1, 3])
  assert.equal(matches[1].fileOffset, crlf.lastIndexOf('alpha'))
  assert.equal(matches[1].col, 1)

  const cr = 'alpha\rbeta\ralpha gamma\r'
  const crMatches = searchContent(cr, ['alpha']).matches
  assert.deepEqual(crMatches.map((m) => m.line), [1, 3])
  assert.equal(crMatches[1].fileOffset, cr.lastIndexOf('alpha'))
})

// ---------------------------------------------------------------- occIdx exactness
check('occIdx equals the matchIndices index of the clicked occurrence (jump exactness)', () => {
  const content = 'apple x\napple y\nApple z\ngrape apple\n'
  const starts = matchIndices(content, 'apple')
  const { matches } = searchContent(content, ['apple'])
  assert.equal(matches.length, 4)
  matches.forEach((m, i) => {
    assert.equal(m.occIdx, i, `match ${i} occIdx`)
    assert.equal(m.fileOffset, starts[i])
  })
})

check('occIdx stays exact even when earlier lines were dropped by the per-file cap', () => {
  const lines = Array.from({ length: SEARCH_LIMITS.maxMatchesPerFile + 5 }, (_, i) => `hit ${i} target\n`)
  const content = lines.join('')
  const starts = matchIndices(content, 'target')
  const { matches, truncated } = searchContent(content, ['target'])
  assert.equal(truncated, true)
  assert.equal(matches.length, SEARCH_LIMITS.maxMatchesPerFile)
  // Every listed match still reports its true whole-document index.
  matches.forEach((m) => assert.equal(m.fileOffset, starts[m.occIdx]))
})

check('non-overlapping semantics match matchIndices for repeated-substring terms', () => {
  const content = 'aaaa\n'
  const starts = matchIndices(content, 'aa')
  const { matches } = searchContent(content, ['aa'])
  const [m] = matches
  assert.equal(m.occIdx, 0)
  assert.equal(m.fileOffset, starts[0])
  assert.equal(m.ranges.length, starts.length === 2 ? 2 : 1)
})

// ---------------------------------------------------------------- snippet windowing
check('long lines are windowed around the first match with visible ellipses', () => {
  const pad = 'x'.repeat(400)
  const content = `${pad}NEEDLE${'y'.repeat(400)}\n`
  const { matches } = searchContent(content, ['needle'])
  const [m] = matches
  assert.ok(m.text.length <= SEARCH_LIMITS.maxLineSnippet + 2)
  assert.ok(m.text.includes('NEEDLE'))
  assert.ok(m.text.startsWith('…') || m.ranges[0].start < 60)
  const [range] = m.ranges
  assert.equal(m.text.slice(range.start, range.end), 'NEEDLE')
})

check('leading indentation is trimmed and ranges follow', () => {
  const content = '    - indented 苹果 item\n'
  const { matches } = searchContent(content, ['苹果'])
  const [m] = matches
  assert.equal(m.text.startsWith('    '), false)
  const [range] = m.ranges
  assert.equal(m.text.slice(range.start, range.end), '苹果')
})

// ---------------------------------------------------------------- caps
check('oversized content is skipped entirely', () => {
  const big = 'a'.repeat(SEARCH_LIMITS.maxFileSize + 1)
  assert.equal(searchContent(big, ['a']).matched, false)
})

check('searchFiles caps the file count and flags truncation', () => {
  const entries = Array.from({ length: SEARCH_LIMITS.maxFiles + 10 }, (_, i) => ({
    path: `/w/f${i}.md`,
    name: `f${i}.md`,
    rel: `f${i}.md`,
    content: `apple ${i}`
  }))
  const { files, truncated } = searchFiles(entries, 'apple')
  assert.equal(files.length, SEARCH_LIMITS.maxFiles)
  assert.equal(truncated, true)
})

console.log(`\nall ${passed} global-search core checks passed`)
