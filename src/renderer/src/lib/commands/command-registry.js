import { COMMAND_DEFINITIONS } from './command-definitions.js'
import { findKeybindingConflicts } from './keybinding-conflicts.js'
import { getDefaultKeybindingMap } from './keybinding-store.js'

export function validateCommandDefinitions(commands = COMMAND_DEFINITIONS) {
  const errors = []
  const ids = new Set()
  const handlers = new Set()

  for (const command of commands) {
    if (!command?.id || typeof command.id !== 'string') {
      errors.push('Command is missing a stable id')
      continue
    }
    if (ids.has(command.id)) errors.push(`Duplicate command id: ${command.id}`)
    ids.add(command.id)

    if (!command.titleKey && !command.fallbackTitle) {
      errors.push(`Command ${command.id} is missing title metadata`)
    }
    if (!command.category) errors.push(`Command ${command.id} is missing a category`)
    if (!command.context) errors.push(`Command ${command.id} is missing a context`)
    if (!Array.isArray(command.defaultKeybindings)) {
      errors.push(`Command ${command.id} must declare defaultKeybindings`)
    }
    if (command.handler) {
      if (handlers.has(command.handler)) errors.push(`Duplicate command handler: ${command.handler}`)
      handlers.add(command.handler)
    }
    if (command.electronAccelerator && !command.handler) {
      errors.push(`Electron command ${command.id} must map to a renderer handler`)
    }
  }

  const conflicts = findKeybindingConflicts(getDefaultKeybindingMap(commands))
  for (const conflict of conflicts) {
    errors.push(`Default shortcut conflict ${conflict.binding}: ${conflict.commandIds.join(', ')}`)
  }

  return errors
}

export function assertValidCommandDefinitions(commands = COMMAND_DEFINITIONS) {
  const errors = validateCommandDefinitions(commands)
  if (errors.length) {
    throw new Error(`Invalid command registry:\n${errors.join('\n')}`)
  }
  return true
}
