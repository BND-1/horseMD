import { BLOCK_COMMAND_IDS, COMMAND_BY_ID } from './command-definitions.js'
import { keybindingToDisplay } from './keybinding-normalize.js'

export function currentShortcutPlatform() {
  if (typeof window !== 'undefined' && window.api?.platform) return window.api.platform
  if (typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac')) return 'darwin'
  return 'win32'
}

export function getCommandShortcut(commandId, effectiveKeybindings, platform = currentShortcutPlatform()) {
  const command = COMMAND_BY_ID[commandId]
  if (!command) return ''
  const bindings = effectiveKeybindings?.[commandId] ?? command.defaultKeybindings ?? []
  return keybindingToDisplay(bindings[0], platform)
}

export function labelWithShortcut(label, commandId, effectiveKeybindings, platform = currentShortcutPlatform()) {
  const shortcut = getCommandShortcut(commandId, effectiveKeybindings, platform)
  return shortcut ? `${label} (${shortcut})` : label
}

export function blockCommandId(blockId) {
  return BLOCK_COMMAND_IDS[blockId] || null
}
