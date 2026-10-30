// LaTeX in `$$` blocks and `$…$` is user data, never Markdown syntax (user
// report 2026-10-30: typing `\\` at a formula line end in a NEW document →
// 富文本与源码不一致 on every keystroke). A new document's source is generated
// from the editor's serialization (generatedScratchMarkdown), and three line
// passes rewrote formulas:
//   - the authored hard-break spelling turned a trailing `\` into two spaces
//     (serializer-style.js, see test:serializer-style);
//   - restoring "fresh" punctuation escapes turned `\\` into `\`, `\{` into `{`;
//   - the empty-paragraph `<br />` line was deleted inside math (and code).
import assert from 'node:assert/strict'
import { canonicalFreshTextToSource, canonicalTextToSource } from '../src/renderer/src/lib/markdown-preservation/core.js'
import { withoutStandaloneEmptyBlockLines } from '../src/renderer/src/lib/markdown-preservation/paragraphs.js'
import { generatedScratchMarkdown } from '../src/renderer/src/markdown-source-preservation.js'

const block = '$$\nE_1:y^2 = x^3 + b \\\\\n\\{a\\}_1 \\_ \\~ \\# * c\n- d\n <br />\n$$\n'

// 1. Fresh-text escape restoration leaves math alone (blocks, quoted, in
//    lists, inline), still restores ordinary text, keeps a literal `\$`.
{
  assert.equal(canonicalFreshTextToSource(block), block, '$$ block kept byte for byte')
  assert.equal(canonicalFreshTextToSource('> $$\n> x\\\\\n> $$\n'), '> $$\n> x\\\\\n> $$\n', 'quoted $$ block')
  assert.equal(canonicalFreshTextToSource('- a\n\n  $$\n  y \\\\\n  $$\n'), '- a\n\n  $$\n  y \\\\\n  $$\n', '$$ block in a list item')
  assert.equal(canonicalFreshTextToSource('$$ \\{x\\} $$\n'), '$$ \\{x\\} $$\n', 'one-line $$')
  assert.equal(
    canonicalFreshTextToSource('text \\# a, \\* b, $\\{a\\}_1\\\\$ and \\$5, $$\\_x$$ \\_ end\n'),
    'text # a, * b, $\\{a\\}_1\\\\$ and \\$5, $$\\_x$$ _ end\n',
    'inline math kept, text escapes restored, literal dollar stays escaped'
  )
  assert.equal(canonicalFreshTextToSource('price \\$5 and \\$6 \\_x\n'), 'price \\$5 and \\$6 _x\n', 'escaped dollars never open math')
  // Text after a closed math block is translated again.
  assert.equal(canonicalFreshTextToSource('$$\n\\\\\n$$\nafter \\_x\n'), '$$\n\\\\\n$$\nafter _x\n')
  // Non-fresh translation (`\~`, `&#x20;`) skips math too: `\~` is a LaTeX accent.
  assert.equal(canonicalTextToSource('$$\n\\~a\n$$\n'), '$$\n\\~a\n$$\n')
}

// 2. The `<br />` empty-paragraph line is removed only in Markdown text.
{
  assert.equal(withoutStandaloneEmptyBlockLines('a\n\n<br />\n\nb\n'), 'a\n\n\n\nb\n')
  assert.equal(withoutStandaloneEmptyBlockLines('> x\n>\n> <br />\n'), '> x\n>\n>\n')
  assert.equal(withoutStandaloneEmptyBlockLines('$$\n <br />\n$$\n<br />\n'), '$$\n <br />\n$$\n\n')
  assert.equal(withoutStandaloneEmptyBlockLines('```\n<br />\n```\n'), '```\n<br />\n```\n')
  assert.equal(withoutStandaloneEmptyBlockLines('~~~~\n```\n<br />\n~~~~\n<br />\n'), '~~~~\n```\n<br />\n~~~~\n\n')
  assert.equal(withoutStandaloneEmptyBlockLines('a\r\n<br />\r\n$$\r\n<br />\r\n$$\r\n'), 'a\r\n\r\n$$\r\n<br />\r\n$$\r\n', 'CRLF')
}

// 3. A new document's generated source keeps the formula exactly.
{
  const canonical = '# 题目给了两条曲线\n\n' + block + '\n'
  const generated = generatedScratchMarkdown(canonical)
  assert.ok(generated.includes(block), `formula kept in the generated source: ${JSON.stringify(generated)}`)
}

// 4. Every generated-source pass leaves closed code / math blocks alone
//    (token swap), in lists and quotes; unclosed blocks and plain text still
//    get the usual treatment.
{
  const code = '```\n- [ ] \n <br />\n|  |  |\n1. x\n```\n'
  const canonical = '# t\n\n' + code + '\n- a\n\n  $$\n  - d \\\\\n   <br />\n  $$\n\n> $$\n> \\{q\\}\n> $$\n\ntext \\_x\n'
  const generated = generatedScratchMarkdown(canonical)
  for (const piece of [code, '  $$\n  - d \\\\\n   <br />\n  $$\n', '> $$\n> \\{q\\}\n> $$\n', 'text _x\n']) {
    assert.ok(generated.includes(piece), `${JSON.stringify(piece)} in ${JSON.stringify(generated)}`)
  }
  assert.doesNotMatch(generated, /\uE0A0/, 'no token left behind')
  const unclosed = '# t\n\n$$\nx \\\\\n <br />\n'
  assert.equal(generatedScratchMarkdown(unclosed), generatedScratchMarkdown(unclosed), 'deterministic')
  assert.doesNotMatch(generatedScratchMarkdown(unclosed), /\uE0A0/)
}

console.log('PASS math literal source: $$ / inline math survive fresh-escape restoration and <br /> placeholder removal (blocks, quotes, lists, CRLF); new-document source keeps formulas and code (token swap: lists, quotes, unclosed blocks)')
