const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta']

const CODE_TO_KEY = {
  Slash: 'Slash',
  Backslash: 'Backslash',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Minus: 'Minus',
  Equal: 'Equal',
  Comma: 'Comma',
  Period: 'Period',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Backquote: 'Backquote',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight'
}

const ELECTRON_KEY = {
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

const DISPLAY_KEY = {
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
}

const CHARACTER_TO_KEY = {
  '/': 'Slash',
  '\\': 'Backslash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  ',': 'Comma',
  '.': 'Period',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote'
}

function normalizeKeyName(raw) {
  const key = String(raw || '').trim()
  if (!key) return null
  if (/^Key[A-Z]$/.test(key)) return key.slice(3)
  if (/^Digit[0-9]$/.test(key)) return key.slice(5)
  if (/^Numpad[0-9]$/.test(key)) return key.slice(6)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  if (/^[A-Z]$/.test(key)) return key
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (CHARACTER_TO_KEY[key]) return CHARACTER_TO_KEY[key]
  return CODE_TO_KEY[key] || null
}

export function normalizeKeybinding(binding) {
  if (typeof binding !== 'string') return null
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return null

  const mods = new Set()
  let key = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'mod' || lower === 'cmd' || lower === 'command') mods.add('Mod')
    else if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl')
    else if (lower === 'meta') mods.add('Meta')
    else if (lower === 'alt' || lower === 'option') mods.add('Alt')
    else if (lower === 'shift') mods.add('Shift')
    else if (!key) key = normalizeKeyName(part)
    else return null
  }
  if (!key) return null

  const sortedMods = []
  if (mods.has('Mod')) sortedMods.push('Mod')
  for (const mod of MODIFIER_ORDER) {
    if (mods.has(mod)) sortedMods.push(mod)
  }
  return [...sortedMods, key].join('+')
}

export function normalizeKeybindings(bindings) {
  if (!Array.isArray(bindings)) return []
  return [...new Set(bindings.map(normalizeKeybinding).filter(Boolean))]
}

export function eventToKeybinding(event, platform = null) {
  if (!event || event.isComposing) return null
  const key = normalizeKeyName(event.code || event.key)
  if (!key) return null
  if (['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'].includes(event.code)) {
    return null
  }
  const parts = []
  const primaryIsMeta = platform === 'darwin'
  if (event.ctrlKey && platform && !primaryIsMeta) parts.push('Mod')
  else if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey && platform && primaryIsMeta) parts.push('Mod')
  else if (event.metaKey) parts.push('Meta')
  parts.push(key)
  return normalizeKeybinding(parts.join('+'))
}

export function resolveMod(binding, platform = 'darwin') {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return null
  const mod = platform === 'darwin' ? 'Meta' : 'Ctrl'
  return normalizeKeybinding(normalized.split('+').map((part) => part === 'Mod' ? mod : part).join('+'))
}

export function keybindingMatchesEvent(binding, event, platform = 'darwin') {
  const expected = resolveMod(binding, platform)
  const actual = eventToKeybinding(event)
  return !!expected && !!actual && expected === actual
}

export function keybindingToElectronAccelerator(binding) {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return null
  const parts = normalized.split('+')
  const key = parts.pop()
  const mods = parts.map((part) => part === 'Mod' ? 'CmdOrCtrl' : part)
  const electronKey = ELECTRON_KEY[key] || key
  return [...mods, electronKey].join('+')
}

export function keybindingToDisplay(binding, platform = 'darwin') {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return ''
  const parts = normalized.split('+')
  const key = parts.pop()
  const labels = parts.map((part) => {
    if (part === 'Mod') return platform === 'darwin' ? '⌘' : 'Ctrl'
    if (platform === 'darwin' && part === 'Alt') return '⌥'
    if (platform === 'darwin' && part === 'Shift') return '⇧'
    if (platform === 'darwin' && part === 'Ctrl') return '⌃'
    if (platform === 'darwin' && part === 'Meta') return '⌘'
    return part
  })
  labels.push(DISPLAY_KEY[key] || key)
  return platform === 'darwin' ? labels.join('') : labels.join('+')
}
