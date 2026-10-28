// Sync diagnostic report (src/renderer/src/lib/sync-diagnostics.js), pure
// part: the changed top-level region (heading ids ignored), the raw source
// slice, the report text (CRLF / tabs visible, fences longer than the
// content's backticks), the event log cap, and the GitHub issue URL limit.
import assert from 'node:assert/strict'
import { Schema } from 'prosemirror-model'
import {
  MAX_ISSUE_URL, buildSyncReport, changedRegion, createSyncEventLog, describeSource, diffTopLevel,
  fenceFor, formatSyncEvent, issueUrl, osLabel
} from '../src/renderer/src/lib/sync-diagnostics.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    heading: { group: 'block', content: 'text*', attrs: { id: { default: '' }, level: { default: 1 } } },
    text: {}
  }
})
const p = (text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const h = (text, id = '') => schema.node('heading', { id, level: 1 }, [schema.text(text)])
const doc = (...blocks) => schema.node('doc', null, blocks)
// Serializer stand-in: one line per block.
const serialize = (d) => { const out = []; d.forEach((n) => out.push((n.type.name === 'heading' ? '# ' : '') + n.textContent)); return out.join('\n\n') + '\n' }

// 1. Diff: identical → null; heading ids ignored; a changed middle block with
// one block of context each side; an insertion.
const a = doc(h('标题'), p('一'), p('二'), p('三'), p('四'))
assert.equal(diffTopLevel(a, doc(h('标题', 'x-id'), p('一'), p('二'), p('三'), p('四'))), null, 'heading ids are not a difference')
assert.deepEqual(diffTopLevel(a, doc(h('标题'), p('一'), p('二改'), p('三'), p('四'))), { source: { from: 1, to: 3 }, editor: { from: 1, to: 3 } })
assert.deepEqual(diffTopLevel(a, doc(h('标题'), p('一'), p('新'), p('二'), p('三'), p('四'))), { source: { from: 1, to: 2 }, editor: { from: 1, to: 3 } })

// 2. Region: the raw source slice comes from the mapper (CRLF kept), the
// editor side from the serializer.
const source = '# 标题\r\n\r\n一\r\n\r\n二\r\n\r\n三\r\n\r\n四\r\n'
const starts = [0, 8, 13, 18, 23] // raw offset of each block
const mapOffset = (pos) => { let at = 0; for (let i = 0; i < a.childCount; i += 1) { if (pos <= at + a.child(i).nodeSize) return starts[i]; at += a.child(i).nodeSize } return null }
const region = changedRegion({ source, sourceDoc: a, editorDoc: doc(h('标题'), p('一'), p('二改'), p('三'), p('四')), mapOffset, serialize })
assert.equal(region.before, '一\r\n\r\n二\r\n\r\n三')
assert.equal(region.beforeRaw, true)
assert.equal(region.after, '一\n\n二改\n\n三')
assert.deepEqual(region.blocks, { source: '2–4 / 5', editor: '2–4 / 5' })
assert.deepEqual(changedRegion({ source, sourceDoc: a, editorDoc: a, mapOffset, serialize }), { same: true })
// Mapper failure → regenerated source; a throwing serializer → error, no throw.
const fallback = changedRegion({ source, sourceDoc: a, editorDoc: doc(h('标题'), p('改')), mapOffset: () => null, serialize })
assert.equal(fallback.beforeRaw, false)
assert.match(fallback.before, /一/)
assert.ok(changedRegion({ source, sourceDoc: a, editorDoc: doc(p('x')), mapOffset, serialize: () => { throw new Error('boom') } }).error === 'boom')

// 3. Report: header fields, visible CRLF / tabs, safe fences, events.
assert.equal(fenceFor('a ```` b'), '`````')
assert.equal(fenceFor('plain'), '```')
assert.equal(describeSource('﻿a\r\nb\nc'), '7 chars, 3 lines, mixed (CRLF 1, LF 1), BOM')
const log = createSyncEventLog(3)
for (let i = 0; i < 5; i += 1) log.push({ type: 'key', key: `K${i}`, block: 'paragraph' }, 1000 + i * 10)
assert.deepEqual(log.entries().map((e) => e.key), ['K2', 'K3', 'K4'], 'the log keeps the last N')
assert.equal(formatSyncEvent({ ms: 20, type: 'input', inputType: 'insertText', data: 'x'.repeat(30), block: 'list_item>paragraph' }),
  `+20ms input insertText "${'x'.repeat(24)}…(30)" @ list_item>paragraph`)
const report = buildSyncReport({ version: '0.13.259', platform: 'win32', userAgent: 'UA', where: 'save', reason: 'unmapped-source-change', at: 'T', source, region: { ...region, before: 'a\tb\r\nc ```' }, events: log.entries() })
assert.match(report, /- 版本：0\.13\.259/)
assert.match(report, /- 系统：win32（UA）/)
assert.match(report, /- 原因：`unmapped-source-change`/)
assert.match(report, /- 文档：.*CRLF/)
assert.ok(report.includes('````markdown\na→\tb␍\nc ```\n````'), 'CRLF and tab visible, fence longer than the content')
assert.ok(report.includes('+40ms key K4 @ paragraph'))
assert.match(buildSyncReport({ source: '', region: { same: true } }), /结构一致/)
assert.match(buildSyncReport({ source: '', region: { error: 'x' } }), /改动定位失败：x/)

// 4. Issue URL: prefilled form; a long report is left out (pasted instead).
const short = issueUrl({ report: '短报告', version: '0.13.259', os: osLabel('win32'), title: '不一致', pastePrompt: '请粘贴' })
assert.equal(short.includesReport, true)
const url = new URL(short.url)
assert.equal(url.origin + url.pathname, 'https://github.com/BND-1/horseMD/issues/new')
assert.deepEqual(Object.fromEntries(url.searchParams), { template: 'bug_report.yml', title: '不一致', version: '0.13.259', os: 'Windows', logs: '短报告' })
const long = issueUrl({ report: '长'.repeat(5000), version: '1', os: 'macOS', title: 't', pastePrompt: '请粘贴' })
assert.equal(long.includesReport, false)
assert.ok(long.url.length <= MAX_ISSUE_URL)
assert.equal(new URL(long.url).searchParams.get('logs'), '请粘贴')
assert.equal(osLabel('darwin'), 'macOS')
assert.equal(osLabel('android'), '')

console.log('PASS sync diagnostics: changed top-level region (heading ids ignored, raw CRLF slice, regenerated fallback, errors caught), report text (visible CRLF/tabs, safe fences, capped event log), prefilled GitHub issue URL within the length limit')
