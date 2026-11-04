// remarkUnwrapNonAsciiAutolinks (editor-autolink.js): a GFM autolink literal
// that swallowed Chinese prose is trimmed back to its domain, but an authored
// link whose URL has non-ASCII characters — `[维基](https://zh.wikipedia.org/wiki/马)`,
// `<https://例子.cn/路径>` — stays a link (it was unwrapped to plain text, so
// such links never showed as links and editing one ended in
// 「富文本与源码不一致」).
import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { remarkUnwrapNonAsciiAutolinks } from '../src/renderer/src/components/editor-autolink.js'

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkUnwrapNonAsciiAutolinks)
const parse = (markdown) => processor.runSync(processor.parse(markdown), markdown)
const links = (tree) => {
  const out = []
  const walk = (node) => {
    if (node.type === 'link') out.push({ url: node.url, text: (node.children || []).map((c) => c.value ?? '').join('') })
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  return out
}
const text = (tree) => {
  let out = ''
  const walk = (node) => { if (node.type === 'text') out += node.value; for (const c of node.children || []) walk(c) }
  walk(tree)
  return out
}

// 1. The greedy literal is trimmed to its domain; the prose stays text.
let tree = parse('官网 www.caixuetang.cn，查看课程1')
assert.deepEqual(links(tree), [{ url: 'http://www.caixuetang.cn', text: 'www.caixuetang.cn' }])
assert.equal(text(tree), '官网 www.caixuetang.cn，查看课程1')
tree = parse('见 https://example.com/a，然后')
assert.deepEqual(links(tree), [{ url: 'https://example.com/a', text: 'https://example.com/a' }])

// 2. A literal whose domain is non-ASCII is plain text.
assert.deepEqual(links(parse('访问 http://例え.jp 吧')), [])

// 3. Authored links keep their non-ASCII URL.
assert.deepEqual(links(parse('[维基](https://zh.wikipedia.org/wiki/马)')), [{ url: 'https://zh.wikipedia.org/wiki/马', text: '维基' }])
assert.deepEqual(links(parse('编辑 [新文字](https://new.example/路径) 结束')), [{ url: 'https://new.example/路径', text: '新文字' }])
assert.deepEqual(links(parse('[**粗**体](https://例子.cn/页)')).map((l) => l.url), ['https://例子.cn/页'])
assert.deepEqual(links(parse('<https://例子.cn/路径>')), [{ url: 'https://例子.cn/路径', text: 'https://例子.cn/路径' }])
assert.deepEqual(links(parse('[ref]\n\n[ref]: https://zh.wikipedia.org/wiki/马')).map((l) => l.url), [])
// With a BOM (mdast offsets skip it, file.value keeps it).
assert.deepEqual(links(parse('﻿[维基](https://zh.wikipedia.org/wiki/马)')), [{ url: 'https://zh.wikipedia.org/wiki/马', text: '维基' }])

// 4. Without the source text (a tree built elsewhere): an authored link's
// text differs from its URL, so it is kept; a literal's equals it.
const bare = (children) => ({ type: 'root', children: [{ type: 'paragraph', children }] })
const run = (t) => { remarkUnwrapNonAsciiAutolinks()(t, {}); return t }
assert.deepEqual(links(run(bare([{ type: 'link', url: 'https://zh.wikipedia.org/wiki/马', children: [{ type: 'text', value: '维基' }] }]))).length, 1)
assert.deepEqual(links(run(bare([{ type: 'link', url: 'http://www.a.cn，中文', children: [{ type: 'text', value: 'www.a.cn，中文' }] }]))), [{ url: 'http://www.a.cn', text: 'www.a.cn' }])

console.log('PASS non-ASCII autolinks: greedy literals trimmed to the domain (non-ASCII domain → text); authored [text](中文 URL) / <中文 URL> / bold-text links kept, also with a BOM and without the source')
