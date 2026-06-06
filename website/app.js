/* ───────────────────────────────────────────────────────────
   HorseMD 官网（無印风）— i18n / 淡入 / 画廊 / 下载直链
   ─────────────────────────────────────────────────────────── */

/* ── i18n ─────────────────────────────────────────────────── */
const I18N = {
  zh: {
    'nav.features': '特性', 'nav.themes': '主题',
    'hero.kicker': '免费 · 开源 · 不要账号',
    'hero.l1': '一个窗口，', 'hero.l2': '装下所有 .md 文件',
    'hero.sub': '一个免费的 Typora 平替，但不止于此。Typora 有的它都有：打字即渲染、表格、LaTeX；Typora 没有的它也有：<strong>标签页</strong>和<strong>文件树</strong>，所有文件开在同一个窗口。',
    'cta.win': '下载 Windows 版', 'cta.mac': '下载 macOS 版',
    'hero.note': '构建未签名 — Windows：更多信息 → 仍要运行 · macOS：右键 → 打开',
    'hero.caption': 'HORSEMD · 文件树 / 标签页 / 所见即所得',
    'strip.tabs': '标签页', 'strip.tree': '文件树', 'strip.i18n': 'EN / 中文', 'strip.themes': '6 套主题',
    'features.title': '它能做什么',
    'f1.title': '标签页', 'f1.body': '双击一个文件，是多一个标签，不是多一个窗口。',
    'f2.title': '文件夹工作区', 'f2.body': '整个文件夹挂在侧边栏，新建、重命名、删除都不用切出去。',
    'f3.title': '所见即所得', 'f3.body': '打字就渲染。表格、代码高亮、LaTeX、任务清单都认。',
    'f4.title': '富文本复制', 'f4.body': '复制自带格式，粘进微信公众号、邮件、Notion 都不丢样式。',
    'themes.title': '六套主题',
    'themes.light': '明亮', 'themes.dark': '暗夜', 'themes.mist': '雾',
    'themes.sage': '鼠尾草', 'themes.rose': '玫瑰', 'themes.dusk': '暮色',
    '_title': 'HorseMD — 一个窗口，装下所有 .md 文件',
    '_desc': 'HorseMD：免费开源的 Typora 平替。标签页 + 文件树 + 所见即所得，Windows 与 macOS。',
  },
  en: {
    'nav.features': 'FEATURES', 'nav.themes': 'THEMES',
    'hero.kicker': 'FREE · OPEN SOURCE · NO ACCOUNT',
    'hero.l1': 'One window.', 'hero.l2': 'Every .md file.',
    'hero.sub': 'A free Typora alternative, and then some. Everything Typora has: type-and-it-renders, tables, LaTeX. Plus what it never had: <strong>tabs</strong> and a <strong>file tree</strong>, every file in one window.',
    'cta.win': 'Download for Windows', 'cta.mac': 'Download for macOS',
    'hero.note': 'Unsigned builds — Windows: More info → Run anyway · macOS: right-click → Open',
    'hero.caption': 'HORSEMD · FILE TREE / TABS / WYSIWYG',
    'strip.tabs': 'Tabs', 'strip.tree': 'File tree', 'strip.i18n': 'EN / 中文', 'strip.themes': '6 themes',
    'features.title': 'What it does',
    'f1.title': 'Tabs', 'f1.body': 'Double-click a file and you get a new tab, not another window.',
    'f2.title': 'Folder workspace', 'f2.body': 'Your folder hangs in the sidebar. Rename, create, delete without leaving.',
    'f3.title': 'WYSIWYG', 'f3.body': 'Type and it renders. Tables, code highlighting, LaTeX, task lists.',
    'f4.title': 'Rich-text copy', 'f4.body': 'Copy keeps formatting. Paste into WeChat, email, or Notion and it stays styled.',
    'themes.title': 'Six themes',
    'themes.light': 'Light', 'themes.dark': 'Dark', 'themes.mist': 'Mist',
    'themes.sage': 'Sage', 'themes.rose': 'Rose', 'themes.dusk': 'Dusk',
    '_title': 'HorseMD — One window. Every .md file.',
    '_desc': 'HorseMD: a free Typora alternative with tabs and a file-tree workspace. Open source, for Windows and macOS.',
  },
}

const LANG_KEY = 'horsemd.site.lang'
let lang = localStorage.getItem(LANG_KEY)
  || (navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')

function applyLang() {
  const dict = I18N[lang]
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n
    if (dict[key] != null) el.innerHTML = dict[key]
  })
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = dict['_title']
  const meta = document.querySelector('meta[name="description"]')
  if (meta) meta.content = dict['_desc']
  document.getElementById('langToggle').textContent = lang === 'zh' ? 'EN' : '中文'
  localStorage.setItem(LANG_KEY, lang)
}
document.getElementById('langToggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  applyLang()
})
applyLang()

/* ── 淡入 ─────────────────────────────────────────────────── */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
  })
}, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' })
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 3) * 80}ms`
  io.observe(el)
})

requestAnimationFrame(() => {
  document.querySelectorAll('.split-line').forEach((el, i) => {
    setTimeout(() => el.classList.add('in'), 120 + i * 180)
  })
})

/* ── 主题画廊：双图交叉淡入 ───────────────────────────────── */
const imgA = document.getElementById('themeImgA')
const imgB = document.getElementById('themeImgB')
let frontIsA = true
document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    const back = frontIsA ? imgB : imgA
    const front = frontIsA ? imgA : imgB
    const swap = () => {
      back.classList.add('on')
      front.classList.remove('on')
      frontIsA = !frontIsA
    }
    back.src = `./assets/${btn.dataset.img}`
    if (back.complete) swap()
    else back.onload = swap
  })
})

/* ── 按访客系统突出对应的下载按钮 ────────────────────────── */
const isMac = /mac/i.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent)
document.getElementById(isMac ? 'dlWin' : 'dlMac').classList.replace('btn-solid', 'btn-ghost')

/* ── GitHub Releases：填充版本号与安装包直链 ─────────────── */
fetch('https://api.github.com/repos/BND-1/horseMD/releases/latest')
  .then(r => (r.ok ? r.json() : null))
  .then(rel => {
    if (!rel) return
    const ver = rel.tag_name || ''
    if (ver) {
      document.getElementById('navVersion').textContent = ver
      document.getElementById('footVersion').textContent = ver
    }
    const assets = rel.assets || []
    const win = assets.find(a => /\.exe$/i.test(a.name))
    const mac = assets.find(a => /\.dmg$/i.test(a.name))
    if (win) document.getElementById('dlWin').href = win.browser_download_url
    if (mac) document.getElementById('dlMac').href = mac.browser_download_url
  })
  .catch(() => { /* 静默回退到 releases 页 */ })
