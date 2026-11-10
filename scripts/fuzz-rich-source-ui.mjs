// Seeded random rich/source editing fuzzer (real Electron, background CDP).
//
// Drives human-like edits — clicks, per-character typing, IME composition,
// Enter/Backspace/Delete/Tab, word selection, undo/redo, bold, source-mode
// round trips with source edits — over a realistic mixed document, and checks
// two independent properties at every checkpoint:
//
//   1. PAUSE  — the app raised a rich/source mismatch or save-paused toast.
//               (fail-closed: safe, but it blocks the user; each one is a bug
//               candidate in a mapping owner).
//   2. CORRUPT — after Save, the file reopened cold in a fresh profile does not
//               parse to the same ProseMirror document the user was looking at.
//               This is the P0: wrong source was written to disk.
//
// Usage:
//   FUZZ_SEEDS=1,2,3 FUZZ_OPS=150 node scripts/fuzz-rich-source-ui.mjs
//   FUZZ_FIXTURE=path/to/doc.md  (default: built-in mixed CJK/English document)
//   FUZZ_FORMAT=1 also format ranges and blocks by shortcut: Shift+arrow
//                 selections, italic / strike / inline code / highlight,
//                 heading levels, paragraph, quote, bullet / ordered list
//                 (opt-in: it changes every seed's ops; the nightly run sets it)
//   FUZZ_UI=1     also use the editor's own UI (2026-11-04): the slash menu
//                 on a new line (`/h2`, `/table`, `/java`…), dragging a block
//                 by its handle onto another block, the table row / column
//                 handle menus (opt-in, like FORMAT)
//   FUZZ_PASTE=1  also paste Markdown / plain text (code blocks, lists, tables,
//                 quotes, math, multi-line text; LF or CRLF) like a user's
//                 Ctrl+V (#171). Opt-in: adding ops changes what every seed
//                 does, and the docs name seeds of the default op set.
// Results: $FUZZ_OUT (default /tmp/horsemd-fuzz/<run>) — one JSON per seed with
// the op log, toasts, checkpoint verdicts, and trace tails for the first failure.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const seeds = String(process.env.FUZZ_SEEDS || '1').split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
const opsPerSeed = Number(process.env.FUZZ_OPS || 150)
const checkpointEvery = Number(process.env.FUZZ_CHECKPOINT || 30)
const basePort = Number(process.env.FUZZ_PORT || 9930)
const outRoot = process.env.FUZZ_OUT || `/tmp/horsemd-fuzz/run-${Date.now()}`
const MOD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const DEFAULT_FIXTURE = [
  '# 产品周报 Weekly',
  '',
  '这是一段普通的中文段落，包含 **粗体**、*斜体*、`inline code` 和 [链接](https://example.com)。',
  'Second line of the same paragraph with a soft break.',
  '',
  '## 待办 Todo',
  '',
  '- 第一项 first',
  '- 第二项 second',
  '  - 嵌套 nested A',
  '  - 嵌套 nested B',
  '- 第三项 third',
  '',
  '1. 步骤一 step one',
  '2. 步骤二 step two',
  '3. 步骤三 step three',
  '',
  '- [ ] 未完成任务 open task',
  '- [x] 已完成任务 done task',
  '',
  '> 引用段落 quoted paragraph',
  '> 第二行 second quoted line',
  '',
  '```js',
  'const answer = 42',
  'console.log(answer)',
  '```',
  '',
  '| 名称 Name | 数量 Qty |',
  '| --- | ---: |',
  '| 苹果 apple | 3 |',
  '| 香蕉 banana | 5 |',
  '',
  '---',
  '',
  '最后一段 final paragraph.',
  ''
].join('\n')

// Mulberry32 — small, deterministic PRNG.
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['alpha', 'beta', 'gamma', 'test', 'note', 'x', 'ok', 'HorseMD', '42', 'a b']
const CJK = ['中文', '测试', '段落', '编辑器', '保存', '你好', '列表', '标题']
const MD_SYMBOLS = ['*', '**', '`', '#', '- ', '> ', '1. ', '[', ']', '(', ')', '_', '~', '\\', '|', '==', '$']

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)]
}

function weighted(rand, table) {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = rand() * total
  for (const [name, weight] of table) {
    roll -= weight
    if (roll <= 0) return name
  }
  return table[table.length - 1][0]
}

const OPS = [
  ['click', 14],
  ['typeWord', 16],
  ['typeCjkIme', 8],
  ['typeSymbol', 5],
  ['enter', 10],
  ['backspace', 10],
  ['delete', 3],
  ['tab', 3],
  ['shiftTab', 2],
  ['arrow', 6],
  ['selectWordAndType', 4],
  ['selectAndDelete', 3],
  ['undo', 3],
  ['redo', 1],
  ['bold', 2],
  ['sourceRoundTrip', 3],
  ['sourceEdit', 2],
  ['save', 3]
]

// #171: pastes were never fuzzed. Each snippet is something a user copies
// from another Markdown file, an IDE or a chat; text/plain only (what other
// apps put on the clipboard), sometimes with Windows line endings.
const PASTE_OPS = [['paste', 6]]
// Formatting by shortcut over ranges (mark combinations, block conversions):
// the editor's own keymaps, as a user presses them.
const FORMAT_OPS = [
  ['shiftSelect', 6],
  ['italic', 2],
  ['strike', 2],
  ['inlineCode', 2],
  ['highlight', 2],
  ['heading', 1],
  ['paragraphBlock', 1],
  ['quote', 1],
  ['bulletList', 1],
  ['orderedList', 1]
]
// The editor's own UI: slash menu, block drag, table handles.
const UI_OPS = [
  ['slash', 3],
  ['dragBlock', 2],
  ['tableHandle', 2]
]
const SLASH_QUERIES = ['h1', 'h2', 'h3', 'quote', 'code', 'table', 'hr', 'todo', 'ul', 'ol', 'math', 'mermaid', 'java', '标题', '引用', '列表']
const ALT = 1
const FORMAT_KEYS = {
  italic: { key: 'i', code: 'KeyI', modifiers: MOD },
  strike: { key: 'x', code: 'KeyX', modifiers: MOD | ALT },
  inlineCode: { key: 'e', code: 'KeyE', modifiers: MOD },
  highlight: { key: 'h', code: 'KeyH', modifiers: MOD | ALT },
  paragraphBlock: { key: '0', code: 'Digit0', modifiers: MOD },
  quote: { key: 'b', code: 'KeyB', modifiers: MOD | SHIFT },
  bulletList: { key: '8', code: 'Digit8', modifiers: MOD | ALT },
  orderedList: { key: '7', code: 'Digit7', modifiers: MOD | ALT }
}
const PASTE_SNIPPETS = [
  '```\nclass Wrapper implements Target {\n    private final Something inner;   // 持有对象\n\n    public void doIt() {\n        inner.doIt();\n    }\n}\n\n```\n',
  '```js\nconst a = 1\n- not a list\n```',
  '- 粘贴项 one\n- 粘贴项 two\n',
  '- 单独一项 single item',
  '1. 第一 first\n2. 第二 second\n',
  '## 粘贴的标题 pasted heading\n\n正文 body text.\n',
  '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  '> 引用 quote line\n> 第二行\n',
  '$$\nE = mc^2 \\\\\nx\n$$\n',
  '段落一 first paragraph\n\n```\ncode line\n```\n\n段落二 second\n',
  '纯文本第一行 plain line one\n纯文本第二行 plain line two\n\n第三行 three',
  'just one plain line'
]
const visiblePm = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

// Live document + committed source at the first pause (engine triage).
// Debug (FUZZ_WATCH_NEWLINE=1): record the first transaction after which a
// non-code text block holds a raw newline (editor-textblock-newlines.js
// should never let one through). Read back as atFailure.newlineWatch.
async function installNewlineWatch(app) {
  await app.evaluate(`(() => {
    const H = globalThis.__hmSourceReprintHarness
    const view = H?.view?.()
    if (!view) return
    const raw = (doc) => { let hit = null; doc.descendants((node, pos, parent) => { if (hit) return false; if (node.isText && parent?.isTextblock && !parent.type.spec.code && node.text.includes('\\n')) hit = { pos, parent: parent.type.name, text: node.text.slice(0, 80) }; return !hit }); return hit }
    const { Plugin } = Object.getPrototypeOf(view.state.plugins[0]).constructor ? { Plugin: view.state.plugins[0].constructor } : {}
    const watch = new Plugin({ appendTransaction(trs, oldState, state) {
      if (globalThis.__hmNewlineWatch || raw(oldState.doc)) return null
      const hit = raw(state.doc)
      if (hit) globalThis.__hmNewlineWatch = { hit, trs: trs.map((tr) => ({ meta: Object.keys(tr.meta || {}), steps: tr.steps.map((step) => step.toJSON()) })) }
      return null
    } })
    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, watch] }))
  })()`)
}

async function pauseSnapshot(app) {
  try {
    return JSON.parse(await app.evaluate(`JSON.stringify({
      liveDoc: (${visiblePm})?.pmViewDesc?.node?.toJSON() ?? null,
      liveSource: globalThis.__hmSourceReprintHarness?.liveSource?.() ?? null,
      atFailure: globalThis.__hmLastSyncFailure ?? null,
      newlineWatch: globalThis.__hmNewlineWatch ?? null
    })`))
  } catch {
    return {}
  }
}

async function docJson(app) {
  return app.evaluate(`(() => {
    const pm = ${visiblePm}
    const node = pm?.pmViewDesc?.node
    return node ? JSON.stringify(node.toJSON()) : null
  })()`)
}

// Attributes that are editor-only or derived and must not count as content.
function normalizeDoc(json) {
  const doc = JSON.parse(json)
  const walk = (node, inTableCell = false) => {
    if (!node || typeof node !== 'object') return node
    // Marks on a line break have no visible meaning (validator ignores them).
    if ((node.type === 'hardbreak' || node.type === 'hard_break') && node.marks) delete node.marks
    // A GFM autolink literal (`https://a.com`, `www.a.com`, `a@b.cn`) is
    // text while typed and a link once read — the projection's guard treats
    // it the same (lib/source-sync/projection.js isAutolinkLiteral; Typora
    // links a typed URL on reopen too). Windows fuzz seed 5469.
    if (node.type === 'text' && Array.isArray(node.marks)) {
      const value = String(node.text || '')
      const literal = (href) => (/^https?:\/\/\S+$/i.test(value) && href === value) ||
        (/^www\.\S+$/i.test(value) && href === `http://${value}`) ||
        (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && href === `mailto:${value}`)
      node.marks = node.marks.filter((mark) => !(mark?.type === 'link' && literal(mark.attrs?.href)))
      if (!node.marks.length) delete node.marks
    }
    // `*` vs `_` (strong / emphasis `marker`) is spelling (validator too).
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.map((mark) => {
        if (mark?.attrs?.marker == null) return mark
        const { marker: _marker, ...attrs } = mark.attrs
        return Object.keys(attrs).length ? { ...mark, attrs } : { type: mark.type }
      })
    }
    if (node.attrs) {
      const attrs = { ...node.attrs }
      delete attrs.id
      delete attrs.spread // tight/loose is reported separately as a soft diff
      if (node.type === 'list_item') delete attrs.label // renumbered labels are derived
      if (node.type === 'table' || node.type === 'table_cell' || node.type === 'table_header') {
        delete attrs.colwidth
      }
      node.attrs = attrs
    }
    if (Array.isArray(node.content)) {
      const cell = node.type === 'table_cell' || node.type === 'table_header'
      node.content = node.content.map((child) => walk(child, cell))
      // Whitespace at the end of a textblock has no Markdown encoding (it is
      // stripped; two spaces would even mean a hard break), so compare
      // textblocks without it. Interior whitespace stays strict.
      // Likewise a space at the start of a textblock or right after a line
      // break (start of a wrapped line).
      // Blanks compare without the marks that show nothing on them, wherever
      // they sit (edges of a run, between two runs, inside one) — the
      // validator's semanticJson and the source reprint do the same, and the
      // serializer writes edge blanks outside the delimiters (`** x**` is not
      // emphasis). Inline code keeps its blanks (content).
      // Strike / highlight / sub / sup since 2026-11-04 (lib/inline-serializer.js).
      const INVISIBLE_ON_BLANK = new Set(['strong', 'emphasis', 'link', 'html_span', 'strike_through', 'highlight', 'subscript', 'superscript'])
      const merge = (list) => list.reduce((runs, child) => {
        const previous = runs[runs.length - 1]
        if (previous?.type === 'text' && child.type === 'text' && JSON.stringify(previous.marks || null) === JSON.stringify(child.marks || null)) {
          previous.text += child.text
        } else runs.push(child)
        return runs
      }, [])
      node.content = merge(node.content.flatMap((child) => {
        if (child?.type !== 'text' || !(child.marks || []).length || child.marks.some((mark) => mark.type === 'inlineCode')) return [child]
        return child.text.split(/([ \t]+)/).filter(Boolean).map((piece) => {
          if (!/^[ \t]+$/.test(piece)) return { ...child, text: piece }
          const marks = child.marks.filter((mark) => !INVISIBLE_ON_BLANK.has(mark.type))
          return marks.length ? { type: 'text', text: piece, marks } : { type: 'text', text: piece }
        })
      }))
      // Whitespace at the start / end of a textblock or around a line break
      // has no Markdown encoding (stripped; two spaces would be a hard break).
      // Interior whitespace stays strict.
      const isBreak = (child) => child?.type === 'hardbreak' || child?.type === 'hard_break'
      node.content.forEach((child, index) => {
        if (child.type !== 'text' || (child.marks || []).some((mark) => mark.type === 'inlineCode')) return
        if (index === 0 || isBreak(node.content[index - 1])) child.text = child.text.replace(/^[ \t]+/, '')
        if (isBreak(node.content[index + 1])) child.text = child.text.replace(/[ \t]+$/, '')
      })
      node.content = merge(node.content.filter((child) => !(child.type === 'text' && child.text === '')))
      // (Again: a leading blank run that was removed exposes the next one.)
      if (node.content[0]?.type === 'text' && !(node.content[0].marks || []).some((mark) => mark.type === 'inlineCode')) {
        node.content[0].text = node.content[0].text.replace(/^[ \t]+/, '')
        if (!node.content[0].text) node.content.shift()
      }
      // A soft break at the very start or end of a text block has no encoding.
      // (A hard break there has none either — table cells excepted: a cell's
      // paragraph is normalized by its own rule below.)
      const softBreak = (child) => child?.type === 'hardbreak' && (child?.attrs?.isInline === true || !inTableCell)
      // A text block holding nothing but such breaks is an empty block (Typora
      // too: `>` + Shift+Enter saves an empty quote; fuzz seed 612).
      while (node.content.length && softBreak(node.content.at(-1))) node.content.pop()
      while (node.content.length && softBreak(node.content[0])) node.content.shift()
      // Trailing blanks of plain text only: once a blank-only run is gone,
      // inline code may end the block, and its blanks are content (fuzz seed
      // 880 on Windows: `1. ` + four spaces compared as `1.`).
      const plain = (child) => child?.type === 'text' && !(child.marks || []).some((mark) => mark.type === 'inlineCode')
      while (plain(node.content.at(-1)) && /[ \t]+$/.test(node.content.at(-1).text)) {
        node.content.at(-1).text = node.content.at(-1).text.replace(/[ \t]+$/, '')
        if (node.content.at(-1).text) break
        node.content.pop()
      }
      // An authored row with fewer cells than the widest row stays irregular
      // in source (author bytes win); the live editor pads it (prosemirror-
      // tables) while a cold reopen may not have yet. Same rectangle, same
      // rendering — pad both sides like the validator's semanticJson does.
      if (node.type === 'table') {
        const width = Math.max(0, ...node.content.map((row) => row.content?.length || 0))
        for (const row of node.content) {
          const cells = row.content || []
          // An empty row is padded too (projection.js stripAttrs does the
          // same); a header row takes header cells.
          const cellType = cells[0]?.type || (row.type === 'table_header_row' ? 'table_header' : 'table_cell')
          for (let column = cells.length; column < width; column += 1) {
            const model = node.content.find((other) => other.content?.[column])?.content[column]
            cells.push({ type: cellType, attrs: { ...(model?.attrs || {}) }, content: [{ type: 'paragraph' }] })
          }
          row.content = cells
        }
      }
      // A text-less paragraph directly under doc/blockquote has no Markdown
      // encoding at most positions (it is a blank line); the design treats
      // it as an editor-only transient. Empty list items stay significant.
      // Inside a quote or list item, an empty paragraph next to real content
      // has no Markdown spelling either (source reprint design §5).
      if (node.type === 'list_item') {
        // Only empty paragraphs left (one of them blanks only, which have no
        // spelling): the item is empty, one empty paragraph (seed 269).
        const kept = node.content.filter((child) => !(child.type === 'paragraph' && !child.content?.length))
        node.content = kept.length ? kept : [{ type: 'paragraph' }]
      }
      if (node.type === 'doc' || node.type === 'blockquote' || node.type === 'list_item') {
        if (node.type !== 'list_item') node.content = node.content.filter((child) => !(child.type === 'paragraph' && !child.content?.length))
        // Adjacent lists of the same kind read back as one (CommonMark), and
        // the source keeps the markers the user wrote (Typora): `1.` typed
        // after a list stays `1.`, an untouched `- b` stays `-`.
        const mergedLists = []
        for (const child of node.content) {
          const previous = mergedLists.at(-1)
          if (previous && (child.type === 'bullet_list' || child.type === 'ordered_list') && previous.type === child.type) {
            previous.content = [...(previous.content || []), ...(child.content || [])]
            continue
          }
          mergedLists.push(child)
        }
        node.content = mergedLists
      }
      // A textblock whose only text was unencodable whitespace (`#     `)
      // reopens with no content at all: same empty block.
      if (!node.content.length && node.type !== 'doc') delete node.content
    }
    return node
  }
  return walk(doc)
}

function literalEmphasisOnly(live, reopened) {
  const strip = (node) => {
    if (!node || typeof node !== 'object') return node
    const next = { ...node }
    if (next.type === 'text') {
      next.text = String(next.text || '').replace(/[*_]/g, '')
      const marks = (next.marks || []).filter((mark) => mark.type !== 'strong' && mark.type !== 'emphasis')
      if (marks.length) next.marks = marks
      else delete next.marks
    }
    if (Array.isArray(next.content)) {
      next.content = next.content.map(strip).filter((child) => !(child.type === 'text' && !child.text))
        .reduce((runs, child) => {
          const previous = runs[runs.length - 1]
          if (previous?.type === 'text' && child.type === 'text' && JSON.stringify(previous.marks || null) === JSON.stringify(child.marks || null)) previous.text += child.text
          else runs.push(child)
          return runs
        }, [])
      if (!next.content.length && next.type !== 'doc') delete next.content
    }
    return next
  }
  if (firstDiff(strip(live), strip(reopened))) return false
  const blocks = (node, out = []) => {
    if (node?.type === 'paragraph' || node?.type === 'heading') {
      out.push((node.content || []).map((child) => child.text || '').join(''))
      return out
    }
    for (const child of node?.content || []) blocks(child, out)
    return out
  }
  const left = blocks(live)
  const right = blocks(reopened)
  if (left.length !== right.length) return false
  return left.every((authored, index) => {
    let at = 0
    for (const character of right[index]) {
      if (at < authored.length && character === authored[at]) at += 1
      else if (character !== '*' && character !== '_') return false
    }
    return at === authored.length
  })
}

function firstDiff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) {
    return { path, live: a, reopened: b }
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const diff = firstDiff(a[key], b[key], `${path}/${key}`)
    if (diff) return diff
  }
  return { path, live: a, reopened: b }
}

async function installToastRecorder(app) {
  await app.evaluate(`(() => {
    if (window.__fuzzToasts) return true
    window.__fuzzToasts = []
    window.alert = (message) => window.__fuzzToasts.push({ at: Date.now(), alert: String(message) })
    const seen = new WeakSet()
    const record = () => {
      for (const node of document.querySelectorAll('.hm-toast-msg')) {
        if (seen.has(node)) continue
        seen.add(node)
        window.__fuzzToasts.push({ at: Date.now(), msg: node.textContent })
      }
    }
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true })
    return true
  })()`)
}

const drainToasts = (app) => app.evaluate(`(() => { const out = window.__fuzzToasts || []; window.__fuzzToasts = []; return out })()`)
const isMismatchToast = (toast) => /不一致|无法安全|could not be mapped|not mapped safely|mismatch/i.test(toast.msg || '')

async function traceTails(app) {
  return app.evaluate(`(() => {
    const tail = (key, n) => Array.isArray(globalThis[key]) ? globalThis[key].slice(-n) : null
    const strip = (entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const out = {}
      for (const [key, value] of Object.entries(entry)) {
        if (value && typeof value === 'object' && (value.type === 'doc' || value.content)) continue
        out[key] = typeof value === 'string' && value.length > 1200 ? value.slice(0, 600) + ' … ' + value.slice(-600) : value
      }
      return out
    }
    return JSON.parse(JSON.stringify({
      integrity: (tail('__hmSourceIntegrityTrace', 6) || []).map(strip),
      diff: (tail('__hmSourceIntegrityDiffTrace', 4) || []).map(strip),
      coordinator: tail('__hmSourceSyncCoordinatorTrace', 8),
      reprint: tail('__hmSourceReprintTrace', 8),
      reprintNow: (() => {
        try {
          const h = globalThis.__hmSourceReprintHarness
          const mark = (globalThis.__hmSourceIntegrityDiffTrace || []).length
          const r = h.reprint(h.liveSource(), h.liveDoc())
          const diffs = (globalThis.__hmSourceIntegrityDiffTrace || []).slice(mark)
          return { ok: r.ok, reason: r.reason, notes: (r.notes || []).slice(0, 12), markdown: r.markdown, engineDiff: diffs.slice(-1)[0] || null }
        } catch (error) { return { error: String(error) } }
      })(),
      shadow: (globalThis.__hmSourceReprintShadowTrace || []).slice(-3).map((entry) => ({ phase: entry.phase, ok: entry.ok, reason: entry.reason, levels: entry.levels, engineDiff: entry.engineDiff, notes: entry.notes })),
      journal: (tail('__hmSourceSyncTransactionJournalTrace', 40) || []).map(strip),
      preserve: (tail('__hmPreserveLog', 6) || []).map(strip),
      flush: (tail('__hmFlushTrace', 10) || []).map(strip),
      owners: Object.fromEntries(Object.keys(globalThis)
        .filter((key) => /^__hm.*TransactionTrace$/.test(key) && Array.isArray(globalThis[key]) && globalThis[key].length)
        .map((key) => [key, globalThis[key].slice(key === '__hmTableTransactionTrace' ? -14 : -3).map(strip)]))
    }))
  })()`)
}

async function sourceToggle(app) {
  return app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return Boolean(button)
  })()`)
}

const sourceVisible = (app) => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`)

// The mode switch is asynchronous (~0.5 s on a mid-size doc). Wait for the
// requested surface instead of sleeping a fixed interval.
async function setSourceMode(app, wanted) {
  if ((await sourceVisible(app)) === wanted) return true
  await sourceToggle(app)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100)
    if ((await sourceVisible(app)) === wanted) {
      await sleep(150)
      return true
    }
  }
  return false
}

async function clickRandomText(app, rand) {
  const target = await app.evaluate(`((r1, r2) => {
    const pm = ${visiblePm}
    if (!pm) return null
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const el = node.parentElement
        if (!el) return NodeFilter.FILTER_REJECT
        // Skip widgets/chrome rendered inside the editor (block handles,
        // code-block toolbars, previews); CodeMirror content stays eligible.
        if (el.closest('.tools, .preview-panel, .milkdown-block-handle, .label-wrapper, .hm-inline-code-delimiter, button')) return NodeFilter.FILTER_REJECT
        const editable = el.closest('[contenteditable]')
        if (editable && editable.getAttribute('contenteditable') === 'false' && !el.closest('.cm-content')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    if (!nodes.length) return null
    const node = nodes[Math.floor(r1 * nodes.length)]
    const offset = Math.floor(r2 * (node.nodeValue.length + 1))
    node.parentElement.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.setStart(node, Math.min(offset, node.nodeValue.length))
    range.collapse(true)
    const rect = range.getClientRects()[0] || node.parentElement.getBoundingClientRect()
    if (!rect || rect.width === 0 && rect.height === 0) return null
    return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2), text: node.nodeValue.slice(0, 40), offset }
  })(${rand()}, ${rand()})`)
  if (!target) return null
  await sleep(60)
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(80)
  return target
}

async function typeChars(app, text, delay = 25) {
  for (const character of [...text]) {
    await app.send('Input.insertText', { text: character })
    await sleep(delay)
  }
}

async function typeIme(app, rand) {
  const word = pick(rand, CJK)
  for (const character of [...word]) {
    const pinyin = 'pinyin'.slice(0, 2 + Math.floor(rand() * 4))
    for (let index = 1; index <= pinyin.length; index += 1) {
      await app.send('Input.imeSetComposition', {
        text: pinyin.slice(0, index),
        selectionStart: index,
        selectionEnd: index
      })
      await sleep(20)
    }
    await app.send('Input.insertText', { text: character })
    await sleep(30)
  }
  return word
}

const KEY_CODES = { z: 'KeyZ', y: 'KeyY', b: 'KeyB' }

// A paste as the editor receives it (other UI tests do the same): a
// ClipboardEvent with text/plain on the focused editor. Nothing handled it →
// insert the text like the browser's default paste would.
async function pastePlain(app, text) {
  return app.evaluate(`((text) => {
    const pm = ${visiblePm}
    if (!pm) return null
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    const target = document.activeElement && pm.contains(document.activeElement) ? document.activeElement : pm
    target.dispatchEvent(event)
    if (!event.defaultPrevented) document.execCommand('insertText', false, text)
    return event.defaultPrevented
  })(${JSON.stringify(text)})`)
}

const mouseAt = async (app, type, point, extra = {}) => app.send('Input.dispatchMouseEvent', {
  type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra
})

// Drag a random top-level block by its handle onto (before) another one:
// the pointer shows the handle in the gutter, then HTML5 drag events as the
// block-handle tests send them (Milkdown's handle is a native drag source).
async function dragRandomBlock(app, rand) {
  const plan = await app.evaluate(`((r1, r2) => {
    const pm = ${visiblePm}
    if (!pm) return null
    const blocks = [...pm.children].filter((node) => node.offsetParent && node.getBoundingClientRect().height > 4)
    if (blocks.length < 2) return null
    const from = Math.floor(r1 * blocks.length)
    let to = Math.floor(r2 * blocks.length)
    if (to === from) to = (to + 1) % blocks.length
    blocks[from].scrollIntoView({ block: 'center' })
    const host = pm.closest('.editor-host')
    const r = blocks[from].getBoundingClientRect()
    globalThis.__fuzzDragTarget = blocks[to]
    return { from, to, gutter: { x: Math.round(Math.max((host?.getBoundingClientRect().left ?? r.left - 60) + 2, pm.getBoundingClientRect().left - 8)), y: Math.round(r.top + Math.min(12, r.height / 2)) } }
  })(${rand()}, ${rand()})`)
  if (!plan) return null
  // The handle shows after the pointer rests in the gutter: wait for it
  // (the block-handle tests do), nudging the pointer like a hand would.
  let grip = null
  for (let attempt = 0; attempt < 8 && !grip; attempt += 1) {
    await mouseAt(app, 'mouseMoved', { x: plan.gutter.x + (attempt % 2), y: plan.gutter.y })
    await sleep(180)
    grip = await app.evaluate(`(() => {
      const handle = [...document.querySelectorAll('.milkdown-block-handle')].find((n) => n.dataset.show === 'true')
      const item = handle && [...handle.querySelectorAll('.operation-item')].pop()
      if (!item) return null
      const r = item.getBoundingClientRect()
      return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
    })()`)
  }
  if (!grip) return { ...plan, dropped: false, why: 'no-handle' }
  await mouseAt(app, 'mouseMoved', grip)
  await mouseAt(app, 'mousePressed', grip)
  const dropped = await app.evaluate(`(() => {
    const handle = [...document.querySelectorAll('.milkdown-block-handle')].find((n) => n.dataset.show === 'true')
    const target = globalThis.__fuzzDragTarget
    if (!handle || !target || !target.isConnected) return false
    const r = target.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    const at = { clientX: r.left + 2, clientY: r.top + 2 }
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...at }))
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...at })
    target.dispatchEvent(drop)
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    return drop.defaultPrevented
  })()`)
  await mouseAt(app, 'mouseReleased', grip)
  await sleep(200)
  return { ...plan, dropped, ...(dropped ? {} : { why: 'drop-not-handled' }) }
}

// Hover a random table cell, click its row or column handle, click one of
// the buttons the handle opens (delete, alignment…).
async function useTableHandle(app, rand) {
  const cell = await app.evaluate(`((r1) => {
    const pm = ${visiblePm}
    const cells = pm ? [...pm.querySelectorAll('td, th')].filter((n) => n.offsetParent) : []
    if (!cells.length) return null
    const td = cells[Math.floor(r1 * cells.length)]
    td.scrollIntoView({ block: 'center' })
    const r = td.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })(${rand()})`)
  if (!cell) return null
  await mouseAt(app, 'mouseMoved', cell)
  await sleep(350)
  const role = rand() < 0.5 ? 'row-drag-handle' : 'col-drag-handle'
  const handle = await app.evaluate(`(() => {
    const h = [...document.querySelectorAll('.milkdown-table-block .cell-handle[data-role="${role}"]')].find((n) => n.dataset.show === 'true' && n.getBoundingClientRect().width)
    if (!h) return null
    const r = h.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!handle) return { role, clicked: false }
  await mouseAt(app, 'mouseMoved', handle)
  await mouseAt(app, 'mousePressed', handle)
  await mouseAt(app, 'mouseReleased', handle)
  await sleep(250)
  const buttons = await app.evaluate(`(() => [...document.querySelectorAll('.milkdown-table-block .cell-handle .button-group[data-show="true"] button')]
    .filter((b) => b.getBoundingClientRect().width).map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }))()`)
  if (!buttons.length) return { role, clicked: false }
  const index = Math.floor(rand() * buttons.length)
  await mouseAt(app, 'mouseMoved', buttons[index])
  await mouseAt(app, 'mousePressed', buttons[index])
  await mouseAt(app, 'mouseReleased', buttons[index])
  await sleep(250)
  return { role, button: index, of: buttons.length }
}

async function performOp(app, op, rand) {
  switch (op) {
    case 'click': return { target: await clickRandomText(app, rand) }
    case 'typeWord': {
      const word = (rand() < 0.5 ? ' ' : '') + pick(rand, WORDS)
      await typeChars(app, word)
      return { text: word }
    }
    case 'typeCjkIme': return { text: await typeIme(app, rand) }
    case 'typeSymbol': {
      const symbol = pick(rand, MD_SYMBOLS)
      await typeChars(app, symbol)
      return { text: symbol }
    }
    case 'enter': await pressKey(app.send, { key: 'Enter', text: '\r' }); return {}
    case 'backspace': {
      const count = 1 + Math.floor(rand() * 4)
      for (let index = 0; index < count; index += 1) await pressKey(app.send, { key: 'Backspace' })
      return { count }
    }
    case 'delete': await pressKey(app.send, { key: 'Delete' }); return {}
    case 'tab': await pressKey(app.send, { key: 'Tab' }); return {}
    case 'shiftTab': await pressKey(app.send, { key: 'Tab', modifiers: SHIFT }); return {}
    case 'arrow': {
      const key = pick(rand, ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
      const count = 1 + Math.floor(rand() * 5)
      for (let index = 0; index < count; index += 1) await pressKey(app.send, { key })
      return { key, count }
    }
    case 'selectWordAndType':
    case 'selectAndDelete': {
      const count = 1 + Math.floor(rand() * 6)
      for (let index = 0; index < count; index += 1) await pressKey(app.send, { key: 'ArrowLeft', modifiers: SHIFT })
      if (op === 'selectAndDelete') {
        await pressKey(app.send, { key: 'Backspace' })
        return { count }
      }
      const word = pick(rand, [...WORDS, ...CJK])
      await typeChars(app, word)
      return { count, text: word }
    }
    case 'slash': {
      // A new line, then the menu (`/` + query, Enter), as a user inserts a block.
      await pressKey(app.send, { key: 'Enter', text: '\r' })
      const query = pick(rand, SLASH_QUERIES)
      await typeChars(app, '/' + query, 60)
      await sleep(250)
      await pressKey(app.send, { key: 'Enter', text: '\r' })
      return { query }
    }
    case 'dragBlock': return (await dragRandomBlock(app, rand)) || {}
    case 'tableHandle': return (await useTableHandle(app, rand)) || {}
    case 'shiftSelect': {
      const key = pick(rand, ['ArrowLeft', 'ArrowRight'])
      const count = 1 + Math.floor(rand() * 8)
      for (let index = 0; index < count; index += 1) await pressKey(app.send, { key, modifiers: SHIFT })
      return { key, count }
    }
    case 'italic':
    case 'strike':
    case 'inlineCode':
    case 'highlight':
    case 'paragraphBlock':
    case 'quote':
    case 'bulletList':
    case 'orderedList':
      await pressKey(app.send, FORMAT_KEYS[op])
      return {}
    case 'heading': {
      const level = 1 + Math.floor(rand() * 3)
      await pressKey(app.send, { key: String(level), code: `Digit${level}`, modifiers: MOD })
      return { level }
    }
    case 'undo':
    case 'redo':
    case 'bold': {
      const key = op === 'undo' ? 'z' : op === 'redo' ? (process.platform === 'darwin' ? 'z' : 'y') : 'b'
      const modifiers = MOD | (op === 'redo' && process.platform === 'darwin' ? SHIFT : 0)
      await pressKey(app.send, { key, code: KEY_CODES[key], modifiers })
      return {}
    }
    case 'sourceRoundTrip': {
      const opened = await setSourceMode(app, true)
      const closed = await setSourceMode(app, false)
      return { opened, closed }
    }
    case 'sourceEdit': {
      if (await setSourceMode(app, true)) {
        const ratio = rand()
        await app.evaluate(`(() => {
          const area = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
          const lines = area.value.split('\\n')
          let offset = 0
          const target = Math.floor(${ratio} * lines.length)
          for (let index = 0; index < target; index += 1) offset += lines[index].length + 1
          offset += lines[target]?.length || 0
          area.focus()
          area.setSelectionRange(offset, offset)
          area.__horsemdSourceSelectionUser = true
        })()`)
        const text = ' src' + Math.floor(rand() * 100)
        await typeChars(app, text)
        await sleep(500)
        return { text, closed: await setSourceMode(app, false) }
      }
      return { opened: false, closed: await setSourceMode(app, false) }
    }
    case 'paste': {
      let text = pick(rand, PASTE_SNIPPETS)
      const crlf = rand() < 0.4
      if (crlf) text = text.replace(/\n/g, '\r\n')
      const handled = await pastePlain(app, text)
      await sleep(250)
      return { text: text.slice(0, 60), crlf, handled }
    }
    case 'save': {
      const saved = await app.evaluate(`(() => { const fab = document.querySelector('.hm-save-fab'); fab?.click(); return Boolean(fab) })()`)
      await sleep(600)
      return { saved }
    }
    default: return {}
  }
}

async function checkpoint({ app, file, seedDir, index, port }) {
  // Leave source mode so the live PM doc is the authoritative view.
  await setSourceMode(app, false)
  await sleep(700)
  const live = await docJson(app)
  // What the source view says before saving (rich → source flush path).
  await setSourceMode(app, true)
  const sourceView = await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null`)
  await setSourceMode(app, false)
  const liveAfterRoundTrip = await docJson(app)
  const hadFab = await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)
  if (hadFab) {
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1200)
  }
  const toasts = await drainToasts(app)
  const paused = toasts.filter(isMismatchToast)
  const stillDirty = await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)
  const disk = await readFile(file, 'utf8')
  const copy = join(seedDir, `checkpoint-${index}.md`)
  await writeFile(copy, disk, 'utf8')
  // Cold reopen the saved bytes in a fresh profile.
  const reopen = await launchBuiltElectron({ profileDir: join(seedDir, `reopen-${index}`), port, appArgs: [copy] })
  let reopened = null
  try {
    for (let attempt = 0; attempt < 60 && !reopened; attempt += 1) {
      reopened = await docJson(reopen)
      if (!reopened) await sleep(150)
    }
    await sleep(500)
    reopened = await docJson(reopen)
  } finally {
    await stopBuiltElectron(reopen, { removeProfile: true })
  }
  let corrupt = null
  let softDiff = null
  if (live && reopened && !stillDirty) {
    const a = normalizeDoc(live)
    const b = normalizeDoc(reopened)
    corrupt = firstDiff(a, b)
    // Option A (Typora parity): bold/italic Markdown cannot delimit is saved
    // as literal `*`/`_`. Not corruption when that is the ONLY difference and
    // every block's text is the live text plus delimiters (see
    // areSourceDocumentsEquivalentWithLiteralEmphasis).
    if (corrupt && literalEmphasisOnly(a, b)) {
      softDiff = { literalEmphasis: true, ...corrupt }
      corrupt = null
    }
    if (!corrupt && !softDiff && live !== reopened) softDiff = firstDiff(JSON.parse(live), JSON.parse(reopened))
  }
  if (corrupt || softDiff || live !== liveAfterRoundTrip) {
    await writeFile(join(seedDir, `checkpoint-${index}.live.json`), live || 'null')
    await writeFile(join(seedDir, `checkpoint-${index}.live-after-source.json`), liveAfterRoundTrip || 'null')
    await writeFile(join(seedDir, `checkpoint-${index}.reopened.json`), reopened || 'null')
    await writeFile(join(seedDir, `checkpoint-${index}.source-view.md`), sourceView ?? '')
  }
  const roundTripChangedDoc = live !== liveAfterRoundTrip
  return { index, hadFab, stillDirty, paused, toasts, corrupt, softDiff, roundTripChangedDoc, sourceViewEqualsDisk: sourceView === disk, diskBytes: disk.length }
}

async function runSeed(seed) {
  const rand = prng(seed)
  const seedDir = join(outRoot, `seed-${seed}`)
  await rm(seedDir, { recursive: true, force: true })
  await mkdir(seedDir, { recursive: true })
  const file = join(seedDir, 'doc.md')
  const fixture = process.env.FUZZ_FIXTURE ? await readFile(resolve(process.env.FUZZ_FIXTURE), 'utf8') : DEFAULT_FIXTURE
  await writeFile(file, fixture, 'utf8')
  const port = basePort + (seed % 20) * 2
  const app = await launchBuiltElectron({ profileDir: join(seedDir, 'profile'), port, appArgs: [file, '--horsemd-input-trace'] })
  const report = { seed, ops: [], checkpoints: [], firstPause: null, firstCorrupt: null, shadow: [] }
  // Source reprint shadow results (R2): drained after every op.
  const drainShadow = async (opIndex) => {
    const raw = await app.evaluate(`(() => { const t = globalThis.__hmSourceReprintShadowTrace || []; globalThis.__hmSourceReprintShadowTrace = []; return JSON.stringify(t) })()`)
    for (const entry of JSON.parse(raw || '[]')) report.shadow.push({ opIndex, ...entry })
  }
  try {
    await app.send('Runtime.enable')
    for (let attempt = 0; attempt < 60 && !(await docJson(app)); attempt += 1) await sleep(150)
    await installToastRecorder(app)
    // P2 shadow (lib/source-sync/projection.js): the projection comparison
    // runs next to the existing one; disagreements are kept in the report.
    if (process.env.FUZZ_PROJECTION === '1') await app.evaluate('globalThis.__hmProjectionShadow = true')
    if (process.env.FUZZ_WATCH_NEWLINE === '1') await installNewlineWatch(app)
    // Start like a user: click into the document first.
    report.ops.push({ index: -1, op: 'click', target: await clickRandomText(app, rand) })
    for (let index = 0; index < opsPerSeed; index += 1) {
      const op = weighted(rand, [...OPS, ...(process.env.FUZZ_FORMAT === '1' ? FORMAT_OPS : []), ...(process.env.FUZZ_UI === '1' ? UI_OPS : []), ...(process.env.FUZZ_PASTE === '1' ? PASTE_OPS : [])])
      let detail = {}
      try {
        detail = await performOp(app, op, rand)
      } catch (error) {
        detail = { error: String(error?.message || error) }
      }
      // Source length next to a fresh serialization of the live document.
      // Blank lines inside a quote read back as nothing, so a source that
      // grows with them passes every equivalence check (seed 3815: 5 MB of
      // `>` lines saved for a 1 KB document).
      const sizes = JSON.parse(await app.evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness; try { return JSON.stringify({ source: h?.liveSource?.()?.length ?? null, serialized: h ? h.serialize(h.liveDoc()).length : null }) } catch { return 'null' } })()`) || 'null')
      report.ops.push({ index, op, ...detail, ...(sizes ? { sourceLength: sizes.source } : {}) })
      if (process.env.FUZZ_DUMP_SOURCE === '1') {
        await writeFile(join(seedDir, `op-${index}.md`), (await app.evaluate(`globalThis.__hmSourceReprintHarness?.liveSource?.() ?? ''`)) || '')
        await writeFile(join(seedDir, `op-${index}.doc.json`), (await docJson(app)) || 'null')
        await writeFile(join(seedDir, `op-${index}.state.json`), String(await app.evaluate(`JSON.stringify((() => { const v = globalThis.__hmSourceReprintHarness?.view?.(); return v ? { composing: v.composing, head: v.state.selection.$head.parent.type.name, active: String(document.activeElement?.className || '').slice(0, 40) } : null })())`)))
      }
      await drainShadow(index)
      if (sizes?.source != null && sizes.serialized != null && sizes.source > sizes.serialized * 3 + 4000 && !report.firstCorrupt) {
        report.firstCorrupt = { opIndex: index, bloat: sizes, recentOps: report.ops.slice(-8), trace: await traceTails(app) }
        console.log(`[seed ${seed}] BLOAT at op ${index} (${op}): source ${sizes.source} chars, document serializes to ${sizes.serialized}`)
        break
      }
      // Fail-closed warnings can fire on any op; capture them with their op.
      const toasts = await app.evaluate(`(window.__fuzzToasts || []).slice()`)
      const mismatch = toasts.find(isMismatchToast)
      if (mismatch && !report.firstPause) {
        report.firstPause = { opIndex: index, op, toast: mismatch.msg, trace: await traceTails(app), recentOps: report.ops.slice(-8), ...(await pauseSnapshot(app)) }
        console.log(`[seed ${seed}] PAUSE at op ${index} (${op}): ${mismatch.msg}`)
        break
      }
      if ((index + 1) % checkpointEvery === 0 || index === opsPerSeed - 1) {
        const result = await checkpoint({ app, file, seedDir, index, port: port + 1 })
        report.checkpoints.push(result)
        await drainShadow(index)
        if (result.paused.length && !report.firstPause) {
          report.firstPause = { opIndex: index, op: 'checkpoint-save', toast: result.paused[0].msg, trace: await traceTails(app), recentOps: report.ops.slice(-8), ...(await pauseSnapshot(app)) }
          console.log(`[seed ${seed}] PAUSE at checkpoint ${index}: ${result.paused[0].msg}`)
          break
        }
        if (result.corrupt) {
          // The owner / reprint trace shows which path wrote the bytes.
          report.firstCorrupt = { opIndex: index, diff: result.corrupt, recentOps: report.ops.slice(-checkpointEvery), shadowTail: report.shadow.slice(-6), trace: await traceTails(app) }
          console.log(`[seed ${seed}] CORRUPT at checkpoint ${index}: ${JSON.stringify(result.corrupt).slice(0, 400)}`)
          break
        }
        console.log(`[seed ${seed}] checkpoint ${index}: ok${result.softDiff ? ' (soft diff ' + result.softDiff.path + ')' : ''}${result.stillDirty ? ' (STILL DIRTY)' : ''}`)
      }
    }
  } finally {
    // Which writer published how often (Editor.jsx __hmPublishTally).
    try { report.publishers = JSON.parse(await app.evaluate('JSON.stringify(globalThis.__hmPublishTally || null)') || 'null') } catch { /* app gone */ }
    try { report.reprintDeclines = JSON.parse(await app.evaluate('JSON.stringify(globalThis.__hmReprintTally || null)') || 'null') } catch { /* app gone */ }
    try { report.legacyCauses = JSON.parse(await app.evaluate('JSON.stringify(globalThis.__hmLegacyCause || null)') || 'null') } catch { /* app gone */ }
    if (process.env.FUZZ_DUMP_SOURCE === '1') { try { report.replaceTrace = JSON.parse(await app.evaluate('JSON.stringify(globalThis.__hmReplaceTrace || null)') || 'null') } catch { /* app gone */ } }
    if (process.env.FUZZ_PROJECTION === '1') {
      try { report.projection = JSON.parse(await app.evaluate('JSON.stringify(globalThis.__hmProjectionShadowLog || null)') || 'null') } catch { /* app gone */ }
    }
    await writeFile(join(seedDir, 'report.json'), JSON.stringify(report, null, 2))
    await stopBuiltElectron(app, { removeProfile: false })
  }
  return report
}

// publish: current path published; reprint verified? same bytes?
// failure: current path refused (pause); would reprint have published?
function shadowSummary(entries) {
  const publish = entries.filter((entry) => entry.phase === 'publish')
  const failure = entries.filter((entry) => entry.phase === 'failure')
  return {
    publish: publish.length,
    publishVerified: publish.filter((entry) => entry.verified).length,
    publishSameBytes: publish.filter((entry) => entry.sameAsCurrent).length,
    failure: failure.length,
    failureRescued: failure.filter((entry) => entry.verified).length,
    maxMs: Math.max(0, ...entries.map((entry) => entry.ms || 0))
  }
}

await mkdir(outRoot, { recursive: true })
const summary = []
for (const seed of seeds) {
  try {
    const report = await runSeed(seed)
    summary.push({
      seed,
      ops: report.ops.length,
      pause: report.firstPause ? `op ${report.firstPause.opIndex} ${report.firstPause.op}` : null,
      corrupt: report.firstCorrupt ? (report.firstCorrupt.bloat ? `bloat op ${report.firstCorrupt.opIndex}` : report.firstCorrupt.diff.path) : null,
      shadow: shadowSummary(report.shadow),
      ...(report.projection ? { projection: { agree: report.projection.agree, disagree: report.projection.disagree, byOptions: report.projection.byOptions } } : {})
    })
  } catch (error) {
    summary.push({ seed, error: String(error?.stack || error).slice(0, 400) })
    console.log(`[seed ${seed}] ERROR ${error?.message}`)
  }
}
await writeFile(join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2))
console.log('FUZZ SUMMARY ' + outRoot)
for (const row of summary) console.log(JSON.stringify(row))
