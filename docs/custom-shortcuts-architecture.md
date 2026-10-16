# 设置中心与自定义快捷键架构

> 状态：第一版已实施  
> 关联 Issue：[#63](https://github.com/BND-1/horseMD/issues/63)  
> 目标：重构设置页面，并建立可持久化、可校验、跨平台的自定义快捷键系统，同时保持现有命令行为不变。

## 0. 当前落地状态

第一版已经落地：

- `SettingsView.jsx` 已降为设置壳层，具体模块搬到 `src/renderer/src/components/settings/`。
- 新增统一命令定义、键位规范化、冲突检测、持久化和 Electron accelerator 转换模块。
- `command-registry.js` 会校验重复命令 ID、缺失标题元数据、缺默认键位声明和默认快捷键冲突。
- 快捷键配置存储在 `localStorage["horsemd.keybindings.v1"]`，不污染文档 session 或 `horsemd.settings.v1`。
- 设置 > 键盘快捷键支持录制、清空、单项恢复、全部恢复默认和冲突提示。
- 录制器会拒绝结构键、普通文本输入键、标准编辑键和应用/系统窗口保留键，并显示具体原因。
- Electron 菜单通过 `menu:setKeybindings` 白名单 IPC 同步应用级 accelerator。
- Renderer 全局快捷键已接入用户配置：标签切换、侧边栏、查找、替换。
- 富文本标题/正文切换已接入用户配置，并通过 ref 读取最新映射，不重建 Crepe。

仍然保守冻结的范围：

- 粗体、斜体仍由 ProseMirror 默认 keymap 拥有。
- 高亮仍由 Milkdown keymap 拥有。
- 表格、CodeMirror、输入法、复制/粘贴/撤销/重做、Enter、Tab、方向键和 Escape 不进入首版自定义。

这个边界是有意设计：这些按键直接参与编辑器结构、输入法和第三方插件生命周期，后续必须逐项迁移和回归，不能在设置页里先开放一个“改了但不一定生效”的入口。

## 1. 为什么先设计再修改

HorseMD 当前的快捷键不是由一个模块统一管理，而是分布在 Electron 菜单、React 全局事件、
ProseMirror 插件、CodeMirror 和若干组件中。设置页面也把所有功能直接堆在一个滚动页面里。

如果只在设置页增加一个快捷键输入框，会产生三个问题：

1. 设置可以保存，但 Electron 菜单或编辑器仍使用旧快捷键。
2. 同一次按键可能同时被主进程和 renderer 捕获，导致命令执行两次。
3. 工具栏、命令面板和菜单仍显示默认键位，与实际配置不一致。

因此本功能必须先统一“命令是什么”，再让菜单、设置页和各编辑上下文消费同一份有效键位。

## 2. 当前架构盘点

### 2.1 设置页面

当前 `src/renderer/src/components/SettingsView.jsx` 同时负责：

- 排版参数、字体枚举和实时预览。
- 主题与自定义主题。
- 拼写检查、隐藏文件、语言和图床命令。
- 版本检查和外部链接。

它是单页堆叠结构，已经超过一个组件适合承担的职责。字体选择还包含权限请求、搜索、悬停预览
和临时监听器，继续把快捷键录制与冲突处理放进该文件会放大生命周期风险。

### 2.2 应用命令

| 位置 | 当前职责 | 主要问题 |
| --- | --- | --- |
| `src/main/index.js` | Electron 菜单与固定 accelerator | 键位静态写死，无法响应 renderer 设置 |
| `src/renderer/src/lib/menuHandlers.js` | 把菜单命令字符串映射到 React 操作 | 只有执行函数，没有统一元数据 |
| `src/renderer/src/lib/menuHandlers.js` 中的 `useGlobalKeys` | 全局键盘事件与主进程菜单事件 | 键位判断分散，部分规则只支持 Ctrl |
| `src/renderer/src/lib/menuHandlers.js` 中的 `useCommands` | 命令面板条目 | 再次维护名称、ID 和执行入口 |
| `src/renderer/src/App.jsx` | 装配上述模块 | 适合继续做编排，不应承担快捷键解析 |

### 2.3 编辑器快捷键

编辑器内部还存在多条独立路径：

- `editor-dom-interactions.js` 处理 `Ctrl/Cmd+0..6` 标题与段落切换。
- `editor-highlight.js` 注册 Milkdown 高亮 keymap。
- ProseMirror/Crepe 自带粗体、斜体等默认 keymap。
- CodeMirror 和表格插件处理 `Tab`、`Enter`、`Shift+Enter` 等结构按键。
- `blocks.js`、`editor-toolbar.js`、`Topbar.jsx` 和 i18n 文案静态显示快捷键。

前四类不能用一个顶层 `window.keydown` 粗暴接管。编辑器命令必须尊重选区、输入法、
CodeMirror 焦点和 ProseMirror transaction。

### 2.4 当前默认键位基线

以下行为是迁移时必须保留的基线，不因“跨平台统一”而顺手改变：

| 命令 | 当前默认键位 | 当前所有者 |
| --- | --- | --- |
| 新建、打开、打开文件夹 | `CmdOrCtrl+N/O/Shift+O` | Electron 菜单 |
| 保存、另存为 | `CmdOrCtrl+S/Shift+S` | Electron 菜单 |
| 导出 PDF、关闭标签 | `CmdOrCtrl+Shift+E/W` | Electron 菜单 |
| 命令面板 | `CmdOrCtrl+P` | Electron 菜单 |
| 大纲、源码、主题 | `CmdOrCtrl+Shift+L`、`CmdOrCtrl+/`、`CmdOrCtrl+Shift+T` | Electron 菜单 |
| 侧边栏 | `Ctrl/Cmd+Shift+B` | renderer capture listener |
| 查找、替换 | `Ctrl/Cmd+F`、`Ctrl/Cmd+Alt+F` | renderer capture listener；查找同时存在菜单 accelerator |
| 上/下一个标签 | `Ctrl+Tab`、`Ctrl+Shift+Tab` | renderer listener，macOS 也仍是 Ctrl |
| 段落、H1-H6 | `Ctrl/Cmd+0..6` | 富文本编辑器 DOM listener |
| 粗体、斜体 | `Ctrl/Cmd+B/I` | ProseMirror 默认 keymap |
| 高亮 | `Ctrl/Cmd+Alt+H` | Milkdown keymap |

插入附件、文件面板、Review 命令等当前没有默认键位。首期可以允许用户绑定，但“无默认值”
也必须被注册表明确记录。

## 3. 设计边界

### 3.1 本期包含

- 模块化设置中心。
- 应用聚焦时生效的自定义快捷键。
- 按键录制、清除、单项恢复、全部恢复默认。
- 冲突检测和系统保留键拦截。
- macOS、Windows、Linux 的标准化与平台化显示。
- Electron 菜单、命令面板、工具提示与实际键位同步。
- 首批文件、视图、查找和编辑命令。

### 3.2 本期不包含

- 操作系统级全局快捷键，即 HorseMD 未聚焦时仍触发的 `globalShortcut`。
- 多段 chord，例如先按 `Ctrl+K` 再按 `Ctrl+S`。
- 允许用户重绑 `Enter`、`Tab`、方向键、`Escape`、复制、粘贴、撤销和重做。
- 用快捷键系统重写源码/富文本切换状态机或 Editor 生命周期。
- 移动端外接键盘的完整配置 UI。首期移动端使用现有默认行为，并通过 capability 隔离桌面能力。

## 4. 设置中心目标结构

### 4.1 页面结构

`SettingsView.jsx` 降为设置壳层，只负责导航、当前模块和公共页面布局：

```text
components/settings/
  SettingsNav.jsx
  GeneralSettings.jsx
  EditorSettings.jsx
  AppearanceSettings.jsx
  FilesSettings.jsx
  KeyboardSettings.jsx
  AboutSettings.jsx
  FontPicker.jsx
  TypographyControls.jsx
  UpdateChecker.jsx
```

建议模块：

| 模块 | 内容 |
| --- | --- |
| 常规 | 界面语言 |
| 编辑器 | 文档字体、代码字体、字号、行高、段间距、页面宽度、拼写检查 |
| 外观 | 内置主题、自定义主题、主题目录 |
| 文件与图片 | 隐藏文件、图床命令 |
| 快捷键 | 搜索、筛选、录制、冲突提示、恢复默认 |
| 关于 | 版本、检查更新、官网与仓库链接 |

桌面端使用左侧模块导航和右侧内容区。窄窗口与移动端使用紧凑的顶部模块选择，不把导航和正文
压成两列。页面分区使用无嵌套卡片的设置行，保持 HorseMD 当前安静、轻量的视觉语言。

### 4.2 生命周期规则

- 只挂载当前设置模块，避免隐藏的字体菜单或快捷键录制器继续监听窗口事件。
- 设置标签仍是临时标签，不写入文档会话恢复。
- 切离快捷键模块时必须结束录制状态并清理监听器。
- 现有状态栏排版、主题和语言快捷入口保留，与设置中心共享原设置数据。
- 设置页重构阶段只搬迁 DOM 和局部状态，不改变已有设置键、默认值和保存时机。

## 5. 统一命令模型

### 5.1 稳定命令 ID

命令 ID 是运行时、持久化和 UI 的共同合同，发布后不能随意改名。采用领域前缀：

```text
file.new
file.open
workspace.addFolder
file.save
file.saveAs
file.attach
file.exportPdf
tab.close
tab.next
tab.previous
view.commandPalette
view.toggleSidebar
view.showFiles
view.showOutline
editor.toggleSource
view.cycleTheme
editor.find
editor.replace
editor.bold
editor.italic
editor.highlight
editor.block.paragraph
editor.block.h1 ... editor.block.h6
```

现有主进程字符串 `new`、`open`、`toggleSource` 等保留一版兼容别名，再在验证完成后移除。

### 5.2 静态定义与动态执行分离

命令定义只保存稳定元数据，不捕获会过期的 React 闭包：

```js
{
  id: 'file.save',
  category: 'file',
  titleKey: 'command.save',
  descriptionKey: 'shortcut.saveDescription',
  scope: 'app',
  defaultBindings: ['Mod+S'],
  configurable: true,
  contexts: ['documentOpen']
}
```

执行函数继续由 App 当前状态构造，并放入稳定的 action ref。统一 dispatcher 根据命令 ID
读取最新 action，因此切换标签、语言或文档后不会执行旧闭包。

建议模块：

```text
src/renderer/src/lib/commands/
  command-definitions.js
  command-registry.js
  keybinding-normalize.js
  keybinding-store.js
  keybinding-conflicts.js
  keybinding-display.js
  electron-accelerators.js
src/renderer/src/hooks/
  useCommandDispatcher.js
  useKeybindings.js
```

### 5.3 快捷键分类

| 分类 | 示例 | 是否允许修改 |
| --- | --- | --- |
| 应用命令 | 新建、保存、命令面板、侧边栏、源码模式 | 是 |
| 编辑命令 | 粗体、斜体、高亮、标题层级 | 首期选择性开放 |
| 编辑器结构键 | 表格 Enter、代码块 Tab、菜单方向键 | 否 |
| 系统编辑键 | 复制、粘贴、撤销、重做、全选 | 否 |
| 窗口/系统保留键 | 退出、关闭窗口、开发者工具等 | 否或平台限制 |

不能只比较按键字符串。冲突判断必须同时考虑按键、作用域和可重叠的上下文。当前第一版采用
保守规则：`app` context 是全局上下文，和任何命令同键都冲突；其他命令只有相同 context
才冲突；`document` 与 `editor` 这类互斥上下文允许同键，避免过度限制编辑器内部命令。

## 6. 键位规范化与存储

### 6.1 规范化

- 配置使用 `Mod` 表示主修饰键：macOS 为 `Meta`，Windows/Linux 为 `Ctrl`。
- 录制优先使用 `KeyboardEvent.code`，避免中文输入法和键盘布局改变字符值。
- 修饰键顺序固定为 `Mod`、`Ctrl`、`Alt`、`Shift`、主键。
- 事件匹配要求修饰键精确相等，避免 `Mod+S` 同时误匹配 `Mod+Shift+S`。
- 展示层再转换为 `Cmd`、`Ctrl`、`Option` 等平台文案。
- Electron accelerator 由同一规范化结果生成，不能维护第二套默认值。

### 6.2 独立持久化

不把快捷键映射直接塞进现有 `horsemd.settings.v1`。新增独立存储：

```json
{
  "version": 1,
  "overrides": {
    "file.save": ["Mod+Shift+S"],
    "view.toggleSidebar": []
  }
}
```

存储键为 `horsemd.keybindings.v1`。约定：

- 缺少命令 ID：使用代码中的默认值。
- 空数组：用户明确解除绑定。
- 第一版 UI 每个命令录制一个主键位；数组结构允许默认键位兼容多个平台，也为后续增加备用键位保留迁移空间。
- 只保存覆盖项，不复制全部默认值，未来调整默认值时老用户可以自然继承。
- JSON 损坏、未知命令或无效键位不得阻止应用启动，回退默认值并保留可诊断信息。
- 重命名命令时提供显式迁移表，不能静默丢失用户配置。

## 7. 单一分发链路

### 7.1 应用级命令

Electron 主进程继续拥有原生菜单模板。renderer 只通过受限 IPC 上报已解析的应用级 accelerator：

1. 应用启动时主进程先使用代码默认值构建菜单。
2. renderer 读取用户配置并计算有效键位。
3. preload 通过 `menu:setKeybindings` 发送命令 ID 与 accelerator。
4. 主进程只接受白名单命令 ID 和合法 accelerator，然后重建菜单；未知命令 ID 被忽略并通过
   `ignoredCommandIds` 返回，非法 payload 或非法 accelerator 直接拒绝。
5. 原生菜单触发后只向 renderer 发送命令 ID，由统一 dispatcher 执行一次。

主进程不能接受 renderer 提供的任意菜单结构或任意 JavaScript。新增 IPC 同时更新 preload；
Capacitor shim 提供 capability 或安全 no-op，保证共享 renderer 不崩溃。

### 7.2 Renderer 与编辑器命令

- 普通应用命令由统一 renderer keydown dispatcher 处理。
- 已交给 Electron accelerator 的命令不在顶层再次捕获，避免双触发。
- ProseMirror 命令通过编辑器 API 或动态 keymap 执行，保留 transaction 和选区语义。
- CodeMirror 聚焦时，先判断命令是否允许跨编辑器执行；结构按键继续由 CodeMirror 自己处理。
- 输入框、设置录制器、弹窗和菜单打开时使用明确 context 屏蔽不应触发的命令。
- 输入法 composing 期间不触发普通字母类命令。

### 7.3 命令上下文

首期不引入可执行字符串形式的 `when` DSL。使用受控 context key：

```text
documentOpen
richEditorFocused
sourceEditorFocused
codeMirrorFocused
settingsOpen
modalOpen
keybindingRecording
```

这样可以测试全部组合，也避免把字符串表达式解析器变成新的维护负担。

## 8. 快捷键设置交互

快捷键模块包含：

- 按命令名称、别名和当前键位搜索。
- 按“文件、编辑、视图、标签页、工作区”筛选。
- 每行显示命令名称、说明、当前键位和“默认/自定义/未绑定”状态。
- 点击键位进入行内录制；`Escape` 取消，`Backspace/Delete` 清除。
- 提供单项恢复按钮和“恢复全部默认”。
- 冲突发生时立即指出冲突命令，只允许“取消”或“替换原命令”，不静默覆盖。
- 系统保留键显示不可用原因。
- 录制状态使用 `aria-live` 通知，所有操作可用键盘完成。

工具栏 tooltip、顶部按钮、欢迎页提示、块菜单、命令面板和 Electron 菜单显示当前有效键位。
命令面板不再维护独立命令清单，而是读取 `COMMAND_DEFINITIONS` 中带 `palette` 标记的命令，
继续通过稳定 action ref 调用现有 handler，避免改名、能力开关和可执行入口分叉。可见快捷键文本
通过 `shortcut-labels.js` 从命令 ID 与有效键位生成；`blocks.js` 只保留块类型和命令 ID，不再保存
静态 `Ctrl+1` 这类展示字符串。README 与用户教程记录默认键位，并说明用户可以在设置中修改；它们
不尝试展示某一台电脑的个人配置。

## 9. 首批开放命令

第一批只迁移当前已有且行为明确的命令：

1. 文件：新建、打开、打开文件夹、保存、另存为、插入附件、导出 PDF、关闭标签。
2. 导航：命令面板、侧边栏、文件、大纲、主题、源码模式、上/下一个标签。
3. 查找：查找、替换。
4. 编辑：粗体、斜体、高亮、段落、H1-H6。

代码块、行内代码、公式等命令只有在确认现有执行 API 能正确处理富文本选区和源码选区后再开放。
`Enter`、`Tab`、菜单导航和表格编辑语义不进入自定义列表。

## 10. 兼容性与不变量

实施过程中必须保持：

1. 没有自定义配置的用户，所有默认键位与当前版本完全一致。
2. 同一次按键最多执行一个命令一次。
3. 仅真实编辑会标记文档 dirty；切设置、改快捷键和程序性同步不能触发修改状态。
4. 源码/富文本切换继续由 `useSourceModeSwitch.js` 管理，本功能只调用既有 `toggleSource`。
5. 富文本编辑器继续按 Tab 延迟挂载并保持挂载，不因设置或键位更新重建 Crepe。
6. 查找、Review、表格、代码块、Mermaid、LaTeX 和图片粘贴的事件优先级不变。
7. 菜单 IPC 只接受白名单数据，不扩大 renderer 权限。
8. 桌面与移动端共享 renderer 的合同保持完整。

## 11. 实施顺序

1. 冻结当前命令与默认键位清单，补纯函数测试。
2. 建立命令定义、规范化、冲突检测、显示和存储模块，不接管运行时。
3. 纯搬迁重构设置页，逐模块对照现有行为。
4. 增加只读快捷键页面，确认注册表覆盖完整、展示正确。
5. 迁移 renderer 应用命令到统一 dispatcher。
6. 增加安全 IPC，让 Electron 菜单使用有效键位。
7. 逐个迁移编辑器命令，每迁移一组就删除对应旧监听器。
8. 开启录制、冲突处理、解除绑定与恢复默认。
9. 更新全部动态键位提示、文档、教程和回归清单。
10. 完成桌面、移动构建与真实安装回归后再合并。

每一步必须可独立构建和回滚。不能先保留旧监听器再叠加新监听器作为长期兼容方案。

## 12. 完成标准

只有同时满足以下条件，功能才算完成：

- 设置中心各模块在桌面、窄窗口和全部内置主题下无重叠、溢出和难以辨识的状态。
- 所有开放命令可以录制、持久化、清除和恢复，重启后仍正确。
- Electron 菜单、命令面板、tooltip 与实际键位一致。
- 冲突、保留键、输入法、源码 textarea、ProseMirror、CodeMirror 和普通输入框均通过专项测试。
- 默认配置下完整手动回归与改造前一致。
- `npm run build`、`npm run build:mobile` 和新增快捷键测试全部通过。
- 最新源码重新打包并安装后完成真实应用验收，而不是只在 Vite 开发环境验证。

详细执行项和验收矩阵见 [custom-shortcuts-implementation-checklist.md](./custom-shortcuts-implementation-checklist.md)。
