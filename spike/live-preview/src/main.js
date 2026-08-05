import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { parser as parseMarkdown } from '@lezer/markdown'

// ---------- fixtures ----------
const CSP = '/Users/yangtingyi/Downloads/Desktop/CSP-J初赛讲义 第1单元 计算机通识.md'
async function loadCsp() {
  const res = await fetch('file://' + CSP)
  return await res.text()
}
function makeLargeCjk() {
  const para = '这是一段用于性能测试的中文正文，包含一些标点符号，以及 123 数字和英文 mixed content。'.repeat(20)
  const blocks = []
  for (let i = 0; i < 120; i++) {
    blocks.push(`## 第 ${i + 1} 节 性能测试标题`)
    blocks.push('')
    blocks.push(para)
    blocks.push('')
    if (i % 10 === 0) blocks.push('```js\nfunction hello(name) {\n  return `你好，${name}`\n}\n```\n')
    if (i % 15 === 0) blocks.push('| 列A | 列B | 列C |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n')
  }
  return blocks.join('\n')
}

// ---------- image widget ----------
class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt }
  eq(other) { return other.src === this.src && other.alt === this.alt }
  toDOM() {
    const img = document.createElement('img')
    img.className = 'hm-img'
    img.alt = this.alt || ''
    img.src = this.src.startsWith('http') ? this.src : 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#eef1f4"/><text x="8" y="24" font-size="12" fill="#57606a">本地图:' + this.alt + '</text></svg>')
    return img
  }
  ignoreEvent() { return true }
}

// ---------- live preview decorations ----------
function livePreview(view) {
  const tree = parseMarkdown.parse(view.state.doc.toString())
  const builder = new RangeSetBuilder()

  const ranges = []
  tree.iterate({
    enter(node) {
      const from = node.from
      const to = node.to
      const name = node.name
      if (name === 'ATXHeading1') ranges.push({ from, to, dec: Decoration.line({ class: 'hm-h1' }) })
      else if (name === 'ATXHeading2') ranges.push({ from, to, dec: Decoration.line({ class: 'hm-h2' }) })
      else if (name === 'ATXHeading3') ranges.push({ from, to, dec: Decoration.line({ class: 'hm-h3' }) })
      else if (name === 'ATXHeading4' || name === 'ATXHeading5' || name === 'ATXHeading6') ranges.push({ from, to, dec: Decoration.line({ class: 'hm-h4' }) })
      else if (name === 'StrongEmphasis') ranges.push({ from, to, dec: Decoration.mark({ class: 'hm-bold' }) })
      else if (name === 'Emphasis') ranges.push({ from, to, dec: Decoration.mark({ class: 'hm-italic' }) })
      else if (name === 'InlineCode') ranges.push({ from, to, dec: Decoration.mark({ class: 'hm-inline-code' }) })
      else if (name === 'Blockquote') ranges.push({ from, to, dec: Decoration.line({ class: 'hm-blockquote' }) })
      else if (name === 'HorizontalRule') ranges.push({ from, to, dec: Decoration.line({ class: 'hm-hr' }) })
      else if (name === 'Image') {
        const src = view.state.sliceDoc(from, to).match(/!\[([^\]]*)\]\(([^)\s]+)/)
        if (src) ranges.push({ from: from + src[0].indexOf(']') + 1, to, dec: Decoration.replace({ widget: new ImageWidget(src[2], src[1]) }) })
      }
    }
  })

  // fenced code block lines
  let inFence = false
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n)
    if (/^\s*(```|~~~)/.test(line.text)) {
      inFence = !inFence
    } else if (inFence) {
      ranges.push({ from: line.from, to: line.to, dec: Decoration.line({ class: 'hm-codeblock' }) })
    }
  }

  const sorted = ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  for (const r of sorted) builder.add(r.from, Math.max(r.from + 1, r.to), r.dec)
  if (typeof window !== 'undefined') { window.__hmDecorCount = ranges.length; window.__hmDecorSample = ranges.slice(0, 3).map((r) => ({ n: r.dec.spec?.class, f: r.from })) }
  return builder.finish()
}

const previewPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    try { this.decorations = livePreview(view) } catch (e) { window.__hmSpikeErr = String((e && e.stack) || e); this.decorations = Decoration.none }
  }
  update(update) {
    if (update.docChanged || update.selectionSet) {
      try { this.decorations = livePreview(update.view) } catch (e) { window.__hmSpikeErr = String((e && e.stack) || e); this.decorations = Decoration.none }
    }
  }
}, { decorations: (v) => v.decorations })

// ---------- editor ----------
const host = document.getElementById('editor-host')
const metrics = document.getElementById('metrics')
let view

function createEditor(doc) {
  const t0 = performance.now()
  const state = EditorState.create({
    doc,
    extensions: [
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      previewPlugin,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const t = performance.now()
          window.__lastInput = t
        }
      })
    ]
  })
  view = new EditorView({ state, parent: host })
  const t1 = performance.now()
  metrics.textContent = `初始渲染: ${(t1 - t0).toFixed(1)}ms | 文档长度: ${doc.length} 字符`
  return view
}

// typing latency probe: dispatch N chars, measure per-char
function typeProbe(text) {
  const start = performance.now()
  const len = text.length
  for (let i = 0; i < len; i++) {
    const ch = text[i]
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: ch }, selection: { anchor: view.state.selection.main.head + 1 } })
  }
  const perChar = (performance.now() - start) / len
  metrics.textContent += ` | 输入延迟: ${perChar.toFixed(2)}ms/字符`
}

document.getElementById('load-small').addEventListener('click', async () => {
  view?.destroy()
  const doc = await loadCsp()
  createEditor(doc)
  typeProbe('中文输入性能测试。')
})
document.getElementById('load-large').addEventListener('click', () => {
  view?.destroy()
  createEditor(makeLargeCjk())
  typeProbe('中文输入性能测试。')
})
document.getElementById('toggle-preview').addEventListener('change', (e) => {
  // toggle: remove/restore the preview plugin
  view?.destroy()
  const doc = view?.state.doc.toString() || ''
  const state = EditorState.create({
    doc,
    extensions: [
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      ...(e.target.checked ? [previewPlugin] : []),
      EditorView.lineWrapping
    ]
  })
  view = new EditorView({ state, parent: host })
})

// default: load the small CSP doc (file:// fetch only works when served; fall back)
loadCsp().then((doc) => createEditor(doc)).catch(() => createEditor('# 测试\n\n## 预览\n\n正文内容\n'))
