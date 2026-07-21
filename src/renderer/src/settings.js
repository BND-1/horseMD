// User preferences persisted to localStorage, separate from the session state
// (open tabs, workspace…) in paths.js. Currently holds the editor page width and
// the image-host upload command. Kept small and self-contained so the Settings
// modal and App can share one source of truth.

export const SETTINGS_KEY = 'horsemd.settings.v1'

// Page-width slider bounds (px). 'full' (a preset, not a slider value) fills the
// pane instead.
export const PAGE_WIDTH_MIN = 600
export const PAGE_WIDTH_MAX = 1400
export const DEFAULT_PAGE_WIDTH = 800

// Quick presets shown as chips above the slider. 'full' = fill the editor pane.
export const PAGE_WIDTH_PRESETS = [
  { id: 'narrow', width: 700 },
  { id: 'medium', width: 800 },
  { id: 'wide', width: 1000 },
  { id: 'full', width: 'full' }
]

// Editor body font size (px). Applies only to the document content, not the app
// chrome (tabs / sidebar / status bar).
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 24
export const DEFAULT_FONT_SIZE = 16

// Quick presets shown as a segmented control above the fine-tune slider.
export const FONT_SIZE_PRESETS = [
  { id: 'small', size: 14 },
  { id: 'medium', size: 16 },
  { id: 'large', size: 18 },
  { id: 'xlarge', size: 20 }
]

// Source-mode font size OFFSET (px) relative to the editor body font size
// (issue #78). Source mode shows raw Markdown in a monospace textarea; its size
// tracks the rich editor font. Default 0 = the SAME size as the document body
// (there's no reason source should differ). The offset is kept as an optional
// knob: a low-vision reader can push source larger, or someone can shrink it to
// fit more raw Markdown on screen.
export const SOURCE_FONT_OFFSET_MIN = -4
export const SOURCE_FONT_OFFSET_MAX = 8
export const DEFAULT_SOURCE_FONT_OFFSET = 0

// Editor body line-height (unitless). Default matches the built-in stylesheet.
export const LINE_HEIGHT_MIN = 1.4
export const LINE_HEIGHT_MAX = 2.4
export const DEFAULT_LINE_HEIGHT = 1.85
export const LINE_HEIGHT_PRESETS = [
  { id: 'compact', value: 1.6 },
  { id: 'standard', value: 1.85 },
  { id: 'relaxed', value: 2.0 },
  { id: 'loose', value: 2.2 }
]

// Space between paragraphs (em). 0 = paragraphs sit flush.
export const PARA_SPACING_MIN = 0
export const PARA_SPACING_MAX = 2
export const DEFAULT_PARA_SPACING = 0.8
export const PARA_SPACING_PRESETS = [
  { id: 'tight', value: 0.4 },
  { id: 'standard', value: 0.8 },
  { id: 'relaxed', value: 1.2 },
  { id: 'loose', value: 1.6 }
]

const round1 = (n) => Math.round(n * 10) / 10

// Default font stacks (app.css defines the same names on body.light/dark). A
// user-set font (issue #38) is PREPENDED to these so an unknown glyph still
// falls back gracefully.
export const DEFAULT_FONT_WRITE =
  "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif"
export const DEFAULT_FONT_MONO =
  "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, 'Courier New', monospace"

// CSS snippets follow Obsidian's useful model: several small, named overrides
// can be enabled independently and compose in list order. Keep the old string
// key below for backwards compatibility with versions that predate snippets.
export const DEFAULT_USER_CSS_SNIPPETS = [
  { id: 'default', name: '', enabled: true, css: '' }
]

export function normalizeUserCssSnippets(raw, legacyCss = '') {
  const usedIds = new Set()
  const snippets = Array.isArray(raw)
    ? raw.slice(0, 40).reduce((items, value, index) => {
      if (!value || typeof value !== 'object' || typeof value.css !== 'string') return items
      let id = typeof value.id === 'string' ? value.id.trim().slice(0, 80) : ''
      if (!id || usedIds.has(id)) id = `snippet-${index + 1}`
      usedIds.add(id)
      items.push({
        id,
        name: typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '',
        enabled: value.enabled !== false,
        css: value.css
      })
      return items
    }, [])
    : []

  if (snippets.length) return snippets
  if (typeof legacyCss === 'string' && legacyCss) {
    return [{ id: 'legacy', name: '', enabled: true, css: legacyCss }]
  }
  return DEFAULT_USER_CSS_SNIPPETS.map((snippet) => ({ ...snippet }))
}

// Build a font-family stack with the user's font first (quoted — names can have
// spaces, e.g. "Fira Code Nerd Font"). Empty name → null (don't override the
// default stack, and on Windows let the .app.is-win Consolas rule still apply).
export const fontStack = (name, base) => {
  const n = (name || '').trim().replace(/'/g, '')
  return n ? `'${n}', ${base}` : null
}

export const DEFAULT_SETTINGS = {
  pageWidth: DEFAULT_PAGE_WIDTH,
  fontSize: DEFAULT_FONT_SIZE,
  // Source-mode font size offset relative to fontSize (issue #78).
  sourceFontOffset: DEFAULT_SOURCE_FONT_OFFSET,
  lineHeight: DEFAULT_LINE_HEIGHT,
  paragraphSpacing: DEFAULT_PARA_SPACING,
  // Document (writing) + code font overrides (issue #38). Empty = use the
  // default stack; otherwise the name leads the stack (e.g. a Nerd Font).
  fontWrite: '',
  fontMono: '',
  // Empty = no image host: pasted/uploaded images keep the default behavior
  // (a local object URL). When set, it's run like Typora's "custom command":
  // the image file path is appended as an argument and the command prints the
  // resulting URL to stdout.
  imageUploadCommand: '',
  // English spell-check (red wavy underline) in the rich editor. Default OFF
  // (cleaner for Chinese-first writing). Editor.jsx applies it as the `spellcheck`
  // attribute on the Crepe `.ProseMirror` contenteditable; other surfaces (the
  // source textarea, inputs) always opt out via spellCheck={false}.
  spellcheck: false,
  // Inline LaTeX deletion mode. "protect" prevents accidental whole-formula
  // deletion by selecting the formula on the first Backspace/Delete and only
  // deleting it on the second press. "fast" keeps the previous one-key delete.
  inlineMathDeleteMode: 'protect',
  // Show dotfiles/dotdirs (.claude, .cursor, .github, etc.) in the file tree.
  // Default off. .git/node_modules/out/dist are always hidden (IGNORED_DIRS).
  showHiddenFiles: false,
  // Legacy single CSS snippet. Retained so users can safely move between
  // versions; new UI writes userCssSnippets instead.
  userCss: '',
  userCssSnippets: DEFAULT_USER_CSS_SNIPPETS,
  // Mobile-only reading lock. Desktop intentionally never consumes this value.
  mobileReadOnly: false
}

function normalizeWidth(w) {
  if (w === 'full') return 'full'
  const n = Number(w)
  if (!Number.isFinite(n)) return DEFAULT_PAGE_WIDTH
  return Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, Math.round(n)))
}

function normalizeFontSize(s) {
  const n = Number(s)
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
}

function normalizeSourceFontOffset(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_SOURCE_FONT_OFFSET
  return Math.min(SOURCE_FONT_OFFSET_MAX, Math.max(SOURCE_FONT_OFFSET_MIN, Math.round(n)))
}

function normalizeInRange(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, round1(n)))
}

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return {
      pageWidth: normalizeWidth(raw.pageWidth ?? DEFAULT_PAGE_WIDTH),
      fontSize: normalizeFontSize(raw.fontSize ?? DEFAULT_FONT_SIZE),
      sourceFontOffset: normalizeSourceFontOffset(raw.sourceFontOffset),
      lineHeight: normalizeInRange(raw.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT),
      paragraphSpacing: normalizeInRange(
        raw.paragraphSpacing,
        PARA_SPACING_MIN,
        PARA_SPACING_MAX,
        DEFAULT_PARA_SPACING
      ),
      imageUploadCommand:
        typeof raw.imageUploadCommand === 'string' ? raw.imageUploadCommand : '',
      spellcheck: raw.spellcheck === true,
      inlineMathDeleteMode: raw.inlineMathDeleteMode === 'fast' ? 'fast' : 'protect',
      showHiddenFiles: raw.showHiddenFiles === true,
      fontWrite: typeof raw.fontWrite === 'string' ? raw.fontWrite : '',
      fontMono: typeof raw.fontMono === 'string' ? raw.fontMono : '',
      userCss: typeof raw.userCss === 'string' ? raw.userCss : '',
      userCssSnippets: normalizeUserCssSnippets(raw.userCssSnippets, raw.userCss),
      mobileReadOnly: raw.mobileReadOnly === true
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* quota / serialization failure — skip */
  }
}

// Apply the page width to the document. The width is a CSS variable read by the
// editor column; the full-width case needs a body class because the source
// editor centers via a calc() that can't collapse to "no max-width" through the
// variable alone.
export function applyPageWidth(width) {
  const root = document.documentElement
  if (width === 'full') {
    document.body.classList.add('hm-full-width')
  } else {
    document.body.classList.remove('hm-full-width')
    root.style.setProperty('--editor-max-width', (width || DEFAULT_PAGE_WIDTH) + 'px')
  }
}

// Apply the editor body font size as a CSS variable the content column reads.
// Headings, code, etc. scale relative to this via `em`, so the whole document
// grows/shrinks together; the app chrome keeps its own fixed sizes.
export function applyFontSize(size) {
  document.documentElement.style.setProperty(
    '--editor-font-size',
    normalizeFontSize(size) + 'px'
  )
}

// Apply the source-mode font offset (issue #78). `.source-editor` computes its
// font size as calc(--editor-font-size + --source-font-offset), so the source
// font tracks the body font but can be independently nudged.
export function applySourceFontOffset(offset) {
  document.documentElement.style.setProperty(
    '--source-font-offset',
    normalizeSourceFontOffset(offset) + 'px'
  )
}

// Body line-height (unitless) and paragraph top/bottom spacing (em), exposed as
// CSS variables the editor content reads.
export function applyLineHeight(value) {
  document.documentElement.style.setProperty(
    '--editor-line-height',
    String(normalizeInRange(value, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT))
  )
}

export function applyParagraphSpacing(value) {
  document.documentElement.style.setProperty(
    '--editor-para-spacing',
    normalizeInRange(value, PARA_SPACING_MIN, PARA_SPACING_MAX, DEFAULT_PARA_SPACING) + 'em'
  )
}
