import assert from 'node:assert/strict'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import { updateFrontmatterValue } from '../src/renderer/src/components/editor-frontmatter.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    frontmatter: { group: 'block', atom: true, attrs: { value: { default: '' } } },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' }
  }
})

const frontmatter = schema.nodes.frontmatter.create({ value: 'name: deploy' })
let state = EditorState.create({
  schema,
  doc: schema.node('doc', null, [frontmatter, schema.node('paragraph', null, schema.text('Body'))])
})
const view = {
  get state() { return state },
  dispatch(tr) { state = state.apply(tr) }
}

assert.equal(updateFrontmatterValue(view, () => 0, frontmatter, 'name: publish\ndescription: test'), true)
assert.equal(state.doc.firstChild.attrs.value, 'name: publish\ndescription: test')
assert.equal(state.doc.childCount, 2, 'editing YAML must not replace adjacent document blocks')
assert.equal(updateFrontmatterValue(view, () => undefined, state.doc.firstChild, 'name: ignored'), false)

const qAndA = `# UDP service discovery

---

### Q3: Why does this not conflict?

Because it uses an ephemeral port.

---

### Q4: Why bind the source address?
`
const parsed = unified().use(remarkParse).use(remarkFrontmatter).parse(qAndA)
assert.equal(parsed.children.some((node) => node.type === 'yaml'), false, 'body separators and Q&A headings must not become YAML')
assert.deepEqual(
  parsed.children.filter((node) => node.type === 'heading').map((node) => node.children?.map((child) => child.value).join('')),
  ['UDP service discovery', 'Q3: Why does this not conflict?', 'Q4: Why bind the source address?'],
  'Q&A headings must survive frontmatter parsing'
)

console.log('PASS frontmatter: rich-card edits update only the YAML atom and body separators remain Markdown')
