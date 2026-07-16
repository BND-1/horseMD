export const MENU_COMMAND_IDS = new Set([
  'file.new',
  'file.open',
  'workspace.openFolder',
  'file.save',
  'file.saveAs',
  'file.attach',
  'file.exportPdf',
  'tab.close',
  'view.commandPalette',
  'view.showOutline',
  'view.toggleSource',
  'view.cycleTheme',
  'editor.find'
])

export const MENU_COMMAND_ALIASES = {
  new: 'file.new',
  open: 'file.open',
  openFolder: 'workspace.openFolder',
  save: 'file.save',
  saveAs: 'file.saveAs',
  attachFile: 'file.attach',
  exportPdf: 'file.exportPdf',
  closeTab: 'tab.close',
  palette: 'view.commandPalette',
  toggleOutline: 'view.showOutline',
  toggleSource: 'view.toggleSource',
  toggleTheme: 'view.cycleTheme',
  find: 'editor.find'
}

export const DEFAULT_MENU_ACCELERATORS = {
  'file.new': 'CmdOrCtrl+N',
  'file.open': 'CmdOrCtrl+O',
  'workspace.openFolder': 'CmdOrCtrl+Shift+O',
  'file.save': 'CmdOrCtrl+S',
  'file.saveAs': 'CmdOrCtrl+Shift+S',
  'file.exportPdf': 'CmdOrCtrl+Shift+E',
  'tab.close': 'CmdOrCtrl+W',
  'view.commandPalette': 'CmdOrCtrl+P',
  'view.showOutline': 'CmdOrCtrl+Shift+L',
  'view.toggleSource': 'CmdOrCtrl+/',
  'view.cycleTheme': 'CmdOrCtrl+Shift+T',
  'editor.find': 'CmdOrCtrl+F'
}

export function isValidAccelerator(value) {
  return value === null || (
    typeof value === 'string' &&
    value.length <= 80 &&
    /^[A-Za-z0-9+\-/\\[\]=,.;'` ]+$/.test(value)
  )
}

export function normalizeMenuKeybindingPayload(accelerators) {
  if (!accelerators || typeof accelerators !== 'object' || Array.isArray(accelerators)) {
    return { ok: false, error: 'invalid-payload' }
  }
  const next = {}
  const ignoredCommandIds = []
  for (const [commandId, accelerator] of Object.entries(accelerators)) {
    const resolvedId = MENU_COMMAND_IDS.has(commandId) ? commandId : MENU_COMMAND_ALIASES[commandId]
    if (!resolvedId || !MENU_COMMAND_IDS.has(resolvedId)) {
      ignoredCommandIds.push(commandId)
      continue
    }
    if (!isValidAccelerator(accelerator)) return { ok: false, error: 'invalid-accelerator' }
    next[resolvedId] = accelerator
  }
  return { ok: true, keybindings: next, ignoredCommandIds }
}

export function menuAcceleratorFor(keybindings, commandId, fallback) {
  return Object.prototype.hasOwnProperty.call(keybindings || {}, commandId)
    ? keybindings[commandId] || undefined
    : fallback
}

export function defaultMenuAcceleratorFor(commandId) {
  return DEFAULT_MENU_ACCELERATORS[commandId]
}
