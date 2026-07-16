export const COMMAND_CONTEXTS = {
  APP: 'app',
  DOCUMENT: 'document',
  EDITOR: 'editor',
  REVIEW: 'review'
}

export const COMMAND_CATEGORIES = {
  FILE: 'file',
  VIEW: 'view',
  EDITOR: 'editor',
  REVIEW: 'review'
}

export const BLOCK_COMMAND_IDS = {
  paragraph: 'editor.block.paragraph',
  h1: 'editor.block.h1',
  h2: 'editor.block.h2',
  h3: 'editor.block.h3',
  h4: 'editor.block.h4',
  h5: 'editor.block.h5',
  h6: 'editor.block.h6'
}

export const LEGACY_COMMAND_ALIASES = {
  new: 'file.new',
  open: 'file.open',
  openFolder: 'workspace.openFolder',
  save: 'file.save',
  saveAs: 'file.saveAs',
  attachFile: 'file.attach',
  exportPdf: 'file.exportPdf',
  closeTab: 'tab.close',
  nextTab: 'tab.next',
  previousTab: 'tab.previous',
  palette: 'view.commandPalette',
  toggleSidebar: 'view.toggleSidebar',
  toggleFiles: 'view.showFiles',
  toggleOutline: 'view.showOutline',
  toggleSource: 'view.toggleSource',
  toggleTheme: 'view.cycleTheme',
  find: 'editor.find',
  replace: 'editor.replace',
  reviewAdd: 'review.add',
  reviewDelete: 'review.delete',
  reviewSubstitute: 'review.substitute',
  reviewHighlight: 'review.highlight',
  reviewCopyPrompt: 'review.copyPrompt',
  reviewAcceptAll: 'review.acceptAll',
  reviewRejectAll: 'review.rejectAll'
}

export const COMMAND_DEFINITIONS = [
  {
    id: 'file.new',
    handler: 'new',
    titleKey: 'cmd.new',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+N'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'file.open',
    handler: 'open',
    titleKey: 'cmd.open',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+O'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'workspace.openFolder',
    handler: 'openFolder',
    titleKey: 'cmd.openFolder',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+Shift+O'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'file.save',
    handler: 'save',
    titleKey: 'cmd.save',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+S'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'file.saveAs',
    handler: 'saveAs',
    titleKey: 'cmd.saveAs',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+Shift+S'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'file.attach',
    handler: 'attachFile',
    titleKey: 'cmd.attachFile',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    electronAccelerator: true,
    capability: 'fileAttachments',
    palette: true
  },
  {
    id: 'file.exportPdf',
    handler: 'exportPdf',
    titleKey: 'cmd.exportPdf',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+Shift+E'],
    electronAccelerator: true,
    capability: 'pdfExport',
    palette: true
  },
  {
    id: 'tab.close',
    handler: 'closeTab',
    titleKey: 'cmd.closeTab',
    fallbackTitle: 'Close Tab',
    category: COMMAND_CATEGORIES.FILE,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+W'],
    electronAccelerator: true
  },
  {
    id: 'tab.next',
    handler: 'nextTab',
    titleKey: 'cmd.nextTab',
    fallbackTitle: 'Next Tab',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Ctrl+Tab']
  },
  {
    id: 'tab.previous',
    handler: 'previousTab',
    titleKey: 'cmd.previousTab',
    fallbackTitle: 'Previous Tab',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Ctrl+Shift+Tab']
  },
  {
    id: 'view.commandPalette',
    handler: 'palette',
    titleKey: 'cmd.palette',
    fallbackTitle: 'Command Palette',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+P'],
    electronAccelerator: true
  },
  {
    id: 'view.toggleSidebar',
    handler: 'toggleSidebar',
    titleKey: 'cmd.sidebar',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+Shift+B'],
    palette: true
  },
  {
    id: 'view.showFiles',
    handler: 'toggleFiles',
    titleKey: 'cmd.files',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'view.showOutline',
    handler: 'toggleOutline',
    titleKey: 'cmd.outline',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+Shift+L'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'view.toggleSource',
    handler: 'toggleSource',
    titleKey: 'cmd.source',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+Slash'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'view.cycleTheme',
    handler: 'toggleTheme',
    titleKey: 'cmd.theme',
    category: COMMAND_CATEGORIES.VIEW,
    context: COMMAND_CONTEXTS.APP,
    defaultKeybindings: ['Mod+Shift+T'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'editor.find',
    handler: 'find',
    titleKey: 'cmd.find',
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+F'],
    electronAccelerator: true,
    palette: true
  },
  {
    id: 'editor.replace',
    handler: 'replace',
    titleKey: 'cmd.replace',
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: ['Mod+Alt+F'],
    palette: true
  },
  {
    id: 'editor.bold',
    titleKey: 'cmd.bold',
    fallbackTitle: 'Bold',
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.EDITOR,
    defaultKeybindings: ['Mod+B'],
    editorOwned: true,
    configurable: false
  },
  {
    id: 'editor.italic',
    titleKey: 'cmd.italic',
    fallbackTitle: 'Italic',
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.EDITOR,
    defaultKeybindings: ['Mod+I'],
    editorOwned: true,
    configurable: false
  },
  {
    id: 'editor.highlight',
    titleKey: 'cmd.highlight',
    fallbackTitle: 'Highlight',
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.EDITOR,
    defaultKeybindings: ['Mod+Alt+H'],
    editorOwned: true,
    configurable: false
  },
  {
    id: 'editor.block.paragraph',
    titleKey: 'block.paragraph',
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.EDITOR,
    defaultKeybindings: ['Mod+0'],
    editorOwned: true
  },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({
    id: `editor.block.h${level}`,
    titleKey: `block.h${level}`,
    category: COMMAND_CATEGORIES.EDITOR,
    context: COMMAND_CONTEXTS.EDITOR,
    defaultKeybindings: [`Mod+${level}`],
    editorOwned: true
  })),
  {
    id: 'review.add',
    handler: 'reviewAdd',
    titleKey: 'cmd.reviewAdd',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'review.delete',
    handler: 'reviewDelete',
    titleKey: 'cmd.reviewDelete',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'review.substitute',
    handler: 'reviewSubstitute',
    titleKey: 'cmd.reviewSubstitute',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'review.highlight',
    handler: 'reviewHighlight',
    titleKey: 'cmd.reviewHighlight',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'review.copyPrompt',
    handler: 'reviewCopyPrompt',
    titleKey: 'cmd.reviewCopyPrompt',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'review.acceptAll',
    handler: 'reviewAcceptAll',
    titleKey: 'cmd.reviewAcceptAll',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  },
  {
    id: 'review.rejectAll',
    handler: 'reviewRejectAll',
    titleKey: 'cmd.reviewRejectAll',
    category: COMMAND_CATEGORIES.REVIEW,
    context: COMMAND_CONTEXTS.DOCUMENT,
    defaultKeybindings: [],
    palette: true
  }
]

export const COMMAND_BY_ID = Object.fromEntries(COMMAND_DEFINITIONS.map((command) => [command.id, command]))
export const COMMAND_BY_HANDLER = Object.fromEntries(
  COMMAND_DEFINITIONS.filter((command) => command.handler).map((command) => [command.handler, command])
)

export function resolveCommandId(commandIdOrAlias) {
  if (COMMAND_BY_ID[commandIdOrAlias]) return commandIdOrAlias
  return LEGACY_COMMAND_ALIASES[commandIdOrAlias] || null
}

export function getCommandHandler(commandIdOrAlias) {
  const commandId = resolveCommandId(commandIdOrAlias)
  return commandId ? COMMAND_BY_ID[commandId]?.handler || null : null
}

export function getCommandTitle(command, t) {
  const title = command.titleKey ? t(command.titleKey) : ''
  if (title && title !== command.titleKey) return title
  return command.fallbackTitle || command.id
}

export function isCommandAvailable(command, capabilities = {}) {
  return !command.capability || capabilities[command.capability] !== false
}
