import { writeFile } from 'node:fs/promises'

import { COMMAND_DEFINITIONS } from '../src/renderer/src/lib/commands/command-definitions.js'
import { keybindingToDisplay, keybindingToElectronAccelerator } from '../src/renderer/src/lib/commands/keybinding-normalize.js'
import { defaultMenuAcceleratorFor } from '../src/main/menu-keybindings.js'

const OUTPUT = new URL('../docs/custom-shortcuts-default-inventory.md', import.meta.url)

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|')
}

function commandOwner(command) {
  if (command.electronAccelerator) return 'Electron menu'
  if (command.editorOwned) return 'Editor'
  if (command.handler) return 'Renderer'
  return 'Registered'
}

const lines = [
  '# 默认快捷键与菜单 Accelerator 清单',
  '',
  '> 由 `npm run shortcuts:inventory` 生成。用于自定义快捷键改造期间核对默认键位、菜单 accelerator、命令所有者和可配置状态。',
  '',
  '| Command ID | 标题 key | 分类 | 上下文 | 默认键位 | macOS 显示 | Windows/Linux 显示 | Electron accelerator | 菜单默认 | 所有者 | 可配置 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
]

for (const command of COMMAND_DEFINITIONS) {
  const bindings = command.defaultKeybindings || []
  const first = bindings[0] || ''
  const electron = first ? keybindingToElectronAccelerator(first) : ''
  lines.push([
    cell(command.id),
    cell(command.titleKey || command.fallbackTitle || ''),
    cell(command.category),
    cell(command.context),
    cell(bindings.join(', ')),
    cell(bindings.map((binding) => keybindingToDisplay(binding, 'darwin')).join(', ')),
    cell(bindings.map((binding) => keybindingToDisplay(binding, 'win32')).join(', ')),
    cell(command.electronAccelerator ? electron : ''),
    cell(command.electronAccelerator ? defaultMenuAcceleratorFor(command.id) || '' : ''),
    cell(commandOwner(command)),
    command.configurable === false ? '否' : '是'
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
}

lines.push('')
lines.push('## 说明')
lines.push('')
lines.push('- `Mod` 在 macOS 上显示为 Command，在 Windows/Linux 上显示为 Ctrl。')
lines.push('- `菜单默认` 来自主进程白名单，只覆盖 Electron 原生菜单拥有的命令。')
lines.push('- `Editor` 所有者表示首版不由全局 dispatcher 接管，避免破坏 ProseMirror、Milkdown、CodeMirror、表格和输入法行为。')
lines.push('')

await writeFile(OUTPUT, lines.join('\n'), 'utf8')
console.log(`wrote ${OUTPUT.pathname}`)
