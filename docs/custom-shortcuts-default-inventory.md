# 默认快捷键与菜单 Accelerator 清单

> 由 `npm run shortcuts:inventory` 生成。用于自定义快捷键改造期间核对默认键位、菜单 accelerator、命令所有者和可配置状态。

| Command ID | 标题 key | 分类 | 上下文 | 默认键位 | macOS 显示 | Windows/Linux 显示 | Electron accelerator | 菜单默认 | 所有者 | 可配置 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| file.new | cmd.new | file | app | Mod+N | ⌘N | Ctrl+N | CmdOrCtrl+N | CmdOrCtrl+N | Electron menu | 是 |
| file.open | cmd.open | file | app | Mod+O | ⌘O | Ctrl+O | CmdOrCtrl+O | CmdOrCtrl+O | Electron menu | 是 |
| workspace.openFolder | cmd.openFolder | file | app | Mod+Shift+O | ⌘⇧O | Ctrl+Shift+O | CmdOrCtrl+Shift+O | CmdOrCtrl+Shift+O | Electron menu | 是 |
| file.save | cmd.save | file | document | Mod+S | ⌘S | Ctrl+S | CmdOrCtrl+S | CmdOrCtrl+S | Electron menu | 是 |
| file.saveAs | cmd.saveAs | file | document | Mod+Shift+S | ⌘⇧S | Ctrl+Shift+S | CmdOrCtrl+Shift+S | CmdOrCtrl+Shift+S | Electron menu | 是 |
| file.attach | cmd.attachFile | file | document |  |  |  |  |  | Electron menu | 是 |
| file.exportPdf | cmd.exportPdf | file | document | Mod+Shift+E | ⌘⇧E | Ctrl+Shift+E | CmdOrCtrl+Shift+E | CmdOrCtrl+Shift+E | Electron menu | 是 |
| tab.close | cmd.closeTab | file | document | Mod+W | ⌘W | Ctrl+W | CmdOrCtrl+W | CmdOrCtrl+W | Electron menu | 是 |
| tab.next | cmd.nextTab | view | app | Ctrl+Tab | ⌃Tab | Ctrl+Tab |  |  | Renderer | 是 |
| tab.previous | cmd.previousTab | view | app | Ctrl+Shift+Tab | ⌃⇧Tab | Ctrl+Shift+Tab |  |  | Renderer | 是 |
| view.commandPalette | cmd.palette | view | app | Mod+P | ⌘P | Ctrl+P | CmdOrCtrl+P | CmdOrCtrl+P | Electron menu | 是 |
| view.toggleSidebar | cmd.sidebar | view | app | Mod+Shift+B | ⌘⇧B | Ctrl+Shift+B |  |  | Renderer | 是 |
| view.showFiles | cmd.files | view | app |  |  |  |  |  | Renderer | 是 |
| view.showOutline | cmd.outline | view | app | Mod+Shift+L | ⌘⇧L | Ctrl+Shift+L | CmdOrCtrl+Shift+L | CmdOrCtrl+Shift+L | Electron menu | 是 |
| view.toggleSource | cmd.source | view | document | Mod+Slash | ⌘/ | Ctrl+/ | CmdOrCtrl+/ | CmdOrCtrl+/ | Electron menu | 是 |
| view.cycleTheme | cmd.theme | view | app | Mod+Shift+T | ⌘⇧T | Ctrl+Shift+T | CmdOrCtrl+Shift+T | CmdOrCtrl+Shift+T | Electron menu | 是 |
| editor.find | cmd.find | editor | document | Mod+F | ⌘F | Ctrl+F | CmdOrCtrl+F | CmdOrCtrl+F | Electron menu | 是 |
| editor.replace | cmd.replace | editor | document | Mod+Alt+F | ⌘⌥F | Ctrl+Alt+F |  |  | Renderer | 是 |
| editor.bold | cmd.bold | editor | editor | Mod+B | ⌘B | Ctrl+B |  |  | Editor | 否 |
| editor.italic | cmd.italic | editor | editor | Mod+I | ⌘I | Ctrl+I |  |  | Editor | 否 |
| editor.highlight | cmd.highlight | editor | editor | Mod+Alt+H | ⌘⌥H | Ctrl+Alt+H |  |  | Editor | 否 |
| editor.block.paragraph | block.paragraph | editor | editor | Mod+0 | ⌘0 | Ctrl+0 |  |  | Editor | 是 |
| editor.block.h1 | block.h1 | editor | editor | Mod+1 | ⌘1 | Ctrl+1 |  |  | Editor | 是 |
| editor.block.h2 | block.h2 | editor | editor | Mod+2 | ⌘2 | Ctrl+2 |  |  | Editor | 是 |
| editor.block.h3 | block.h3 | editor | editor | Mod+3 | ⌘3 | Ctrl+3 |  |  | Editor | 是 |
| editor.block.h4 | block.h4 | editor | editor | Mod+4 | ⌘4 | Ctrl+4 |  |  | Editor | 是 |
| editor.block.h5 | block.h5 | editor | editor | Mod+5 | ⌘5 | Ctrl+5 |  |  | Editor | 是 |
| editor.block.h6 | block.h6 | editor | editor | Mod+6 | ⌘6 | Ctrl+6 |  |  | Editor | 是 |
| review.add | cmd.reviewAdd | review | document |  |  |  |  |  | Renderer | 是 |
| review.delete | cmd.reviewDelete | review | document |  |  |  |  |  | Renderer | 是 |
| review.substitute | cmd.reviewSubstitute | review | document |  |  |  |  |  | Renderer | 是 |
| review.highlight | cmd.reviewHighlight | review | document |  |  |  |  |  | Renderer | 是 |
| review.copyPrompt | cmd.reviewCopyPrompt | review | document |  |  |  |  |  | Renderer | 是 |
| review.acceptAll | cmd.reviewAcceptAll | review | document |  |  |  |  |  | Renderer | 是 |
| review.rejectAll | cmd.reviewRejectAll | review | document |  |  |  |  |  | Renderer | 是 |

## 说明

- `Mod` 在 macOS 上显示为 Command，在 Windows/Linux 上显示为 Ctrl。
- `菜单默认` 来自主进程白名单，只覆盖 Electron 原生菜单拥有的命令。
- `Editor` 所有者表示首版不由全局 dispatcher 接管，避免破坏 ProseMirror、Milkdown、CodeMirror、表格和输入法行为。
