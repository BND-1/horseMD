import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  markdownOffsetToPmPos,
  pmPosToMarkdownOffset
} from '../src/renderer/src/components/editor-source-map.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    code_block: { content: 'text*', group: 'block', code: true },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    table: { content: 'table_row+', group: 'block' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph+' },
    image: { group: 'block', atom: true, attrs: { src: { default: '' } } },
    html: { group: 'block', atom: true, attrs: { value: { default: '' } } },
    text: { group: 'inline' }
  }
})

const remark = unified().use(remarkParse).use(remarkGfm)
const text = (value) => value ? schema.text(value) : null
const paragraph = (value) => schema.node('paragraph', null, text(value))
const heading = (value, level = 1) => schema.node('heading', { level }, text(value))
const codeBlock = (value) => schema.node('code_block', null, text(value))
const cell = (value) => schema.node('table_cell', null, paragraph(value))
const row = (...values) => schema.node('table_row', null, values.map(cell))
const table = (...rows) => schema.node('table', null, rows)
const listItem = (value) => schema.node('list_item', null, paragraph(value))
const bulletList = (...values) => schema.node('bullet_list', null, values.map(listItem))
const doc = (...blocks) => schema.node('doc', null, blocks)

const nthTextblockPos = (pmDoc, value, occurrence = 0) => {
  let seen = 0
  let found = null
  pmDoc.descendants((node, pos) => {
    if (!node.isTextblock || node.textContent !== value) return true
    if (seen++ === occurrence) found = pos + 1
    return found == null
  })
  assert.notEqual(found, null, `Missing PM textblock: ${value} #${occurrence}`)
  return found
}

const nthNodePos = (pmDoc, type, occurrence = 0) => {
  let seen = 0
  let found = null
  pmDoc.descendants((node, pos) => {
    if (node.type.name !== type) return true
    if (seen++ === occurrence) found = pos
    return found == null
  })
  assert.notEqual(found, null, `Missing PM node: ${type} #${occurrence}`)
  return found
}

const assertTextRoundTrip = ({ label, markdown, pmDoc, token, tokenOccurrence = 0, local = 0, pmText, pmOccurrence = 0 }) => {
  let rawStart = -1
  let from = 0
  for (let i = 0; i <= tokenOccurrence; i++) {
    rawStart = markdown.indexOf(token, from)
    assert.ok(rawStart >= 0, `Missing markdown token for ${label}`)
    from = rawStart + token.length
  }
  const rawOffset = rawStart + local
  const pmOffset = nthTextblockPos(pmDoc, pmText, pmOccurrence) + pmText.indexOf(token) + local
  const mapped = markdownOffsetToPmPos(markdown, rawOffset, pmDoc, remark)
  assert.equal(mapped?.atom, false, `${label}: source should map to text`)
  assert.equal(mapped?.pos, pmOffset, `${label}: source -> PM`)
  assert.equal(pmPosToMarkdownOffset(markdown, pmOffset, pmDoc, remark), rawOffset, `${label}: PM -> source`)
}

const cases = []

{
  const markdown = '# Title\n\nsame paragraph\n\nmiddle\n\nsame paragraph\n'
  const pmDoc = doc(heading('Title'), paragraph('same paragraph'), paragraph('middle'), paragraph('same paragraph'))
  assertTextRoundTrip({
    label: 'duplicate paragraph occurrence',
    markdown,
    pmDoc,
    token: 'same paragraph',
    tokenOccurrence: 1,
    local: 5,
    pmText: 'same paragraph',
    pmOccurrence: 1
  })
  cases.push('duplicate paragraph')
}

{
  const markdown = [
    '| Item | Command | Note |',
    '| --- | --- | --- |',
    '| Alpha | `npm run build` | repeated |',
    '| Beta | prefix `git status` suffix | repeated |',
    '| Gamma | `npm run build` | final |'
  ].join('\n')
  const pmDoc = doc(table(
    row('Item', 'Command', 'Note'),
    row('Alpha', 'npm run build', 'repeated'),
    row('Beta', 'prefix git status suffix', 'repeated'),
    row('Gamma', 'npm run build', 'final')
  ))
  assertTextRoundTrip({
    label: 'table inline code local offset',
    markdown,
    pmDoc,
    token: 'git status',
    local: 4,
    pmText: 'prefix git status suffix'
  })
  assertTextRoundTrip({
    label: 'duplicate table cell occurrence',
    markdown,
    pmDoc,
    token: 'npm run build',
    tokenOccurrence: 1,
    local: 7,
    pmText: 'npm run build',
    pmOccurrence: 1
  })
  cases.push('table cells and inline code')
}

{
  const markdown = 'Before\n\n```js\nconst answer = 42\nconsole.log(answer)\n```\n\nAfter\n'
  const code = 'const answer = 42\nconsole.log(answer)'
  const pmDoc = doc(paragraph('Before'), codeBlock(code), paragraph('After'))
  assertTextRoundTrip({
    label: 'fenced code block line offset',
    markdown,
    pmDoc,
    token: 'console.log',
    local: 6,
    pmText: code
  })
  cases.push('fenced code block')
}

{
  const markdown = '- first item\n- second repeated item\n- third item\n'
  const pmDoc = doc(bulletList('first item', 'second repeated item', 'third item'))
  assertTextRoundTrip({
    label: 'nested list paragraph',
    markdown,
    pmDoc,
    token: 'second repeated item',
    local: 9,
    pmText: 'second repeated item'
  })
  cases.push('list item')
}

{
  const markdown = 'Before\n\n![diagram](https://example.com/image.png)\n\nAfter\n'
  const pmDoc = doc(
    paragraph('Before'),
    schema.node('image', { src: 'https://example.com/image.png' }),
    paragraph('After')
  )
  const rawStart = markdown.indexOf('![diagram]')
  const pmPos = nthNodePos(pmDoc, 'image')
  const mapped = markdownOffsetToPmPos(markdown, rawStart + 5, pmDoc, remark)
  assert.deepEqual(mapped, { pos: pmPos, atom: true }, 'image: source -> atom')
  assert.equal(pmPosToMarkdownOffset(markdown, pmPos, pmDoc, remark), rawStart, 'image: atom -> source')
  cases.push('image atom')
}

{
  const markdown = 'Before\n\n<section data-id="x">raw html</section>\n\nAfter\n'
  const rawStart = markdown.indexOf('<section')
  const pmDoc = doc(
    paragraph('Before'),
    schema.node('html', { value: '<section data-id="x">raw html</section>' }),
    paragraph('After')
  )
  const pmPos = nthNodePos(pmDoc, 'html')
  const mapped = markdownOffsetToPmPos(markdown, rawStart + 12, pmDoc, remark)
  assert.deepEqual(mapped, { pos: pmPos, atom: true }, 'HTML: source -> atom')
  assert.equal(pmPosToMarkdownOffset(markdown, pmPos, pmDoc, remark), rawStart, 'HTML: atom -> source')
  cases.push('HTML atom')
}

console.log(`PASS editor source map: ${cases.length} groups`)
cases.forEach((name) => console.log(`  - ${name}`))
