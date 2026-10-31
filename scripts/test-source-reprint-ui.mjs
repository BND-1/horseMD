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
  { name: 'inline code edit + blank after a soft break', source: 'p `inline cod`x。\nn    Second line.\n', target: 'p `inlin`x。\n&#x20;n    Second line.\n', expected: 'p `inlin`x。\nn    Second line.\n' },
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
  { name: 'cell: deleting spaces between \\ and <br> keeps it literal (seed 73)', source: '| A |\n| --- |\n| x\\  <br>y |\n', target: '| A |\n| --- |\n| x\\\\<br>y |\n', expected: '| A |\n| --- |\n| x\\\\<br>y |\n' },
  { name: 'table: emptying the last cell of a row without closing pipe (seed 84)', source: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | x\n', target: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n', expected: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n' },
  { name: 'table: an added column reprints the table (seed 80)', source: '| A | B |\n| --- | ---: |\n| 1 | 2 |\n', target: '| A | B |  |\n| --- | ---: | :--- |\n| 1 | 2 |  |\n', expected: '| A | B |  |\n| --- | ---: | :--- |\n| 1 | 2 |  |\n' },
  { name: 'ordered list: first item lifted to a paragraph renumbers (seed 96)', source: 'x\n\n1. a\n2. b\n3. c\n', target: 'x\n\na\n\n1. b\n2. c\n', expected: 'x\n\na\n\n1. b\n2. c\n' },
  { name: 'irregular ordered list: new first item takes the start number (seed 96)', source: 'x\n\n1. a\n2. b\n3. c\n1. d\n', target: 'x\n\na\n\n1. b\n2. c\n3. d\n', expected: 'x\n\na\n\n1. b\n2. c\n3. d\n' },
  { name: 'heading turned paragraph gets a blank line before the next paragraph (seed 111)', source: '# T\nnext para\n', target: 'T\n\nnext para\n', expected: 'T\n\nnext para\n' },
  { name: 'bold inside italic keeps the space before it (seed 57, Milkdown moveSpaces)', source: 'x\n\n*alph a b*\n', target: 'x\n\n*alph **a b***\n', expected: 'x\n\n*alph* ***a b***\n' },
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
  { name: 'letter added after bold ending in punctuation is encoded', source: 'x **foo.** y\n', target: 'x **foo.**&#x61; y\n', expected: 'x **foo.**&#x61; y\n' }
]

const session = await open('source-reprint', FIXTURE)
let failures = 0
try {
  for (const testCase of cases) {
    const result = await session.app.evaluate(`((source, target, emptyAt, previous, previousEmptyAt) => {
      const h = globalThis.__hmSourceReprintHarness
      const src = source ?? h.liveSource()
      const withEmpty = (doc, indices) => {
        if (!indices?.length) return doc
        const json = doc.toJSON()
        for (const index of [...indices].sort((a, b) => a - b)) json.content.splice(index, 0, { type: 'paragraph' })
        return h.docFromJSON(json)
      }
      const doc = withEmpty(h.parse(target ?? src), emptyAt)
      const previousDoc = previous == null ? null : withEmpty(h.parse(previous), previousEmptyAt)
      const out = h.reprint(src, doc, previousDoc)
      return JSON.stringify({ src, out: { ok: out.ok, verified: out.verified, reason: out.reason, markdown: out.markdown, notes: out.notes, error: out.error } })
    })(${JSON.stringify(testCase.source)}, ${JSON.stringify(testCase.target)}, ${JSON.stringify(testCase.emptyAt ?? null)}, ${JSON.stringify(testCase.previous ?? null)}, ${JSON.stringify(testCase.previousEmptyAt ?? null)})`)
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
