import { normalizeHtmlOptions } from '../shared/html-options.js'

const THEMES = Object.freeze({
  clean: { bg: '#ffffff', page: '#ffffff', text: '#25282d', muted: '#6d737c', line: '#dfe2e6', soft: '#f4f5f6', accent: '#3f6f59', code: '#f2f3f4' },
  paper: { bg: '#eeece6', page: '#fbfaf6', text: '#302d28', muted: '#746e65', line: '#d8d2c7', soft: '#f2eee5', accent: '#6c7650', code: '#f0ece3' },
  reading: { bg: '#eef1ef', page: '#fdfefd', text: '#26302c', muted: '#69746f', line: '#d7ded9', soft: '#eef3f0', accent: '#2f7357', code: '#edf2ef' },
  night: { bg: '#17191c', page: '#202327', text: '#e7e8e9', muted: '#a4a8ad', line: '#3b3f45', soft: '#282c31', accent: '#8fc6a6', code: '#292d32' }
})

const WIDTHS = Object.freeze({ compact: '680px', standard: '820px', wide: '1040px', full: 'none' })

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const normalizeHeadings = (headings, depth) => (Array.isArray(headings) ? headings : [])
  .map((heading, index) => ({
    id: String(heading?.id || `hm-html-heading-${index + 1}`),
    level: Math.min(6, Math.max(1, Number(heading?.level) || 1)),
    text: String(heading?.text || '').trim()
  }))
  .filter((heading) => heading.text && heading.level <= depth)

export function buildHtmlToc(headings, options = {}) {
  const page = normalizeHtmlOptions(options)
  if (!page.includeToc) return ''
  const items = normalizeHeadings(headings, page.tocDepth)
  if (!items.length) return ''
  const root = { level: 0, children: [] }
  const stack = [root]
  for (const heading of items) {
    while (stack.length > 1 && stack.at(-1).level >= heading.level) stack.pop()
    const node = { ...heading, children: [] }
    stack.at(-1).children.push(node)
    stack.push(node)
  }
  const render = (nodes) => `<ol>${nodes.map((node) => (
    `<li><a href="#${escapeHtml(node.id)}">${escapeHtml(node.text)}</a>${node.children.length ? render(node.children) : ''}</li>`
  )).join('')}</ol>`
  return `<nav class="hm-html-toc"><h2>${escapeHtml(page.tocTitle)}</h2>${render(root.children)}</nav>`
}

export function buildHtmlDocument(source, options = {}) {
  const payload = typeof source === 'string' ? { html: source, headings: [], title: '' } : source || {}
  const page = normalizeHtmlOptions(options)
  const theme = THEMES[page.theme]
  const title = String(payload.title || 'HorseMD')
  const maxWidth = WIDTHS[page.contentWidth]
  const shellWidth = maxWidth === 'none'
    ? 'width:calc(100% - 40px);max-width:none;'
    : `width:min(calc(100% - 40px),${maxWidth});max-width:${maxWidth};`
  const cover = page.includeDocumentTitle && title
    ? `<header class="hm-html-cover"><h1>${escapeHtml(title)}</h1></header>`
    : ''
  const toc = buildHtmlToc(payload.headings, page)
  const csp = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"
  const css = `
    :root{color-scheme:${page.theme === 'night' ? 'dark' : 'light'};--bg:${theme.bg};--page:${theme.page};--text:${theme.text};--muted:${theme.muted};--line:${theme.line};--soft:${theme.soft};--accent:${theme.accent};--code:${theme.code};--content-width:${maxWidth};--font-size:${page.fontSizePx}px;--line-height:${page.lineHeight}}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC",sans-serif;font-size:var(--font-size);line-height:var(--line-height);letter-spacing:0}
    .hm-html-shell{${shellWidth}margin:32px auto;min-height:calc(100vh - 64px);padding:clamp(30px,6vw,72px);background:var(--page);box-shadow:0 10px 34px rgba(20,24,22,.08)}
    .hm-html-cover{padding-bottom:2rem;margin-bottom:2.5rem;border-bottom:1px solid var(--line)}.hm-html-cover h1{margin:0;font-size:2.4em;line-height:1.18}
    .doc{overflow-wrap:anywhere}.doc>*:first-child{margin-top:0}.doc>*:last-child{margin-bottom:0}
    h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.8em 0 .65em;font-weight:650;letter-spacing:0;scroll-margin-top:24px}h1{font-size:2em}h2{font-size:1.6em;border-bottom:1px solid var(--line);padding-bottom:.3em}h3{font-size:1.3em}h4{font-size:1.12em}h5,h6{font-size:1em}
    p{margin:.75em 0}a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:.18em}hr{border:0;border-top:1px solid var(--line);margin:2.2em 0}blockquote{margin:1.1em 0;padding:.2em 1em;border-left:3px solid var(--accent);color:var(--muted);background:var(--soft)}
    ul,ol{padding-left:1.6em}li{margin:.22em 0}li>p{margin:.15em 0}input[type="checkbox"]{accent-color:var(--accent)}li:has(>input[type="checkbox"]){display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;column-gap:.55em;list-style:none}li>input[type="checkbox"]{margin:.55em 0 0;opacity:1}li>input[type="checkbox"]+p{margin:.15em 0}
    code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:.9em;background:var(--code);border:1px solid var(--line);border-radius:4px;padding:.12em .34em}pre{overflow:auto;margin:1.2em 0;padding:1em 1.1em;background:var(--code);border:1px solid var(--line);border-radius:6px;line-height:1.55}pre code{padding:0;border:0;background:transparent;font-size:.88em;white-space:pre}
    table{border-collapse:collapse;width:max-content;max-width:100%;margin:1.25em 0;background:var(--page)}th,td{border:1px solid var(--line);padding:.42em .68em;text-align:left;vertical-align:top}th{background:var(--soft);font-weight:650}td p,th p{margin:0}
    img,svg{display:block;max-width:100%;height:auto;margin:1.4em auto}figure{margin:1.5em 0;overflow:auto}math[display="block"]{display:block;max-width:100%;overflow-x:auto;overflow-y:hidden;margin:1.4em auto;padding:.2em 0}
    .hm-html-toc{margin:0 0 3rem;padding:1.25rem 1.4rem;border:1px solid var(--line);background:var(--soft)}.hm-html-toc h2{margin:0 0 .8rem;padding:0;border:0;font-size:1.15em}.hm-html-toc ol{list-style:none;margin:.25em 0;padding-left:0}.hm-html-toc ol ol{padding-left:1.2em}.hm-html-toc li{margin:.25em 0}.hm-html-toc a{color:var(--text);text-decoration:none}.hm-html-toc a:hover{color:var(--accent);text-decoration:underline}
    @media(max-width:720px){.hm-html-shell{width:100%;max-width:none;margin:0;min-height:100vh;padding:24px 20px;box-shadow:none}.hm-html-cover h1{font-size:2em}}
    @media print{html,body{background:#fff}.hm-html-shell{width:auto;max-width:none;margin:0;padding:0;box-shadow:none}}
  `
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><main class="hm-html-shell">${cover}${toc}<article class="doc">${payload.html || ''}</article></main></body></html>`
}
