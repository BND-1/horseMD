import assert from 'node:assert/strict'
import {
  areMarkdownListSlotTransitionsEquivalent,
  areMarkdownListSlotsEquivalent,
  markdownListSlotFingerprint
} from '../src/renderer/src/lib/source-structure-fingerprint.js'

assert.equal(
  areMarkdownListSlotsEquivalent(
    ['1. 内容', '2. <br />'].join('\n'),
    ['1. 内容', '1. '].join('\n')
  ),
  true,
  'marker spelling may differ when list slots are identical'
)
assert.equal(
  areMarkdownListSlotsEquivalent(
    ['1. 内容', '1. ', '3. '].join('\n'),
    ['1. 内容', '2. <br />', '3. <br />'].join('\n'),
    { strictOrderedNumbers: true }
  ),
  false,
  'strict validation rejects an incorrectly numbered empty item'
)
assert.equal(
  areMarkdownListSlotsEquivalent(
    ['* <br />', '  1. nested'].join('\n'),
    ['-   1. nested'].join('\n'),
    { strictOrderedNumbers: true }
  ),
  true,
  'source and canonical line wrapping does not change nested list slots'
)
assert.equal(
  areMarkdownListSlotsEquivalent(
    ['- parent', '  - child'].join('\n'),
    ['- parent', '- child'].join('\n'),
    { strictOrderedNumbers: true, strictNesting: true }
  ),
  false,
  'strict validation rejects a list item flattened to the parent depth'
)
assert.deepEqual(
  markdownListSlotFingerprint('```\n- not a list\n```'),
  [],
  'fenced code is excluded from list-slot validation'
)
assert.deepEqual(
  markdownListSlotFingerprint(['```你好```', '', '1. after literal backticks'].join('\n')),
  [[{
    kind: 'ordered',
    indent: 0,
    number: '1',
    task: 'plain',
    empty: false,
    depth: 0
  }]],
  'a same-line literal triple-backtick paragraph must not hide later list slots as an unterminated fence'
)
assert.deepEqual(
  markdownListSlotFingerprint([
    '````',
    '- hidden one',
    '```',
    '1. still hidden after short close',
    '````',
    '2. visible after real close'
  ].join('\n')),
  [[{
    kind: 'ordered',
    indent: 0,
    number: '2',
    task: 'plain',
    empty: false,
    depth: 0
  }]],
  'a shorter backtick run must not close a longer fenced code block'
)
assert.deepEqual(
  markdownListSlotFingerprint([
    '```js',
    '- hidden',
    '``` trailing text',
    '1. still hidden',
    '```',
    '3. visible'
  ].join('\n')),
  [[{
    kind: 'ordered',
    indent: 0,
    number: '3',
    task: 'plain',
    empty: false,
    depth: 0
  }]],
  'a closing fence may contain only indentation and trailing whitespace'
)
assert.equal(
  areMarkdownListSlotsEquivalent(
    ['1. 输入个人的时光', '2. 的人多不多吧', '', '- 看了呢分'].join('\n'),
    ['1. 输入个人的时光', '2. 的人多不多吧', '', '<br />', '', '* 看了呢分'].join('\n'),
    { strictOrderedNumbers: true, previousMarkdown: ['1. 输入个人的时光', '2. 的人多不多吧', '3. <br />', '* 看了呢分'].join('\n') }
  ),
  true,
  'exiting an empty list item drops the item and its <br /> placeholder without changing list groups'
)

const preexistingSourceSlots = [
  '- source-only',
  'plain fence'
].join('\n')
const preexistingCanonicalSlots = [
  '- canonical-a',
  'plain fence',
  '- canonical-b',
  'tail fence'
].join('\n')
assert.equal(
  areMarkdownListSlotTransitionsEquivalent(
    preexistingSourceSlots,
    `${preexistingSourceSlots}\n\n1. new`,
    preexistingCanonicalSlots,
    `${preexistingCanonicalSlots}\n\n1. new`,
    { strictOrderedNumbers: true, strictNesting: true }
  ),
  true,
  'pre-existing list-group count divergence may still append the same strict ordered slot transition'
)
assert.equal(
  areMarkdownListSlotTransitionsEquivalent(
    preexistingSourceSlots,
    `${preexistingSourceSlots}\n\n1. new`,
    preexistingCanonicalSlots,
    `${preexistingCanonicalSlots}\n\n2. new`,
    { strictOrderedNumbers: true, strictNesting: true }
  ),
  false,
  'slot transition proof must reject a different ordered number'
)
assert.equal(
  areMarkdownListSlotTransitionsEquivalent(
    preexistingSourceSlots,
    `${preexistingSourceSlots}\n\n- parent\n  1. new`,
    preexistingCanonicalSlots,
    `${preexistingCanonicalSlots}\n\n1. new`,
    { strictOrderedNumbers: true, strictNesting: true }
  ),
  false,
  'slot transition proof must reject a different nesting structure'
)
assert.equal(
  areMarkdownListSlotTransitionsEquivalent(
    `${preexistingSourceSlots}\n\n1. saved`,
    `${preexistingSourceSlots}\n\n4. `,
    `${preexistingCanonicalSlots}\n\n3. saved`,
    `${preexistingCanonicalSlots}\n\n4. <br />`,
    { strictOrderedNumbers: true, strictNesting: true }
  ),
  true,
  'trusted old ordered numbers may differ after serializer renumbering when the new empty slot number and structure match exactly'
)
assert.equal(
  areMarkdownListSlotTransitionsEquivalent(
    `${preexistingSourceSlots}\n\n1. saved`,
    `${preexistingSourceSlots}\n\n5. `,
    `${preexistingCanonicalSlots}\n\n3. saved`,
    `${preexistingCanonicalSlots}\n\n4. <br />`,
    { strictOrderedNumbers: true, strictNesting: true }
  ),
  false,
  'new ordered slot numbering remains strict even when the trusted old numbers differ'
)

console.log('PASS source structure fingerprint: list slots are fail-closed without normalizing marker spelling')
