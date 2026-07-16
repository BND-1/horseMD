import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { COMMAND_CATEGORIES, COMMAND_DEFINITIONS, getCommandHandler, resolveCommandId } from '../src/renderer/src/lib/commands/command-definitions.js'
import { DEFAULT_MENU_ACCELERATORS, defaultMenuAcceleratorFor, menuAcceleratorFor, normalizeMenuKeybindingPayload } from '../src/main/menu-keybindings.js'
import { assertValidCommandDefinitions, validateCommandDefinitions } from '../src/renderer/src/lib/commands/command-registry.js'
import { buildElectronAcceleratorPayload } from '../src/renderer/src/lib/commands/electron-accelerators.js'
import { findKeybindingConflicts } from '../src/renderer/src/lib/commands/keybinding-conflicts.js'
import { getReservedKeybindingReason, isAlwaysReservedKeybinding, isReservedKeybinding } from '../src/renderer/src/lib/commands/keybinding-reserved.js'
import { getCommandShortcut, labelWithShortcut } from '../src/renderer/src/lib/commands/shortcut-labels.js'
import {
  eventToKeybinding,
  keybindingMatchesEvent,
  keybindingToDisplay,
  keybindingToElectronAccelerator,
  normalizeKeybinding,
  resolveMod
} from '../src/renderer/src/lib/commands/keybinding-normalize.js'
import {
  getEffectiveKeybindingMap,
  loadKeybindingState,
  normalizeKeybindingOverrides,
  saveKeybindingState,
  setCommandKeybindings
} from '../src/renderer/src/lib/commands/keybinding-store.js'
import {
  SETTINGS_BACKGROUND_HANDLERS,
  shouldBlockForSettings
} from '../src/renderer/src/lib/menuHandlers.js'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data)
  }
}

const i18nSource = readFileSync(new URL('../src/renderer/src/i18n.jsx', import.meta.url), 'utf8')
const i18nKeyCount = (key) => (i18nSource.match(new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g')) || []).length

assert.equal(normalizeKeybinding('cmd+shift+o'), 'Mod+Shift+O')
assert.equal(assertValidCommandDefinitions(), true)
assert.equal(normalizeKeybinding('Ctrl+KeyB'), 'Ctrl+B')
assert.equal(normalizeKeybinding('Mod+/'), 'Mod+Slash')
assert.equal(normalizeKeybinding('Mod+NotAKey'), null)
assert.equal(resolveMod('Mod+Slash', 'darwin'), 'Meta+Slash')
assert.equal(resolveMod('Mod+Slash', 'win32'), 'Ctrl+Slash')
assert.equal(keybindingToElectronAccelerator('Mod+Slash'), 'CmdOrCtrl+/')
assert.equal(keybindingToDisplay('Mod+Shift+S', 'darwin'), '⌘⇧S')
assert.equal(keybindingToDisplay('Mod+Shift+S', 'win32'), 'Ctrl+Shift+S')

assert.equal(eventToKeybinding({
  code: 'KeyF',
  ctrlKey: false,
  altKey: true,
  shiftKey: false,
  metaKey: true,
  isComposing: false
}), 'Alt+Meta+F')
assert.equal(eventToKeybinding({
  code: 'KeyF',
  ctrlKey: false,
  altKey: true,
  shiftKey: false,
  metaKey: true,
  isComposing: false
}, 'darwin'), 'Mod+Alt+F')
assert.equal(keybindingMatchesEvent('Mod+Alt+F', {
  code: 'KeyF',
  ctrlKey: false,
  altKey: true,
  shiftKey: false,
  metaKey: true,
  isComposing: false
}, 'darwin'), true)

const effective = getEffectiveKeybindingMap()
assert.equal(effective['file.save'][0], 'Mod+S')
assert.equal(effective['view.toggleSource'][0], 'Mod+Slash')
assert.equal(buildElectronAcceleratorPayload(effective)['view.toggleSource'], 'CmdOrCtrl+/')
assert.equal(buildElectronAcceleratorPayload({
  ...effective,
  'file.save': []
})['file.save'], null)

const state = setCommandKeybindings({ overrides: {} }, 'file.save', ['Ctrl+Alt+S'])
assert.deepEqual(state.overrides['file.save'], ['Ctrl+Alt+S'])
assert.deepEqual(normalizeKeybindingOverrides({ unknown: ['Mod+X'], 'file.save': ['cmd+s'] }), {
  'file.save': ['Mod+S']
})
assert.deepEqual(normalizeKeybindingOverrides({ save: ['cmd+alt+s'], toggleSource: [] }), {
  'file.save': ['Mod+Alt+S'],
  'view.toggleSource': []
})
assert.deepEqual(normalizeKeybindingOverrides({ 'view.toggleSidebar': ['A'] }), {})
assert.deepEqual(normalizeKeybindingOverrides({ 'file.save': ['Mod+NotAKey'] }), {})
assert.deepEqual(normalizeKeybindingOverrides({ 'file.save': [] }), { 'file.save': [] })
assert.equal(resolveCommandId('toggleSource'), 'view.toggleSource')
assert.equal(resolveCommandId('view.toggleSource'), 'view.toggleSource')
assert.equal(resolveCommandId('missingLegacyCommand'), null)
assert.equal(getCommandHandler('view.toggleSource'), 'toggleSource')
assert.equal(getCommandHandler('toggleSource'), 'toggleSource')

const corruptStorage = memoryStorage({ 'horsemd.keybindings.v1': '{bad json' })
assert.deepEqual(loadKeybindingState(corruptStorage), { version: 1, overrides: {} })
const legacyStorage = memoryStorage({
  'horsemd.keybindings.v1': JSON.stringify({
    version: 0,
    overrides: {
      'file.save': ['cmd+alt+s'],
      unknown: ['Mod+X'],
      'file.open': ['Mod+NotAKey']
    }
  })
})
assert.deepEqual(loadKeybindingState(legacyStorage), {
  version: 1,
  overrides: {
    'file.save': ['Mod+Alt+S']
  }
})
const savedStorage = memoryStorage()
assert.deepEqual(saveKeybindingState({
  overrides: {
    unknown: ['Mod+X'],
    'file.save': ['Mod+Alt+S'],
    'file.open': ['Mod+NotAKey']
  }
}, savedStorage), {
  version: 1,
  overrides: {
    'file.save': ['Mod+Alt+S']
  }
})

const commandsWithDefaults = COMMAND_DEFINITIONS.filter((command) => command.defaultKeybindings?.length)
assert.ok(commandsWithDefaults.length >= 15)
assert.equal(COMMAND_DEFINITIONS.length, 35)
assert.equal(COMMAND_DEFINITIONS.filter((command) => command.configurable === false).length, 3)
assert.equal(COMMAND_DEFINITIONS.filter((command) => command.palette).length, 21)
assert.ok(COMMAND_DEFINITIONS.filter((command) => command.palette).every((command) => command.handler && command.titleKey))
for (const command of COMMAND_DEFINITIONS) {
  assert.ok(command.fallbackTitle || i18nKeyCount(command.titleKey) >= 2, `missing i18n title for ${command.id}`)
}
for (const category of Object.values(COMMAND_CATEGORIES)) {
  const key = `settings.keyboard.category.${category}`
  assert.ok(i18nKeyCount(key) >= 2, `missing i18n category ${category}`)
}
assert.deepEqual(findKeybindingConflicts(getEffectiveKeybindingMap()), [])
assert.ok(validateCommandDefinitions([
  ...COMMAND_DEFINITIONS,
  { ...COMMAND_DEFINITIONS[0] }
]).some((error) => error.includes('Duplicate command id')))

const duplicate = {
  ...effective,
  'file.save': ['Mod+O']
}
assert.deepEqual(findKeybindingConflicts(duplicate, 'darwin'), [
  { binding: 'Meta+O', commandIds: ['file.open', 'file.save'] }
])
assert.deepEqual(findKeybindingConflicts({
  ...effective,
  'editor.find': ['Mod+Alt+1'],
  'editor.block.h1': ['Mod+Alt+1']
}, 'darwin'), [])
assert.deepEqual(findKeybindingConflicts({
  ...effective,
  'view.toggleSidebar': ['Mod+Alt+1'],
  'editor.block.h1': ['Mod+Alt+1']
}, 'darwin'), [
  { binding: 'Alt+Meta+1', commandIds: ['view.toggleSidebar', 'editor.block.h1'] }
])
assert.deepEqual(findKeybindingConflicts({
  ...effective,
  'file.save': ['Mod+Alt+2'],
  'editor.replace': ['Mod+Alt+2']
}, 'darwin'), [
  { binding: 'Alt+Meta+2', commandIds: ['file.save', 'editor.replace'] }
])

assert.equal(getReservedKeybindingReason('Enter'), 'structural')
assert.equal(getReservedKeybindingReason('Tab'), 'structural')
assert.equal(getReservedKeybindingReason('A'), 'textInput')
assert.equal(getReservedKeybindingReason('1'), 'textInput')
assert.equal(getReservedKeybindingReason('Space'), 'textInput')
assert.equal(getReservedKeybindingReason('Mod+C', 'darwin'), 'systemEditing')
assert.equal(getReservedKeybindingReason('Mod+Shift+Z', 'win32'), 'systemEditing')
assert.equal(getReservedKeybindingReason('Mod+Q', 'darwin'), 'appWindow')
assert.equal(getReservedKeybindingReason('Alt+F4', 'win32'), 'appWindow')
assert.equal(isReservedKeybinding('Mod+Alt+S', 'darwin'), false)
assert.equal(isReservedKeybinding('Mod+Shift+B', 'win32'), false)
assert.equal(isAlwaysReservedKeybinding('A'), true)
assert.equal(isAlwaysReservedKeybinding('Mod+A'), false)
assert.equal(getCommandShortcut('file.save', effective, 'darwin'), '⌘S')
assert.equal(getCommandShortcut('file.save', { ...effective, 'file.save': ['Mod+Alt+S'] }, 'darwin'), '⌘⌥S')
assert.equal(getCommandShortcut('file.save', { ...effective, 'file.save': [] }, 'darwin'), '')
assert.equal(labelWithShortcut('Save', 'file.save', effective, 'win32'), 'Save (Ctrl+S)')

for (const handler of [
  'save',
  'saveAs',
  'attachFile',
  'exportPdf',
  'toggleSidebar',
  'toggleOutline',
  'toggleFiles',
  'toggleSource',
  'find',
  'replace',
  'reviewAdd',
  'reviewDelete',
  'reviewSubstitute',
  'reviewHighlight',
  'reviewCopyPrompt',
  'reviewAcceptAll',
  'reviewRejectAll'
]) {
  assert.equal(SETTINGS_BACKGROUND_HANDLERS.has(handler), true, `settings should block ${handler}`)
  assert.equal(shouldBlockForSettings(handler, 'settings'), true, `settings should block ${handler}`)
  assert.equal(shouldBlockForSettings(handler, 'doc'), false, `doc should not block ${handler}`)
}
for (const handler of ['new', 'open', 'openFolder', 'palette', 'toggleTheme', 'closeTab']) {
  assert.equal(shouldBlockForSettings(handler, 'settings'), false, `settings should allow ${handler}`)
}

assert.deepEqual(normalizeMenuKeybindingPayload({
  'file.save': 'CmdOrCtrl+Alt+S',
  'unknown.command': 'CmdOrCtrl+X',
  'view.toggleSource': null
}), {
  ok: true,
  keybindings: {
    'file.save': 'CmdOrCtrl+Alt+S',
    'view.toggleSource': null
  },
  ignoredCommandIds: ['unknown.command']
})
assert.deepEqual(normalizeMenuKeybindingPayload({
  save: 'CmdOrCtrl+Alt+S',
  toggleSource: null
}), {
  ok: true,
  keybindings: {
    'file.save': 'CmdOrCtrl+Alt+S',
    'view.toggleSource': null
  },
  ignoredCommandIds: []
})
assert.deepEqual(normalizeMenuKeybindingPayload(null), { ok: false, error: 'invalid-payload' })
assert.deepEqual(normalizeMenuKeybindingPayload([]), { ok: false, error: 'invalid-payload' })
assert.deepEqual(normalizeMenuKeybindingPayload({ 'file.save': '<script>' }), { ok: false, error: 'invalid-accelerator' })
assert.equal(defaultMenuAcceleratorFor('file.save'), 'CmdOrCtrl+S')
assert.equal(DEFAULT_MENU_ACCELERATORS['view.toggleSource'], 'CmdOrCtrl+/')
assert.equal(menuAcceleratorFor({ 'file.save': 'CmdOrCtrl+Alt+S' }, 'file.save', 'CmdOrCtrl+S'), 'CmdOrCtrl+Alt+S')
assert.equal(menuAcceleratorFor({ 'file.save': null }, 'file.save', 'CmdOrCtrl+S'), undefined)
assert.equal(menuAcceleratorFor({}, 'file.save', 'CmdOrCtrl+S'), 'CmdOrCtrl+S')

console.log('keybinding tests passed')
