// The list-slot check (source-structure-fingerprint.js) reads lists with a
// fast line scanner that imitates the Markdown parser. #171: a paste left a
// lone CR before a fence (`常用\r```…`), the scanner (split on LF only) glued
// the fence to the line before, its closing fence opened a block that hid the
// next lists, and every later list was compared with the wrong one →
// 「检测到富文本与源码不一致」(source-list-structure-mismatch). Code nested in a
// list item (`    ```` under `  - b`), `* * *` breaks and link definitions
// shifted the lists the same way.
//
// Locked here:
//   1. the scanner agrees with the real parser (micromark + GFM, math, front
//      matter) on a corpus of constructs, apart from the listed scopes;
//   2. a difference the scanner reports is confirmed by the parser before it
//      can stop a sync (its verdict wins);
//   3. real slot changes still fail closed.
import assert from 'node:assert/strict'
import {
  areMarkdownListSlotsEquivalent,
  areMarkdownListSlotTransitionsEquivalent,
  markdownListSlotFingerprint as scan,
  markdownListSlotFingerprintExact as parse
} from '../src/renderer/src/lib/source-structure-fingerprint.js'

const shape = (groups) => groups.map((group) => group
  .map((slot) => (slot.empty ? 'E' : '') + slot.kind[0] + (slot.task === 'plain' ? '' : slot.task[0]) + (slot.number ?? ''))
  .join(',')).join(' | ')

// 1. Parity. Each entry is authored Markdown a user may have.
const CORPUS = [
  '* * *', '- - -', '_ _ _', '***', '---', 'a\n- - -', '- a\n  * * *\n- b',
  '+ a\n+ b', '* a\n* b', '- a\n* b', '- a\n\n* b', '- a\n+ b\n- c',
  '1) a\n2) b', '1. a\n1. b', '3. a\n4. b', '1. a\n2) b',
  '- a\nlazy\n- b', '- a\n    - b\n- c', '- a\n   - b', '\t- a\n\t- b', '- a\n\t- b',
  '- a\n```\nx\n```', '- a\n| x | y |\n| - | - |\n| 1 | 2 |', '- a\n# h', '- a\n> q',
  'para\n- a\n- b', 'para\n2. a\n3. b', 'para\n1. a',
  '- a\n\n  ```\n  - x\n  1. y\n  ```\n- b',
  '- a\n\n    ```\n    - x\n    ```',
  '```\n- x\n```\n- a', '    - x\n    - y\n\n- a',
  '- a\n  - b\n\n    ```java\n    /**\n     * doc\n     */\n    ```\n- c',
  '1. a\n\n   ```\n   - x\n   ```\n2. b',
  '  - a\n\n      ```\n      - x\n      ```',
  '- a\n\n  ~~~\n  - x\n  ~~~\n- b', '- a\n\n  ````\n  ```\n  - x\n  ````\n- b',
  '- a\n  ```\n  - x\n  ```\n- b',
  '$$\n- x\n1. y\n$$\n\n- a', '- a\n\n  $$\n  - x\n  $$\n- b',
  '---\ntitle: t\ntags:\n- x\n---\n\n- a',
  '- [ ] a\n- [x] b', '-\n- a', '- \n- a', '1.\n2. a', '- <br />\n- a', '-   a\n-   b',
  '- a\n\n- b\n\n\n- c', '**- a**\n\n- b', '1.5 版本\n\n- a', '- a\n  1. b\n  2. c', '* a\n  * b\n    * c',
  '- a\n<br />\n- b', '- a\n\n<br />\n\n- b', '- a\n\n```\nx\n```\n- b', '- a\n```\nx\n```\n- b',
  '1. a\n\n   - b\n\n2. c', '- a\n\n      code\n- b', '- a\n  > q\n- b',
  '- a\n\n[x]: http://e.com\n- b', '- a\n- [链接](http://x)\n- b', '- `- x`\n- b', '- a  \n  b\n- c', '- a\\\n  b\n- c',
  '- a\n\n  para\n\n  - b\n- c',
  // Line endings: CRLF, and the lone CR #171 left behind.
  '- a\r\n```\r\n- x\r\n```\r\n\r\n- b\r\n- c', '- a\r```\n- x\n```\n\n- b\n- c', '常用\r```\nx\n```\n\n\r\n- b\r\n- c'
]
// Scopes the scanner leaves out on purpose (same on both sides of a check):
// lists inside quotes, Markdown-looking lines in raw HTML blocks, and an item
// whose marker line is empty but holds a block (`-` + code: the scanner calls
// it empty, the parser does not; the parser confirms such a difference).
const KNOWN = new Set([
  '> - a\n> - b', '> - a\n- b', '<div>\n- x\n</div>\n\n- a', '<!-- - x -->\n- a',
  '-\n  ```\n  y\n  ```'
])
for (const markdown of [...CORPUS, ...KNOWN]) {
  const scanned = shape(scan(markdown + '\n'))
  const parsed = shape(parse(markdown + '\n'))
  if (KNOWN.has(markdown)) continue
  assert.equal(scanned, parsed, `scanner = parser for ${JSON.stringify(markdown)}`)
}

// 2. #171 in small: a CRLF file with a fence glued by a lone CR, then a list
// gets a new item holding a code block. Source and canonical (the editor's
// own spelling, LF) must agree on every list.
{
  const source = [
    '- 缺点：插件系统常用\r```\nclass A {}\n```\n\n\r\n工厂方法\r\n\r\n',
    '- 做法\r\n- 例子：`Collection.iterator()`\r\n-\r\n  ```\r\n  class B {}\r\n  ```\r\n\r\n抽象工厂\r\n\r\n- 做法\r\n'
  ].join('')
  const canonical = '- 缺点：插件系统常用\n\n```\nclass A {}\n```\n\n工厂方法\n\n- 做法\n- 例子：`Collection.iterator()`\n- <br />\n\n  ```\n  class B {}\n  ```\n\n抽象工厂\n\n- 做法\n'
  const previous = '- 缺点：插件系统常用\n\n```\nclass A {}\n```\n\n工厂方法\n\n- 做法\n- 例子：`Collection.iterator()`\n\n抽象工厂\n\n- 做法\n'
  assert.equal(shape(scan(source)), 'b | b,b,Eb | b', shape(scan(source)))
  assert.equal(areMarkdownListSlotsEquivalent(source, canonical, { strictNesting: true, previousMarkdown: previous }), true, 'the #171 source passes')
}

// 3. The parser overrules a scanner false alarm: `-` + an indented paragraph
// is one item holding that paragraph (the scanner sees an empty item and a
// separate line).
{
  globalThis.__hmSourceIntegrityDiffTrace = []
  assert.equal(shape(scan('-\n  text\n- b\n')), 'Eb | b')
  assert.equal(areMarkdownListSlotsEquivalent('-\n  text\n- b\n', '- text\n- b\n', { strictNesting: true }), true)
  assert.ok(globalThis.__hmSourceIntegrityDiffTrace.some((entry) => entry.kind === 'list-slot-scanner-overruled-by-parser'), 'the overrule is traced')
  assert.equal(
    areMarkdownListSlotTransitionsEquivalent('- a\n', '- a\n-\n  text\n', '- a\n', '- a\n- text\n', { strictNesting: true }),
    true,
    'transitions too'
  )
  delete globalThis.__hmSourceIntegrityDiffTrace
}

// 4. Real slot changes fail closed with both readers.
{
  const opts = { strictOrderedNumbers: true, strictNesting: true }
  assert.equal(areMarkdownListSlotsEquivalent('- a\n- b\n', '- a\n-\n- b\n', opts), false, 'a dropped empty item')
  assert.equal(areMarkdownListSlotsEquivalent('- a\n- b\n', '- a\n  - b\n', opts), false, 'a flattened item')
  assert.equal(areMarkdownListSlotsEquivalent('1. a\n1. b\n', '1. a\n2. b\n', opts), false, 'wrong ordered number')
  assert.equal(areMarkdownListSlotsEquivalent('- [ ] a\n', '- [x] a\n', opts), false, 'task state')
  assert.equal(areMarkdownListSlotsEquivalent('- a\n- b\n', '1. a\n2. b\n', opts), false, 'list kind')
  // A fence nested in a list no longer hides a real difference after it.
  const nested = '- a\n\n    ```\n    - x\n    ```\n\n'
  assert.equal(areMarkdownListSlotsEquivalent(nested + '- b\n- c\n', nested + '- b\n', opts), false, 'a lost item below a nested fence')
}

console.log(`PASS list-slot parser parity (#171): scanner = parser on ${CORPUS.length} constructs (fences nested in lists, lone CR, breaks, definitions, math, front matter); scanner differences confirmed by the parser; real slot changes fail closed`)
