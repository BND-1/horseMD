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

export const DEFAULT_SETTINGS = {
  pageWidth: DEFAULT_PAGE_WIDTH,
  fontSize: DEFAULT_FONT_SIZE,
  // Empty = no image host: pasted/uploaded images keep the default behavior
  // (a local object URL). When set, it's run like Typora's "custom command":
  // the image file path is appended as an argument and the command prints the
  // resulting URL to stdout.
  imageUploadCommand: '',
  aiProvider: 'openai',
  aiOpenaiApiKey: '',
  aiOpenaiBaseUrl: '',
  aiOpenaiModel: 'gpt-4o-mini',
  aiDeepseekApiKey: '',
  aiDeepseekBaseUrl: 'https://api.deepseek.com/v1',
  aiDeepseekModel: 'deepseek-chat'
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

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return {
      pageWidth: normalizeWidth(raw.pageWidth ?? DEFAULT_PAGE_WIDTH),
      fontSize: normalizeFontSize(raw.fontSize ?? DEFAULT_FONT_SIZE),
      imageUploadCommand:
        typeof raw.imageUploadCommand === 'string' ? raw.imageUploadCommand : '',
      aiProvider: raw.aiProvider === 'deepseek' ? 'deepseek' : 'openai',
      aiOpenaiApiKey: typeof raw.aiOpenaiApiKey === 'string' ? raw.aiOpenaiApiKey : raw.aiApiKey || '',
      aiOpenaiBaseUrl:
        typeof raw.aiOpenaiBaseUrl === 'string' ? raw.aiOpenaiBaseUrl : raw.aiBaseUrl || '',
      aiOpenaiModel:
        typeof raw.aiOpenaiModel === 'string' && raw.aiOpenaiModel.trim()
          ? raw.aiOpenaiModel
          : raw.aiModel || DEFAULT_SETTINGS.aiOpenaiModel,
      aiDeepseekApiKey: typeof raw.aiDeepseekApiKey === 'string' ? raw.aiDeepseekApiKey : '',
      aiDeepseekBaseUrl:
        typeof raw.aiDeepseekBaseUrl === 'string' && raw.aiDeepseekBaseUrl.trim()
          ? raw.aiDeepseekBaseUrl
          : DEFAULT_SETTINGS.aiDeepseekBaseUrl,
      aiDeepseekModel:
        typeof raw.aiDeepseekModel === 'string' && raw.aiDeepseekModel.trim()
          ? raw.aiDeepseekModel
          : DEFAULT_SETTINGS.aiDeepseekModel
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
