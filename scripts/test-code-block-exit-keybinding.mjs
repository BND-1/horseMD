import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import { exitCodeBlockFromDomEvent } from '../src/renderer/src/components/editor-code-block-exit.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true
    },
    text: { group: 'inline' }
  }
})
const paragraph = (value = '') => schema.nodes.paragraph.create(
  null,
  value ? schema.text(value) : null
)
const codeBlock = (value = '', language = 'js') => schema.nodes.code_block.create(
  { language },
  value ? schema.text(value) : null
)
const document = (...children) => schema.nodes.doc.create(null, children)

const topLevelOffset = (doc, targetIndex) => {
  let result = null
  doc.forEach((_node, offset, index) => {
    if (index === targetIndex) result = offset
  })
  return result
}

const createDom = () => {
  const codeDom = {
    contains: (candidate) => candidate === codeDom || candidate === target
  }
  const target = {
    closest: (selector) => selector === '.milkdown-code-block' ? codeDom : null
  }
  const root = {
    contains: (candidate) => candidate === codeDom || candidate === target
  }
  return { codeDom, target, root }
}

const createEvent = (target) => {
  const calls = { preventDefault: 0, stopImmediatePropagation: 0 }
  return {
    event: {
      target,
      preventDefault: () => { calls.preventDefault += 1 },
      stopImmediatePropagation: () => { calls.stopImmediatePropagation += 1 }
    },
    calls
  }
}

const createView = ({ doc, codeDom, exposeNode = true, contained = true } = {}) => {
  const dispatched = []
  let focused = 0
  const codeOffset = topLevelOffset(doc, 1)
  const view = {
    state: EditorState.create({ schema, doc }),
    dom: { contains: () => contained },
    nodeDOM: (position) => exposeNode && position === codeOffset ? codeDom : null,
    posAtDOM: () => exposeNode ? codeOffset : null,
    dispatch(transaction) {
      dispatched.push(transaction)
      this.state = this.state.apply(transaction)
    },
    focus() { focused += 1 }
  }
  return { view, dispatched, focused: () => focused, codeOffset }
}

{
  const doc = document(paragraph('before'), codeBlock('console.log(1)'), paragraph('after'))
  const { codeDom, target } = createDom()
  const { event, calls } = createEvent(target)
  const fixture = createView({ doc, codeDom })
  const result = exitCodeBlockFromDomEvent({ event, view: fixture.view })

  assert.equal(result, true)
  assert.equal(calls.preventDefault, 1)
  assert.equal(calls.stopImmediatePropagation, 1)
  assert.equal(fixture.focused(), 1)
  assert.equal(fixture.dispatched.length, 1,
    'the DOM bridge must dispatch only the official document-changing exit transaction')
  assert.equal(fixture.dispatched[0].steps.length, 1)
  assert.equal(fixture.dispatched[0].steps[0].constructor.name, 'ReplaceStep')
  assert.equal(fixture.dispatched[0].steps[0].from,
    fixture.codeOffset + doc.child(1).nodeSize)
  assert.equal(fixture.dispatched[0].steps[0].to,
    fixture.codeOffset + doc.child(1).nodeSize)

  const finalDoc = fixture.view.state.doc
  assert.deepEqual(
    Array.from({ length: finalDoc.childCount }, (_, index) => finalDoc.child(index).type.name),
    ['paragraph', 'code_block', 'paragraph', 'paragraph']
  )
  assert.equal(finalDoc.child(1).textContent, 'console.log(1)')
  assert.equal(finalDoc.child(2).textContent, '')
  assert.equal(finalDoc.child(3).textContent, 'after')
  assert.equal(fixture.view.state.selection.$from.parent.type.name, 'paragraph')
  assert.equal(fixture.view.state.selection.$from.index(0), 2)
}

{
  const doc = document(paragraph('before'), codeBlock(''), paragraph('after'))
  const { codeDom, target } = createDom()
  const { event, calls } = createEvent(target)
  const fixture = createView({ doc, codeDom })
  assert.equal(exitCodeBlockFromDomEvent({ event, view: fixture.view }), false)
  assert.deepEqual(calls, { preventDefault: 0, stopImmediatePropagation: 0 })
  assert.equal(fixture.dispatched.length, 0)
}

{
  const doc = document(paragraph('before'), codeBlock('code'), paragraph('after'))
  const { codeDom } = createDom()
  const outsideTarget = { closest: () => null }
  const { event, calls } = createEvent(outsideTarget)
  const fixture = createView({ doc, codeDom })
  assert.equal(exitCodeBlockFromDomEvent({ event, view: fixture.view }), false)
  assert.deepEqual(calls, { preventDefault: 0, stopImmediatePropagation: 0 })
}

{
  const doc = document(paragraph('before'), codeBlock('code'), paragraph('after'))
  const { codeDom, target } = createDom()
  const { event, calls } = createEvent(target)
  const fixture = createView({ doc, codeDom, exposeNode: false })
  assert.equal(exitCodeBlockFromDomEvent({ event, view: fixture.view }), false)
  assert.deepEqual(calls, { preventDefault: 0, stopImmediatePropagation: 0 })
  assert.equal(fixture.dispatched.length, 0)
}

{
  const doc = document(paragraph('before'), codeBlock('code'), paragraph('after'))
  const { codeDom, target } = createDom()
  const { event, calls } = createEvent(target)
  const fixture = createView({ doc, codeDom, contained: false })
  assert.equal(exitCodeBlockFromDomEvent({ event, view: fixture.view }), false)
  assert.deepEqual(calls, { preventDefault: 0, stopImmediatePropagation: 0 })
}

console.log('PASS code block exit keybinding: a DOM-owned Mod+Enter maps one non-empty CodeMirror node view to the official exitCode transaction; empty, outside, unmapped and foreign DOM fail open')
