import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { AllSelection, EditorState, Plugin } from '@milkdown/prose/state'
import {
  areSourceDocumentTransitionsEquivalent,
  areSourceDocumentsEquivalent,
  formatWholeDocumentReplacementSource,
  isWholeDocumentReplacementBatch
} from '../src/renderer/src/lib/source-transaction-sync.js'
import { createSourceTransactionDispatch } from '../src/renderer/src/components/editor-source-transactions.js'

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

// A focused transaction owner may also bind the exact blockquote path for the
// normal text-predecessor transient. This is used when a trailing-space text
// transaction and Enter share one journal; wrong paths and multiple empties
// must remain strict.
const quoteTextWithoutTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文 ')])
])
const quoteTextWithTrailingEmpty = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文 '), paragraph()])
])
assert.equal(
  areSourceDocumentsEquivalent(
    quoteTextWithoutTrailingEmpty,
    quoteTextWithTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]] }
  ),
  true,
  'transaction-proven text quote may ignore one trailing empty paragraph at its exact path'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteTextWithoutTrailingEmpty,
    quoteTextWithTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraphPaths: [[1]] }
  ),
  false,
  'transaction-proven text quote must stay strict at an unrelated path'
)
const quoteTextSourceWithoutSpace = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文')])
])
assert.equal(
  areSourceDocumentsEquivalent(
    quoteTextSourceWithoutSpace,
    quoteTextWithTrailingEmpty,
    {
      ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]],
      ignoreSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths: [[0]]
    }
  ),
  true,
  'exact pending quote proof may ignore one Markdown-nonsemantic trailing space before its empty paragraph'
)
const quoteTextWithHardBreakSpaces = schema.nodes.doc.create(null, [
  schema.nodes.blockquote.create(null, [paragraph('引用正文  '), paragraph()])
])
assert.equal(
  areSourceDocumentsEquivalent(
    quoteTextSourceWithoutSpace,
    quoteTextWithHardBreakSpaces,
    {
      ignoreTrailingEmptyBlockquoteParagraphPaths: [[0]],
      ignoreSingleTrailingSpaceBeforeEmptyBlockquoteParagraphPaths: [[0]]
    }
  ),
  true,
  // 0.13.235: spaces at the very END of a paragraph never encode a hard break
  // in CommonMark (a break needs following text in the same paragraph), so
  // they are stripped on parse and are not authored meaning. Spaces before an
  // in-paragraph break node stay strict (see the hard-break check below).
  'trailing spaces at a paragraph end are Markdown-nonsemantic, even two of them'
)
{
  const withBreak = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [schema.text('a  '), schema.nodes.hard_break?.create?.() || schema.nodes.hardbreak?.create?.(), schema.text('b')].filter(Boolean))
  ])
  const withoutSpaces = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [schema.text('a'), schema.nodes.hard_break?.create?.() || schema.nodes.hardbreak?.create?.(), schema.text('b')].filter(Boolean))
  ])
  if (withBreak.firstChild.childCount === 3) {
    assert.equal(
      areSourceDocumentsEquivalent(withBreak, withoutSpaces),
      false,
      'spaces before an in-paragraph break remain strict'
    )
  }
}

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
  true,
  // E0 P3d (f117a33): a PROOF-OWNED path collapses the whole run of trailing
  // empty quote paragraphs (repeated Enter over a published transient) —
  // authored `>` bytes cannot encode any of them.
  'proof-owned blockquote-list path collapses the whole trailing empty run'
)
assert.equal(
  areSourceDocumentsEquivalent(
    quoteListWithoutTrailingEmpty,
    quoteListWithTwoTrailingEmpty,
    { ignoreTrailingEmptyBlockquoteParagraph: true }
  ),
  false,
  'the legacy (non-path) blockquote allowance stays exactly one trailing empty paragraph after text'
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
let state = EditorState.create({ schema, doc })
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

// Line-edge whitespace (fuzz UI 2026-11-04): blanks before a break go
// first, then edge breaks, then blanks after the remaining soft breaks; the
// spaces of inline code are content everywhere.
{
  const s2 = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
      hardbreak: { inline: true, group: 'inline', attrs: { isInline: { default: false } } }
    },
    marks: { inlineCode: {} }
  })
  const t = (value) => s2.text(value)
  const code = (value) => s2.text(value, [s2.marks.inlineCode.create()])
  const soft = () => s2.nodes.hardbreak.create({ isInline: true })
  const para = (...children) => s2.nodes.doc.create(null, [s2.nodes.paragraph.create(null, children)])
  assert.equal(areSourceDocumentsEquivalent(para(t('Second')), para(t('    '), soft(), t('Second'))), true, 'blanks + soft break at a paragraph start are nothing (seed 127)')
  assert.equal(areSourceDocumentsEquivalent(para(t(' note')), para(soft(), t(' note'))), true, 'a dropped leading break leaves the spelled leading space (seed 185)')
  assert.equal(areSourceDocumentsEquivalent(para(t('note')), para(soft(), t(' note'))), false, '...which is not dropped')
  assert.equal(areSourceDocumentsEquivalent(para(t(' note')), para(soft(), soft(), t(' note'))), true, 'a run of leading breaks too (seed 368)')
  assert.equal(areSourceDocumentsEquivalent(para(t('note')), para(soft(), soft(), t(' note'))), false, '...its space is not dropped either')
  assert.equal(areSourceDocumentsEquivalent(para(t('a'), soft(), t('b')), para(t('a'), soft(), t('  b'))), true, 'continuation-line blanks still ignored')
  assert.equal(areSourceDocumentsEquivalent(para(t('a '), code('c')), para(t('a '), code('c '))), false, 'trailing space inside inline code is content')
  assert.equal(areSourceDocumentsEquivalent(para(code('c'), soft(), t('d')), para(code('c '), soft(), t('d'))), false, 'space in code before a break is content')
}

console.log('PASS source transaction sync: document equivalence, select-all replacement detection/formatting and the dispatch wrapper')
