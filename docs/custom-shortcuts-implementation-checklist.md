# 设置中心与自定义快捷键实施清单

> 本清单配合 [设置中心与自定义快捷键架构](./custom-shortcuts-architecture.md) 使用。  
> 原则：每个阶段先测试再进入下一阶段；发现回归就停在当前阶段修复，不带病继续。

## 当前验收边界

- [x] macOS 本机自动化门禁已通过：`npm run test:shortcuts`、`npm run test:core`、`npm run test:ui-regression`、`npm run build`、`npm run build:mobile`、`npm run guide:check`、`git diff --check`。
- [x] 真实 UI 回归已覆盖设置页、命令面板、Electron 菜单、PDF Studio、Review、Lightbox、表格、#57-#60、#66/#67、真实大文档和 `电脑档案.md` 双向模式切换链路。
- [x] macOS 安装版已用隔离 profile 做过快捷键设置页 smoke，验证运行路径、app.asar 来源、35 个命令、保留键提示和设置页后台快捷键阻断。
- [ ] Windows / Linux 实机安装、系统菜单、窗口控制和平台快捷键冲突仍需目标平台验收。
- [ ] 发布前仍需人工按 [manual-test-checklist.md](./manual-test-checklist.md) 跑设置、快捷键、保存、查找、源码切换、表格、PDF 和核心编辑路径。
- [ ] 多窗口同步不是首期目标；当前设计仍以单主窗口为主要运行模型。

## 0. 开始前基线

- [x] 确认工作区状态，保留并识别用户已有修改。
- [ ] 记录当前设置页面截图：桌面宽屏、窄窗口、浅色、深色和一个自定义主题。
- [x] 导出当前全部默认快捷键、菜单 accelerator 和静态 tooltip 清单。
  - [x] `npm run shortcuts:inventory` 生成 [默认快捷键与菜单 Accelerator 清单](./custom-shortcuts-default-inventory.md)，覆盖 35 个命令、默认键位、平台显示、菜单 accelerator、所有者和可配置状态。
- [x] `npm run build` 通过。
- [x] `npm run build:mobile` 通过。
- [ ] 按 `docs/manual-test-checklist.md` 完成设置、快捷键、保存和模式切换基线。
- [x] 建立快捷键专项测试脚本，并先证明它能发现重复命令 ID、重复默认绑定和非法键位。

## 1. 纯命令模型

### 实现

- [x] 新增稳定的命令定义表，包含 ID、分类、i18n key、作用域、上下文、默认键位和是否可配置。
- [x] 为现有 `menuHandlers`、`useCommands` 和主进程命令建立完整映射表。
- [x] 增加旧命令字符串到新 ID 的兼容别名。
  - [x] `npm run test:keybindings` 覆盖 `toggleSource` → `view.toggleSource`、`save` → `file.save` 的存储迁移、renderer 菜单事件解析和主进程菜单 IPC 归一化。
- [x] 命令定义与执行闭包分离，执行层读取最新 action ref。
- [x] 增加注册表校验，不允许重复 ID、缺少标题元数据或默认键位冲突。

### 测试门槛

- [x] 默认命令数量和当前盘点一致。
- [x] 中文、英文名称和分类均存在。
- [x] 未知命令 ID 不执行、不崩溃，并留下可诊断结果。
- [ ] 此阶段运行时行为完全不变。
- [x] `npm run build` 通过。

## 2. 键位纯函数与存储

### 实现

- [x] 实现 `KeyboardEvent` 到规范键位的转换。
- [x] 实现 `Mod` 在 macOS 与 Windows/Linux 的解析和显示。
- [x] 实现精确修饰键匹配。
- [x] 实现 Electron accelerator 转换。
- [x] 实现按作用域和上下文判断的冲突检测。
- [x] 实现系统保留键校验。
- [x] 新增 `horsemd.keybindings.v1` 读写、版本和迁移逻辑。
- [x] 缺失覆盖、空数组解除绑定、单项恢复和全部恢复语义明确。

### 自动化测试

- [x] `Mod+S` 在 macOS 映射为 `Meta+S`，其他桌面平台映射为 `Ctrl+S`。
- [x] `Mod+S` 不误匹配 `Mod+Shift+S`。
- [x] 大小写、标点、数字行、功能键和方向键规范化稳定。
- [x] 中文输入法 composing 事件不触发命令。
- [x] 同键同上下文冲突；互斥上下文按设计允许或拒绝。
- [x] 损坏 JSON、未知命令、旧版本和非法键位安全回退。
- [x] 旧命令字符串覆盖项会迁移到稳定 command id，不会丢失用户配置。
- [x] 未自定义用户得到与当前版本完全相同的默认键位。
- [x] `npm run build` 通过。

## 3. 设置页面纯重构

### 实现

- [x] `SettingsView.jsx` 只保留壳层和模块导航。
- [x] 搬迁常规、编辑器、外观、文件与图片、关于模块。
- [x] 提取字体选择、排版预览和更新检查组件。
- [x] 桌面使用左侧导航，窄窗口使用紧凑导航。
- [x] 只挂载当前模块，离开模块时清理临时监听器和悬停预览。
- [x] 不修改现有 `horsemd.settings.v1` 字段和默认值。

### 功能回归

- [ ] 文档字体、代码字体、字号、行高、段间距和页面宽度实时生效。
  - [x] 字号、行高、段间距和页面宽度已由 `npm run test:settings-ui` 覆盖，验证 `horsemd.settings.v1` 与 `--editor-font-size`、`--editor-line-height`、`--editor-para-spacing`、`--editor-max-width` / `hm-full-width` 同步。
  - [x] 文档字体、代码字体和字体悬停预览已由 `npm run test:settings-ui` 覆盖，验证 `queryLocalFonts` 结果进入字体菜单、hover 更新 `--font-write`、选择写入 `fontWrite` / `fontMono` 并更新 app CSS 变量。
- [x] 字体权限请求、字体搜索、悬停预览、选择与关闭菜单正常。
  - [x] `npm run test:settings-ui` 使用 mocked `queryLocalFonts` 覆盖字体菜单打开、搜索、选择、hover preview 和外部点击关闭；真实系统权限弹窗仍由人工安装包验收。
- [x] 所有内置主题和自定义主题可切换。
  - [x] 内置主题切换已由 `npm run test:settings-ui` 覆盖，逐个点击 Warm Light、Warm Dark、Morandi Sage、Morandi Rose、Morandi Mist、Morandi Dusk，验证 `body` base/class、session 持久化和自定义主题 overlay 清理。
  - [x] 自定义主题选择已由 `npm run test:settings-ui` 覆盖：隔离 profile 写入 `themes/Codex Custom.css`，经 `themes:list` / `themeRead` 注入 `#hm-custom-theme` 并添加 `hm-has-custom-theme`。
- [ ] 打开主题目录和获取更多主题正常。
  - [x] `npm run test:settings-actions` 覆盖设置页和状态栏主题菜单的回调链路：`themesReveal()` 与 `openExternal('https://theme.typora.io/')` 没有在拆分中断线。
  - [ ] 真实打开 Finder/Explorer 和浏览器仍需安装包人工验收。
- [x] 拼写检查、隐藏文件、语言和图床命令正常保存并生效。
  - [x] 语言、拼写检查、隐藏文件和图床命令已由 `npm run test:settings-ui` 覆盖。
- [ ] 检查更新的进行中、最新版、新版本和失败状态正常。
  - [x] 更新结果状态解析已由 `npm run test:settings-update` 覆盖：失败、最新版、新版本、内部测试版本号倒挂和缺失下载链接。
  - [ ] 进行中按钮禁用、真实 GitHub 请求和下载链接点击仍需真实应用或专项 UI 测试覆盖。
- [x] 设置标签仍不进入文档会话恢复，不使文档变 dirty。
- [x] 状态栏中的排版、主题和语言入口仍与设置同步。
  - [x] 状态栏排版入口已由 `npm run test:settings-ui` 覆盖：文档 tab 中通过状态栏 Layout 改字号后，设置页重新打开能读到同一值。
  - [x] 状态栏主题和语言入口已由 `npm run test:settings-ui` 覆盖：从自定义主题切换到 Morandi Rose 会清除自定义 overlay，语言切到中文后 session `lang` 更新为 `zh`。

### 视觉回归

- [ ] 浅色、深色和全部内置主题下导航、分隔线、输入框、下拉层和焦点态清晰。
  - [x] 浅色、深色和 4 个 Morandi 内置主题的设置页/快捷键页基础布局已由 `npm run test:settings-layout-ui` 覆盖；下拉层和焦点态仍需视觉或专项测试。
- [ ] 1280×800、1440×900、窄窗口和移动 viewport 无横向撑开、遮挡或文字溢出。
  - [x] 1440×900、820×720 和 390×844 移动 CSS 类下的设置页/快捷键页全局横向溢出与关键控件可见性已由 `npm run test:settings-layout-ui` 覆盖。
- [ ] 不出现卡片套卡片、过宽空白或不一致的圆角与阴影。
- [ ] 键盘 Tab 顺序、焦点环和屏幕阅读标签正确。
- [x] `npm run build` 与 `npm run build:mobile` 通过。

## 4. 只读快捷键页面

### 实现

- [x] 增加“快捷键”设置模块。
- [x] 按分类展示全部首批命令及有效默认键位。
- [x] 支持按中文、英文、命令 ID、分类和键位搜索。
- [x] 命令面板和设置页从同一命令定义读取标题与分类。
- [x] 此阶段不允许修改键位，验证清单完整后再开启录制。

### 测试门槛

- [ ] 设置页展示的默认值与 Electron 菜单、工具提示和实际行为逐项一致。
  - [x] `npm run test:keybindings-ui` 覆盖设置页 35 个可用命令的标题、分类、默认键位、未分配状态和固定/可配置状态，全部由命令注册表生成期望值逐项比对。
  - [x] Electron 菜单默认 accelerator 与热更新已由 `npm run test:menu-keybindings-ui` 覆盖；工具提示和全部真实行为仍需矩阵验收。
- [ ] 没有重复、缺失或无法执行的命令。
  - [x] `npm run test:keybindings` 覆盖命令注册表重复 ID、重复 handler、缺标题、缺分类、缺上下文、缺默认键位声明和默认快捷键冲突校验。
  - [x] `npm run test:keybindings-ui` 覆盖设置页命令行数与注册表一致、无重复标题、无缺失 UI 行；全部命令逐项可执行仍需真实行为矩阵验收。
- [x] 搜索和分类切换不会改变文档焦点、内容或 dirty 状态。
- [x] 切离页面后没有残留 keydown 监听器。

## 5. Renderer 应用命令迁移

### 实现

- [ ] 新增统一 dispatcher 与 context provider。
- [x] 迁移 `useGlobalKeys` 中 renderer 自己负责的快捷键。
- [x] 迁移命令面板，使其调用同一 dispatcher。
- [ ] 每迁移一个命令就删除对应旧判断，避免双触发。
  - [x] 命令面板执行 `view.toggleSidebar` 单次触发已由 `npm run test:command-palette-keybindings-ui` 覆盖。
- [ ] 处理 source textarea、普通 input、弹窗、设置页和录制器上下文。
  - [x] 设置页上下文已由 `npm run test:keybindings-runtime-ui` 覆盖：设置 tab 显示时 `view.toggleSidebar` 和 `editor.find` 不会触发后台命令，回到 Home 后同一快捷键恢复生效。
  - [x] 设置页后台阻断集合已由 `npm run test:keybindings` 覆盖：`save`、`saveAs`、`attachFile`、`exportPdf`、源码切换、查找/替换和 Review 命令在设置页均被阻断；新建、打开、打开文件夹、命令面板、主题切换等 app 命令不被误阻断。
  - [x] 录制器上下文已由 `npm run test:keybindings-ui` 覆盖：离开快捷键页面后录制监听器清理，不再消费后续按键。
  - [x] 普通文本输入键已由 `npm run test:keybindings` 和 `npm run test:keybindings-ui` 覆盖：无修饰字符不能被录制或从旧配置迁移为快捷键。
- [ ] 保持 `menuHandlers` 对 App 现有动作函数的调用语义。

### 真实行为测试

- [ ] 新建、保存、另存为、关闭标签、命令面板执行一次且仅一次。
- [ ] 侧边栏、文件、大纲、主题、源码模式执行一次且仅一次。
  - [x] `view.toggleSidebar` 已由 `npm run test:keybindings-runtime-ui` 覆盖：清空后不响应，恢复默认后单次按键只切换一次。
- [ ] 查找和替换在富文本与源码模式均正常聚焦和跳转。
- [x] 当前默认的 `Ctrl+Tab` 与 `Ctrl+Shift+Tab` 正反向切换在各平台语义不变；只有用户主动改绑后才使用新键位。
- [x] 输入框中输入普通文字不会触发单字母命令。
  - [x] `npm run test:keybindings` 覆盖无修饰 `A` / `1` 被判定为 `textInput` 保留键，并从旧 keybinding overrides 中过滤。
  - [x] `npm run test:keybindings-ui` 覆盖在设置页录制无修饰字母会显示保留键提示且不会写入 `horsemd.keybindings.v1`。
- [ ] 设置弹窗、文件对话框和其他 modal 打开时不会误执行后台命令。
  - [x] 设置页已由 `npm run test:keybindings-runtime-ui` 覆盖，不再响应侧边栏和文档查找后台快捷键；文件对话框和其他 modal 仍需专项或人工验收。
- [ ] 默认键位行为与改造前一致。

## 6. Electron 菜单同步

### 实现

- [x] 主进程菜单默认值改为读取共享的安全映射，而不是散落字符串。
- [x] 新增白名单 IPC 接收应用级有效 accelerator。
- [x] 更新 preload 合同与 capability。
- [x] Capacitor shim 提供安全 no-op 或隐藏桌面快捷键配置能力。
- [x] 主进程拒绝未知命令、非法 accelerator 和任意菜单结构。
- [ ] 菜单重建不会丢失 macOS 应用菜单和 Windows/Linux 窗口菜单差异。
  - [x] macOS built Electron 菜单结构已由 `npm run test:menu-keybindings-ui` 覆盖：重建后 File/Edit/View/Window 菜单和原生 Edit role 保留；Windows/Linux 仍需目标平台验证。

### 测试门槛

- [ ] 启动早期使用默认菜单，renderer 就绪后切换为用户键位。
- [x] 修改键位后菜单立即更新，不需要重启。
  - [x] `npm run test:menu-keybindings-ui` 覆盖主进程菜单快照：`file.save` 从 `CmdOrCtrl+S` 热更新为 `CmdOrCtrl+Alt+S`，`view.toggleSource` 可清空。
- [ ] 点击菜单和按 accelerator 都只执行一次。
  - [x] `view.toggleSidebar` renderer 快捷键已覆盖单次触发；Electron 菜单点击/accelerator 仍需专项人工或主进程级测试。
- [ ] macOS 的关闭窗口、退出与系统编辑菜单保持正常。
  - [x] macOS built Electron 菜单快照保留应用菜单、Window 菜单和 Edit 菜单原生 `undo`/`copy` role；关闭窗口和退出仍需人工点击确认。
- [ ] Windows/Linux 的窗口控制与 Alt+F4 保持正常。
- [x] 伪造 IPC 数据不能增加未知快捷键或执行任意行为。
  - [x] `npm run test:menu-keybindings-ui` 覆盖未知菜单命令被忽略、非法 accelerator 被拒绝，且拒绝后菜单 accelerator 不变。
- [x] `npm run build` 与 `npm run build:mobile` 通过。

## 7. 编辑器命令迁移

### 实现顺序

- [x] 段落与 H1-H6。
- [ ] 高亮。
- [ ] 粗体与斜体。
- [ ] 经过独立评估后再决定代码、行内代码和公式是否进入首期。
- [ ] 保留表格、CodeMirror 和 slash 菜单的结构键。
- [x] 删除 `blocks.js`、`editor-toolbar.js` 等位置的静态键位展示，改用格式化器。

### 专项测试

- [ ] 富文本普通段落中选区格式正确，光标不跳。
- [ ] 表格单元格中格式正确，行列按钮和菜单不受影响。
- [ ] CodeMirror 聚焦时格式键不错误修改外层文档。
- [ ] 源码 textarea 中只触发被明确支持的命令。
- [ ] 中文输入法候选阶段不触发格式或标题命令。
- [ ] Review 标记、行内公式、代码块、Mermaid 和图片 caption 附近快捷键无回归。
- [ ] 每个命令只提交一次 ProseMirror transaction。

## 8. 开启用户配置

### 交互

- [x] 点击键位按钮进入行内录制。
- [x] `Escape` 取消；`Backspace/Delete` 解除绑定。
- [x] 单项恢复默认和全部恢复默认有清晰确认范围。
- [x] 冲突时显示冲突命令，可取消或替换，不静默覆盖。
- [x] 系统保留键显示具体原因。
- [x] 录制器不会把用于确认/取消的按键继续传播给应用。
- [x] 自定义、默认和未绑定状态可辨识。

### 持久化

- [x] 修改后实际行为、菜单、命令面板和 tooltip 同步更新。
- [x] 重启应用后配置保持。
- [x] 清除配置后命令确实不再响应。
- [x] 恢复默认后不残留覆盖项。
- [ ] 多窗口或未来窗口场景不会相互覆盖为旧值。

## 9. 最终完整回归

### 快捷键矩阵

- [ ] macOS：Cmd、Option、Shift、功能键与菜单显示。
- [ ] Windows：Ctrl、Alt、Shift、系统窗口键冲突。
- [ ] Linux：Ctrl、Alt、Shift、GTK 菜单和窗口控制。
- [ ] 默认、自定义、解除绑定、冲突替换、单项恢复、全部恢复。
- [ ] 富文本、源码、CodeMirror、表格、查找框、设置输入框和弹窗上下文。
- [ ] 中文、英文界面的搜索、分类、命令名称和错误提示。

### 核心功能防回归

- [ ] 保存、另存为、dirty 状态和关闭确认。
- [ ] 富文本与源码双向切换，前/中/后及表格、代码块位置各往返至少 10 次。
  - [x] 已新增并运行 `npm run test:ui-regression`，统一编排真实 UI 回归 session，避免多个 CDP 脚本并行抢同一个窗口。
  - [x] `scripts/test-mode-switch-10x.mjs` 已在真实大文档 `/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md` 上通过：5 个光标位置 + 5 个阅读位置往返，outline 和 dirty 状态稳定。
  - [x] `scripts/test-mode-switch-chains.mjs` 已在 `/Users/yangtingyi/vibe_everything/电脑档案.md` 上通过：`source -> rich -> source -> rich` 与 `rich -> source -> rich -> source` 两条链路共 6 个位置全部通过。
- [ ] 查找替换在两种模式中高亮、跳转和替换。
  - [x] `scripts/test-source-find.mjs --mode-switch` 已在真实大文档上通过：源码模式唯一 late query、连续 10 次下一项跳转、source/rich/source 切换后的匹配数量和当前高亮均稳定。
- [ ] 多标签、分屏、大纲、工作区和会话恢复。
  - [x] `scripts/test-issues-66-67-ui.mjs` 通过，覆盖分屏下左右 pane 大纲跟随、左侧 source + 右侧 rich 混合状态的大纲归属、点击大纲跳转到正确 pane。
- [ ] Review/CriticMarkup 接受、拒绝和卡片交互。
  - [x] `scripts/test-review-ui.mjs` 通过，覆盖 CriticMarkup 渲染、堆叠评论按钮、评论卡片打开/编辑/取消和完成操作。
- [ ] 表格、代码块、Mermaid、LaTeX、图片粘贴和微信公众号富文本粘贴。
  - [x] `scripts/test-table-scroll-ui.mjs` 通过，覆盖桌面/移动 viewport 下页面不被宽表撑开、Markdown/HTML 宽表独立横向滚动、表格行列控制和加行/加列按钮命中。
  - [x] `scripts/test-lightbox-ui.mjs` 通过，覆盖 Mermaid 和图片 Lightbox 原始比例、缩放控件和临时监听清理。
  - [x] `scripts/test-issues-57-60-ui.mjs` 通过，覆盖 LaTeX slash 命令、`$$` 数学块编辑焦点、inline code 边界追加和 PDF 设置入口。
- [ ] PDF 导出中心打开、预览、配置和导出。
  - [x] `scripts/test-pdf-studio-ui.mjs` 通过，覆盖 PDF Studio 打开、预览、横竖版、目录页、PDF 导航大纲、页码范围、快速设置 latest-wins、源码模式编辑同步和命令面板 PDF 入口。
- [ ] 大文档与远程图片文档没有新增卡顿或编辑器重挂载。
  - [x] 真实大文档 10 次源码/富文本往返通过，包含远程图片密集文档的加载、切换、outline 稳定和 dirty 状态稳定验证。
- [ ] 全量执行 `docs/manual-test-checklist.md` 中受影响章节。

### 构建与真实安装

- [x] 新增纯函数和集成测试全部通过。
  - [x] 已新增并运行 `npm run test:shortcuts`，一条命令覆盖快捷键盘点、纯函数、设置页快捷键 UI、持久化、运行时、Electron 菜单、设置页拆分、布局、更新状态、主题动作和命令面板快捷键同步。
  - [x] 已运行 `npm run test:keybindings`、`npm run test:keybindings-ui`、`npm run test:keybindings-persistence-ui`、`npm run test:keybindings-runtime-ui`、`npm run test:menu-keybindings-ui`、`npm run test:settings-ui`、`npm run test:settings-layout-ui`、`npm run test:settings-update`、`npm run test:settings-actions`、`npm run test:command-palette-keybindings-ui`。
- [x] `npm run test:keybindings-ui` 通过，覆盖设置页搜索、录制、保留键、冲突、清空和切页监听器清理。
- [x] `npm run shortcuts:inventory` 通过，生成默认快捷键/菜单 accelerator 清单。
- [x] `npm run test:keybindings-persistence-ui` 通过，覆盖真实 Electron 重启后的存储恢复、UI 展示和主进程菜单 accelerator 同步。
- [x] `npm run test:keybindings-runtime-ui` 通过，覆盖清空命令不响应、单项恢复默认后响应，以及 renderer 快捷键无双触发。
- [x] `npm run test:settings-ui` 通过，覆盖设置页持久化、设置标签不进 session、设置页不 dirty、设置页单实例和字号实时 CSS 变量。
- [x] `npm run test:command-palette-keybindings-ui` 通过，覆盖命令面板快捷键 hint 同步和命令面板执行同一 handler 的单次触发。
- [x] `npm run test:menu-keybindings-ui` 通过，覆盖真实 Electron 菜单结构快照、accelerator 热更新、清空和非法 IPC 拒绝。
- [x] `node scripts/test-strike-guard.mjs` 通过。
- [x] `npm run test:source-map` 通过。
- [x] `npm run build` 通过。
- [x] `npm run build:mobile` 通过。
- [x] `npm run guide:check` 通过。
- [x] `git diff --check` 通过。
- [x] `npm run test:core` 通过，覆盖安全协议/PDF 文档、PDF 保存状态、编辑器 API registry、文件系统、watcher、source map、Review/CriticMarkup、行内代码/公式和浮动菜单定位。
- [x] `npm run test:ui-regression` 通过，覆盖 9 个真实 UI session：#57-#60、PDF Studio、Review、Lightbox、表格滚动与控件、#66/#67、真实大文档切换/查找和 `电脑档案.md` 双向切换链路。
- [ ] 按目标平台打包，彻底关闭旧进程后安装最新产物。
  - [x] macOS 本机已执行 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir`，先终止旧 `/Applications/HorseMD.app` 进程，再用 `dist/mac-arm64/HorseMD.app` 覆盖安装到 `/Applications/HorseMD.app` 并清除 quarantine。
  - [x] 本轮新增 `npm run test:shortcuts` 和验证报告后，已再次执行 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir` 并覆盖安装最新 `/Applications/HorseMD.app`。
  - [x] 本轮文档收尾后再次执行 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir`，覆盖安装 `/Applications/HorseMD.app`，确保人工测试使用当前源码产物。
- [ ] 验证运行中的应用路径和 `app.asar` 确实来自最后一次代码修改。
  - [x] 已验证 `/Applications/HorseMD.app/Contents/Resources/app.asar` 包含 `settings.keyboardReserved.textInput` 标记，安装时间为本轮构建后；安装版进程路径为 `/Applications/HorseMD.app/Contents/MacOS/HorseMD`，CDP page URL 指向 `/Applications/HorseMD.app/Contents/Resources/app.asar/out/renderer/index.html`。
  - [x] 本轮安装版 `app.asar` 修改时间为 `2026-07-17 02:01:50 +0800`，运行命令行为 `/Applications/HorseMD.app/Contents/MacOS/HorseMD --remote-debugging-port=9457 --user-data-dir=/tmp/horsemd-installed-keybindings-latest`。
  - [x] 最新安装版 `app.asar` 修改时间为 `2026-07-17 02:33:38 +0800`，运行命令行为 `/Applications/HorseMD.app/Contents/MacOS/HorseMD --remote-debugging-port=9461 --user-data-dir=/tmp/horsemd-installed-keybindings-final`，页面来源为 `/Applications/HorseMD.app/Contents/Resources/app.asar/out/renderer/index.html`。
- [ ] 使用隔离 profile 完成真实应用 CDP 和人工验收。
  - [x] 已用 `/tmp/horsemd-installed-keybindings` 隔离 profile 启动安装版，CDP 验证设置页快捷键列表为 35 项、单字母 `A` 显示普通文本输入保留键提示、设置页内 `Cmd+F` 不打开后台查找栏。
  - [x] 本轮已用 `/tmp/horsemd-installed-keybindings-latest` 隔离 profile 重跑安装版 CDP smoke：页面来自 `/Applications/HorseMD.app/Contents/Resources/app.asar/out/renderer/index.html`，快捷键 recorder 为 35 项，普通字母 `A` 保留键提示正常，设置页内 `Cmd+F` 不打开后台查找栏。
  - [x] 最新安装版已用 `/tmp/horsemd-installed-keybindings-final` 隔离 profile 重跑 CDP smoke：快捷键设置行数 35、普通字母 `A` 保留键提示正常、设置页内 `Cmd+F` 不打开后台查找栏。
  - [ ] 人工验收仍需在最新安装包中执行。

## 10. 文档与交付

- [x] 更新 `CHANGELOG.md`。
- [x] 更新 `README.md` 默认快捷键表，并注明设置入口。
- [x] 更新 `guide/productivity/shortcuts.md`，补设置、录制、冲突与恢复默认图文教程。
  - [x] 已补自定义快捷键入口、录制、取消、清空、单项恢复、全部恢复、冲突/保留键和设置页后台快捷键阻断说明。
  - [x] 已接入 `guide/public/images/v0.6.5/keyboard-shortcuts.png`，展示最新安装包中的键盘快捷键设置页。
- [x] 更新 `docs/features.md`、`docs/architecture.md` 和 `docs/manual-test-checklist.md`。
- [x] 新截图来自最新安装包，不包含个人路径或旧版本 UI。
  - [x] 已从 `/Applications/HorseMD.app` 以隔离 profile 和 CDP 采集，尺寸为 1440×900，截图内容仅包含设置页与命令列表。
- [x] 提交保持阶段独立，至少区分设置页纯重构、命令内核、运行时迁移和文档。
  - [x] `3d0a1f8 feat(shortcuts): add customizable keybindings`：设置页拆分、统一命令模型、运行时快捷键、Electron 菜单同步和移动端 no-op 合同。
  - [x] `9c3ed98 test(shortcuts): add keybinding regression coverage`：快捷键专项、设置页 UI、菜单、持久化、真实 UI 回归编排和旧 CDP 脚本适配。
  - [x] 当前 `docs(shortcuts): document custom keybinding rollout` 文档提交：架构文档、实施清单、验证报告、README/教程/截图和变更说明。
- [x] 最终记录根因、关键决策、测试结果和剩余限制。
  - [x] 已新增 [设置中心与自定义快捷键验证报告](./custom-shortcuts-verification-report.md)，记录自动化覆盖、安装版证据、剩余人工/跨平台验收边界和后续开放编辑器命令的条件。

## 停止条件

遇到以下任一情况，不进入下一阶段：

- 默认键位与当前发布版不一致。
- 同一按键出现双触发或偶发不触发。
- 设置修改导致文档 dirty、编辑器重挂载或模式切换漂移。
- CodeMirror、表格、输入法或普通输入框中的按键优先级无法解释。
- Electron 菜单显示与实际行为不一致。
- 共享 renderer 在移动构建中失败。
- 自动化测试或对应人工回归未通过。
