import { COMMAND_DEFINITIONS, resolveCommandId } from './command-definitions.js'
import { normalizeKeybindings } from './keybinding-normalize.js'
import { isAlwaysReservedKeybinding } from './keybinding-reserved.js'

export const KEYBINDINGS_KEY = 'horsemd.keybindings.v1'
export const KEYBINDINGS_VERSION = 1

export function getDefaultKeybindingMap(commands = COMMAND_DEFINITIONS) {
  return Object.fromEntries(
    commands.map((command) => [command.id, normalizeKeybindings(command.defaultKeybindings || [])])
  )
}

export function normalizeKeybindingOverrides(overrides, commands = COMMAND_DEFINITIONS) {
  const knownIds = new Set(commands.map((command) => command.id))
  const out = {}
  if (!overrides || typeof overrides !== 'object') return out
  for (const [commandId, bindings] of Object.entries(overrides)) {
    const resolvedId = resolveCommandId(commandId)
    if (!resolvedId || !knownIds.has(resolvedId)) continue
    const rawBindings = Array.isArray(bindings) ? bindings : []
    const normalized = normalizeKeybindings(rawBindings).filter((binding) => !isAlwaysReservedKeybinding(binding))
    if (rawBindings.length > 0 && normalized.length === 0) continue
    out[resolvedId] = normalized
  }
  return out
}

export function getEffectiveKeybindingMap(overrides = {}, commands = COMMAND_DEFINITIONS) {
  const defaults = getDefaultKeybindingMap(commands)
  const normalized = normalizeKeybindingOverrides(overrides, commands)
  return {
    ...defaults,
    ...normalized
  }
}

export function loadKeybindingState(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(KEYBINDINGS_KEY) || '{}')
    return {
      version: KEYBINDINGS_VERSION,
      overrides: normalizeKeybindingOverrides(raw.overrides)
    }
  } catch {
    return { version: KEYBINDINGS_VERSION, overrides: {} }
  }
}

export function saveKeybindingState(state, storage = globalThis.localStorage) {
  const payload = {
    version: KEYBINDINGS_VERSION,
    overrides: normalizeKeybindingOverrides(state?.overrides)
  }
  try {
    storage.setItem(KEYBINDINGS_KEY, JSON.stringify(payload))
  } catch {
    /* localStorage quota or private mode failure: skip */
  }
  return payload
}

export function setCommandKeybindings(state, commandId, bindings) {
  const next = {
    version: KEYBINDINGS_VERSION,
    overrides: { ...(state?.overrides || {}) }
  }
  next.overrides[commandId] = normalizeKeybindings(bindings)
  next.overrides = normalizeKeybindingOverrides(next.overrides)
  return next
}

export function resetCommandKeybindings(state, commandId) {
  const next = {
    version: KEYBINDINGS_VERSION,
    overrides: { ...(state?.overrides || {}) }
  }
  delete next.overrides[commandId]
  return next
}

export function resetAllKeybindings() {
  return { version: KEYBINDINGS_VERSION, overrides: {} }
}
