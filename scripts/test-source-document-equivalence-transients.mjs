import assert from 'node:assert/strict'
import { areSourceDocumentsEquivalent } from '../src/renderer/src/lib/source-transaction-sync.js'

const node = (json) => ({ toJSON: () => JSON.parse(JSON.stringify(json)) })
const paragraph = (text = '') => text
  ? { type: 'paragraph', content: [{ type: 'text', text }] }
  : { type: 'paragraph' }
const bulletDoc = (itemContent) => node({
  type: 'doc',
  content: [{
    type: 'bullet_list',
    content: [{ type: 'list_item', content: itemContent }]
  }]
})

const authored = bulletDoc([paragraph('啊v擦')])
const oneTransient = bulletDoc([paragraph('啊v擦'), paragraph()])
const twoTransients = bulletDoc([paragraph('啊v擦'), paragraph(), paragraph()])
const nestedThenEmpty = node({
  type: 'doc',
  content: [{
    type: 'bullet_list',
    content: [{
      type: 'list_item',
      content: [
        paragraph('啊v擦'),
        { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('child')] }] },
        paragraph()
      ]
    }]
  }]
})
const nestedWithoutEmpty = node({
  type: 'doc',
  content: [{
    type: 'bullet_list',
    content: [{
      type: 'list_item',
      content: [
        paragraph('啊v擦'),
        { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('child')] }] }
      ]
    }]
  }]
})

assert.equal(
  areSourceDocumentsEquivalent(authored, oneTransient),
  false,
  'default semantic comparison must keep a trailing list-item paragraph strict'
)
assert.equal(
  areSourceDocumentsEquivalent(authored, oneTransient, { ignoreTrailingEmptyListItemParagraph: true }),
  true,
  'opt-in should ignore exactly one trailing editor-owned empty paragraph after text'
)
assert.equal(
  areSourceDocumentsEquivalent(authored, twoTransients, { ignoreTrailingEmptyListItemParagraph: true }),
  false,
  'opt-in must not hide multiple trailing empty paragraphs'
)
assert.equal(
  areSourceDocumentsEquivalent(nestedWithoutEmpty, nestedThenEmpty, { ignoreTrailingEmptyListItemParagraph: true }),
  false,
  'opt-in must not hide an empty paragraph after nested list structure'
)

console.log('PASS source document equivalence transient option stays narrow')
