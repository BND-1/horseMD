// A raw newline must never stay in a paragraph's text (it reads back as a
// line break, so the sync paused). editor-textblock-newlines.js turns one
// into a soft break. Fuzz seed 936: a selection from a paragraph's end into a
// code block deleted + Enter (delete and split in ONE transaction) joined the
// code text in just after the changed range, which the plugin did not scan.
import assert from 'node:assert/strict'
import { open, sleep } from './lib/probe-session.mjs'

const MOD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const SOURCE = 'alp\n\n```js\nconst a = 1\n- a list\n```\n\nh3\n'
const session = await open('textblock-newlines', SOURCE)
try {
  await sleep(800)
  const result = JSON.parse(await session.app.evaluate(`(() => {
    const H = globalThis.__hmSourceReprintHarness
    const view = H.view()
    const doc = view.state.doc
    let paraEnd = null, codeStart = null
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph' && node.textContent === 'alp') paraEnd = offset + 1 + node.content.size
      if (node.type.name === 'code_block' && codeStart == null) codeStart = offset + 1
    })
    const tr = view.state.tr.delete(paraEnd, codeStart)
    tr.split(paraEnd)
    view.dispatch(tr)
    const after = view.state.doc
    const raw = []
    after.descendants((node, pos, parent) => { if (node.isText && parent.isTextblock && !parent.type.spec.code && node.text.includes('\\n')) raw.push(node.text) })
    const blocks = []
    after.forEach((node) => blocks.push({ type: node.type.name, text: node.textContent, breaks: (() => { let n = 0; node.descendants((c) => { if (c.type.name === 'hardbreak') n += 1 }); return n })() }))
    const markdown = H.serialize(after)
    return JSON.stringify({ raw, blocks, markdown, roundTrip: H.equivalent(markdown, after) })
  })()`))
  assert.deepEqual(result.raw, [], `raw newline left in a paragraph: ${JSON.stringify(result.raw)}`)
  const joined = result.blocks.find((block) => block.text.includes('const a = 1'))
  assert.equal(joined?.type, 'paragraph', JSON.stringify(result.blocks))
  assert.equal(joined.breaks, 1, `the newline should be one soft break: ${JSON.stringify(result.blocks)}`)
  assert.equal(result.roundTrip, true, `serialization does not read back: ${JSON.stringify(result.markdown)}`)
} finally {
  await session.close()
}

// A code block turned into a paragraph / heading drops its blank-only first
// and last lines: Markdown has no paragraph that starts or ends with a line
// break, so the editor showed lines the file never got and reopening dropped
// them — and the next line's indent with them. Real shortcuts, then the live
// block must be what the saved source reads back as.
// Heading ids have no Markdown (Milkdown derives them).
const noIds = `.replace(/"id":"[^"]*",?/g, '')`
const live = (s) => s.app.evaluate(`JSON.stringify(globalThis.__hmSourceReprintHarness.liveDoc().toJSON().content[1])${noIds}`)
const reread = (s, source) => s.app.evaluate(`JSON.stringify(globalThis.__hmSourceReprintHarness.parse(${JSON.stringify(source)}).toJSON().content[1])${noIds}`)
const CONVERSIONS = [
  ['leading blank line', '```\n   \nabc\n```', 'abc', { key: '0', code: 'Digit0', modifiers: MOD }, 'x\n\nabc\n\ny\n'],
  ['trailing blank line', '```\nabc\n   \n```', 'abc', { key: '0', code: 'Digit0', modifiers: MOD }, 'x\n\nabc\n\ny\n'],
  ['blank lines both ends, tab', '```\n  \n\t\nabc\n\n  \n```', 'abc', { key: '0', code: 'Digit0', modifiers: MOD }, 'x\n\nabc\n\ny\n'],
  ['empty first line, a line between kept', '```\n\na\n\nb\n```', 'a', { key: '0', code: 'Digit0', modifiers: MOD }, null],
  ['indent after a blank first line', '```\n   \n    }\n```', '}', { key: '0', code: 'Digit0', modifiers: MOD }, 'x\n\n\u200B    }\n\ny\n'],
  // Milkdown's heading commands are setBlockType too; their shortcuts do
  // not reach the editor from inside CodeMirror, so the command is run.
  ['to a heading', '```\n  \nabc\n  \n```', 'abc', 'heading', 'x\n\n# abc\n\ny\n']
]
for (const [name, code, click, shortcut, expected] of CONVERSIONS) {
  const s = await open('textblock-edges', `x\n\n${code}\n\ny\n`)
  try {
    await sleep(600)
    await s.clickText(click, 1)
    if (shortcut === 'heading') {
      await s.app.evaluate(`(() => { const view = globalThis.__hmSourceReprintHarness.view(); const { state } = view
        let at = null; state.doc.forEach((node, offset) => { if (node.type.name === 'code_block' && at == null) at = offset })
        view.dispatch(state.tr.setBlockType(at, at + 1, state.schema.nodes.heading, { level: 1 })) })()`)
    } else await s.key(shortcut.key, shortcut)
    await sleep(900)
    const block = JSON.parse(await live(s))
    assert.notEqual(block.type, 'code_block', `${name}: not converted`)
    const source = await s.source()
    if (expected) assert.equal(source, expected, `${name}: source`)
    assert.equal(await live(s), await reread(s, source), `${name}: the editor shows what the file does not hold: ${await live(s)}`)
    assert.equal(await s.paused(), false, `${name}: warning`)
    if (name === 'leading blank line') {
      // Undo brings the code block back whole, blank lines included.
      await s.clickText('abc', 1)
      await s.key('z', { code: 'KeyZ', modifiers: MOD })
      await sleep(900)
      assert.equal(await s.source(), `x\n\n${code}\n\ny\n`, 'undo')
    }
  } finally {
    await s.close()
  }
}

// Only converted blocks are trimmed: Shift+Enter at a paragraph's end keeps
// its line while the user goes on typing on it.
{
  const s = await open('textblock-typing', 'x\n\nabc\n\ny\n')
  try {
    await sleep(600)
    await s.clickText('abc', 3)
    await s.key('Enter', { code: 'Enter', modifiers: SHIFT })
    await sleep(400)
    assert.equal(JSON.parse(await live(s)).content.at(-1)?.type, 'hardbreak', 'typed break kept')
    await s.type('d')
    await sleep(900)
    const source = await s.source()
    assert.equal(await live(s), await reread(s, source), `typing after Shift+Enter: ${source}`)
    assert.equal(await s.paused(), false, 'typing after Shift+Enter: warning')
  } finally {
    await s.close()
  }
}
console.log('PASS textblock newlines: code text joined into a paragraph by delete + split in one transaction gets soft breaks and reads back; code blocks turned into a paragraph / heading lose their blank first / last lines (the editor shows what the file holds, indents kept, undo restores the block); a typed Shift+Enter is not trimmed')
