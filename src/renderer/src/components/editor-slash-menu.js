// Feishu-style slash menu — full menu on "/", narrows (never dismisses) as you
// type, matching Chinese/English keywords + abbreviations + Markdown symbols.
//
// Why this exists: Crepe's built-in slash (the Feature.BlockEdit menu) filters
// items by `item.label.includes(filter)` ONLY — there is no keyword field — so
// typing `h1` / `#` / `ol` against the Chinese labels matches nothing and the
// menu appears to "vanish" the moment you keep typing. We keep the EXACT same
// insert semantics (the Milkdown preset commands Crepe itself uses, see
// @milkdown/crepe .../feature/block-edit) so the inserted blocks are identical;
// we only replace the trigger/filter UX.
//
// How: a raw ProseMirror plugin (added via prosePluginsCtx, the same channel
// mathPreviewPlugin uses) whose pluginView owns a SlashProvider
// (@milkdown/kit/plugin/slash) for floating positioning + show/hide, plus a
// hand-built menu DOM. The DOM mirrors Crepe's block-edit structure
// (.milkdown-slash-menu > .menu-groups > .menu-group > h6 + li[svg,span],
// .hover/.active) so it inherits Crepe's slash CSS (theme/common/block-edit.css)
// for free, and the existing bounds-fixer in editor-dom-bindings.js (keys off
// .milkdown-slash-menu / .menu-groups) keeps it inside the pane.
//
// Crepe's own slash is neutralized via disableCrepeSlash() (its CREPE_MENU plugin
// spec is replaced with a no-op), but Feature.BlockEdit stays ENABLED so the
// block drag/add handle (.milkdown-block-handle) is preserved. Block switching
// (status bar / right-click / Ctrl+1..6) is untouched — it uses convertBlock
// (editor-html.js) + editor-dom-bindings.js's keydown, not BlockEdit's slash.

import { SlashProvider } from '@milkdown/kit/plugin/slash'
import { commandsCtx } from '@milkdown/kit/core'
import {
  clearTextInCurrentBlockCommand,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
  addBlockTypeCommand,
  selectTextNearPosCommand
} from '@milkdown/kit/preset/commonmark'
import { createTable } from '@milkdown/kit/preset/gfm'
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { pinyin as toPinyin } from 'pinyin-pro'

const KEY = new PluginKey('hm-slash-menu')

// Neutralize Crepe's built-in slash menu. BlockEdit's slash is the slice named
// "CREPE_MENU_SLASH_SPEC" (slashFactory id + "_SLASH_SPEC"); its $prose plugin
// reads a PluginSpec from that ctx slot. We replace it with a no-op view so the
// built-in menu never constructs/shows — but Feature.BlockEdit stays enabled, so
// the block drag/add handle (.milkdown-block-handle, a separate slice) is kept.
// We look the slice up by NAME (ctx.get accepts a string) because Milkdown slice
// ids are per-call Symbols: re-running slashFactory('CREPE_MENU') here would mint
// a different id and miss Crepe's registered slice.
export function disableCrepeSlash(ctx) {
  ctx.update('CREPE_MENU_SLASH_SPEC', () => ({
    view: () => ({ update() {}, destroy() {} })
  }))
}

// ---- icons (24x24; line icons use currentColor so Crepe's `.menu-group li svg`
// color rule tints them like the original menu). Headings render their level as
// text, which is the clearest signal at a glance. ----
const strokeSvg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
const textSvg = (s) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><text x="3" y="17" font-size="13" font-weight="700" letter-spacing="-0.5" fill="currentColor" font-family="-apple-system,Segoe UI,sans-serif">${s}</text></svg>`

const ICON = {
  text: strokeSvg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h11"/>'),
  quote: strokeSvg('<path d="M7 5v14"/><path d="M11 9h7M11 13h7M11 17h5"/>'),
  divider: strokeSvg('<path d="M4 12h16"/>'),
  bullet:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="4.5" cy="7" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="4.5" cy="17" r="1.6"/></svg>',
  ordered:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="1.5" y="9" font-size="7" font-weight="700" fill="currentColor" font-family="-apple-system,sans-serif">1.</text><text x="1.5" y="14.5" font-size="7" font-weight="700" fill="currentColor" font-family="-apple-system,sans-serif">2.</text><text x="1.5" y="20" font-size="7" font-weight="700" fill="currentColor" font-family="-apple-system,sans-serif">3.</text><path d="M9 7h12M9 12h12M9 17h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  task: strokeSvg(
    '<rect x="3" y="5" width="4.5" height="4.5" rx="1"/><path d="M4 7.2l1 1 1.6-1.8"/><rect x="3" y="11" width="4.5" height="4.5" rx="1"/><rect x="3" y="17" width="4.5" height="4.5" rx="1"/><path d="M10 7.2h11M10 13.2h11M10 19.2h7"/>'
  ),
  image: strokeSvg(
    '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.4"/><path d="M21 16l-5-5-9 8"/>'
  ),
  code: strokeSvg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6.5l-3 11"/>'),
  table: strokeSvg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M3 15h18M10 4v16"/>'),
  math:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="4" y="18" font-size="15" font-weight="600" fill="currentColor" font-family="-apple-system,sans-serif">∑</text></svg>'
}

// ---- command runners. Each mirrors Crepe's block-edit onRun EXACTLY: clear the
// "/query" text in the current block, then set/wrap/insert the target node via
// the Milkdown preset commands. Node types resolve from the LIVE schema
// (view.state.schema.nodes) — provably the same NodeType objects Crepe gets from
// `schema.type(ctx)`, so inserted nodes match the old menu. ----
function clearThen(ctx, commandKey, payload) {
  const commands = ctx.get(commandsCtx)
  commands.call(clearTextInCurrentBlockCommand.key)
  commands.call(commandKey, payload)
}

function node(view, name) {
  const t = view.state.schema.nodes[name]
  if (!t) console.warn('[horsemd/slash] node not in schema:', name)
  return t
}

const RUN = {
  text: (ctx, view) => clearThen(ctx, setBlockTypeCommand.key, { nodeType: node(view, 'paragraph') }),
  heading: (level) => (ctx, view) =>
    clearThen(ctx, setBlockTypeCommand.key, { nodeType: node(view, 'heading'), attrs: { level } }),
  quote: (ctx, view) => clearThen(ctx, wrapInBlockTypeCommand.key, { nodeType: node(view, 'blockquote') }),
  divider: (ctx, view) => clearThen(ctx, addBlockTypeCommand.key, { nodeType: node(view, 'hr') }),
  bullet: (ctx, view) => clearThen(ctx, wrapInBlockTypeCommand.key, { nodeType: node(view, 'bullet_list') }),
  ordered: (ctx, view) => clearThen(ctx, wrapInBlockTypeCommand.key, { nodeType: node(view, 'ordered_list') }),
  task: (ctx, view) =>
    clearThen(ctx, wrapInBlockTypeCommand.key, { nodeType: node(view, 'list_item'), attrs: { checked: false } }),
  image: (ctx, view) => {
    const nt = node(view, 'image-block') || node(view, 'image')
    if (nt) clearThen(ctx, addBlockTypeCommand.key, { nodeType: nt })
  },
  code: (ctx, view) => clearThen(ctx, setBlockTypeCommand.key, { nodeType: node(view, 'code_block') }),
  // Code block preset to a language (/java, /python, /mermaid, …). mermaid is
  // included so /mermaid inserts a diagram block (rendered via code-block preview).
  codeLang: (lang) => (ctx, view) =>
    clearThen(ctx, setBlockTypeCommand.key, { nodeType: node(view, 'code_block'), attrs: { language: lang } }),
  math: (ctx, view) =>
    clearThen(ctx, addBlockTypeCommand.key, { nodeType: node(view, 'code_block'), attrs: { language: 'LaTeX' } }),
  table: (ctx, view) => {
    const commands = ctx.get(commandsCtx)
    commands.call(clearTextInCurrentBlockCommand.key)
    const { from } = view.state.selection
    commands.call(addBlockTypeCommand.key, { nodeType: createTable(ctx, 3, 3) })
    commands.call(selectTextNearPosCommand.key, { pos: from })
  }
}

// ---- item table. label = localized display name; keywords = comma-joined
// aliases (zh+en+symbols) read fresh from i18n each render so language switches
// apply without recreating the editor. ----
const GROUP_LABEL = { text: 'slash.text', list: 'slash.list', advanced: 'slash.advanced' }

// Recognized code-fence languages for "/language" → code-block-with-language.
// [canonicalName, [aliases]]. When the slash query matches a language, the
// generic "code" item is replaced by a "code · <lang>" item that inserts a
// code_block preset to that language (Typora/Feishu behavior). Kept short on
// purpose — only the languages users actually type.
const LANGUAGES = [
  ['javascript', ['js', 'javascript']],
  ['typescript', ['ts', 'typescript']],
  ['python', ['py', 'python']],
  ['java', ['java']],
  ['go', ['go', 'golang']],
  ['rust', ['rust', 'rs']],
  ['cpp', ['cpp', 'c++', 'cxx']],
  ['csharp', ['csharp', 'c#', 'cs']],
  ['php', ['php']],
  ['ruby', ['ruby', 'rb']],
  ['swift', ['swift']],
  ['kotlin', ['kotlin', 'kt']],
  ['scala', ['scala']],
  ['sql', ['sql']],
  ['html', ['html']],
  ['css', ['css']],
  ['json', ['json']],
  ['yaml', ['yaml', 'yml']],
  ['xml', ['xml']],
  ['bash', ['bash', 'sh', 'shell', 'zsh']],
  ['powershell', ['powershell', 'ps1']],
  ['lua', ['lua']],
  ['dart', ['dart']],
  ['markdown', ['markdown', 'md']],
  ['mermaid', ['mermaid', 'mmd']],
  ['diff', ['diff', 'patch']],
  ['dockerfile', ['dockerfile']],
  ['graphql', ['graphql']]
]
// Language code-block items whose canonical name OR any alias starts with the
// query (prefix match) — so "/j" → java/javascript/json, "/m" → mermaid/markdown,
// "/c" → c/cpp/csharp/css, while a full "/java" still resolves exactly. Only
// generated when there's a query: the full "/" menu stays the clean 14 items.
// The generic "code" item is always present too; when the query is a language
// prefix it just doesn't match and is filtered out by scoring. Scoring ranks an
// exact-keyword hit ("/java") above a prefix hit ("/j"→javascript), so the most
// precise match wins.
// Pinyin matching: for a CJK label, also match its full pinyin + initial-letter
// pinyin (so "/bt" → 标题, "/bg" → 表格, "/wxlb" → 无序列表, "/biaoti" → 标题).
// Non-CJK labels pass through pinyin-pro unchanged (harmless, already covered by
// their English keywords). Cached per label — buildItems runs on every keystroke.
const PY_CACHE = new Map()
function pinyinKeywords(label) {
  if (!label) return []
  const cached = PY_CACHE.get(label)
  if (cached) return cached
  const out = new Set()
  try {
    const full = toPinyin(label, { toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '').toLowerCase()
    const first = toPinyin(label, { pattern: 'first', toneType: 'none', type: 'array' }).join('').replace(/\s+/g, '').toLowerCase()
    if (full && /[a-z]/.test(full)) out.add(full)
    if (first && /[a-z]/.test(first) && first !== full) out.add(first)
  } catch {
    /* pinyin-pro shouldn't throw on any string, but never let matching crash the menu */
  }
  const arr = [...out]
  PY_CACHE.set(label, arr)
  return arr
}

function languageItemsFor(t, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  const out = []
  for (const [name, aliases] of LANGUAGES) {
    const all = [name, ...aliases]
    if (all.some((a) => a.startsWith(q))) {
      out.push({
        id: 'code:' + name,
        group: 'advanced',
        label: t('slash.code') + ' · ' + name,
        icon: ICON.code,
        keywords: [...new Set(all)],
        run: RUN.codeLang(name)
      })
    }
  }
  return out
}

function buildItems(t, query) {
  const kw = (id) =>
    (t('slash.kw.' + id) || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  return [
    { id: 'text', group: 'text', label: t('slash.text'), icon: ICON.text, keywords: kw('text'), run: RUN.text },
    { id: 'h1', group: 'text', label: t('block.h1'), icon: textSvg('H1'), keywords: kw('h1'), run: RUN.heading(1) },
    { id: 'h2', group: 'text', label: t('block.h2'), icon: textSvg('H2'), keywords: kw('h2'), run: RUN.heading(2) },
    { id: 'h3', group: 'text', label: t('block.h3'), icon: textSvg('H3'), keywords: kw('h3'), run: RUN.heading(3) },
    { id: 'h4', group: 'text', label: t('block.h4'), icon: textSvg('H4'), keywords: kw('h4'), run: RUN.heading(4) },
    { id: 'h5', group: 'text', label: t('block.h5'), icon: textSvg('H5'), keywords: kw('h5'), run: RUN.heading(5) },
    { id: 'h6', group: 'text', label: t('block.h6'), icon: textSvg('H6'), keywords: kw('h6'), run: RUN.heading(6) },
    { id: 'quote', group: 'text', label: t('slash.quote'), icon: ICON.quote, keywords: kw('quote'), run: RUN.quote },
    { id: 'divider', group: 'text', label: t('slash.divider'), icon: ICON.divider, keywords: kw('divider'), run: RUN.divider },
    { id: 'bullet', group: 'list', label: t('slash.bullet'), icon: ICON.bullet, keywords: kw('bullet'), run: RUN.bullet },
    { id: 'ordered', group: 'list', label: t('slash.ordered'), icon: ICON.ordered, keywords: kw('ordered'), run: RUN.ordered },
    { id: 'task', group: 'list', label: t('slash.task'), icon: ICON.task, keywords: kw('task'), run: RUN.task },
    { id: 'image', group: 'advanced', label: t('slash.image'), icon: ICON.image, keywords: kw('image'), run: RUN.image },
    { id: 'code', group: 'advanced', label: t('slash.code'), icon: ICON.code, keywords: kw('code'), run: RUN.code },
    { id: 'table', group: 'advanced', label: t('slash.table'), icon: ICON.table, keywords: kw('table'), run: RUN.table },
    { id: 'math', group: 'advanced', label: t('slash.math'), icon: ICON.math, keywords: kw('math'), run: RUN.math },
    ...languageItemsFor(t, query)
  ].map((it) => ({ ...it, keywords: [...it.keywords, ...pinyinKeywords(it.label)] }))
}

// Relevance score for a query against an item. Higher = better. -1 = no match.
// Exact keyword beats prefix beats substring — this resolves symbol overlap
// (e.g. "/-" hits bullet's exact "-" keyword, not divider's "---" substring).
// Substring is gated to queries of length >= 3: for 1-2 char queries it's far
// too noisy (every keyword CONTAINING the letter matches — "title" has "i",
// "code" has "o"), so short queries use exact + prefix only.
function scoreItem(item, q) {
  if (!q) return 1
  const label = item.label.toLowerCase()
  const kws = item.keywords
  if (kws.includes(q) || label === q) return 90
  if (label.startsWith(q) || kws.some((k) => k.startsWith(q))) return 50
  if (q.length >= 3 && (label.includes(q) || kws.some((k) => k.includes(q)))) return 10
  return -1
}

// ---- selection helpers (mirror Crepe's block-edit guards) ----
function hasAncestorType($pos, name) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === name) return true
  return false
}
const isInCodeBlock = (sel) => hasAncestorType(sel.$from, 'code_block')
const isInList = (sel) => hasAncestorType(sel.$from, 'list_item')
function atEndOfBlock(sel) {
  if (!(sel instanceof TextSelection)) return false
  const { $head } = sel
  return $head.parentOffset === $head.parent.content.size
}

// ---- the menu controller. One per editor (pluginView lifetime). ----
class SlashMenu {
  constructor(ctx, view, getT) {
    this.ctx = ctx
    this.view = view
    this.getT = getT
    this.items = buildItems(getT, '')
    this.filtered = []
    this.selectedIndex = 0

    const content = document.createElement('div')
    content.className = 'milkdown-slash-menu'
    content.setAttribute('data-show', 'false')
    content.addEventListener('pointermove', this.onPointerMove)
    content.addEventListener('pointerdown', this.onPointerDown)
    content.addEventListener('pointerup', this.onPointerUp)
    this.content = content

    this.provider = new SlashProvider({
      content,
      debounce: 20,
      offset: 10,
      shouldShow: (v) => this.shouldShow(v)
    })
  }

  shouldShow(view) {
    const sel = view.state.selection
    if (isInCodeBlock(sel) || isInList(sel)) return false
    const text = this.provider.getContent(view, (n) => ['paragraph', 'heading'].includes(n.type.name))
    if (text == null) return false
    if (!atEndOfBlock(sel)) return false
    if (!text.startsWith('/')) return false
    this.render(text.slice(1))
    return true // keep showing (even empty-state) — the menu never "vanishes"
  }

  // Rebuild the filtered list + DOM. Items are re-read from i18n each render so
  // a language change applies on the next keystroke. No query → grouped full
  // menu. With a query → flat list ranked by relevance (exact keyword first),
  // like Feishu's narrowing.
  render(query) {
    const q = (query || '').trim().toLowerCase()
    const all = buildItems(this.getT, query)
    const t = this.getT
    if (q) {
      const ranked = all
        .map((it, orig) => ({ it, s: scoreItem(it, q), orig }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s || a.orig - b.orig)
      this.filtered = ranked.map((x) => x.it)
    } else {
      this.filtered = all
    }
    this.selectedIndex = 0
    if (!this.filtered.length) {
      this.content.innerHTML =
        '<div class="menu-groups"><div class="menu-group"><div class="hm-slash-empty">' +
        esc(t('slash.empty') || 'No matches') +
        '</div></div></div>'
      return
    }
    const itemLi = (it, idx) =>
      '<li class="hm-slash-item' +
      (idx === this.selectedIndex ? ' hover' : '') +
      '" data-index="' +
      idx +
      '" role="option">' +
      it.icon +
      '<span>' +
      esc(it.label) +
      '</span></li>'
    let html = '<div class="menu-groups">'
    if (q) {
      // Flat ranked list (single group) when filtering.
      html += '<div class="menu-group">'
      this.filtered.forEach((it, i) => {
        html += itemLi(it, i)
      })
      html += '</div>'
    } else {
      // Grouped full menu, in declared group order.
      const groups = []
      let cur = null
      for (const it of this.filtered) {
        if (!cur || cur.id !== it.group) {
          cur = { id: it.group, label: t(GROUP_LABEL[it.group]) || it.group, items: [] }
          groups.push(cur)
        }
        cur.items.push(it)
      }
      let idx = 0
      for (const g of groups) {
        html += '<div class="menu-group"><h6>' + esc(g.label) + '</h6>'
        for (const it of g.items) html += itemLi(it, idx++)
        html += '</div>'
      }
    }
    html += '</div>'
    this.content.innerHTML = html
  }

  highlight() {
    const lis = this.content.querySelectorAll('.hm-slash-item')
    lis.forEach((li, i) => li.classList.toggle('hover', i === this.selectedIndex))
    const target = lis[this.selectedIndex]
    if (target) target.scrollIntoView({ block: 'nearest' })
  }

  move(delta) {
    if (!this.filtered.length) return
    const n = this.filtered.length
    this.selectedIndex = (this.selectedIndex + delta + n) % n
    this.highlight()
  }

  runSelected() {
    const item = this.filtered[this.selectedIndex]
    if (!item) return
    this.provider.hide()
    item.run(this.ctx, this.view)
    this.view.focus()
  }

  shown() {
    return this.content.getAttribute('data-show') === 'true'
  }

  onKey(view, event) {
    if (!this.shown()) return false
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        this.move(1)
        return true
      case 'ArrowUp':
        event.preventDefault()
        this.move(-1)
        return true
      case 'Tab':
        event.preventDefault()
        this.move(event.shiftKey ? -1 : 1)
        return true
      case 'Enter':
        if (!this.filtered.length) {
          this.provider.hide()
          return false
        }
        event.preventDefault()
        this.runSelected()
        return true
      case 'Escape':
        event.preventDefault()
        this.provider.hide()
        return true
      default:
        return false
    }
  }

  onPointerMove = (e) => {
    const li = e.target.closest ? e.target.closest('.hm-slash-item') : null
    if (!li) return
    const idx = Number(li.dataset.index)
    if (idx !== this.selectedIndex) {
      this.selectedIndex = idx
      this.highlight()
    }
  }
  onPointerDown = (e) => {
    const li = e.target.closest ? e.target.closest('.hm-slash-item') : null
    if (li) e.preventDefault() // keep caret/selection in the editor
  }
  onPointerUp = (e) => {
    const li = e.target.closest ? e.target.closest('.hm-slash-item') : null
    if (!li) return
    this.selectedIndex = Number(li.dataset.index)
    this.runSelected()
  }

  update(view, prev) {
    this.provider.update(view, prev)
  }
  destroy() {
    this.provider.destroy()
    this.content.remove()
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

// ---- public: build the raw ProseMirror plugin. Add via prosePluginsCtx. ----
export function createSlashPlugin(ctx, getT) {
  let menu = null
  return new Plugin({
    key: KEY,
    view: (view) => {
      menu = new SlashMenu(ctx, view, getT)
      return {
        update: (v, prev) => menu && menu.update(v, prev),
        destroy: () => {
          if (menu) menu.destroy()
          menu = null
        }
      }
    },
    props: {
      handleKeyDown: (view, event) => (menu ? menu.onKey(view, event) : false)
    }
  })
}
