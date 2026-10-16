import { normalizeKeybinding, resolveMod } from './keybinding-normalize.js'

const STRUCTURAL_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
])

const TEXT_INPUT_KEYS = new Set(['Space'])

const SYSTEM_EDITING_KEYS = new Set([
  'Mod+A',
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+Z',
  'Mod+Shift+Z'
])

const APP_WINDOW_KEYS = new Set([
  'Mod+Q',
  'Mod+M',
  'Mod+H',
  'Mod+Alt+I',
  'Mod+Shift+I',
  'F11',
  'F12',
  'Alt+F4'
])

function splitBinding(binding) {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return null
  const parts = normalized.split('+')
  const key = parts.pop()
  return { normalized, key, modifiers: parts }
}

export function getReservedKeybindingReason(binding, platform = 'darwin') {
  const parsed = splitBinding(binding)
  if (!parsed) return 'invalid'
  const { normalized, key, modifiers } = parsed
  const resolved = resolveMod(normalized, platform)

  if (!modifiers.length && STRUCTURAL_KEYS.has(key)) return 'structural'
  if (!modifiers.length && (TEXT_INPUT_KEYS.has(key) || key.length === 1)) return 'textInput'
  if ([...SYSTEM_EDITING_KEYS].some((reserved) => resolveMod(reserved, platform) === resolved)) {
    return 'systemEditing'
  }
  if ([...APP_WINDOW_KEYS].some((reserved) => resolveMod(reserved, platform) === resolved)) {
    return 'appWindow'
  }
  if (key === 'Escape' || key === 'Enter' || key === 'Tab') return 'structural'
  return null
}

export function isReservedKeybinding(binding, platform = 'darwin') {
  return !!getReservedKeybindingReason(binding, platform)
}

export function isAlwaysReservedKeybinding(binding) {
  const parsed = splitBinding(binding)
  if (!parsed) return true
  const { key, modifiers } = parsed
  if (!modifiers.length && STRUCTURAL_KEYS.has(key)) return true
  if (!modifiers.length && (TEXT_INPUT_KEYS.has(key) || key.length === 1)) return true
  if (key === 'Escape' || key === 'Enter' || key === 'Tab') return true
  return false
}
