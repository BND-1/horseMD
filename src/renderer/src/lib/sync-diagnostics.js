// Diagnostic report for「检测到富文本与源码不一致」and the save-time recovery
// prompt. Users hit these without --horsemd-input-trace, so there was nothing
// to send us. At the failure the editor keeps the stale source + the live
// document (immutable references) and the last input events; the report is
// built only when the user opens it: the top-level blocks that differ, as the
// source has them and as the editor would write them, plus what was typed.
// The user sees (and can edit) the text before copying or opening GitHub.

export const SYNC_REPORT_EVENT = 'hm:sync-report'
export const ISSUE_NEW_URL = 'https://github.com/BND-1/horseMD/issues/new'
// The author's WeChat (public: guide/community.md).
export const AUTHOR_WECHAT = 'alwaysraiseuplikesun'
// GitHub answers 414 / truncates far before browsers do; stay well under.
export const MAX_ISSUE_URL = 7000
const MAX_SNIPPET = 4000
const MAX_DATA = 24

/** Ring buffer of recent input events (no timers, no DOM). */
export function createSyncEventLog(limit = 40) {
  const items = []
  let first = null
  return {
    push(entry, now = Date.now()) {
      if (first == null) first = now
      items.push({ ms: now - first, ...entry })
      if (items.length > limit) items.shift()
    },
    entries: () => items.map((item) => ({ ...item })),
    get size() { return items.length }
  }
}

const shortData = (data) => {
  if (typeof data !== 'string' || !data) return ''
  const text = data.length > MAX_DATA ? `${data.slice(0, MAX_DATA)}…(${data.length})` : data
  return JSON.stringify(text)
}

/** One event → one short line ("+120ms keydown Tab @ list_item>paragraph"). */
export function formatSyncEvent(event) {
  const parts = [`+${event.ms}ms`, event.type]
  if (event.key) parts.push(event.key)
  if (event.inputType) parts.push(event.inputType)
  if (event.data) parts.push(shortData(event.data))
  if (event.length != null) parts.push(`len=${event.length}`)
  if (event.mime) parts.push(event.mime)
  if (event.block) parts.push(`@ ${event.block}`)
  return parts.join(' ')
}

/** Line-ending / BOM summary of the source the editor started from. */
export function describeSource(source) {
  const text = String(source ?? '')
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length - crlf
  const eol = crlf && lf ? `mixed (CRLF ${crlf}, LF ${lf})` : crlf ? 'CRLF' : 'LF'
  const lines = text ? text.split('\n').length : 0
  return `${text.length} chars, ${lines} lines, ${eol}${text.charCodeAt(0) === 0xfeff ? ', BOM' : ''}`
}

// Heading ids are added by a plugin after parsing, so a freshly parsed
// document lacks them: compare blocks without ids.
const blockKey = (node) => JSON.stringify(node.toJSON(), (key, value) => (key === 'id' ? undefined : value))

/**
 * Top-level block range that differs between the parsed source and the live
 * document, widened by `context` blocks each side. Returns null when no block
 * differs (the two documents are equivalent).
 */
export function diffTopLevel(sourceDoc, editorDoc, context = 1) {
  const a = []
  const b = []
  sourceDoc.forEach((node) => a.push(blockKey(node)))
  editorDoc.forEach((node) => b.push(blockKey(node)))
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  if (start === a.length && start === b.length) return null
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1 }
  const from = Math.max(0, start - context)
  return {
    source: { from, to: Math.min(a.length - 1, Math.max(endA, start - 1) + context) },
    editor: { from, to: Math.min(b.length - 1, Math.max(endB, start - 1) + context) }
  }
}

const childStart = (doc, index) => {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize
  return pos
}

const clip = (text) => (text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}\n…（已截断，共 ${text.length} 字符）` : text)

/**
 * The differing region in both forms. `mapOffset(pmPos)` maps a position in
 * `sourceDoc` to a raw offset in `source` (editor-source-map); `serialize(doc)`
 * is the editor's serializer. Never throws.
 */
export function changedRegion({ source, sourceDoc, editorDoc, mapOffset, serialize, context = 1 }) {
  try {
    const range = diffTopLevel(sourceDoc, editorDoc, context)
    if (!range) return { same: true }
    const slice = (doc, { from, to }) => {
      const nodes = []
      for (let i = from; i <= to && i < doc.childCount; i += 1) nodes.push(doc.child(i))
      return doc.type.create(doc.attrs, nodes)
    }
    let before = null
    let beforeRaw = false
    if (sourceDoc.childCount && mapOffset) {
      const start = mapOffset(childStart(sourceDoc, range.source.from) + 1)
      const end = range.source.to + 1 < sourceDoc.childCount
        ? mapOffset(childStart(sourceDoc, range.source.to + 1) + 1)
        : String(source).length
      if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
        // A mapped offset can land inside a block's prefix ("- ", "> ");
        // start at its line.
        const lineStart = String(source).lastIndexOf('\n', start - 1) + 1
        before = String(source).slice(lineStart, end).replace(/(\r?\n)+$/, '')
        beforeRaw = true
      }
    }
    if (before == null && sourceDoc.childCount) before = serialize(slice(sourceDoc, range.source)).replace(/\n+$/, '')
    const after = editorDoc.childCount ? serialize(slice(editorDoc, range.editor)).replace(/\n+$/, '') : ''
    return {
      same: false,
      before: clip(before ?? ''),
      beforeRaw,
      after: clip(after),
      blocks: {
        source: `${range.source.from + 1}–${range.source.to + 1} / ${sourceDoc.childCount}`,
        editor: `${range.editor.from + 1}–${range.editor.to + 1} / ${editorDoc.childCount}`
      }
    }
  } catch (error) {
    return { error: error?.message || String(error) }
  }
}

/** A fence longer than any backtick run inside the text. */
export function fenceFor(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

const block = (text, lang = 'markdown') => {
  const fence = fenceFor(text)
  // Make line endings and tabs visible: they often decide these bugs.
  const shown = String(text).replace(/\r\n/g, '␍\n').replace(/\t/g, '→\t')
  return `${fence}${lang}\n${shown}\n${fence}`
}

/** The report text (Markdown, pasted into a GitHub issue as is). */
export function buildSyncReport({ version, platform, userAgent, where, reason, at, source, region, events = [] }) {
  const lines = [
    '### HorseMD 同步诊断',
    '',
    `- 版本：${version || '?'}`,
    `- 系统：${platform || '?'}${userAgent ? `（${userAgent}）` : ''}`,
    `- 时间：${at || ''}`,
    `- 出现位置：${where || 'edit'}`,
    `- 原因：\`${reason || 'unknown'}\``,
    `- 文档：${describeSource(source)}`
  ]
  if (region?.error) {
    lines.push('', `改动定位失败：${region.error}`)
  } else if (region?.same) {
    lines.push('', '编辑器里的文档和源码解析出的结构一致（差别只在源码字节层面）。')
  } else if (region) {
    lines.push(
      '',
      `#### 改动前（源码${region.beforeRaw ? '原文' : '，重新生成'}，第 ${region.blocks.source} 块）`,
      block(region.before),
      '',
      `#### 改动后（编辑器里的样子，第 ${region.blocks.editor} 块）`,
      block(region.after)
    )
  }
  lines.push('', `#### 最近的操作（${events.length} 条）`, block(events.map(formatSyncEvent).join('\n') || '（无）', 'text'))
  lines.push('', '> ␍ 表示 CRLF 换行，→ 表示 Tab。')
  return lines.join('\n')
}

/**
 * New-issue URL with the bug form prefilled. When the report does not fit the
 * URL, the logs field asks the user to paste it (the caller copies it first).
 */
export function issueUrl({ report, version, os, title, pastePrompt }) {
  const params = (logs) => {
    const query = new URLSearchParams({ template: 'bug_report.yml', title: title || '', version: version || '' })
    if (os) query.set('os', os)
    query.set('logs', logs)
    return `${ISSUE_NEW_URL}?${query.toString()}`
  }
  const full = params(report)
  if (full.length <= MAX_ISSUE_URL) return { url: full, includesReport: true }
  return { url: params(pastePrompt || ''), includesReport: false }
}

/** win32 / darwin / linux → the bug form's dropdown option. */
export const osLabel = (platform) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[platform] || ''

/**
 * Toast action that opens the report dialog. `build()` makes the report text
 * (lazily: the diff work runs only when the user asks for it); `hint` is the
 * line under the message asking the user to send it to us.
 */
export function syncReportAction(build, label, hint) {
  if (typeof build !== 'function') return undefined
  return {
    label,
    hint,
    run: () => window.dispatchEvent(new CustomEvent(SYNC_REPORT_EVENT, { detail: { build } }))
  }
}
