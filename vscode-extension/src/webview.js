// HorseMD VSCode webview entry — bundled by esbuild into media/editor.js
// All resources local; no CDN dependency.
// Aligned with main HorseMD app's editor-crepe-setup.js modules.

import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import '@milkdown/crepe/theme/common/latex.css'
import 'katex/dist/katex.min.css'

import { Crepe, CrepeFeature } from '@milkdown/crepe'
import {
  editorViewOptionsCtx,
  nodeViewCtx,
  prosePluginsCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx
} from '@milkdown/kit/core'
import { inlineCodeSchema } from '@milkdown/kit/preset/commonmark'
import remarkFrontmatter from 'remark-frontmatter'

import { imageBlockMarkdownSchema } from './editor-image-markdown.js'
import { highlightFeatures, highlightStringifyHandler } from './editor-highlight.js'
import { frontmatterSchema, renderFrontmatterNodeView } from './editor-frontmatter.js'
import { tabAtCursorKeymap } from './editor-codeblock-tab.js'
import { tableBreakKeymap, tableCellBreakHandler, brToBreakRemarkPlugin } from './editor-tablebreak.js'
import { renderHtmlNodeView, remarkMergeInlineHtml } from './editor-html.js'
import { createInlineMathEditingPlugin } from './editor-inline-math.js'
import { mathPreviewPlugin } from './editor-math-preview.js'
import { toolbarAutohidePlugin } from './editor-toolbar-autohide.js'
import { createTaskListInputPlugin } from './editor-task-list.js'
import { normalizeWebPasteHtml } from './editor-web-paste.js'
import { createBlockHandleGutterPlugin, getBlockHandlePosition } from './editor-block-handle-guard.js'

const vscode = acquireVsCodeApi()

let crepe = null
let currentTheme = 'auto'
let suppressUpdate = false
let lastMd = ''
let scrollSpyRaf = 0
let scrollSpyCleanup = null

// ===== Theme =====
const THEME_CLASSES = ['light', 'dark', 'theme-morandi', 'theme-morandi-rose', 'theme-morandi-blue', 'theme-morandi-dark']
const THEMES = [
  { id: 'light', base: 'light', cls: '' },
  { id: 'dark', base: 'dark', cls: '' },
  { id: 'morandi', base: 'light', cls: 'theme-morandi' },
  { id: 'morandi-rose', base: 'light', cls: 'theme-morandi-rose' },
  { id: 'morandi-blue', base: 'light', cls: 'theme-morandi-blue' },
  { id: 'morandi-dark', base: 'dark', cls: 'theme-morandi-dark' }
]

function applyTheme(themeId) {
  document.body.classList.remove(...THEME_CLASSES)
  let resolved = themeId
  if (themeId === 'auto') {
    const cls = document.body.className
    resolved = cls.includes('vscode-dark') || cls.includes('vscode-high-contrast') ? 'dark' : 'light'
  }
  const theme = THEMES.find(t => t.id === resolved) || THEMES[0]
  document.body.classList.add(theme.base)
  if (theme.cls) document.body.classList.add(theme.cls)
}

// ===== Outline =====
function generateOutline() {
  const headings = document.querySelectorAll('#editor h1, #editor h2, #editor h3, #editor h4, #editor h5, #editor h6')
  const nav = document.getElementById('hm-outline')
  if (!nav) return
  if (!headings.length) { nav.innerHTML = '<p class="hm-outline-empty">No headings</p>'; return }
  const items = []
  headings.forEach((h, i) => {
    if (!h.id) h.id = 'hm-heading-' + (i + 1)
    items.push({ id: h.id, level: parseInt(h.tagName[1]), text: h.textContent.trim() })
  })
  nav.innerHTML = '<nav>' + items.map(item =>
    '<a href="#' + item.id + '" class="hm-outline-item hm-outline-l' + item.level + '" data-target="' + item.id + '">' +
    item.text.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])) + '</a>'
  ).join('') + '</nav>'
  nav.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault()
      const el = document.getElementById(a.dataset.target)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })
  setupScrollSpy(headings)
}

function setupScrollSpy(headings) {
  if (scrollSpyCleanup) scrollSpyCleanup()
  const scroll = document.getElementById('hm-scroll')
  const links = document.querySelectorAll('.hm-outline-item')
  function onScroll() {
    cancelAnimationFrame(scrollSpyRaf)
    scrollSpyRaf = requestAnimationFrame(() => {
      let activeIdx = 0
      const scrollTop = scroll.scrollTop
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].offsetTop - 80 <= scrollTop) activeIdx = i
      }
      links.forEach((l, i) => l.classList.toggle('hm-active', i === activeIdx))
    })
  }
  scroll.addEventListener('scroll', onScroll, { passive: true })
  scrollSpyCleanup = () => scroll.removeEventListener('scroll', onScroll)
  onScroll()
}

// ===== Init =====
async function init(opts) {
  currentTheme = opts.theme || 'auto'
  applyTheme(currentTheme)

  if (opts.fontSize) document.documentElement.style.setProperty('--hm-font-size', opts.fontSize + 'px')
  if (opts.contentWidth) {
    const widths = { compact: '680px', standard: '820px', wide: '1040px', full: 'none' }
    document.documentElement.style.setProperty('--hm-content-width', widths[opts.contentWidth] || '820px')
  }

  new MutationObserver(() => {
    if (currentTheme === 'auto') applyTheme('auto')
  }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] })

  try {
    crepe = new Crepe({
      root: '#editor',
      defaultValue: opts.content || '',
      features: {
        [CrepeFeature.Toolbar]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.Table]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.Latex]: true,
        [CrepeFeature.Cursor]: false,
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: { text: 'Start writing…', mode: 'block' },
        [CrepeFeature.BlockEdit]: {
          blockHandle: {
            getPosition: getBlockHandlePosition,
            getOffset: () => 0
          }
        },
        [CrepeFeature.CodeMirror]: {
          copyText: 'Copy',
          previewToggleText: (previewOnly) => previewOnly ? 'Edit' : 'Hide',
          extensions: [tabAtCursorKeymap]
        },
        [CrepeFeature.Latex]: {
          katexOptions: {
            output: 'htmlAndMathml'
          }
        }
      }
    })

    // Register markdownUpdated BEFORE create
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        if (suppressUpdate) return
        if (markdown === lastMd) return
        lastMd = markdown
        vscode.postMessage({ type: 'edit', markdown })
        generateOutline()
      })
    })

    // Wire all schema extensions, plugins, and node views
    crepe.editor.config((ctx) => {
      // Paste HTML normalization
      ctx.update(editorViewOptionsCtx, (options) => ({
        ...options,
        transformPastedHTML: (html, view) => {
          const transformed = options.transformPastedHTML
            ? options.transformPastedHTML(html, view)
            : html
          return normalizeWebPasteHtml(transformed)
        }
      }))

      // Custom node views
      ctx.update(nodeViewCtx, (views) => [
        ...views,
        ['html', (node) => renderHtmlNodeView(node)],
        ['frontmatter', (node, view, getPos) => renderFrontmatterNodeView(node, view, getPos, {
          onEdit: () => {},
          onValueChange: () => {},
          canEdit: () => true
        })]
      ])

      // ProseMirror plugins
      ctx.update(prosePluginsCtx, (plugins) => [
        createBlockHandleGutterPlugin(ctx),
        ...plugins,
        tableBreakKeymap(),
        createInlineMathEditingPlugin(),
        createTaskListInputPlugin(),
        toolbarAutohidePlugin(),
        mathPreviewPlugin(() => null),
      ])

      // Stringify handlers
      ctx.update(remarkStringifyOptionsCtx, (opts) => ({
        ...opts,
        handlers: {
          ...(opts?.handlers || {}),
          break: tableCellBreakHandler,
          highlight: highlightStringifyHandler
        }
      }))

      // Remark plugins
      ctx.update(remarkPluginsCtx, (plugins) => [
        ...plugins,
        { plugin: remarkFrontmatter, options: undefined },
        { plugin: brToBreakRemarkPlugin, options: undefined },
        { plugin: remarkMergeInlineHtml, options: undefined },
      ])
    })

    // Schema extensions
    crepe.editor.use(
      inlineCodeSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), inclusive: false }))
    )
    crepe.editor.use(imageBlockMarkdownSchema)
    crepe.editor.use(highlightFeatures)
    crepe.editor.use(frontmatterSchema)

    await crepe.create()
    lastMd = opts.content || ''
    generateOutline()
  } catch (err) {
    document.getElementById('editor').innerHTML =
      '<pre style="padding:2em;color:#c93b3b;font-family:monospace;white-space:pre-wrap">Failed to load Milkdown Crepe:\n' +
      (err.message || err) + '</pre>'
  }
}

// ===== Messages from host =====
window.addEventListener('message', (event) => {
  const msg = event.data
  if (msg.type === 'init') {
    init(msg)
  } else if (msg.type === 'update' && crepe) {
    if (msg.content !== lastMd) {
      suppressUpdate = true
      crepe.setMarkdown(msg.content)
      lastMd = msg.content
      generateOutline()
      Promise.resolve().then(() => { suppressUpdate = false })
    }
  } else if (msg.type === 'theme') {
    currentTheme = msg.theme
    applyTheme(msg.theme)
  } else if (msg.type === 'toggleOutline') {
    document.getElementById('hm-outline').classList.toggle('hm-hidden')
  }
})

// Signal host that we're ready to receive init message
vscode.postMessage({ type: 'ready' })
