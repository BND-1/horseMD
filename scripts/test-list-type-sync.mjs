// List items follow their list's type (lib/list-type-sync.js): mixed bullet
// lists are reset to bullets (fuzz seed 60), and a bullet list led by an
// ordered item becomes ordered when Milkdown's own sync skips the batch — a
// drop or paste (fuzz UI seed 286: shown `1.`, saved `-`).
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import { createListTypeSyncPlugin } from '../src/renderer/src/lib/list-type-sync.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block', attrs: { spread: { default: false } } },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 }, spread: { default: false } } },
    list_item: { content: 'paragraph block*', attrs: { label: { default: '•' }, listType: { default: 'bullet' }, spread: { default: false }, checked: { default: null } } },
    text: {}
  }
})
const item = (text, listType = 'bullet', label = listType === 'bullet' ? '•' : '1.') =>
  schema.nodes.list_item.create({ listType, label }, schema.nodes.paragraph.create(null, schema.text(text)))
const plugin = createListTypeSyncPlugin()

// Replace the doc's only block with `list` in a transaction carrying `meta`.
const run = (list, meta) => {
  const state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text('x'))]), plugins: [plugin] })
  let tr = state.tr.replaceWith(0, state.doc.content.size, list)
  for (const [key, value] of Object.entries(meta)) tr = tr.setMeta(key, value)
  return state.applyTransaction(tr).state.doc.firstChild
}
const shape = (list) => {
  const items = []
  list.forEach((child) => items.push(`${child.attrs.listType}:${child.attrs.label}`))
  return `${list.type.name}[${items.join(',')}]`
}

// Mixed: later ordered items in a bullet list become bullets (any batch).
assert.equal(shape(run(schema.nodes.bullet_list.create(null, [item('a'), item('b', 'ordered', '2.')]), {})), 'bullet_list[bullet:•,bullet:2.]')
assert.equal(shape(run(schema.nodes.bullet_list.create(null, [item('a'), item('b', 'ordered', '2.')]), { uiEvent: 'drop' })), 'bullet_list[bullet:•,bullet:2.]')
// Led by an ordered item, generic batch: left to Milkdown's own plugin.
assert.equal(shape(run(schema.nodes.bullet_list.create(null, [item('a', 'ordered'), item('b')]), {})), 'bullet_list[ordered:1.,bullet:•]')
// ...a drop / paste batch (Milkdown skips it): the list becomes ordered here.
assert.equal(shape(run(schema.nodes.bullet_list.create(null, [item('a', 'ordered'), item('b')]), { uiEvent: 'drop' })), 'ordered_list[ordered:1.,ordered:2.]')
assert.equal(shape(run(schema.nodes.bullet_list.create(null, [item('a', 'ordered', '3.')]), { uiEvent: 'paste' })), 'ordered_list[ordered:1.]')
// Items of an ordered list are ordered, also when their label is already
// right (Milkdown's own sync drops that fix; fuzz UI seed 403).
assert.equal(shape(run(schema.nodes.ordered_list.create(null, [item('a', 'bullet', '1.'), item('b', 'bullet', '2.')]), {})), 'ordered_list[ordered:1.,ordered:2.]')
assert.equal(shape(run(schema.nodes.ordered_list.create({ order: 3 }, [item('a', 'ordered', '3.'), item('b')]), { addToHistory: false })), 'ordered_list[ordered:3.,ordered:4.]')
console.log('PASS list type sync: mixed bullet lists reset to bullets; ordered lists hold ordered items; a list led by an ordered item becomes ordered in batches Milkdown skips (drop / paste)')
