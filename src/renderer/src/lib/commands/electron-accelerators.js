import { COMMAND_DEFINITIONS } from './command-definitions.js'
import { keybindingToElectronAccelerator } from './keybinding-normalize.js'

export function buildElectronAcceleratorPayload(effectiveKeybindings) {
  const payload = {}
  for (const command of COMMAND_DEFINITIONS) {
    if (!command.electronAccelerator) continue
    const binding = effectiveKeybindings?.[command.id]?.[0] || ''
    payload[command.id] = binding ? keybindingToElectronAccelerator(binding) : null
  }
  return payload
}

// Commands the main process registers with globalShortcut (they fire while the
// window is hidden to the tray). Same shape as the menu payload: command id ->
// Electron accelerator, or null when the user cleared the binding.
export function buildGlobalAcceleratorPayload(effectiveKeybindings) {
  const payload = {}
  for (const command of COMMAND_DEFINITIONS) {
    if (!command.globalAccelerator) continue
    const binding = effectiveKeybindings?.[command.id]?.[0] || ''
    payload[command.id] = binding ? keybindingToElectronAccelerator(binding) : null
  }
  return payload
}
