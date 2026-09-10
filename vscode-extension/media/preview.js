// HorseMD VSCode webview — thin display layer.
// Receives rendered HTML from the extension host, injects theme CSS,
// builds outline from headings, lazy-loads Mermaid from CDN.
// No bundler needed — plain JS loaded directly as <script src>.

const vscode = acquireVsCodeApi()

let currentTheme = 'auto'
let outlineVisible = true
let scrollSpyRaf = 0

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
    const kind = document.body.getAttribute('data-vscode-theme-kind') || ''
    resolved = kind.includes('dark') || kind.includes('high-contrast') ? 'dark' : 'light'
  }
  const theme = THEMES.find((t) => t.id === resolved) || THEMES[0]
  document.body.classList.add(theme.base)
  if (theme.cls) document.body.classList.add(theme.cls)
}

function refreshMermaid() {
  if (window.__mermaid) {
    const isDark = document.body.classList.contains('dark')
    window.__mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default', securityLevel: 'loose' })
    document.querySelectorAll('.hm-mermaid[data-rendered]').forEach((b) => {
      b.removeAttribute('data-rendered')
      b.innerHTML = '<p class="hm-mermaid-loading">Rendering diagram…</p>'
    })
    renderMermaidBlocks()
  }
}

// ===== Mermaid (lazy from CDN) =====
async function renderMermaidBlocks() {
  const blocks = document.querySelectorAll('.hm-mermaid:not([data-rendered])')
  if (!blocks.length) return

  if (!window.__mermaid) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js')
      const isDark = document.body.classList.contains('dark')
      window.__mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default', securityLevel: 'loose' })
    } catch (err) {
      for (const b of blocks) {
        b.innerHTML = `<p class="hm-mermaid-error">Failed to load Mermaid: ${escapeHtml(String(err.message || err))}</p>`
        b.setAttribute('data-rendered', 'true')
      }
      return
    }
  }

  for (const block of blocks) {
    const code = decodeURIComponent(block.dataset.mermaid || '')
    const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const { svg } = await window.__mermaid.render(id, code)
      block.innerHTML = svg
    } catch (err) {
      block.innerHTML = `<p class="hm-mermaid-error">Mermaid: ${escapeHtml(String(err.message || err))}</p>`
    }
    block.setAttribute('data-rendered', 'true')
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error('Failed to load ' + src))
    document.head.appendChild(s)
  })
}

// ===== Outline =====
function generateOutline() {
  const headings = document.querySelectorAll('.hm-doc h1, .hm-doc h2, .hm-doc h3, .hm-doc h4, .hm-doc h5, .hm-doc h6')
  const nav = document.getElementById('hm-outline')

  if (!headings.length) {
    nav.innerHTML = '<p class="hm-outline-empty">No headings</p>'
    return
  }

  const items = []
  headings.forEach((h, i) => {
    if (!h.id) h.id = 'hm-heading-' + (i + 1)
    items.push({ id: h.id, level: parseInt(h.tagName[1]), text: h.textContent.trim() })
  })

  nav.innerHTML = '<nav>' + items.map(function (item) {
    return '<a href="#' + item.id + '" class="hm-outline-item hm-outline-l' + item.level + '" data-target="' + item.id + '">' + escapeHtml(item.text) + '</a>'
  }).join('') + '</nav>'

  nav.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault()
      var el = document.getElementById(a.dataset.target)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })

  setupScrollSpy(headings)
}

function setupScrollSpy(headings) {
  var scroll = document.getElementById('hm-scroll')
  var links = document.querySelectorAll('.hm-outline-item')

  function onScroll() {
    cancelAnimationFrame(scrollSpyRaf)
    scrollSpyRaf = requestAnimationFrame(function () {
      var activeIdx = 0
      var scrollTop = scroll.scrollTop
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].offsetTop - 80 <= scrollTop) activeIdx = i
      }
      links.forEach(function (l, i) { l.classList.toggle('hm-active', i === activeIdx) })
    })
  }

  scroll.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}

// ===== Helpers =====
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  })
}

// ===== CSS injection =====
function injectCSS() {
  var style = document.createElement('style')
  style.textContent = getThemeCSS() + '\n' + getHljsCSS()
  document.head.appendChild(style)
}

function getHljsCSS() {
  return `
.hljs{color:#abb2bf;background:transparent}
.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}
.hljs-doctag,.hljs-keyword,.hljs-formula{color:#c678dd}
.hljs-section,.hljs-name,.hljs-selector-tag,.hljs-deletion,.hljs-subst{color:#e06c75}
.hljs-literal{color:#56b6c2}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#98c379}
.hljs-attr,.hljs-variable,.hljs-template-variable,.hljs-type,.hljs-selector-class,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-number{color:#d19a66}
.hljs-symbol,.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-title{color:#61aeee}
.hljs-built_in,.hljs-title.class_,.hljs-class .hljs-title{color:#e6c07b}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
.hljs-link{text-decoration:underline}
`
}

function getThemeCSS() {
  return `
/* ===== Reset & Layout ===== */
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-write);
  color: var(--text);
  background: var(--bg);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
#hm-app { display: flex; height: 100vh; overflow: hidden; }
#hm-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; overscroll-behavior: contain; }
.hm-hidden { display: none !important; }

/* ===== Outline Sidebar ===== */
#hm-outline {
  width: 240px; flex-shrink: 0; overflow-y: auto;
  border-right: 1px solid var(--border-soft);
  background: var(--bg-sidebar, var(--bg));
  padding: 16px 8px 16px 12px;
  transition: width 0.2s ease;
}
#hm-outline nav { display: flex; flex-direction: column; gap: 1px; }
.hm-outline-item {
  display: block; padding: 3px 8px; font-size: 13px;
  color: var(--muted); text-decoration: none; cursor: pointer;
  border: none !important; border-radius: var(--radius-sm);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background 0.12s, color 0.12s;
}
.hm-outline-item:hover { background: var(--hover-elevated, var(--code-bg)); color: var(--text); }
.hm-outline-item.hm-active { color: var(--accent); font-weight: 500; }
.hm-outline-l1 { font-weight: 600; font-size: 14px; color: var(--text); }
.hm-outline-l2 { padding-left: 20px; }
.hm-outline-l3 { padding-left: 36px; font-size: 12px; }
.hm-outline-l4, .hm-outline-l5, .hm-outline-l6 { padding-left: 52px; font-size: 12px; opacity: 0.8; }
.hm-outline-empty { color: var(--faint, var(--muted)); font-size: 12px; padding: 8px; }

/* ===== Theme Variables ===== */
:root {
  --font-write: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, 'Courier New', monospace;
  --radius-sm: 5px; --radius-md: 8px; --radius-lg: 12px;
}

/* --- Warm Light --- */
body.light {
  --bg: #ebe7e0; --bg-elevated: #faf8f5; --bg-sidebar: #e3dfd7; --bg-editor: #fdfbf7;
  --text: #2a2620; --text-strong: #0f0d0a; --muted: #5a5650; --faint: #8a867e;
  --border: #c8c4bc; --border-soft: #ddd9d2;
  --hover-elevated: #f0ede5; --code-bg: #f2efe8; --code-border: #ddd9d2;
  --code-block-bg: #2a2730; --code-block-border: rgba(0,0,0,0.25);
  --accent: #c86b35; --accent-strong: #a04f22; --accent-soft: rgba(200,107,53,0.15);
  --danger: #c93b3b; --success: #4a8f4a;
}
/* --- Warm Dark --- */
body.dark {
  --bg: #16130e; --bg-elevated: #1e1a16; --bg-sidebar: #191512; --bg-editor: #1d1914;
  --text: #d0c8bc; --text-strong: #f2ebe0; --muted: #8a8378; --faint: #6a655c;
  --border: #3a3630; --border-soft: #302c28;
  --hover-elevated: #2e2a24; --code-bg: #24201c; --code-border: #3a3630;
  --code-block-bg: #100e0b; --code-block-border: rgba(255,255,255,0.06);
  --accent: #e69055; --accent-strong: #ffb080; --accent-soft: rgba(230,144,85,0.18);
  --danger: #ff7070; --success: #7ac47a;
}
/* --- Morandi Sage --- */
body.theme-morandi {
  --bg: #e7e8e2; --bg-elevated: #f3f4ef; --bg-sidebar: #dfe1d9; --bg-editor: #f6f7f2;
  --text: #3a3d35; --text-strong: #23261f; --muted: #6c6f63; --faint: #97998d;
  --border: #c5c8bc; --border-soft: #d9dbd0;
  --hover-elevated: #ecede6; --code-bg: #eceee6; --code-border: #d9dbd0;
  --code-block-bg: #2a2730; --code-block-border: rgba(0,0,0,0.25);
  --accent: #7d8a6a; --accent-strong: #5f6b4e; --accent-soft: rgba(125,138,106,0.16);
  --danger: #b3645f; --success: #6f8a66;
}
/* --- Morandi Rose --- */
body.theme-morandi-rose {
  --bg: #ece5e2; --bg-elevated: #f6f1ef; --bg-sidebar: #e5ddd9; --bg-editor: #f8f4f2;
  --text: #423a37; --text-strong: #271f1c; --muted: #70645f; --faint: #9c918b;
  --border: #ccc1bc; --border-soft: #ddd4cf;
  --hover-elevated: #efe8e5; --code-bg: #efe8e5; --code-border: #ddd4cf;
  --code-block-bg: #2a2730; --code-block-border: rgba(0,0,0,0.25);
  --accent: #a8807b; --accent-strong: #855e59; --accent-soft: rgba(168,128,123,0.18);
  --danger: #b85c57; --success: #7d8a6a;
}
/* --- Morandi Mist --- */
body.theme-morandi-blue {
  --bg: #e4e7ea; --bg-elevated: #f1f3f5; --bg-sidebar: #dce0e4; --bg-editor: #f5f7f8;
  --text: #383d42; --text-strong: #1f242a; --muted: #656d74; --faint: #939ba2;
  --border: #c2c8ce; --border-soft: #d6dade;
  --hover-elevated: #eaedf0; --code-bg: #e9edf0; --code-border: #d6dade;
  --code-block-bg: #2a2730; --code-block-border: rgba(0,0,0,0.25);
  --accent: #7e94a6; --accent-strong: #5d7385; --accent-soft: rgba(126,148,166,0.18);
  --danger: #b3645f; --success: #6f8a87;
}
/* --- Morandi Dusk --- */
body.theme-morandi-dark {
  --bg: #21242b; --bg-elevated: #282c34; --bg-sidebar: #23262d; --bg-editor: #262a31;
  --text: #c3c7cd; --text-strong: #e7eaef; --muted: #878c95; --faint: #5f636b;
  --border: #3a3f49; --border-soft: #313640;
  --hover-elevated: #2e333c; --code-bg: #2b2f37; --code-border: #3a3f49;
  --code-block-bg: #16191f; --code-block-border: rgba(255,255,255,0.06);
  --accent: #92a3b8; --accent-strong: #aebfd2; --accent-soft: rgba(146,163,184,0.18);
  --danger: #cf7a76; --success: #8aa888;
}

/* ===== Prose Content ===== */
.hm-doc {
  font-family: var(--font-write);
  font-size: var(--hm-font-size, 16px);
  line-height: var(--hm-line-height, 1.8);
  color: var(--text);
  max-width: var(--hm-content-width, 820px);
  margin: 0 auto;
  padding: 40px clamp(24px, 6vw, 72px) 25vh;
  overflow-wrap: anywhere;
}
.hm-doc > *:first-child { margin-top: 0; }
.hm-doc > *:last-child { margin-bottom: 0; }
.hm-doc h1, .hm-doc h2, .hm-doc h3, .hm-doc h4, .hm-doc h5, .hm-doc h6 {
  font-weight: 700; line-height: 1.3; margin-top: 1.8em; margin-bottom: 0.65em; scroll-margin-top: 24px;
}
.hm-doc h1 { font-size: 2.25em; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.3em; }
.hm-doc h2 { font-size: 1.75em; }
.hm-doc h3 { font-size: 1.4em; font-weight: 600; }
.hm-doc h4 { font-size: 1.2em; font-weight: 600; color: var(--text); }
.hm-doc h5, .hm-doc h6 { font-size: 1em; font-weight: 600; color: var(--text); }
.hm-doc p { margin: 0.8em 0; line-height: inherit; }
.hm-doc a { color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); }
.hm-doc a:hover { color: var(--accent-strong); border-color: var(--accent); }
.hm-doc blockquote {
  margin: 1.35em 0; padding: 0.65em 1.1em;
  border-left: 3px solid color-mix(in srgb, var(--accent) 72%, var(--border));
  background: var(--code-bg); color: var(--muted);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.hm-doc blockquote p { margin: 0.4em 0; }
.hm-doc code {
  font-family: var(--font-mono); font-size: 0.9em;
  background: var(--code-bg); border: 1px solid var(--code-border);
  border-radius: var(--radius-sm); padding: 0.12em 0.34em;
}
.hm-doc pre {
  background: var(--code-block-bg); border: 1px solid var(--code-block-border);
  border-radius: var(--radius-md); padding: 1em 1.1em; overflow: auto;
  margin: 1.2em 0; font-family: var(--font-mono); line-height: 1.55;
}
.hm-doc pre code { background: transparent; border: none; padding: 0; font-size: 0.88em; white-space: pre; color: #e8e3d8; }
.hm-doc pre.hljs { background: var(--code-block-bg) !important; }
.hm-doc table { border-collapse: collapse; width: max-content; max-width: 100%; margin: 1.35em 0; }
.hm-doc th, .hm-doc td { border: none; border-bottom: 1px solid var(--border-soft); padding: 0.5em 0.75em; text-align: left; vertical-align: top; }
.hm-doc th { background: var(--code-bg); font-weight: 600; }
.hm-doc tr:last-child td { border-bottom: none; }
.hm-doc td p, .hm-doc th p { margin: 0; }
.hm-doc ul, .hm-doc ol { padding-left: 1.6em; margin: 0.8em 0; }
.hm-doc li { margin: 0.22em 0; line-height: inherit; }
.hm-doc li > p { margin: 0.15em 0; }
.hm-doc li::marker { color: var(--accent); font-weight: 500; }
.hm-doc li:has(> input[type="checkbox"]) { list-style: none; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; column-gap: 0.55em; padding-left: 0; }
.hm-doc li > input[type="checkbox"] { margin: 0.55em 0 0; accent-color: var(--accent); width: 16px; height: 16px; }
.hm-doc hr { border: 0; border-top: 1px solid var(--border-soft); margin: 2.2em 0; }
.hm-doc img { display: block; max-width: 100%; height: auto; border-radius: var(--radius-md); margin: 1.4em auto; }
.hm-doc figure { margin: 1.5em 0; }
.hm-doc figcaption { font-size: 0.85em; color: var(--muted); text-align: center; margin-top: 0.5em; }
.hm-doc .katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 4px 2px; }
.hm-doc .katex { color: inherit; font-size: 1.05em; }
.hm-doc .hm-mermaid { display: flex; justify-content: center; padding: 8px 4px; }
.hm-doc .hm-mermaid svg { height: auto; max-width: 100%; }
.hm-doc .hm-mermaid-error { color: var(--danger); font-size: 0.9em; padding: 1em; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.hm-doc .hm-mermaid-loading { color: var(--muted); font-size: 0.9em; padding: 1em; }
.hm-doc .hm-frontmatter { background: var(--code-bg); border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: 1em 1.2em; margin-bottom: 2em; font-family: var(--font-mono); font-size: 0.85em; color: var(--muted); overflow-x: auto; }
#hm-scroll::-webkit-scrollbar { width: 10px; }
#hm-scroll::-webkit-scrollbar-track { background: transparent; }
#hm-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }
#hm-scroll::-webkit-scrollbar-thumb:hover { background: var(--muted); }
@media print { #hm-outline { display: none !important; } #hm-scroll { overflow: visible; } body { background: #fff; } }
`
}

// ===== Message handling =====
window.addEventListener('message', function (event) {
  var msg = event.data

  if (msg.type === 'update') {
    var content = document.getElementById('hm-content')
    var fmHtml = msg.frontmatter
      ? '<div class="hm-frontmatter"><pre>' + escapeHtml(msg.frontmatter) + '</pre></div>'
      : ''
    content.innerHTML = fmHtml + msg.html
    generateOutline()
    renderMermaidBlocks()
  } else if (msg.type === 'theme') {
    currentTheme = msg.theme
    applyTheme(msg.theme)
    setTimeout(refreshMermaid, 50)
  } else if (msg.type === 'colorThemeChanged') {
    if (currentTheme === 'auto') { applyTheme('auto'); setTimeout(refreshMermaid, 50) }
  } else if (msg.type === 'toggleOutline') {
    outlineVisible = !outlineVisible
    document.getElementById('hm-outline').classList.toggle('hm-hidden', !outlineVisible)
  } else if (msg.type === 'error') {
    var content = document.getElementById('hm-content')
    content.innerHTML = '<p class="hm-mermaid-error">Render error: ' + escapeHtml(msg.message || '') + '</p>'
  }
})

// ===== Init =====
function init() {
  injectCSS()

  var opts = window.__horsemd || {}
  currentTheme = opts.theme || 'auto'
  applyTheme(currentTheme)
  outlineVisible = opts.showOutline !== false

  if (opts.fontSize) document.documentElement.style.setProperty('--hm-font-size', opts.fontSize + 'px')
  if (opts.contentWidth) {
    var widths = { compact: '680px', standard: '820px', wide: '1040px', full: 'none' }
    document.documentElement.style.setProperty('--hm-content-width', widths[opts.contentWidth] || '820px')
  }

  // Observe VSCode theme-kind attribute changes (for auto theme)
  var observer = new MutationObserver(function () {
    if (currentTheme === 'auto') applyTheme('auto')
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] })

  vscode.postMessage({ type: 'ready' })
}

try {
  init()
  window.__horsemd_ready = true
} catch (e) {
  var el = document.getElementById('hm-content')
  if (el) el.innerHTML = '<pre style="padding:2em;color:#c93b3b;font-family:monospace;white-space:pre-wrap">init() error: ' + (e.message || e) + '\\n' + (e.stack || '') + '</pre>'
  console.error('[HorseMD] init error:', e)
}
