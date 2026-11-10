// Source reprint engine (R1) against the real Crepe parser/serializer.
// One Electron session; each case: authored `source`, a `target` whose parse
// is the editor document, and the exact `expected` bytes (author spelling of
// untouched parts must survive). See docs/source-reprint-architecture.md.
import assert from 'node:assert/strict'
import { open } from './lib/probe-session.mjs'

const FIXTURE = undefined // probe-session default fixture
const cases = [
  { name: 'identity: fixture unchanged', source: null, target: null, expected: null },
  { name: 'paragraph: insert a char', source: 'a para here\n\nnext\n', target: 'a paXra here\n\nnext\n', expected: 'a paXra here\n\nnext\n' },
  { name: 'list: author `-` kept when meaning is spelled `*`', source: '- one\n- two\n', target: '* one\n* twoX\n', expected: '- one\n- twoX\n' },
  { name: 'quote: edit second line keeps `> ` prefixes', source: '> first line\n> second line\n\nafter\n', target: '> first line\n> second lineX\n\nafter\n', expected: '> first line\n> second lineX\n\nafter\n' },
  { name: 'hr removed exactly', source: '# T\n\n---\n\nfinal\n', target: '# T\n\nfinal\n', expected: '# T\n\nfinal\n' },
  { name: 'table: cell edit keeps padding', source: '| A   | B |\n| --- | --- |\n| 1   | 2 |\n', target: '| A | B |\n|-|-|\n| 1 | 2z |\n', expected: '| A   | B |\n| --- | --- |\n| 1   | 2z |\n' },
  { name: 'doc: insert paragraph between', source: 'a\n\nb\n', target: 'a\n\nnew\n\nb\n', expected: 'a\n\nnew\n\nb\n' },
  { name: 'list: insert item keeps marker', source: '- a\n- b\n', target: '* a\n* x\n* b\n', expected: '- a\n- x\n- b\n' },
  { name: 'ordered list: append item', source: '1. a\n2. b\n', target: '1. a\n2. b\n3. c\n', expected: '1. a\n2. b\n3. c\n' },
  { name: 'code block in quote: content edit', source: '> ```js\n> let a = 1\n> ```\n', target: '> ```js\n> let a = 12\n> ```\n', expected: '> ```js\n> let a = 12\n> ```\n' },
  { name: 'emphasis `_x_` kept on inner edit', source: 'a _em_ b\n', target: 'a _emX_ b\n', expected: 'a _emX_ b\n' },
  { name: 'bold toggle on a word', source: 'a word b\n', target: 'a **word** b\n', expected: 'a **word** b\n' },
  { name: 'CRLF file edit', source: 'one\r\n\r\ntwo\r\n', target: 'one\n\ntwoX\n', expected: 'one\r\n\r\ntwoX\r\n' },
  { name: 'BOM file edit', source: '﻿# T\n\n*a* b\n', target: '# T\n\n*a* bX\n', expected: '﻿# T\n\n*a* bX\n' },
  { name: 'task checkbox toggle', source: '- [ ] a\n- [x] b\n', target: '- [x] a\n- [x] b\n', expected: '- [x] a\n- [x] b\n' },
  { name: 'nested list item edit', source: '- a\n  - b\n  - c\n- d\n', target: '- a\n  - b\n  - cX\n- d\n', expected: '- a\n  - b\n  - cX\n- d\n' },
  { name: 'heading level change', source: '## a\n\nb\n', target: '### a\n\nb\n', expected: '### a\n\nb\n' },
  { name: 'typed `*` stays literal', source: 'a b\n', target: 'a \\* b\n', expected: 'a * b\n' },
  { name: 'leading spaces use the sentinel', source: 'x\n\nsecond `code` here\n', target: 'x\n\n&#x20;   second `code` here\n', expected: 'x\n\n​    second `code` here\n' },
  { name: 'soft-break paragraph: edit 2nd line', source: 'line one\nline two\n\nnext\n', target: 'line one\nline twoX\n\nnext\n', expected: 'line one\nline twoX\n\nnext\n' },
  // Fuzz 2026-10-31 (seed 0): inline code edited and a blank typed after the
  // soft break, in one paragraph — the segment patch lost the line break;
  // the verifier's last step prints the paragraph whole.
  // Fuzz 2026-10-31 (seed 48): content lines of an indented fence carry its
  // indentation (CommonMark removes up to that many spaces from each).
  { name: 'code: fence indented 1, line with leading blanks', source: '# h\n ```js\nconst a = 1\n- not a list\n```\n\nafter\n', target: '# h\n\n```js\nconst a = 1\n- not\n  a list\n```\n\nafter\n', expected: '# h\n ```js\n const a = 1\n - not\n   a list\n```\n\nafter\n' },
  { name: 'code: fence indented 2', source: '  ```\n  x\n  ```\n', target: '```\nx\n  y\n```\n', expected: '  ```\n  x\n    y\n  ```\n' },
  { name: 'code: fence one past the list item column', source: '- i\n\n   ```\n   x\n   ```\n', target: '- i\n\n  ```\n  x\n    y\n  ```\n', expected: '- i\n\n   ```\n   x\n     y\n   ```\n' },
  // A blank at the start of a continuation line reads back (`&#x20;`):
  // content, kept (projection; it used to be dropped as "no Markdown").
  { name: 'inline code edit + blank after a soft break', source: 'p `inline cod`x。\nn    Second line.\n', target: 'p `inlin`x。\n&#x20;n    Second line.\n', expected: 'p `inlin`x。\n&#x20;n    Second line.\n' },
  { name: 'delete first paragraph', source: 'a\n\nb\n\nc\n', target: 'b\n\nc\n', expected: 'b\n\nc\n' },
  { name: 'delete last list item', source: '- a\n- b\n- c\n', target: '- a\n- b\n', expected: '- a\n- b\n' },
  { name: 'join two paragraphs (Backspace)', source: 'first *em*\n\nsecond `c`\n', target: 'first *em*second `c`\n', expected: 'first *em*second `c`\n' },
  { name: 'split paragraph inside bold (Enter)', source: 'Lead **bold word** tail.\n\nafter\n', target: 'Lead **bold**\n\n**word** tail.\n\nafter\n', expected: 'Lead **bold**\n\n**word** tail.\n\nafter\n' },
  { name: 'lazy quote continuation edit', source: '> 引用段落 quoted\n第二行 lazy line\n\nafter\n', target: '> 引用段落 quoted\n> 第二行 lazy lineX\n\nafter\n', expected: '> 引用段落 quoted\n第二行 lazy lineX\n\nafter\n' },
  { name: 'quote with bold: type inside bold', source: '> quote **bold** here\n\nafter\n', target: '> quote **boZld** here\n\nafter\n', expected: '> quote **boZld** here\n\nafter\n' },
  { name: 'table: `|` typed in a cell is escaped', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n', target: '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |\n', expected: '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |\n' },
  { name: 'table: Enter in a cell becomes <br>', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n', target: '| A | B |\n| --- | --- |\n| 1<br>x | 2 |\n', expected: '| A | B |\n| --- | --- |\n| 1<br>x | 2 |\n' },
  { name: 'irregular table: edit keeps the short row', source: 'intro\n\n| A | B |\n| --- | --- |\n| 1 |\n| 3 | 4 |\n', target: 'intro\n\n| A | B |\n| --- | --- |\n| 1 |\n| 3z | 4 |\n', expected: 'intro\n\n| A | B |\n| --- | --- |\n| 1 |\n| 3z | 4 |\n' },
  { name: 'bullet → ordered conversion', source: 'x\n\n- a\n- b\n\ny\n', target: 'x\n\n1. a\n2. b\n\ny\n', expected: 'x\n\n1. a\n2. b\n\ny\n' },
  { name: 'html block untouched while editing elsewhere', source: '<div align="center">\n  <b>hi</b>\n</div>\n\npara\n', target: '<div align="center">\n  <b>hi</b>\n</div>\n\nparaX\n', expected: '<div align="center">\n  <b>hi</b>\n</div>\n\nparaX\n' },
  { name: 'math block untouched', source: '$$\na^2\n$$\n\npara\n', target: '$$\na^2\n$$\n\nparaX\n', expected: '$$\na^2\n$$\n\nparaX\n' },
  { name: 'frontmatter untouched', source: '---\ntitle: x\n---\n\npara\n', target: '---\ntitle: x\n---\n\nparaX\n', expected: '---\ntitle: x\n---\n\nparaX\n' },
  { name: 'escaped source chars survive nearby edit', source: 'price \\*not em\\* 1\\. x\n', target: 'price \\*not em\\* 1\\. xY\n', expected: 'price \\*not em\\* 1\\. xY\n' },
  { name: 'loose list: insert item keeps blank lines', source: '- a\n\n- b\n', target: '- a\n\n- x\n\n- b\n', expected: '- a\n\n- x\n\n- b\n' },
  { name: 'ordered `1)` delimiter kept', source: '1) a\n2) b\n', target: '1. a\n2. bX\n', expected: '1) a\n2) bX\n' },
  { name: 'image paragraph untouched', source: '![alt](a.png)\n\npara\n', target: '![alt](a.png)\n\nparaX\n', expected: '![alt](a.png)\n\nparaX\n' },
  { name: 'link text edit keeps url spelling', source: 'see [the docs](<https://x.y/a b> "t") now\n', target: 'see [the docsX](<https://x.y/a b> "t") now\n', expected: 'see [the docsX](<https://x.y/a b> "t") now\n' },
  { name: 'table: cell emptied keeps padding', source: '| A | B |\n| --- | ---: |\n| x | 5 |\n', target: '| A | B |\n| --- | ---: |\n| x |  |\n', expected: '| A | B |\n| --- | ---: |\n| x |  |\n' },
  { name: 'table: `>` typed at cell start stays literal', source: '| A | B |\n| --- | --- |\n| x | y |\n', target: '| A | B |\n| --- | --- |\n| x | \\> y |\n', expected: '| A | B |\n| --- | --- |\n| x | > y |\n' },
  { name: 'inline code: text typed at code start', source: 'a `code` b\n', target: 'a ` xcode` b\n', expected: 'a ` xcode` b\n' },
  { name: 'block reprint keeps the leading-space sentinel', source: 'x\n\n- a\n', target: 'x\n\n&#x20; lead **b**\n\n- a\n', expected: 'x\n\n\u200B  lead **b**\n\n- a\n' },
  { name: 'escaped backslash keeps mapping', source: '## a \\\\ b\n\npara\n', target: '## a \\\\ bX\n\npara\n', expected: '## a \\\\ bX\n\npara\n' },
  { name: 'trailing space in editor is not written (no growth)', source: '# Title\n\npara\n', target: '# Title&#x20;\n\npara\n', expected: '# Title\n\npara\n' },
  { name: 'irregular table: padded row stays short', source: '| A | B |\n| --- | --- |\n| 1 | 2 | extra |\n\nx\n', target: '| A | B |\n| --- | --- |\n| 1 | 2 | extra |\n\nxY\n', expected: '| A | B |\n| --- | --- |\n| 1 | 2 | extra |\n\nxY\n' },
  { name: 'text typed before a sentinel-led space', source: '## \u200B Todo\n', target: '## X Todo\n', expected: '## X Todo\n' },
  { name: 'irregular table: line break added in next row keeps pipes', source: '| A | B |\n| --- | ---: |\n| 苹果 apple | 3 | 42src **tes** |\n| alphatest | 5 |\n', target: '| A | B |\n| --- | ---: |\n| 苹果 apple | 3 | 42src **tes** |\n| alphatest | <br>5 |\n', expected: '| A | B |\n| --- | ---: |\n| 苹果 apple | 3 | 42src **tes** |\n| alphatest | <br>5 |\n' },
  { name: 'reference links survive a nearby edit', source: '[HorseMD][horse] 与 [shortcut] 和 SHORTCUT_AFTER 共存。\n\n[horse]: https://h.example "H"\n[shortcut]: https://s.example\n', target: '[HorseMD][horse] 与 [shortcut] 和 SHORTCUT_AFTERX 共存。\n\n[horse]: https://h.example "H"\n[shortcut]: https://s.example\n', expected: '[HorseMD][horse] 与 [shortcut] 和 SHORTCUT_AFTERX 共存。\n\n[horse]: https://h.example "H"\n[shortcut]: https://s.example\n' },
  { name: 'table: trailing line break in a cell is written', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n', target: '| A | B |\n| --- | --- |\n| 1<br> | 2 |\n', expected: '| A | B |\n| --- | --- |\n| 1<br> | 2 |\n' },
  { name: 'table: leading line break in a cell is written', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n', target: '| A | B |\n| --- | --- |\n| <br>1 | 2 |\n', expected: '| A | B |\n| --- | --- |\n| <br>1 | 2 |\n' },
  { name: 'separator: second paragraph inside a list item', source: '- a\n  - n\n', target: '- a\n\n  b\n\n  - n\n', expected: '- a\n\n  b\n  - n\n' },
  { name: 'separator: empty nested item after a paragraph is not a setext underline', source: '- test\n', target: '- test\n\n  -\n', expected: '- test\n\n  -\n' },
  { name: 'separator: paragraph after a list gets a blank line', source: '- a\n', target: '- a\n\npara\n', expected: '- a\n\npara\n' },
  { name: 'separator: tight first gap does not glue new paragraphs', source: '# h\npara\n', target: '# h\npara\n\nnew\n', expected: '# h\npara\n\nnew\n' },
  { name: 'table printed whole keeps a trailing cell <br> and the delimiter row', source: '| A | B |\n| :-- | --: |\n| 1 | 2 |\n', target: '| A | B | C |\n| :-- | --: | --- |\n| 1<br> | 2 | 3 |\n', expected: '| A | B | C |\n| :--- | ---: | --- |\n| 1<br> | 2 | 3 |\n' },
  // A blank right after a cell `<br>` shows nothing and is not written by
  // the serializer: either spelling verifies (seeds 1142, 5344).
  { name: 'cell italic running over a <br> (seed 1142)', source: '| *test* |\n| --- |\n|  |\n', target: '| *test<br> oktest* |\n| --- |\n|  |\n', expected: '| *test*<br> *oktest* |\n| --- |\n|  |\n' },
  // Bold " alp" right after a cell `<br>`: the serializer wrote the cell two
  // ways (` **alp`, then `**alp` once read back), so no reprint verified
  // (Windows fuzz seed 5344). Blanks next to a cell break are never written.
  { name: 'cell: bold text starting with a blank after <br> (seed 5344)', source: '| Qty你好 |\n| --- |\n|  |\n', targetDoc: {"type": "doc", "content": [{"type": "table", "content": [{"type": "table_header_row", "content": [{"type": "table_header", "attrs": {"alignment": null}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Qty你好"}, {"type": "hardbreak", "attrs": {"isInline": false}, "marks": [{"type": "strong", "attrs": {"marker": "*"}}, {"type": "highlight", "attrs": {"color": "yellow"}}]}, {"type": "text", "text": " alp", "marks": [{"type": "strong", "attrs": {"marker": "*"}}]}, {"type": "hardbreak", "attrs": {"isInline": false}, "marks": [{"type": "strong", "attrs": {"marker": "*"}}]}, {"type": "text", "text": "/table", "marks": [{"type": "strong", "attrs": {"marker": "*"}}]}, {"type": "hardbreak", "attrs": {"isInline": false}, "marks": [{"type": "strong", "attrs": {"marker": "*"}}]}]}]}]}, {"type": "table_row", "content": [{"type": "table_cell", "attrs": {"alignment": null}, "content": [{"type": "paragraph"}]}]}]}]}, expected: '| Qty你好<br> **alp**<br>**/table**<br> |\n| --- |\n|  |\n' },
  // An empty item opening a quote right after a paragraph line reads as
  // text (`> -`); no patch verifies, the widened print does (Windows fuzz
  // seed 286: the verifier used to have nothing left and paused).
  { name: 'empty bullet opening a quote under an item line: widened print (seed 286)', source: '# h\n\n1. a\n   > b\n\nend\n', targetDoc: {"type": "doc", "content": [{"type": "heading", "attrs": {"level": 1, "id": "h"}, "content": [{"type": "text", "text": "h"}]}, {"type": "ordered_list", "attrs": {"order": 1, "spread": false}, "content": [{"type": "list_item", "attrs": {"label": "1.", "listType": "ordered", "spread": false, "checked": null}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}, {"type": "blockquote", "content": [{"type": "bullet_list", "attrs": {"spread": false}, "content": [{"type": "list_item", "attrs": {"label": "•", "listType": "bullet", "spread": false, "checked": null}, "content": [{"type": "paragraph"}]}]}, {"type": "paragraph", "content": [{"type": "text", "text": "b"}]}]}]}]}, {"type": "paragraph", "content": [{"type": "text", "text": "end"}]}]}, expected: '# h\n\n1. a\n\n   > -\n   >\n   > b\n\nend\n' },
  // Every HTML named reference maps (`&copy;`, `&hellip;`), and `&amp;`
  // is read as the reference it is, not a literal `&` (the whole paragraph
  // was reprinted with the characters instead).
  { name: 'character references keep their spelling around an edit', source: '实体 A：&copy;、&amp;、&hellip; 尾\n', target: '实体 AX：©、&、… 尾\n', expected: '实体 AX：&copy;、&amp;、&hellip; 尾\n' },
  // A list whose type alone changed: only the markers are rewritten.
  { name: 'ordered list converted to bullets keeps nested spacing and markers', source: '1. a\n\n   * x\n   * y\n2. b\n', target: '- a\n\n   * x\n   * y\n- b\n', expected: '- a\n\n   * x\n   * y\n- b\n' },
  { name: 'bullet list converted to ordered moves its later lines with the marker', source: '- a\n\n  * x\n- b\n', target: '1. a\n\n   * x\n2. b\n', expected: '1. a\n\n   * x\n2. b\n' },
  { name: 'nested list on the same line as its parent marker keeps its spelling', source: '- a\n- - 测试 1. 你好\n- c\n', target: '- a\n- - 测试 1. 你好X\n- c\n', expected: '- a\n- - 测试 1. 你好X\n- c\n' },
  { name: 'paragraph lifted out of an empty nested item stays in the parent item', source: '1. a\n   1. x\n   2.\n      y\n', target: '1. a\n   1. x\n   2.\n\n   y\n', expected: '1. a\n   1. x\n   2.\n\n   y\n' },
  { name: 'CJK bold around full-width punctuation (Typora parity)', source: '这是「重点」内容\n', target: '这是**「重点」**内容\n', expected: '这是**「重点」**内容\n' },
  { name: 'ordered list: deleting an item renumbers the following ones', source: 'x\n\n1. a\n2. b\n3. c\n4. d\n', target: 'x\n\n1. a\n2. c\n3. d\n', expected: 'x\n\n1. a\n2. c\n3. d\n' },
  { name: 'ordered list: inserting an item renumbers the following ones', source: 'x\n\n1. a\n2. b\n3. c\n', target: 'x\n\n1. a\n2. n\n3. b\n4. c\n', expected: 'x\n\n1. a\n2. n\n3. b\n4. c\n' },
  { name: 'ordered list: all-1 numbering is kept', source: 'x\n\n1. a\n1. b\n1. c\n', target: 'x\n\n1. a\n1. c\n', expected: 'x\n\n1. a\n1. c\n' },
  { name: 'setext heading edit', source: 'Title\n=====\n\npara\n', target: '# TitleX\n\npara\n', expected: 'TitleX\n=====\n\npara\n' },
  // Typora parity (checked in Typora 0.11.18, 2026-10-09): emptying a
  // top-level paragraph keeps its line; Backspace on that empty line then
  // collapses the blank lines. `emptyAt` inserts editor-only empty paragraphs
  // at top-level indices (Markdown cannot spell them).
  { name: 'emptied paragraph keeps its line (Typora)', source: '# 测试\n\n你好\n\n再见\n', target: '# 测试\n\n再见\n', emptyAt: [1], expected: '# 测试\n\n\n\n再见\n' },
  { name: 'emptied paragraph with marks keeps its line', source: 'a\n\n**粗** `c`\n\nb\n', target: 'a\n\nb\n', emptyAt: [1], expected: 'a\n\n\n\nb\n' },
  { name: 'emptied first paragraph keeps its line', source: '你好\n\n再见\n', target: '再见\n', emptyAt: [0], expected: '\n\n再见\n' },
  { name: 'removing the empty line collapses blank lines (Typora)', source: '# 测试\n\n\n\n再见\n', target: '# 测试\n\n再见\n', previous: '# 测试\n\n再见\n', previousEmptyAt: [1], expected: '# 测试\n\n再见\n' },
  { name: 'empty line still present: blank lines stay', source: '# 测试\n\n\n\n再见\n', target: '# 测试\n\n再见X\n', emptyAt: [1], previous: '# 测试\n\n再见\n', previousEmptyAt: [1], expected: '# 测试\n\n\n\n再见X\n' },
  { name: 'authored extra blank lines untouched by an edit elsewhere', source: 'a\n\n\n\nb\n', target: 'a\n\n\n\nbX\n', previous: 'a\n\nb\n', expected: 'a\n\n\n\nbX\n' },
  { name: 'typing into the kept empty line', source: '# 测试\n\n\n\n再见\n', target: '# 测试\n\nQ\n\n再见\n', previous: '# 测试\n\n再见\n', previousEmptyAt: [1], expected: '# 测试\n\nQ\n\n再见\n' },
  // Fuzz primary14: a deletion exposing a leading blank, and Enter before the
  // space of a heading, keep the sentinel spelling.
  { name: 'deleting the first char exposes a leading space (seed 61)', source: 'x\n\na bk\n', target: 'x\n\n&#x20;bk\n', expected: 'x\n\n\u200B bk\n' },
  { name: 'deleting the first char exposes a marker', source: 'x\n\na- b\n', target: 'x\n\n\\- b\n', expected: 'x\n\n\\- b\n' },
  { name: 'heading split before a space keeps the sentinel (seed 66)', source: '## 待办 Todo\n\nz\n', target: '## 待办\n\n## &#x20;Todo\n\nz\n', expected: '## 待办\n\n## \u200B Todo\n\nz\n' },
  { name: 'cell: backslash typed before <br> stays literal (seed 73)', source: '| A |\n| --- |\n| x<br>y |\n', target: '| A |\n| --- |\n| x\\\\<br>y |\n', expected: '| A |\n| --- |\n| x\\\\<br>y |\n' },
  { name: 'backslash typed before authored punctuation stays literal', source: 'a *b*\n', target: 'a\\\\*b*\n', expected: 'a\\\\*b*\n' },
  { name: 'cell: deleting spaces between \\ and <br> keeps it literal (seed 73)', source: '| A |\n| --- |\n| x\\  <br>y |\n', target: '| A |\n| --- |\n| x\\\\<br>y |\n', expected: '| A |\n| --- |\n| x\\  <br>y |\n' }, // blanks before a <br> show nothing: same meaning, authored bytes kept
  { name: 'table: emptying the last cell of a row without closing pipe (seed 84)', source: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | x\n', target: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n', expected: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n' },
  // Fuzz FORMAT+UI 2026-11-04: a table handle's align button (seed 107) and
  // an item inserted under a parent whose marker ends its line (seed 105).
  { name: 'table: an alignment change respells only that delimiter segment (seed 107)', source: '| A |  B |\n|---|--:|\n| 1<br> |2|\n', target: '| A | B |\n| --- | :---: |\n| 1<br> | 2 |\n', expected: '| A |  B |\n|---|:--:|\n| 1<br> |2|\n' },
  { name: 'table: alignment and cell text change together', source: '| A | B |\n| --- | ---: |\n| 1 | 2 |\n', target: '| A | B |\n| :--- | ---: |\n| 1x | 2 |\n', expected: '| A | B |\n| :--- | ---: |\n| 1x | 2 |\n' },
  { name: 'table in a quote: alignment change', source: '> | A |\n> | --- |\n> | 1 |\n', target: '> | A |\n> | ---: |\n> | 1 |\n', expected: '> | A |\n> | ---: |\n> | 1 |\n' },
  { name: 'nested item inserted under a marker that ends its line (seed 105)', source: 'x\n\n1. a\n2.\n   1. b\n3. c\n', target: 'x\n\n1. a\n2.\n   1. b\n   2. n\n3. c\n', expected: 'x\n\n1. a\n2.\n   1. b\n   2. n\n3. c\n' },
  { name: 'table: deleting the first body row keeps the delimiter row (seed 128)', source: '| A | B |\n|---| :--- |\n| 1 | 2 |\n| 3 | 4 |\n', target: '| A | B |\n| --- | :--- |\n| 3 | 4 |\n', expected: '| A | B |\n|---| :--- |\n| 3 | 4 |\n' },
  { name: 'table: inserting a first body row keeps the delimiter row', source: '| A |\n| --- |\n| 3 |\n', target: '| A |\n| --- |\n| n |\n| 3 |\n', expected: '| A |\n| --- |\n| n |\n| 3 |\n' },
  { name: 'table: deleting the only body row keeps the delimiter row', source: 'x\n\n| A |\n| --- |\n| 1 |\n\ny\n', target: 'x\n\n| A |\n| --- |\n\ny\n', expected: 'x\n\n| A |\n| --- |\n\ny\n' },
  { name: 'task led by a block keeps its sentinel line when the item is edited (seed 154)', source: 'x\n\n- [x] \u200B\n  ```js\n  a\n  ```\n  b\n', target: 'x\n\n- [x] \u200B\n  ```js\n  a\n  ```\n  nb\n', expected: 'x\n\n- [x] \u200B\n  ```js\n  a\n  ```\n  nb\n', stripSentinels: true },
  { name: 'nested task led by a block, after an empty task (seed 154)', source: 'x\n\n- [x] a\n  - [x] \u200B\n  - [x] \u200B\n    ```js\n    a\n    ```\n    b\n', target: 'x\n\n- [x] a\n  - [x] \u200B\n  - [x] \u200B\n    ```js\n    a\n    ```\n    nb\n', expected: 'x\n\n- [x] a\n  - [x] \u200B\n  - [x] \u200B\n    ```js\n    a\n    ```\n    nb\n', stripSentinels: true },
  { name: 'task whose text was emptied, nested list now first: marker line keeps the sentinel (seed 165)', source: 'x\n\n- [x] a\n  - [x] b\n', target: 'x\n\n- [x] \u200B\n  - [x] b\n', expected: 'x\n\n- [x] \u200B\n  - [x] b\n', stripSentinels: true },
  { name: 'unclosed $$ block in a list item edited: the next item keeps its line (seed 181)', source: 'x\n\n- $$\n  E\n  $$ s\n  y\n- b\n', target: 'x\n\n- $$\n  E\n  $$ s\n  yz\n- b\n', expected: 'x\n\n- $$$\n  E\n  $$ s\n  yz\n  $$$\n- b\n' },
  { name: 'paragraph inserted before a tight setext heading gets a blank line (seed 226)', source: '## A\nH\n-\n', target: '## A\n\np\n\n## H\n', expected: '## A\np\n\nH\n-\n' },
  { name: 'empty task line, then a paragraph below: a blank line between (seed 311)', source: 'x\n\n1. a\n2. [ ] \u200B\n\n   b\n', target: 'x\n\n1. a\n2. [ ] \u200B\n\n   bc\n\n3. n\n', expected: 'x\n\n1. a\n2. [ ] \u200B\n\n   bc\n3. n\n', stripSentinels: true },
  { name: 'two hard breaks in a row stay in one paragraph (seed 151)', source: 'x\n\na\n', target: 'x\n\na\\\n\\\nb\n', expected: 'x\n\na  \n\\\nb\n' },
  { name: 'cell: inline code keeps its edge spaces (seed 118)', source: '| A |\n| --- |\n| x |\n', target: '| A |\n| --- |\n| ` test` |\n', expected: '| A |\n| --- |\n| ` test` |\n' },
  { name: 'inline code of only a space is not an empty paragraph (spec 332)', source: 'x\n\n` a`\n', target: 'x\n\n` `\n', expected: 'x\n\n` `\n' },
  { name: 'inline code at a paragraph end keeps its trailing space', source: 'a\n\nb\n', target: 'a `c `\n\nb\n', expected: 'a `c `\n\nb\n' },
  { name: 'table: an added column reprints the table (seed 80)', source: '| A | B |\n| --- | ---: |\n| 1 | 2 |\n', target: '| A | B |  |\n| --- | ---: | :--- |\n| 1 | 2 |  |\n', expected: '| A | B |  |\n| --- | ---: | :--- |\n| 1 | 2 |  |\n' },
  { name: 'ordered list: first item lifted to a paragraph renumbers (seed 96)', source: 'x\n\n1. a\n2. b\n3. c\n', target: 'x\n\na\n\n1. b\n2. c\n', expected: 'x\n\na\n\n1. b\n2. c\n' },
  { name: 'irregular ordered list: new first item takes the start number (seed 96)', source: 'x\n\n1. a\n2. b\n3. c\n1. d\n', target: 'x\n\na\n\n1. b\n2. c\n3. d\n', expected: 'x\n\na\n\n1. b\n2. c\n3. d\n' },
  { name: 'heading turned paragraph gets a blank line before the next paragraph (seed 111)', source: '# T\nnext para\n', target: 'T\n\nnext para\n', expected: 'T\n\nnext para\n' },
  // Seed 57: Milkdown's #moveSpaces lost this space; the inline serializer
  // (inline-serializer.js) writes the nesting as typed, with no workaround.
  { name: 'bold inside italic keeps the space before it (seed 57)', source: 'x\n\n*alph a b*\n', target: 'x\n\n*alph **a b***\n', expected: 'x\n\n*alph **a b***\n' },
  { name: 'emptied list item is unchanged behaviour', source: '- a\n- b\n', target: '- a\n-\n', expected: '- a\n- \n' },
  // Yuque (面试问题.md): typing over the `<font>` after `**<font>…</font>**`
  // puts a letter right after the closing `**`; literal, it stops closing.
  { name: 'text typed over html right after bold is encoded (Yuque)', source: '+ **<font>max</font>**<font>：tail</font>\n+ b\n', target: '+ **<font>max</font>**&#x61;bc\n+ b\n', expected: '+ **<font>max</font>**&#x61;bc\n+ b\n' },
  // Yuque nests lists as blank + 4 spaces (indented code). Backspace joining
  // the paragraph between the list and that code leaves code right after a
  // list, where indented code has no spelling: it is fenced (fuzz seed 47).
  { name: 'indented code kept after what became a list is fenced (Yuque)', source: '1. a\n\ntail\n\n    - x\n    - y\n\nend\n', target: '1. atail\n\n```\n- x\n- y\n```\n\nend\n', expected: '1. atail\n\n```\n- x\n- y\n```\n\nend\n' },
  { name: 'paragraph `2.` after the newly fenced code stays text (Yuque)', source: '1. a\n\ntail\n\n    - x\n2. end\n', target: '1. atail\n\n```\n- x\n```\n\n2\\. end\n', expected: '1. atail\n\n```\n- x\n```\n2\\. end\n' },
  { name: 'line break inside <font> survives an item split (Yuque)', source: '1. **a**<font>  \n</font><font>b</font>\n2. c\n', target: '1. **a**<font>  \n</font><font>b</font>x\n2. y\n3. c\n', expected: '1. **a**<font>  \n   b</font>x\n2. y\n3. c\n' },
  // (Editable spans: the break-only `<font>` and the next identical `<font>`
  // are one span in the editor, so the edited item prints them as one.)
  { name: 'letter added after bold ending in punctuation is encoded', source: 'x **foo.** y\n', target: 'x **foo.**&#x61; y\n', expected: 'x **foo.**&#x61; y\n' },
  // Text deleted before two soft breaks leaves a paragraph that starts with
  // them; they have no spelling (fuzz UI seed 368: `\n&#10; x` read back as
  // text starting with a newline). Same at the end.
  { name: 'paragraph starting with two soft breaks', source: 'x\n\nab\ncd\nef note\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: true } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: ' note' }] }] }, expected: 'x\n\n\u200B note\n' },
  // A heading pasted at the start of a task's text: the task keeps an empty
  // first paragraph, the heading must not land on the checkbox line
  // (`5. [x] ## h` is paragraph text; fuzz UI seed 398).
  { name: 'heading pasted at the start of a task', source: 'x\n\n1. [x] k\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: true }, content: [{ type: 'paragraph' }, { type: 'heading', attrs: { level: 2, id: '' }, content: [{ type: 'text', text: 'h' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'k' }] }] }] }] }, expected: 'x\n\n1. [x] \u200B\n   ## h\n   k\n' },
  // Italic over lines that start with spaces (an indented code block turned
  // into a paragraph): the spaces leave the mark — `*    b*` is no italic,
  // and `* ` at a line start is a list (fuzz UI seed 410). The inline
  // serializer does this itself (blanks leave every mark edge).
  { name: 'italic over line-start blanks after a hard break', source: 'a  \n\u200B &#x20;&#x20;&#x20;b\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'emphasis', attrs: { marker: '*' } }] }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '    b', marks: [{ type: 'emphasis', attrs: { marker: '*' } }] }] }] }, expected: '*a*  \n\u200B    *b*\n' },
  { name: '...in a list item', source: '1. a  \n   \u200B &#x20;&#x20;&#x20;b\n', targetDoc: { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'emphasis', attrs: { marker: '*' } }] }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '    b', marks: [{ type: 'emphasis', attrs: { marker: '*' } }] }] }] }] }] }, expected: '1. *a*  \n   &#x20;   *b*\n' },
  { name: '...before punctuation', source: 'a  \n\u200B &#x20;&#x20;&#x20;}\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'emphasis', attrs: { marker: '*' } }] }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '    }', marks: [{ type: 'emphasis', attrs: { marker: '*' } }] }] }] }, expected: '*a*  \n\u200B    *}*\n' },
  // Literal `==` typed before a highlight: `段落==编==步骤==` paired the
  // literal one with the highlight's opener (fuzz seed 525) → `\\==`.
  // A code block printed whole keeps `&#x20;` / `<br />` lines: the
  // printer's Markdown passes skip fenced content (fuzz seed 562).
  // A task emptied of its only text keeps its checkbox: `- [ ] ` + U+200B
  // (fuzz seeds 619 / 678: the region patch dropped the empty paragraph and
  // left `- [ ] `, a plain item on reopen).
  { name: 'task emptied of its only text', source: 'x\n\n- [ ] open task\n- [x] done\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: false }, content: [{ type: 'paragraph' }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] }] }] }, expected: 'x\n\n- [ ] \u200B\n- [x] done\n' },
  { name: 'code block printed whole keeps &#x20; lines', source: '```\na\n', targetDoc: { type: 'doc', content: [{ type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: '## &#x20;   b\n``` x\n<br />\nno' }] }] }, expected: '````\n## &#x20;   b\n``` x\n<br />\nno\n````\n' },
  { name: 'literal == before a highlight', source: '步骤三 x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '段落==编辑' }, { type: 'text', text: '步骤三', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] }, { type: 'text', text: ' x' }] }] }, expected: '段落\\==编辑==步骤三== x\n' },
  { name: '...in a list item with a soft break', source: '1. 步骤三 x\n   src\n', targetDoc: { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '段落==编辑' }, { type: 'text', text: '步骤三', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] }, { type: 'text', text: ' x' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'src' }] }] }] }] }, expected: '1. 段落\\==编辑==步骤三== x\n   src\n' },
  { name: 'highlight after a {', source: 'a\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a{' }, { type: 'text', text: 'b', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] }] }] }, expected: 'a{<mark class="hm-hl-yellow">b</mark>\n' },
  // A paragraph indented one space turned into a list item holding a pasted
  // fence: the item is printed whole, so the space goes too — ` 1. s` +
  // `   ```js` put the fence outside the item (fuzz seed 722).
  { name: 'indented paragraph becomes a multi-block list item', source: 'x\n\n---\n src1\n最后一段\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'hr' }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 's' }] }, { type: 'code_block', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const a = 1' }] }, { type: 'paragraph', content: [{ type: 'text', text: ' alpha1' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '最后一段' }] }] }] }] }, expected: 'x\n\n---\n1. s\n   ```js\n   const a = 1\n   ```\n   \u200B alpha1\n   最后一段\n' },
  // An item paragraph ending in `1.` (text: an empty item cannot interrupt a
  // paragraph) above a nested list starting at 2: the canonical text the
  // check reads wrote them flush, losing the nested list (fuzz seed 814).
  { name: 'nested list starting at 2 below an item paragraph', source: 'x\n\n1. a\n   1.\n\n   2. b\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'xy' }] }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '1.' }] }, { type: 'ordered_list', attrs: { order: 2, spread: false }, content: [{ type: 'list_item', attrs: { label: '2.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] }] }] }, expected: 'xy\n\n1. a\n   1.\n\n   2. b\n' },
  // The paragraph before an indented fence is removed (a block drag): the
  // fence keeps its indent, which its content lines are read against —
  // a top-level ``` left `  x` with two extra spaces (fuzz seed 940).
  { name: 'removed block before an indented fence keeps the fence indent', source: 'a\n\nsrc40\n\n  ```\n  x\n  y\n  ```\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'x\ny' }] }] }, expected: 'a\n\n  ```\n  x\n  y\n  ```\n' },
  // ...but right after what is now a list, the indented fence would be read
  // as the list's continuation: the code block is printed whole at the margin
  // (seed 940).
  { name: 'removed block between a list and an indented fence', source: 'a\n\n- l\n\nsrc\n\n  ```\n  x\n  ```\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'l' }] }] }] }, { type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'x' }] }] }, expected: 'a\n\n- l\n\n```\nx\n```\n' },
  // A block moved in front of a list does not take the indent of the fence
  // that used to follow it (`  - l`; seed 940).
  { name: 'moved paragraph does not take the next fence indent', source: 't\n\n- l\n\nsrc\n  ```\n  c\n  ```\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 't' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'src' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'l' }] }] }] }, { type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'c' }] }] }, expected: 't\n\nsrc\n- l\n\n```\nc\n```\n' },
  // An item paragraph starting with soft break + spaces + soft break (Tab
  // typed on an empty first line): those lines have no encoding; printed,
  // the blank line ended the item (fuzz seed 1001).
  { name: 'item paragraph starting with a blank soft-broken line', source: 'x\n\n1. a\n2. \n   tes\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'list_item', attrs: { label: '2.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '  ' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: ' tes b' }] }] }] }] }, expected: 'x\n\n1. a\n2. \n   \u200B tes b\n' }, // the blank edge line goes; the space before `tes` is text
  // ...but after plain leading soft breaks the line's blanks stay (a code
  // block turned paragraph: `    }`; fuzz seed 1053).
  { name: 'paragraph starting with a soft break keeps the next line indent', source: 'x\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '    }' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'b' }] }] }, expected: 'x\n\n\u200B    }\nb\n' },
  // A paragraph of a soft break + spaces shows nothing: no encoding beyond the
  // blank line kept for an emptied paragraph (it was written as U+200B +
  // spaces and reopened holding U+200B; fuzz seed 1057).
  { name: 'paragraph of a soft break and spaces has no encoding', source: 'x\n\nb\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '        ' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n\n\ny\n' },
  // A quote holding two empty paragraphs (`/quote`, Tab, Enter) has one
  // spelling, `>`: the check collapses the empties (fuzz seed 1142).
  { name: 'quote of two empty paragraphs', source: 'x\n\n/quote\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '    ' }] }, { type: 'paragraph' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n>\n\ny\n' },
  { name: 'paragraph ending in two soft breaks', source: 'x\n\nnote\nab\ncd\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'note' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'hardbreak', attrs: { isInline: true } }] }] }, expected: 'x\n\nnote\n' },
  // Seed 1299: a list indented inside its quote; a list added to its item
  // must print at the item's content column, not the marker's.
  { name: 'nested list added to an indented item in a quote', source: 'x\n\n>   - a\n>\n>   - b\n', target: 'x\n\n> - a\n>   - n\n>\n> - b\n', expected: 'x\n\n>   - a\n>\n>     - n\n>\n>   - b\n' },
  { name: 'nested list added to an indented item', source: 'x\n\n  - a\n\n  - b\n', target: 'x\n\n- a\n  - n\n\n- b\n', expected: 'x\n\n  - a\n\n    - n\n\n  - b\n' },
  // Seed 1505: renumbering `9.` to `11.` moves the item's content column;
  // its fence moves with it (else the fence leaves the item).
  { name: 'renumbered item of a wider number moves its lines', source: 'x\n\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n   ```\n   code\n   ```\n', target: 'x\n\n1. a\n2. n\n3. m\n4. b\n5. c\n6. d\n7. e\n8. f\n9. g\n10. h\n11. i\n    ```\n    code\n    ```\n', expected: 'x\n\n1. a\n2. n\n3. m\n4. b\n5. c\n6. d\n7. e\n8. f\n9. g\n10. h\n11. i\n    ```\n    code\n    ```\n' },
  { name: 'renumbered item of a narrower number moves its lines', source: 'x\n\n8. a\n9. b\n10. c\n    ```\n    code\n    ```\n', target: 'x\n\n8. a\n9. c\n   ```\n   code\n   ```\n', expected: 'x\n\n8. a\n9. c\n   ```\n   code\n   ```\n' },
  // Seed 1286: text that itself starts with U+200B + a space is not the
  // leading-space sentinel; it is written with the entity.
  // A list moved in front of an indented paragraph: the gap kept the
  // paragraph's 3-space indent, so it became that list item's text (fuzz UI
  // seed 1607, block drag on Windows).
  { name: 'list moved in front of an indented paragraph', source: 'x\n\n   p\n\n- a\n- b\n', target: 'x\n\n- a\n\np\n\n- b\n', expected: 'x\n\n- a\n\np\n\n- b\n' },
  // `- 1. a` is a bullet holding an ordered list (Milkdown puts an empty
  // paragraph in front). Reprinted, the list stays on the marker line; it
  // was written `-` + `  1. a` (test:diverged-list-structure-ui).
  { name: 'item led by a list keeps it on the marker line', source: 'x\n\n- 1. a\n- 2. b\n- c\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph' }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] }] }] }, expected: 'x\n\n- 1. a\n\n  b\n- c\n' },
  // A selection over plain text and a whole bold run deleted: only those raw
  // bytes go, the authored literal `*` before them stays unescaped (it was
  // respelled `\*`; test:diverged-delete-source-ui).
  { name: 'deletion across a bold run keeps the authored bytes around it', source: '# t\n\n前段。* **输入设备：** 内容\n\n第二段。\n', targetDoc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: '' }, content: [{ type: 'text', text: 't' }] }, { type: 'paragraph', content: [{ type: 'text', text: '前段。* ' }] }, { type: 'paragraph', content: [{ type: 'text', text: '第二段。' }] }] }, expected: '# t\n\n前段。* \n\n第二段。\n' },
  // Typora keeps an emptied paragraph's line. The second one emptied after
  // the first was saved lost its line (test:code-fence-delete-source-ui).
  { name: 'second paragraph emptied after the first keeps its line', source: '# h\n\n\n\nB\n\nC\n', targetDoc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: '' }, content: [{ type: 'text', text: 'h' }] }, { type: 'paragraph' }, { type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] }, expected: '# h\n\n\n\n\n\nC\n' },
  // A document whose text was all deleted (`\n`) has no block to anchor
  // new blocks on: every later edit failed to sync (Air trace 2026-11-06).
  { name: 'typing into an emptied document', source: '\n', targetDoc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: '' }, content: [{ type: 'text', text: '我要' }] }] }, expected: '# 我要\n' },
  { name: 'typing into an empty file', source: '', targetDoc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: '' }, content: [{ type: 'text', text: '我要' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, expected: '# 我要\n\na\n' },
  // A parent item's text deleted above its nested list: only the text goes
  // (RS-67; it was printed whole, the list moved onto the marker line).
  { name: 'parent item text deleted above a nested list', source: 'x\n\n1. 父\n   1. 微风\n\n后文\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph' }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '微风' }] }] }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: '后文' }] }] }, expected: 'x\n\n1. \n   1. 微风\n\n后文\n' },
  // A list printed in place of removed blocks keeps a removed list's markers
  // (an empty `1) ` lifted into `+ literal` reprinted that list with `-`).
  { name: 'list merged from removed blocks keeps its + marker', source: 'before\n\n+ literal\n\n1) \n\n- right\n\nafter\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'literal' }] }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph' }] }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'right' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'after' }] }] }, expected: 'before\n\n+ literal\n+\n\n- right\n\nafter\n' },
  // A CRLF file appended to with LF lines keeps each region's line ending
  // (the reprinted list took the file's CRLF; test-family-multicycle-ui).
  { name: 'mixed line endings: an LF list in a CRLF file stays LF', source: 'a\r\n\r\nb\r\n\r\n1. x\n2. y\n', target: 'a\n\nb\n\n1. x\n2. y\n3. z\n', expected: 'a\r\n\r\nb\r\n\r\n1. x\n2. y\n3. z\n' },
  // Typed after the blank that already ends the line (CommonMark trims it):
  // no trailing space left behind (`1\. 测 `).
  { name: 'text typed after a trailing blank reuses it', source: '- 1\\. \n\nafter\n', target: '- 1\\. 测\n\nafter\n', expected: '- 1\\. 测\n\nafter\n' },
  // RS-63: Backspace in an empty last item joins it to the item above as an
  // empty paragraph (no Markdown): that item keeps its bytes, nested `*` too.
  { name: 'empty last item joined to the item above keeps its nested marker', source: '# RS63\n\n- sefsf \n- wefsfesf\n  * wfewff \n- \n', targetDoc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: 'rs63' }, content: [{ type: 'text', text: 'RS63' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'sefsf' }] }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'wefsfesf' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'wfewff' }] }] }] }, { type: 'paragraph' }] }] }] }, expected: '# RS63\n\n- sefsf \n- wefsfesf\n  * wfewff \n' },
  // RS-86: Enter twice in the middle of a tight list splits it around an
  // empty paragraph (no Markdown). Blank lines for it would reopen as ONE
  // loose list; the list is written as authored, `*` kept for both parts.
  { name: 'tight list split by an empty paragraph stays as written', source: 'a\n\n* one\n* two\n* three\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] }, { type: 'paragraph' }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n* one\n* two\n* three\n\nb\n' },
  { name: 'typed list (items spread: true) split by an empty paragraph stays as written', source: 'a\n\n- one\n- two\n- three\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] }, { type: 'paragraph' }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n- one\n- two\n- three\n\nb\n' },
  // A loose two-item list split into two one-item lists: neither part has an
  // item gap of its own; the source list's blank line is kept
  // (test-bullet-exit-keeps-sibling-ui).
  { name: 'loose two-item list split into one-item lists keeps its blank line', source: '# t\n\n- one\n\n- two\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: 't' }, content: [{ type: 'text', text: 't' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }, { type: 'paragraph' }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: '# t\n\n- one\n\n- two\n\nb\n' },
  { name: 'text typed between the two parts keeps both markers', source: 'a\n\n* one\n* two\n* three\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n* one\n* two\n\nx\n\n* three\n\nb\n' },
  // Fuzz seed 2829: a literal `==` after an empty line written `&#10;`, or
  // in a text whose leading space is spelled with the U+200B sentinel, read
  // back as a highlight (the highlight parse lost track of the source there).
  { name: 'literal == after a &#10; empty line stays text', source: 'q\n\nzzz\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '==g==' }] }] }, expected: 'q\n\na\n&#10;\\==g==\n' },
  { name: 'literal == in a text with a leading space stays text', source: 'q\n\nzzz\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }, { type: 'paragraph', content: [{ type: 'text', text: ' a ==g==' }] }] }, expected: 'q\n\n\u200B a \\=\\=g\\=\\=\n' },
  // Changing a code block's language rewrote the whole block as a ``` fence
  // (the attrs differed, so the code patch declined): only the info word
  // changes now, the authored fence and its blanks stay.
  { name: 'code block language change keeps the authored fence', source: 'a\n\n~~~   ts  \nx\n~~~\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'go' }, content: [{ type: 'text', text: 'x' }] }] }, expected: 'a\n\n~~~   go  \nx\n~~~\n' },
  { name: '...language and code changed together', source: 'a\n\n```js\nx\n```\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'py' }, content: [{ type: 'text', text: 'y' }] }] }, expected: 'a\n\n```py\ny\n```\n' },
  { name: '...language added to a bare fence', source: 'a\n\n~~~\nx\n~~~\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'rust' }, content: [{ type: 'text', text: 'x' }] }] }, expected: 'a\n\n~~~rust\nx\n~~~\n' },
  { name: '...language removed', source: 'a\n\n```js  \nx\n```\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'x' }] }] }, expected: 'a\n\n```  \nx\n```\n' },
  { name: '...inside a list item', source: '- a\n\n  ~~~ ts\n  x\n  ~~~\n', targetDoc: { type: 'doc', content: [{ type: 'bullet_list', attrs: { spread: true }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'go' }, content: [{ type: 'text', text: 'x' }] }] }] }] }, expected: '- a\n\n  ~~~ go\n  x\n  ~~~\n' },
  // Two lists the editor keeps apart (no empty paragraph between) read back
  // as ONE list when they share the delimiter / bullet: the second one's
  // markers change (list-boundaries.js). A Backspace merge left the authored
  // `1.` below `4.`: reopening numbered it 5.
  { name: 'adjacent ordered lists keep their markers', source: '2. b\n\n- c\n\n1. e\n', targetDoc: { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 2, spread: false }, content: [{ type: 'list_item', attrs: { label: '2.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, { type: 'list_item', attrs: { label: '3.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] }] }, { type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'e' }] }] }] }] }, expected: '2. b\n3. c\n\n1) e\n' },
  { name: '...adjacent bullet lists', source: '- a\n\n1. x\n\n- b\n', targetDoc: { type: 'doc', content: [{ type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] }, expected: '- a\n\n* b\n' },
  { name: '...an empty paragraph between them may merge (RS-86)', source: '- a\n- b\n', targetDoc: { type: 'doc', content: [{ type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }, { type: 'paragraph' }, { type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] }, expected: '- a\n- b\n' },
  // A thematic break typed over a paragraph keeps the typed character
  // (Typora): `---` was saved as the serializer's `***`.
  { name: 'typed thematic break keeps its character', source: 'a\n\n\\-\\-\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'hr' }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n---\n\nb\n' },
  { name: '...typed with asterisks', source: 'a\n\n\\*\\*\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'hr' }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n***\n\nb\n' },
  { name: '...the paragraph was not the break alone: ***', source: '- a\n  \\-\\-\n', targetDoc: { type: 'doc', content: [{ type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: false, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'hr' }] }] }] }, expected: '- a\n\n  ***\n' },
  { name: 'text starting with a zero-width space and a space', source: 'x\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: '\u200B a' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'q' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '\u200B b' }] }] }, expected: 'x\n\n&#x200B; a\n\nq  \n&#x200B; b\n' },
  // Seed 3716 (Windows): a cell starting with a space has no other spelling
  // (GFM trims cell edges); the table failed its cell patch, was printed
  // whole (degraded) and a fallback writer took the edit.
  { name: 'table cell with an edge blank keeps the table bytes', source: 'x\n\n| N | b |\n| - | -: |\n| 1 | 2 |\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'table', content: [{ type: 'table_header_row', content: [{ type: 'table_header', attrs: { alignment: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: ' N' }] }] }, { type: 'table_header', attrs: { alignment: 'right' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b ' }] }] }] }, { type: 'table_row', content: [{ type: 'table_cell', attrs: { alignment: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] }, { type: 'table_cell', attrs: { alignment: 'right' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] }] }] }] } },
  // ...and the paragraph of only blanks next to it, spelled U+200B + blanks
  // by a fallback writer: it reads back empty; reprinted, it is a blank line
  // (no encoding, seed 49).
  { name: 'paragraph of blanks spelled sentinel + blanks', source: 'x\n\n​     \n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: '     ' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n\n\ny\n' },
  // Blanks around a soft break have no Markdown either (CommonMark strips
  // them): the paragraph keeps its bytes (seed 3716: a code block turned
  // paragraph, `const answer = ` + `   HorseMD`, was printed whole).
  { name: 'blanks around a soft break keep the paragraph bytes', source: 'x\n\nconst a =\nb\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'const a = ' }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: '   b  ' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] } , expected: 'x\n\nconst a =\n&#x20;  b\n\ny\n' }, // blanks before a line ending go, blanks starting a line are text
  // ...not after a hard break, nor at the paragraph start: those blanks are
  // content and get a spelling.
  { name: '...a leading blank is content', source: 'x\n\nb\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: '  b' }] }] }, expected: 'x\n\n​  b\n' },
  // Fuzz seed 3735: text holding the characters `&#x20;` is written
  // `\&#x20;`; the reprint took that for its own space entity and printed
  // `\ ` (a block printed whole: code text dropped into a heading).
  { name: 'literal &#x20; text in a block printed whole', source: 'x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: '用 &#x20; 写空格' }] }] }, expected: 'x\n\n用 \\&#x20; 写空格\n' },
  { name: '...at the end of a line', source: 'x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a &#x20;' }] }] }, expected: 'x\n\na \\&#x20;\n' },
  { name: '...in a heading after a hard break', source: 'x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'heading', attrs: { level: 2, id: 'h' }, content: [{ type: 'text', text: 'a' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '&#x20;&#x20;b' }] }] }, expected: 'x\n\na<br>\\&#x20;\\&#x20;b\n--------------------\n' },
  // Fuzz seed 3737: a fence left open runs to the end of its container; a
  // block added after it (a paste, a line typed below) needs the closing
  // fence, or it reads back as code.
  { name: 'block added after an open fence closes it', source: 'a\n\n```\ncode\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'code' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n```\ncode\n```\n\nb\n' },
  { name: '...a fence with only its opening line', source: 'a\n\n```js', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'js' } }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n```js\n```\n\nb' },
  { name: '...an open $$ block', source: 'a\n\n$$\nx\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'LaTeX' }, content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n$$\nx\n$$\n\nb\n' },
  { name: '...inside a list item', source: '- a\n\n  ```\n  code\n', targetDoc: { type: 'doc', content: [{ type: 'bullet_list', attrs: { spread: true }, content: [{ type: 'list_item', attrs: { label: '•', listType: 'bullet', spread: true, checked: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'code' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] }, expected: '- a\n\n  ```\n  code\n  ```\n\n  b\n' },
  { name: '...inside a quote', source: '> ```\n> code\n', targetDoc: { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text: 'code' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }, expected: '> ```\n> code\n> ```\n>\n> b\n' },
  { name: '...a closed fence keeps its bytes', source: 'a\n\n~~~~ js\ncode\n~~~~\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'code_block', attrs: { language: 'js' }, content: [{ type: 'text', text: 'code' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }, expected: 'a\n\n~~~~ js\ncode\n~~~~\n\nb\n' },
  // Fuzz seed 3788: a soft break right after a HARD break (Shift+Enter,
  // then Enter) is an empty line inside the paragraph: written as two line
  // endings it split the paragraph in two. It is `&#10;`, as after a soft
  // break.
  { name: 'soft break after a hard break stays in the paragraph', source: 'x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'b' }] }] }, expected: 'x\n\na  \n&#10;b\n' },
  { name: '...two soft breaks after it', source: 'x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'b' }] }] }, expected: 'x\n\na  \n&#10;&#10;b\n' },
  { name: '...in a quote', source: 'x\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'b' }] }] }] }, expected: 'x\n\n> a  \n> &#10;b\n' },
  // Fuzz seed 3815: a paragraph of only a hard break has no Markdown (a
  // break at a paragraph end is none). Taken for a new block, it was printed
  // again on every sync: two more blank `>` lines each time, 1 KB saved as
  // 5 MB. It is an editor-only empty paragraph: the bytes stay.
  { name: 'paragraph of only a hard break in a quote: no new lines on every print', source: 'x\n\n> a\n>\n> b\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: false } }] }, { type: 'paragraph', content: [{ type: 'text', text: 'bz' }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n> a\n>\n> bz\n\ny\n' },
  { name: '...two hard breaks', source: 'x\n\n> a\n>\n> b\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: false } }, { type: 'hardbreak', attrs: { isInline: false } }] }, { type: 'paragraph', content: [{ type: 'text', text: 'bz' }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n> a\n>\n> bz\n\ny\n' },
  { name: '...in a list item', source: 'x\n\n- a\n\n  b\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'bullet_list', content: [{ type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: false } }] }, { type: 'paragraph', content: [{ type: 'text', text: 'bz' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n- a\n\n  bz\n\ny\n' },
  { name: '...at the top level', source: 'x\n\na\n\nb\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: false } }] }, { type: 'paragraph', content: [{ type: 'text', text: 'bz' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\na\n\nbz\n\ny\n' },
  // Fuzz seed 3908: a line of only `-` between two hard breaks. The printer
  // drops the blank before a break (`- ` → `-`) and remark, seeing `-\`,
  // escaped nothing; with two-space breaks `-  ` is a setext underline and
  // the line above became a heading — every print failed the check.
  { name: 'new paragraph with a line of only "-" between hard breaks', source: 'x\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'c' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '- ' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: 'd' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\nc  \n\\-  \nd\n\ny\n' },
  { name: '...a line of only "-" in a quote', source: 'x\n\ny\n', targetDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: '-' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: 'd' }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'y' }] }] }, expected: 'x\n\n> c  \n> \\-  \n> d\n\ny\n' },
  // Seed 2322 (Windows): the list-slot check read the document without its
  // empty paragraphs and dropped the one holding a task's checkbox (code
  // block / heading below), so every reprint of that list failed.
  { name: 'empty task item above a code block, item split before soft breaks', source: '1. [ ] \u200B\n\n   ```js\n   x\n   ```\n2. [ ] a\n   &#10;b\n', targetDoc: { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: false }, content: [{ type: 'paragraph' }, { type: 'code_block', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x' }] }] }, { type: 'list_item', attrs: { label: '2.', listType: 'ordered', spread: false, checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'list_item', attrs: { label: '3.', listType: 'ordered', spread: false, checked: false }, content: [{ type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: true } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'b' }] }] }] }] }, expected: '1. [ ] \u200B\n\n   ```js\n   x\n   ```\n2. [ ] a\n3. [ ] b\n' },
  { name: '...above a heading', source: '1. [ ] \u200B\n\n   # h\n2. [ ] a\n   &#10;b\n', targetDoc: { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 1, spread: false }, content: [{ type: 'list_item', attrs: { label: '1.', listType: 'ordered', spread: false, checked: false }, content: [{ type: 'paragraph' }, { type: 'heading', attrs: { level: 1, id: 'h' }, content: [{ type: 'text', text: 'h' }] }] }, { type: 'list_item', attrs: { label: '2.', listType: 'ordered', spread: false, checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'list_item', attrs: { label: '3.', listType: 'ordered', spread: false, checked: false }, content: [{ type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: true } }, { type: 'hardbreak', attrs: { isInline: true } }, { type: 'text', text: 'b' }] }] }] }] }, expected: '1. [ ] \u200B\n\n   # h\n2. [ ] a\n3. [ ] b\n' }
]

const session = await open('source-reprint', FIXTURE)
let failures = 0
try {
  for (const testCase of cases) {
    const result = await session.app.evaluate(`((source, target, emptyAt, previous, previousEmptyAt, stripSentinels, targetDoc) => {
      const h = globalThis.__hmSourceReprintHarness
      const src = source ?? h.liveSource()
      const withEmpty = (doc, indices) => {
        if (!indices?.length) return doc
        const json = doc.toJSON()
        for (const index of [...indices].sort((a, b) => a - b)) json.content.splice(index, 0, { type: 'paragraph' })
        return h.docFromJSON(json)
      }
      // The editor's own empty task body: a paragraph with no text where the
      // source spells U+200B (stripSentinels).
      const withoutSentinels = (doc) => {
        if (!stripSentinels) return doc
        const strip = (node) => {
          if (node.type === 'paragraph' && node.content?.every((child) => child.type === 'text' && /^\\u200B+$/.test(child.text))) delete node.content
          // Milkdown parses list spread as a string; the schema wants a boolean.
          if (typeof node.attrs?.spread === 'string') node.attrs.spread = node.attrs.spread === 'true'
          node.content?.forEach(strip)
          return node
        }
        return h.docFromJSON(strip(doc.toJSON()))
      }
      const doc = targetDoc ? h.docFromJSON(targetDoc) : withoutSentinels(withEmpty(h.parse(target ?? src), emptyAt))
      const previousDoc = previous == null ? null : withEmpty(h.parse(previous), previousEmptyAt)
      const out = h.reprint(src, doc, previousDoc)
      return JSON.stringify({ src, out: { ok: out.ok, verified: out.verified, reason: out.reason, markdown: out.markdown, notes: out.notes, error: out.error } })
    })(${JSON.stringify(testCase.source)}, ${JSON.stringify(testCase.target)}, ${JSON.stringify(testCase.emptyAt ?? null)}, ${JSON.stringify(testCase.previous ?? null)}, ${JSON.stringify(testCase.previousEmptyAt ?? null)}, ${JSON.stringify(Boolean(testCase.stripSentinels))}, ${JSON.stringify(testCase.targetDoc ?? null)})`)
    const { src, out } = JSON.parse(result)
    const expected = testCase.expected ?? src
    try {
      assert.equal(out.ok, true, `not ok: ${out.reason} ${out.error || ''} ${JSON.stringify(out.notes)}`)
      assert.equal(out.markdown, expected)
      console.log(`ok   ${testCase.name}  ${JSON.stringify((out.notes || []).map((note) => note.level || note))}`)
    } catch (error) {
      failures += 1
      console.log(`FAIL ${testCase.name}: ${String(error.message).slice(0, 600)}`)
    }
  }
} finally {
  await session.close()
}
if (failures) {
  console.log(`FAIL source reprint: ${failures}/${cases.length}`)
  process.exit(1)
}
console.log(`PASS source reprint: ${cases.length} cases keep authored bytes and verify against the editor document`)
