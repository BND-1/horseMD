import assert from 'node:assert/strict'
import { Schema, Slice, Fragment } from '@milkdown/prose/model'
import { AllSelection, EditorState, Plugin } from '@milkdown/prose/state'
import { ReplaceStep } from '@milkdown/prose/transform'
import {
  areSourceDocumentTransitionsEquivalent,
  areSourceDocumentsEquivalent,
  formatWholeDocumentReplacementSource,
  isWholeDocumentReplacementBatch,
  mapPlainTextTransactionsToSource
} from '../src/renderer/src/lib/source-transaction-sync.js'
import { createSourceTransactionDispatch } from '../src/renderer/src/components/editor-source-transactions.js'

const mapTransactions = (options) => mapPlainTextTransactionsToSource({
  ...options,
  validateMarkdown: options.validateMarkdown || (() => true)
})

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: { attrs: { level: { default: 1 } }, content: 'text*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    text: { group: 'inline' }
  },
  marks: {
    strong: {}
  }
})

const text = (value) => schema.text(value)
const paragraph = (value = '') => schema.nodes.paragraph.create(null, value ? text(value) : null)
const heading = (value) => schema.nodes.heading.create({ level: 1 }, text(value))
const quote = (value) => schema.nodes.blockquote.create(null, paragraph(value))
const item = (value) => schema.nodes.list_item.create(null, paragraph(value))
const list = (value) => schema.nodes.bullet_list.create(null, item(value))

const doc = schema.nodes.doc.create(null, [
  heading('标题'),
  paragraph('正文'),
  quote('引用'),
  list('项目')
])

const source = '# 标题\n\n正文\n\n> 引用\n\n- 项目\n'

const jsonNode = (value) => ({
  toJSON: () => JSON.parse(JSON.stringify(value))
})
const emptyTableCellDocument = jsonNode({
  type: 'doc',
  content: [{
    type: 'table',
    content: [{
      type: 'table_row',
      content: [{
        type: 'table_cell',
        content: [{ type: 'paragraph' }]
      }]
    }]
  }]
})
const tableColumnWidthBaseline = jsonNode({
  type: 'doc',
  content: [{
    type: 'table',
    content: [
      {
        type: 'table_row',
        content: [{
          type: 'table_header',
          attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: 'left' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }]
        }]
      },
      {
        type: 'table_row',
        content: [{
          type: 'table_cell',
          attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: 'left' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }]
        }]
      }
    ]
  }]
})
const tableColumnWidthExpected = jsonNode({
  type: 'doc',
  content: [{
    type: 'table',
    content: [
      {
        type: 'table_row',
        content: [{
          type: 'table_header',
          attrs: { colspan: 1, rowspan: 1, colwidth: [188], alignment: 'left' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }]
        }]
      },
      {
        type: 'table_row',
        content: [{
          type: 'table_cell',
          attrs: { colspan: 1, rowspan: 1, colwidth: [188], alignment: 'left' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }]
        }]
      }
    ]
  }]
})
assert.equal(
  areSourceDocumentsEquivalent(tableColumnWidthBaseline, tableColumnWidthExpected),
  false,
  'table colwidth metadata must remain strict without a focused path proof'
)
const previousSemanticDiffTrace = globalThis.__hmSourceIntegrityDiffTrace
globalThis.__hmSourceIntegrityDiffTrace = []
assert.equal(
  areSourceDocumentsEquivalent(tableColumnWidthBaseline, tableColumnWidthExpected, {
    recordDifference: false
  }),
  false,
  'preflight semantic comparison must remain strict when diagnostics are disabled'
)
assert.deepEqual(
  globalThis.__hmSourceIntegrityDiffTrace,
  [],
  'preflight semantic comparison must not pollute first-divergence diagnostics'
)
globalThis.__hmSourceIntegrityDiffTrace = previousSemanticDiffTrace
assert.equal(
  areSourceDocumentsEquivalent(tableColumnWidthBaseline, tableColumnWidthExpected, {
    ignoreTableColumnWidthPaths: [[0, 0, 0], [0, 1, 0]]
  }),
  true,
  'a focused owner may ignore colwidth at every proven cell path'
)
assert.equal(
  areSourceDocumentsEquivalent(tableColumnWidthBaseline, tableColumnWidthExpected, {
    ignoreTableColumnWidthPaths: [[0, 0, 0]]
  }),
  false,
  'missing one changed row path must keep table colwidth semantics strict'
)
const tableColumnAlignmentChanged = jsonNode({
  type: 'doc',
  content: [{
    type: 'table',
    content: [
      {
        type: 'table_row',
        content: [{
          type: 'table_header',
          attrs: { colspan: 1, rowspan: 1, colwidth: [188], alignment: 'right' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }]
        }]
      },
      {
        type: 'table_row',
        content: [{
          type: 'table_cell',
          attrs: { colspan: 1, rowspan: 1, colwidth: [188], alignment: 'left' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }]
        }]
      }
    ]
  }]
})
assert.equal(
  areSourceDocumentsEquivalent(tableColumnWidthBaseline, tableColumnAlignmentChanged, {
    ignoreTableColumnWidthPaths: [[0, 0, 0], [0, 1, 0]]
  }),
  false,
  'colwidth proof must not hide alignment or other authored attrs'
)

for (const placeholderType of ['hardbreak', 'hard_break']) {
  const placeholderTableCellDocument = jsonNode({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'table_row',
        content: [{
          type: 'table_cell',
          content: [{
            type: 'paragraph',
            content: [{ type: placeholderType }]
          }]
        }]
      }]
    }]
  })
  assert.equal(
    areSourceDocumentsEquivalent(emptyTableCellDocument, placeholderTableCellDocument),
    true,
    `standalone ${placeholderType} table-cell placeholder must equal an authored blank cell`
  )
  const meaningfulBreakDocument = jsonNode({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'table_row',
        content: [{
          type: 'table_cell',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: 'before' },
              { type: placeholderType },
              { type: 'text', text: 'after' }
            ]
          }]
        }]
      }]
    }]
  })
  assert.equal(
    areSourceDocumentsEquivalent(emptyTableCellDocument, meaningfulBreakDocument),
    false,
    `inline ${placeholderType} surrounded by text must remain authored semantics`
  )
}

// A list-item Backspace can transiently turn an empty sibling item into a
// second hardbreak-only/empty paragraph inside the preceding item. Markdown
// cannot persist two consecutive empty list-item paragraphs without exposing a
// Crepe placeholder, so integrity treats only that duplicate-empty multiplicity
// as non-authored. A meaningful second paragraph must remain strict.
const oneEmptyListParagraph = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create(null, [paragraph()]))
])
const duplicateEmptyListParagraph = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create(null, [paragraph(), paragraph()]))
])
const meaningfulSecondListParagraph = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create(null, [paragraph(), paragraph('保留正文')]))
])
assert.equal(
  areSourceDocumentsEquivalent(oneEmptyListParagraph, duplicateEmptyListParagraph),
  true,
  'consecutive duplicate empty paragraphs inside one list item are a transient editor placeholder'
)
assert.equal(
  areSourceDocumentsEquivalent(oneEmptyListParagraph, meaningfulSecondListParagraph),
  false,
  'semantic equivalence must never hide a non-empty second paragraph inside a list item'
)

// RS-56: removing a deepest nested list row can leave exactly one editor-owned
// empty paragraph at the end of its parent nested list item. This difference is
// structural by default and may be ignored only when the preservation reason
// has independently proven the list-row removal.
const nestedListWithoutTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('outer'),
      schema.nodes.bullet_list.create(null,
        schema.nodes.list_item.create(null, [paragraph('inner')]))
    ]))
])
const nestedListWithTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('outer'),
      schema.nodes.bullet_list.create(null,
        schema.nodes.list_item.create(null, [paragraph('inner'), paragraph()]))
    ]))
])
assert.equal(
  areSourceDocumentsEquivalent(nestedListWithoutTrailingEmpty, nestedListWithTrailingEmpty),
  false,
  'nested trailing empty list-item paragraph must remain strict without an explicit removal proof'
)

const exactPathListBaseline = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('first')]),
    schema.nodes.list_item.create(null, [paragraph('second')])
  ])
])
const exactPathFirstItemTransient = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('first'), paragraph()]),
    schema.nodes.list_item.create(null, [paragraph('second')])
  ])
])
const exactPathBothItemsTransient = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('first'), paragraph()]),
    schema.nodes.list_item.create(null, [paragraph('second'), paragraph()])
  ])
])
const exactPathMeaningfulSecondParagraph = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('first'), paragraph('must remain')]),
    schema.nodes.list_item.create(null, [paragraph('second')])
  ])
])
assert.equal(
  areSourceDocumentsEquivalent(exactPathListBaseline, exactPathFirstItemTransient),
  false,
  'transaction list transient must remain strict without its exact PM path'
)
assert.equal(
  areSourceDocumentsEquivalent(exactPathListBaseline, exactPathFirstItemTransient, {
    ignoreTrailingEmptyListItemPaths: [[0, 0]]
  }),
  true,
  'a focused transaction proof may ignore one trailing empty paragraph at its exact list_item path'
)
assert.equal(
  areSourceDocumentsEquivalent(exactPathListBaseline, exactPathFirstItemTransient, {
    ignoreTrailingEmptyListItemPaths: [[0, 1]]
  }),
  false,
  'an exact-path proof must not relax a different list item'
)
assert.equal(
  areSourceDocumentsEquivalent(exactPathListBaseline, exactPathBothItemsTransient, {
    ignoreTrailingEmptyListItemPaths: [[0, 0]]
  }),
  false,
  'one proven path must not hide a second transient in another list item'
)
assert.equal(
  areSourceDocumentsEquivalent(exactPathListBaseline, exactPathMeaningfulSecondParagraph, {
    ignoreTrailingEmptyListItemPaths: [[0, 0]]
  }),
  false,
  'the exact-path option must never hide meaningful paragraph text'
)
assert.equal(
  areSourceDocumentsEquivalent(
    nestedListWithoutTrailingEmpty,
    nestedListWithTrailingEmpty,
    { ignoreTrailingEmptyListItemParagraph: true }
  ),
  true,
  'a proven nested list-row removal may ignore exactly one editor-owned trailing empty paragraph'
)

// RS-85: deleting an empty top-level ordered parent that still owns a nested
// ordered child moves exactly one editor-owned empty paragraph into the prior
// sibling, immediately BEFORE that child. This is strict by default and may be
// omitted only under the dedicated raw-owner proof. A meaningful middle
// paragraph, the wrong nested-list kind, or multiple candidate triples remain
// structural mismatches even when the option is enabled.
const orderedChild = (value) => schema.nodes.ordered_list.create(null,
  schema.nodes.list_item.create(null, [paragraph(value)]))
const orderedParentWithoutMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('父项'),
      orderedChild('子项')
    ]))
])
const orderedParentWithMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('父项'),
      paragraph(),
      orderedChild('子项')
    ]))
])
assert.equal(
  areSourceDocumentsEquivalent(
    orderedParentWithoutMiddleEmpty,
    orderedParentWithMiddleEmpty
  ),
  false,
  'RS-85 middle empty paragraph must remain strict without its dedicated proof'
)
assert.equal(
  areSourceDocumentsEquivalent(
    orderedParentWithoutMiddleEmpty,
    orderedParentWithMiddleEmpty,
    { ignoreEmptyListItemParagraphBeforeNestedStructure: true }
  ),
  true,
  'RS-85 dedicated proof may ignore exactly one empty paragraph before an ordered child'
)
const orderedParentWithMeaningfulMiddle = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('父项'),
      paragraph('必须保留'),
      orderedChild('子项')
    ]))
])
assert.equal(
  areSourceDocumentsEquivalent(
    orderedParentWithoutMiddleEmpty,
    orderedParentWithMeaningfulMiddle,
    { ignoreEmptyListItemParagraphBeforeNestedStructure: true }
  ),
  false,
  'RS-85 proof must never hide a meaningful paragraph before the nested child'
)
const bulletParentWithMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('父项'),
      paragraph(),
      schema.nodes.bullet_list.create(null,
        schema.nodes.list_item.create(null, [paragraph('子项')]))
    ]))
])
assert.equal(
  areSourceDocumentsEquivalent(
    orderedParentWithoutMiddleEmpty,
    bulletParentWithMiddleEmpty,
    { ignoreEmptyListItemParagraphBeforeNestedStructure: true }
  ),
  false,
  'RS-85 proof must not ignore an empty paragraph before a bullet child'
)
const twoOrderedChildrenWithoutMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('父项一'),
      orderedChild('子项一'),
      paragraph('父项二'),
      orderedChild('子项二')
    ]))
])
const twoOrderedChildrenWithMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null,
    schema.nodes.list_item.create(null, [
      paragraph('父项一'),
      paragraph(),
      orderedChild('子项一'),
      paragraph('父项二'),
      paragraph(),
      orderedChild('子项二')
    ]))
])
assert.equal(
  areSourceDocumentsEquivalent(
    twoOrderedChildrenWithoutMiddleEmpty,
    twoOrderedChildrenWithMiddleEmpty,
    { ignoreEmptyListItemParagraphBeforeNestedStructure: true }
  ),
  false,
  'RS-85 semantic option must fail closed when one list item has multiple candidate triples'
)
const twoOrderedItemsWithoutMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('父项一'), orderedChild('子项一')]),
    schema.nodes.list_item.create(null, [paragraph('父项二'), orderedChild('子项二')])
  ])
])
const twoOrderedItemsWithMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('父项一'), paragraph(), orderedChild('子项一')]),
    schema.nodes.list_item.create(null, [paragraph('父项二'), paragraph(), orderedChild('子项二')])
  ])
])
assert.equal(
  areSourceDocumentsEquivalent(
    twoOrderedItemsWithoutMiddleEmpty,
    twoOrderedItemsWithMiddleEmpty,
    { ignoreEmptyListItemParagraphBeforeNestedStructure: true }
  ),
  false,
  'RS-85 semantic option must fail closed when separate list items each contain a candidate'
)
const firstOrderedItemWithMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('父项一'), paragraph(), orderedChild('子项一')]),
    schema.nodes.list_item.create(null, [paragraph('父项二'), orderedChild('子项二')])
  ])
])
const secondOrderedItemWithMiddleEmpty = schema.nodes.doc.create(null, [
  schema.nodes.ordered_list.create(null, [
    schema.nodes.list_item.create(null, [paragraph('父项一'), orderedChild('子项一')]),
    schema.nodes.list_item.create(null, [paragraph('父项二'), paragraph(), orderedChild('子项二')])
  ])
])
assert.equal(
  areSourceDocumentsEquivalent(
    firstOrderedItemWithMiddleEmpty,
    secondOrderedItemWithMiddleEmpty,
    { ignoreEmptyListItemParagraphBeforeNestedStructure: true }
  ),
  false,
  'RS-85 semantic option must not hide one candidate moving between list items'
)

// RS-58 uses the same narrow semantic shape for a checked task item: a
// non-empty first paragraph followed by exactly one editor-owned empty paragraph.
// `checked` remains authored semantics; only the empty trailing paragraph is
// ignored after preservation has independently proven its deletion.
const taskWithoutTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create({ checked: true }, [paragraph('前端')]))
])
const taskWithTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.bullet_list.create(null,
    schema.nodes.list_item.create({ checked: true }, [paragraph('前端'), paragraph()]))
])
assert.equal(
  areSourceDocumentsEquivalent(taskWithoutTrailingEmpty, taskWithTrailingEmpty),
  false,
  'task trailing empty paragraph must remain strict without a dedicated preservation proof'
)
assert.equal(
  areSourceDocumentsEquivalent(
    taskWithoutTrailingEmpty,
    taskWithTrailingEmpty,
    { ignoreTrailingEmptyListItemParagraph: true }
  ),
  true,
  'a proven task continuation deletion may ignore exactly one trailing empty paragraph'
)

// RS-57: a proven trailing blockquote Enter may temporarily add exactly one
// empty paragraph after a non-empty quote paragraph. Default semantic identity
// stays strict; only the dedicated preservation reason opts into ignoring it.
const quoteWithoutTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文')])
])
const quoteWithTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文'), paragraph()])
])
assert.equal(
  areSourceDocumentsEquivalent(quoteWithoutTrailingEmpty, quoteWithTrailingEmpty),
  false,
  'trailing empty blockquote paragraph must remain strict by default'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteWithoutTrailingEmpty,
    quoteWithTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraph: true }
  ),
  true,
  'a proven trailing blockquote Enter may ignore exactly one editor-owned empty paragraph'
)

// A list exit inside a blockquote creates the same unrepresentable trailing
// empty quote paragraph, but the previous child is a list rather than text.
// Keep the generic blockquote relaxation strict and permit this shape only at
// the exact blockquote path proven by the structural transaction owner.
const quotedOrderedList = schema.nodes.ordered_list.create(null, [item('一'), item('二')])
const quoteListWithoutTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文'), quotedOrderedList])
])
const quoteListWithTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文'), quotedOrderedList, paragraph()])
])
assert.equal(
  areSourceDocumentsEquivalent(
    quoteListWithoutTrailingEmpty,
    quoteListWithTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraph: true }
  ),
  false,
  'generic blockquote transient allowance must not accept an empty paragraph after a list'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteListWithoutTrailingEmpty,
    quoteListWithTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[1]] }
  ),
  false,
  'blockquote-list transient allowance must remain strict at an unrelated path'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteListWithoutTrailingEmpty,
    quoteListWithTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'transaction-proven blockquote-list exit may ignore one trailing empty paragraph at its exact path'
)
const quoteListWithTwoTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [
    paragraph('引用正文'),
    quotedOrderedList,
    paragraph(),
    paragraph()
  ])
])
assert.equal(
  areSourceDocumentsEquivalent(
    quoteListWithoutTrailingEmpty,
    quoteListWithTwoTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  false,
  'blockquote-list transient allowance must reject two trailing empty paragraphs'
)

// A trusted baseline may already have a stable serializer/source divergence.
// The integrity gate may accept a later edit only when BOTH representations
// undergo the same normalized semantic transition.
const divergedSourceBefore = schema.nodes.doc.create(null, [
  paragraph('前文'),
  paragraph('旧表示')
])
const divergedCanonicalBefore = schema.nodes.doc.create(null, [
  paragraph('前文'),
  quote('旧表示')
])
const divergedSourceAfterAppend = schema.nodes.doc.create(null, [
  paragraph('前文'),
  paragraph('旧表示'),
  paragraph('新增')
])
const divergedCanonicalAfterAppend = schema.nodes.doc.create(null, [
  paragraph('前文'),
  quote('旧表示'),
  paragraph('新增')
])
assert.equal(
  areSourceDocumentTransitionsEquivalent(
    divergedSourceBefore,
    divergedSourceAfterAppend,
    divergedCanonicalBefore,
    divergedCanonicalAfterAppend
  ),
  true,
  'a pre-existing divergence must allow an identical later semantic append'
)
const divergedCanonicalWrongAppend = schema.nodes.doc.create(null, [
  paragraph('前文'),
  quote('旧表示'),
  paragraph('错误新增')
])
assert.equal(
  areSourceDocumentTransitionsEquivalent(
    divergedSourceBefore,
    divergedSourceAfterAppend,
    divergedCanonicalBefore,
    divergedCanonicalWrongAppend
  ),
  false,
  'different source/canonical transitions must remain fail-closed'
)

const textPositions = {}
doc.descendants((node, pos) => {
  if (node.isText) textPositions[node.text] = pos
})

const rawStarts = {
  标题: source.indexOf('标题'),
  正文: source.indexOf('正文'),
  引用: source.indexOf('引用'),
  项目: source.indexOf('项目')
}

const mapPosition = (markdown, pmPos, pmDoc) => {
  let result = null
  pmDoc.descendants((node, pos) => {
    if (result != null || !node.isText) return
    if (pmPos < pos || pmPos > pos + node.nodeSize) return
    const rawStart = markdown.indexOf(node.text)
    if (rawStart >= 0) result = rawStart + (pmPos - pos)
  })
  if (result != null) return result
  // Empty textblocks have no text descendant; this test intentionally leaves
  // them unmapped because production must fail closed in the same situation.
  return null
}

const apply = (state, step) => {
  const tr = state.tr.step(step)
  return {
    transaction: tr,
    state: state.apply(tr)
  }
}

// Plain text insertion in a paragraph.
let state = EditorState.create({ schema, doc })
let result = apply(
  state,
  new ReplaceStep(
    textPositions.正文 + 2,
    textPositions.正文 + 2,
    new Slice(Fragment.from(text('新增')), 0, 0)
  )
)
let mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正文新增\n\n> 引用\n\n- 项目\n')

// A revision-bound journal may replay several transactions in one atomic call.
// The normalized→raw boundary map must survive an insertion in an earlier block
// before a later replacement, including the authored terminal newline.
const chainedDoc = schema.nodes.doc.create(null, [paragraph('alpha'), paragraph('beta')])
const chainedSource = 'alpha\n\nbeta\n'
let chainedState = EditorState.create({ schema, doc: chainedDoc })
let chainedPositions = {}
chainedState.doc.descendants((node, pos) => {
  if (node.isText) chainedPositions[node.text] = pos
})
const chainedInsert = chainedState.tr.insertText('X', chainedPositions.alpha + 5)
const afterChainedInsert = chainedState.apply(chainedInsert)
chainedPositions = {}
afterChainedInsert.doc.descendants((node, pos) => {
  if (node.isText) chainedPositions[node.text] = pos
})
const chainedReplace = afterChainedInsert.tr.insertText(
  'ZZ',
  chainedPositions.beta + 2,
  chainedPositions.beta + 4
)
const afterChainedReplace = afterChainedInsert.apply(chainedReplace)
mapped = mapTransactions({
  source: chainedSource,
  transactions: [chainedInsert, chainedReplace],
  oldState: chainedState,
  newState: afterChainedReplace,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, 'alphaX\n\nbeZZ\n')

// Enter inside a top-level paragraph inserts exactly one Markdown blank line,
// then following text transactions map against the newly split PM document.
const tailDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
const tailSource = '# 标题\n\n正文\n'
let tailTextPos = null
tailDoc.descendants((node, pos) => {
  if (tailTextPos == null && node.isText && node.text === '正文') tailTextPos = pos
})
state = EditorState.create({ schema, doc: tailDoc })
const splitTransaction = state.tr.split(tailTextPos + 1)
const splitState = state.apply(splitTransaction)
mapped = mapTransactions({
  source: tailSource,
  transactions: [splitTransaction],
  oldState: state,
  newState: splitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正\n\n文\n')
const splitSource = mapped.markdown
const splitHints = mapped.blockHints
let newParagraphTextPos = null
splitState.doc.descendants((node, pos) => {
  if (newParagraphTextPos == null && node.isText && node.text === '文') newParagraphTextPos = pos
})
const followTransaction = splitState.tr.insertText('新', newParagraphTextPos)
const followState = splitState.apply(followTransaction)
mapped = mapTransactions({
  source: splitSource,
  transactions: [followTransaction],
  oldState: splitState,
  newState: followState,
  blockHints: splitHints,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正\n\n新文\n')

// Enter at the end of a paragraph before another authored paragraph creates a
// real raw blank-line slot. A second Enter inside that owned empty paragraph
// creates another slot; neither operation may map later text into a neighbour.
const middleDoc = schema.nodes.doc.create(null, [paragraph('Alpha'), paragraph('Omega')])
const middleSource = 'Alpha\n\nOmega'
state = EditorState.create({ schema, doc: middleDoc })
const middleSplit = state.tr.split(6)
const middleSplitState = state.apply(middleSplit)
mapped = mapTransactions({
  source: middleSource,
  transactions: [middleSplit],
  oldState: state,
  newState: middleSplitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, 'Alpha\n\n\n\nOmega')

const ownedEmptySplit = middleSplitState.tr.split(8)
const ownedEmptySplitState = middleSplitState.apply(ownedEmptySplit)
mapped = mapTransactions({
  source: mapped.markdown,
  transactions: [ownedEmptySplit],
  oldState: middleSplitState,
  newState: ownedEmptySplitState,
  blockHints: mapped.blockHints,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, 'Alpha\n\n\n\n\n\nOmega')

// Hints own both a ProseMirror coordinate and a raw Markdown coordinate. An
// edit in an earlier block must shift both before text is entered into the
// empty block, including CRLF documents.
const runHintShiftCase = (lineEnding) => {
  const initialDoc = schema.nodes.doc.create(null, [paragraph('a')])
  const initialSource = 'a'
  let initialState = EditorState.create({ schema, doc: initialDoc })
  const split = initialState.tr.split(2)
  const afterSplit = initialState.apply(split)
  let result = mapTransactions({
    source: initialSource,
    transactions: [split],
    oldState: initialState,
    newState: afterSplit,
    mapPosition
  })
  assert.equal(result.ok, true)
  if (lineEnding === '\r\n') {
    result.markdown = result.markdown.replaceAll('\n', '\r\n')
    result.blockHints = result.blockHints.map((hint) => ({
      ...hint,
      rawStart: hint.rawStart * 2 - 1
    }))
  }

  const editFirst = afterSplit.tr.insertText('x', 2)
  const afterFirst = afterSplit.apply(editFirst)
  result = mapTransactions({
    source: result.markdown,
    transactions: [editFirst],
    oldState: afterSplit,
    newState: afterFirst,
    blockHints: result.blockHints,
    mapPosition
  })
  assert.equal(result.ok, true)

  const typeInEmpty = afterFirst.tr.insertText('b', 5)
  const afterEmpty = afterFirst.apply(typeInEmpty)
  result = mapTransactions({
    source: result.markdown,
    transactions: [typeInEmpty],
    oldState: afterFirst,
    newState: afterEmpty,
    blockHints: result.blockHints,
    mapPosition
  })
  assert.equal(result.ok, true)
  assert.equal(result.markdown, `ax${lineEnding}${lineEnding}b`)
}
runHintShiftCase('\n')
runHintShiftCase('\r\n')

// Leading spaces are authored as U+200B + literal spaces so Markdown does not
// reinterpret them as an indented code block. The sentinel disappears again
// when the block no longer starts with whitespace.
const sentinelDoc = schema.nodes.doc.create(null, [paragraph('a')])
state = EditorState.create({ schema, doc: sentinelDoc })
const sentinelSplit = state.tr.split(2)
let sentinelState = state.apply(sentinelSplit)
let sentinelMapped = mapTransactions({
  source: 'a',
  transactions: [sentinelSplit],
  oldState: state,
  newState: sentinelState,
  mapPosition
})
const sentinelSpace = sentinelState.tr.insertText(' ', 4)
let sentinelNextState = sentinelState.apply(sentinelSpace)
sentinelMapped = mapTransactions({
  source: sentinelMapped.markdown,
  transactions: [sentinelSpace],
  oldState: sentinelState,
  newState: sentinelNextState,
  blockHints: sentinelMapped.blockHints,
  mapPosition
})
assert.equal(sentinelMapped.ok, true)
assert.equal(sentinelMapped.markdown, 'a\n\n\u200B ')
sentinelState = sentinelNextState
const sentinelText = sentinelState.tr.insertText('x', 5)
sentinelNextState = sentinelState.apply(sentinelText)
sentinelMapped = mapTransactions({
  source: sentinelMapped.markdown,
  transactions: [sentinelText],
  oldState: sentinelState,
  newState: sentinelNextState,
  blockHints: sentinelMapped.blockHints,
  mapPosition
})
assert.equal(sentinelMapped.markdown, 'a\n\n\u200B x')
sentinelState = sentinelNextState
const removeLeadingSpace = sentinelState.tr.delete(4, 5)
sentinelNextState = sentinelState.apply(removeLeadingSpace)
sentinelMapped = mapTransactions({
  source: sentinelMapped.markdown,
  transactions: [removeLeadingSpace],
  oldState: sentinelState,
  newState: sentinelNextState,
  blockHints: sentinelMapped.blockHints,
  mapPosition
})
assert.equal(sentinelMapped.ok, true)
assert.equal(sentinelMapped.markdown, 'a\n\nx')

// An empty block that was not created by the mapper has no byte ownership.
// Even if a caller supplies an optimistic position, it must fail closed.
const unownedEmptyDoc = schema.nodes.doc.create(null, [paragraph()])
state = EditorState.create({ schema, doc: unownedEmptyDoc })
const unownedType = state.tr.insertText('unsafe', 1)
const unownedTypeState = state.apply(unownedType)
mapped = mapTransactions({
  source: '',
  transactions: [unownedType],
  oldState: state,
  newState: unownedTypeState,
  mapPosition: () => 0
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'empty-block-without-source-slot')

// CRLF documents keep their line-ending convention when Enter creates a new
// paragraph. The transaction mapper must not introduce a lone LF.
const crlfSource = tailSource.replaceAll('\n', '\r\n')
state = EditorState.create({ schema, doc: tailDoc })
const crlfSplit = state.tr.split(tailTextPos + 1)
const crlfSplitState = state.apply(crlfSplit)
mapped = mapTransactions({
  source: crlfSource,
  transactions: [crlfSplit],
  oldState: state,
  newState: crlfSplitState,
  // The mapper hands the position mapper the normalized LF view, so the
  // plain-LF resolver applies directly.
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\n\r\n正\r\n\r\n文\r\n')

// BOM + CRLF documents keep both file-format spellings through plain edits
// and structural splits. The normalized proof view is invisible to the caller.
const bomCrlfSource = '\uFEFF# 标题\r\n\r\n正文\r\n'
const bomCrlfDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
state = EditorState.create({ schema, doc: bomCrlfDoc })
let bomCrlfTextPos = null
bomCrlfDoc.descendants((node, pos) => {
  if (bomCrlfTextPos == null && node.isText && node.text === '正文') bomCrlfTextPos = pos
})
const bomInsert = state.tr.insertText('X', bomCrlfTextPos + 2)
const bomInsertState = state.apply(bomInsert)
mapped = mapTransactions({
  source: bomCrlfSource,
  transactions: [bomInsert],
  oldState: state,
  newState: bomInsertState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '\uFEFF# 标题\r\n\r\n正文X\r\n')

state = EditorState.create({ schema, doc: bomCrlfDoc })
const bomSplit = state.tr.split(bomCrlfTextPos + 1)
const bomSplitState = state.apply(bomSplit)
mapped = mapTransactions({
  source: bomCrlfSource,
  transactions: [bomSplit],
  oldState: state,
  newState: bomSplitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '\uFEFF# 标题\r\n\r\n正\r\n\r\n文\r\n')

// A lone-CR document uses `\r` as its own line ending; the mapper must not
// silently upgrade it to LF when Enter creates a new paragraph.
const crOnlySource = '# 标题\r\r正文\r'
const crOnlyDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
state = EditorState.create({ schema, doc: crOnlyDoc })
let crOnlyTextPos = null
crOnlyDoc.descendants((node, pos) => {
  if (crOnlyTextPos == null && node.isText && node.text === '正文') crOnlyTextPos = pos
})
const crOnlySplit = state.tr.split(crOnlyTextPos + 1)
const crOnlySplitState = state.apply(crOnlySplit)
mapped = mapTransactions({
  source: crOnlySource,
  transactions: [crOnlySplit],
  oldState: state,
  newState: crOnlySplitState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\r正\r\r文\r')

// Plain text edits in a lone-CR document keep the authored spelling; no line
// ending is introduced by the insertion.
state = EditorState.create({ schema, doc: crOnlyDoc })
const crOnlyInsert = state.tr.insertText('X', crOnlyTextPos + 2)
const crOnlyInsertState = state.apply(crOnlyInsert)
mapped = mapTransactions({
  source: crOnlySource,
  transactions: [crOnlyInsert],
  oldState: state,
  newState: crOnlyInsertState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\r正文X\r')

// Mixed EOL documents reject structural splits atomically; ordinary plain
// text edits (which introduce no new line ending) remain safe.
const mixedSource = '# 标题\r\n\r\n正文\n'
const mixedDoc = schema.nodes.doc.create(null, [heading('标题'), paragraph('正文')])
state = EditorState.create({ schema, doc: mixedDoc })
let mixedTextPos = null
mixedDoc.descendants((node, pos) => {
  if (mixedTextPos == null && node.isText && node.text === '正文') mixedTextPos = pos
})
const mixedSplit = state.tr.split(mixedTextPos + 1)
const mixedSplitState = state.apply(mixedSplit)
mapped = mapTransactions({
  source: mixedSource,
  transactions: [mixedSplit],
  oldState: state,
  newState: mixedSplitState,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'mixed-line-ending-split')
assert.equal(mapped.markdown, mixedSource)

state = EditorState.create({ schema, doc: mixedDoc })
const mixedInsert = state.tr.insertText('X', mixedTextPos + 2)
const mixedInsertState = state.apply(mixedInsert)
mapped = mapTransactions({
  source: mixedSource,
  transactions: [mixedInsert],
  oldState: state,
  newState: mixedInsertState,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\r\n\r\n正文X\n')

// Editing list text preserves the authored `-` marker. Emptying the whole item
// stays on the specialized list-exit fallback until that structural sequence
// is transaction-owned end to end.
state = EditorState.create({ schema, doc })
result = apply(
  state,
  new ReplaceStep(
    textPositions.项目 + 1,
    textPositions.项目 + 2,
    Slice.empty
  )
)
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, true)
assert.equal(mapped.markdown, '# 标题\n\n正文\n\n> 引用\n\n- 项\n')
assert.ok(!mapped.markdown.includes('* 项'))

state = EditorState.create({ schema, doc })
result = apply(
  state,
  new ReplaceStep(
    textPositions.项目,
    textPositions.项目 + 2,
    Slice.empty
  )
)
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'textblock-emptied')
assert.equal(mapped.markdown, source)

// Cross-block and syntax-sensitive edits are rejected atomically.
state = EditorState.create({ schema, doc })
const crossBlockTransaction = state.tr.delete(textPositions.正文, textPositions.引用 + 2)
result = {
  transaction: crossBlockTransaction,
  state: state.apply(crossBlockTransaction)
}
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.markdown, source)

// A batch is atomic: a valid first transaction followed by an unsupported
// syntax transaction must not leak the first patch into the source.
const atomicDoc = schema.nodes.doc.create(null, [paragraph('atomic')])
const atomicSource = 'atomic'
state = EditorState.create({ schema, doc: atomicDoc })
const atomicPlain = state.tr.insertText('X', 2)
const atomicMidState = state.apply(atomicPlain)
const atomicSyntax = atomicMidState.tr.insertText('`', 3)
const atomicFinalState = atomicMidState.apply(atomicSyntax)
mapped = mapTransactions({
  source: atomicSource,
  transactions: [atomicPlain, atomicSyntax],
  oldState: state,
  newState: atomicFinalState,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.markdown, atomicSource)

// Individually ordinary characters can complete Markdown syntax across
// transactions. The parser-equivalence gate must reject the final source when
// it would cold-open as a different document than the live ProseMirror state.
const semanticDoc = schema.nodes.doc.create(null, [paragraph('x~~')])
const semanticSource = 'x~~'
state = EditorState.create({ schema, doc: semanticDoc })
const semanticTransaction = state.tr.insertText('~~', 1)
const semanticState = state.apply(semanticTransaction)
mapped = mapTransactions({
  source: semanticSource,
  transactions: [semanticTransaction],
  oldState: state,
  newState: semanticState,
  mapPosition,
  validateMarkdown: (markdown) => markdown !== '~~x~~'
})
assert.equal(mapped.ok, false)
assert.equal(mapped.reason, 'semantic-document-mismatch')
assert.equal(mapped.markdown, semanticSource)

state = EditorState.create({ schema, doc })
result = apply(
  state,
  new ReplaceStep(
    textPositions.正文 + 2,
    textPositions.正文 + 2,
    new Slice(Fragment.from(text('`')), 0, 0)
  )
)
mapped = mapTransactions({
  source,
  transactions: [result.transaction],
  oldState: state,
  newState: result.state,
  mapPosition
})
assert.equal(mapped.ok, false)
assert.equal(mapped.markdown, source)

// The dispatch boundary forwards one complete applyTransaction batch,
// including recursively appended plugin transactions, before updating the
// view. A batch prefix can therefore never advance source independently.
const appendPlugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null
    if (transactions.some((transaction) => transaction.getMeta('hm-append-test'))) return null
    return newState.tr
      .insertText('!', newState.doc.content.size - 1)
      .setMeta('hm-append-test', true)
  }
})
const dispatchState = EditorState.create({
  schema,
  doc: schema.nodes.doc.create(null, [paragraph('atomic')]),
  plugins: [appendPlugin]
})
let observedBatch = null
let updateCount = 0
const fakeView = {
  state: dispatchState,
  updateState(nextState) {
    updateCount += 1
    this.state = nextState
  }
}
createSourceTransactionDispatch((transactions, oldState, newState) => {
  observedBatch = { transactions, oldState, newState }
}).call(fakeView, dispatchState.tr.insertText('X', 2))
assert.equal(observedBatch.transactions.length, 2)
assert.equal(observedBatch.oldState, dispatchState)
assert.equal(observedBatch.newState.doc.textContent, 'aXtomic!')
assert.equal(updateCount, 1)
assert.equal(fakeView.state, observedBatch.newState)

// A select-all replacement owns the complete old document even when its
// authored source and canonical serializer are globally divergent. Requiring
// the old AllSelection prevents a sole-block Markdown input rule from being
// misclassified as a whole-document replacement.
state = EditorState.create({ schema, doc })
state = state.apply(state.tr.setSelection(new AllSelection(state.doc)))
const wholeReplacement = state.tr.replaceSelectionWith(paragraph('周/月(使用每周复盘数据)'), false)
const wholeReplacementState = state.apply(wholeReplacement)
assert.equal(isWholeDocumentReplacementBatch({
  transactions: [wholeReplacement],
  oldState: state,
  newState: wholeReplacementState
}), true)
const nonSelectedState = EditorState.create({ schema, doc })
assert.equal(isWholeDocumentReplacementBatch({
  transactions: [wholeReplacement],
  oldState: nonSelectedState,
  newState: wholeReplacementState
}), false)
assert.equal(
  formatWholeDocumentReplacementSource({
    canonical: '周/月\n下一行\n',
    previousSource: '\uFEFF# 标题\r\n\r\n旧正文\r\n'
  }),
  '\uFEFF周/月\r\n下一行\r\n'
)
assert.equal(
  formatWholeDocumentReplacementSource({
    canonical: '',
    previousSource: '\uFEFF旧正文\r\n'
  }),
  ''
)
assert.equal(
  formatWholeDocumentReplacementSource({
    canonical: '新正文\n下一行\n',
    previousSource: '旧正文\r\n第二行\n'
  }),
  '新正文\n下一行\n'
)

console.log('PASS source transaction sync: plain edits and select-all replacement map exactly; unsupported edits fail closed')
