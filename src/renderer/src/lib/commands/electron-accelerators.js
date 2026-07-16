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
