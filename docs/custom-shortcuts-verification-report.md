# 设置中心与自定义快捷键验证报告

> 对应实施清单：[设置中心与自定义快捷键实施清单](./custom-shortcuts-implementation-checklist.md)。  
> 本报告记录第一版自定义快捷键的验证范围、证据和仍需人工验收的边界。

## 当前结论

第一版已经把设置页拆分为模块化设置中心，并引入统一命令定义、快捷键存储、冲突检测、设置页录制、Electron 菜单 accelerator 同步、命令面板提示同步和文档教程。

已由自动化覆盖的核心风险：

- 默认命令注册表完整性、重复命令 ID、重复默认键位、缺失标题/分类会失败。
- macOS / Windows / Linux 的 `Mod` 解析、Electron accelerator 转换和显示格式稳定。
- 损坏配置、旧命令 ID、未知命令、非法键位和普通文本输入键会安全回退。
- 设置页快捷键列表与命令注册表一致，支持搜索、录制、取消、清空、恢复默认、冲突提示和保留键提示。
- 自定义键位重启后仍保持，Electron 菜单 accelerator 随用户配置热更新。
- 设置页打开时，保存、查找、侧边栏等文档命令不会在后台误触发。
- 设置页后台阻断集合覆盖保存、另存为、附件、导出 PDF、源码切换、查找/替换和 Review 命令；新建、打开、打开文件夹、命令面板、主题切换等应用级命令不被误阻断。
- 命令面板使用同一命令注册表，快捷键提示与设置页同步。
- 设置页拆分后，字体、排版、主题、语言、拼写检查、隐藏文件和图床命令设置仍能保存并同步到界面。
- 教程截图来自最新安装包和隔离 profile，不包含个人路径或旧版本 UI。

## 自动化验证命令

推荐用一条命令运行快捷键专项回归：

```bash
npm run test:shortcuts
```

该命令展开为：

- `npm run shortcuts:inventory`
- `npm run test:keybindings`
- `npm run test:keybindings-ui`
- `npm run test:keybindings-persistence-ui`
- `npm run test:keybindings-runtime-ui`
- `npm run test:menu-keybindings-ui`
- `npm run test:settings-ui`
- `npm run test:settings-layout-ui`
- `npm run test:settings-update`
- `npm run test:settings-actions`
- `npm run test:command-palette-keybindings-ui`

交付前还需要运行通用门禁：

```bash
npm run test:core
npm run build
npm run build:mobile
npm run guide:check
git diff --check
```

本轮本机已通过：

- `npm run test:shortcuts`
- `npm run test:core`
- `npm run test:ui-regression`
- `npm run build`
- `npm run build:mobile`
- `npm run guide:check`
- `git diff --check`
- `scripts/test-issues-57-60-ui.mjs`
- `scripts/test-pdf-studio-ui.mjs`
- `scripts/test-review-ui.mjs`
- `scripts/test-lightbox-ui.mjs`
- `scripts/test-table-scroll-ui.mjs`
- `scripts/test-issues-66-67-ui.mjs`
- `scripts/test-mode-switch-10x.mjs`
- `scripts/test-source-find.mjs --mode-switch`
- `scripts/test-mode-switch-chains.mjs`

其中 `npm run test:core` 覆盖安全协议/PDF 文档、PDF 保存状态、编辑器 API registry、文件系统、watcher、Markdown source map、Review/CriticMarkup、行内代码/公式和浮动菜单定位，作为设置中心改造后的核心功能防回归证据。

`npm run test:ui-regression` 统一编排以下真实 UI 回归，所有 session 独立 profile/端口串行执行，避免多个 CDP 脚本抢同一个窗口：

- `issues-57-60` fixture：LaTeX slash 命令、`$$` 数学块、inline code 边界追加、PDF 设置入口。
- PDF Studio：预览、横竖版、目录页、PDF 导航大纲、页码范围、源码模式编辑同步、命令面板 PDF 入口。
- Review UI：CriticMarkup 渲染、堆叠评论、评论卡片编辑/取消/完成。
- Lightbox：Mermaid/图片原始比例、缩放控件、临时监听生命周期。
- Table scroll：桌面/移动 viewport 不被宽表撑开、Markdown/HTML 宽表横向滚动、表格行列控制与加行/加列按钮。
- Issues #66/#67：分屏大纲归属、source/rich 混合 pane、Ctrl+B 与侧边栏快捷键分离。
- 真实大文档：`MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md` 完成 5 个光标位置 + 5 个阅读位置的源码/富文本往返，outline 与 dirty 状态稳定。
- 真实文档：`电脑档案.md` 完成 source/rich/source/rich 与 rich/source/rich/source 双向链路 6/6。
- 源码查找：真实大文档中 `企业` 共 98 个匹配，连续跳转、源码高亮、富文本高亮和 source/rich/source 切换状态保持均通过。

同时修正了若干 CDP 回归脚本的过时假设：源码切换按钮不再硬编码 `Ctrl+/`，改为同时匹配平台化快捷键标签和命令标题；源码查找脚本在 macOS 使用 `Cmd+F`，避免把测试脚本自身的快捷键假设误判为产品问题。

## 真实安装验证

macOS 本机验证流程：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir
pkill -f '/Applications/HorseMD.app/Contents/MacOS/HorseMD' || true
ditto dist/mac-arm64/HorseMD.app /Applications/HorseMD.app
xattr -dr com.apple.quarantine /Applications/HorseMD.app
open -na /Applications/HorseMD.app --args --remote-debugging-port=9455 --user-data-dir=/tmp/horsemd-installed-keybindings
```

已经验证过的安装版证据：

- 运行路径为 `/Applications/HorseMD.app/Contents/MacOS/HorseMD`。
- CDP 页面来自 `/Applications/HorseMD.app/Contents/Resources/app.asar/out/renderer/index.html`。
- `app.asar` 包含本轮功能标记 `settings.keyboardReserved.textInput`。
- 设置页快捷键列表显示 35 个命令。
- 在录制器里按普通字母 `A` 会显示普通文本输入保留键提示，不会写入用户配置。
- 设置页打开时按 `Cmd+F` 不会打开后台文档查找栏。

最近一次安装版复测：

- 重新执行 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir` 并覆盖安装 `/Applications/HorseMD.app`。
- 安装版 `app.asar` 修改时间为 `2026-07-17 02:33:38 +0800`。
- 运行命令行为 `/Applications/HorseMD.app/Contents/MacOS/HorseMD --remote-debugging-port=9461 --user-data-dir=/tmp/horsemd-installed-keybindings-final`。
- 隔离 profile CDP smoke 通过：页面来自安装版 app.asar、快捷键设置行数为 35，普通字母 `A` 保留键提示正常，设置页内 `Cmd+F` 不打开后台文档查找栏。

## 仍需人工验收

以下项目自动化只能覆盖一部分，不能在文档中假设完成：

- Windows / Linux 的真实菜单、窗口控制、Alt+F4 和系统快捷键冲突。
- macOS 真实菜单点击、关闭窗口、退出应用和系统编辑菜单行为。
- 文件对话框、系统字体权限弹窗、浏览器打开主题站点和 Finder/Explorer 打开主题目录。
- 富文本、源码、CodeMirror、表格、查找框、设置输入框和 modal 的完整人工矩阵。
- 大文档、远程图片、富文本/源码双向切换、Review、PDF、LaTeX、Mermaid、微信公众号粘贴等全量回归。
- 多窗口场景。当前版本仍以单主窗口为主要设计目标。

## 当前限制

- 首期只开放应用级命令、视图命令、文件命令和标题层级等低风险命令；粗体、斜体、高亮等编辑器原生命令暂时保持固定。
- 表格、CodeMirror、slash 菜单、输入法组合态和编辑器插件结构键仍优先由编辑器内部处理。
- 用户配置存储在 `localStorage["horsemd.keybindings.v1"]`，后续多窗口同步需要单独设计。
- 自定义快捷键尚未支持导入导出配置。

## 后续建议

1. 在发布前由人工按 `docs/manual-test-checklist.md` 跑设置、快捷键、保存、查找、源码切换、表格和 PDF 相关章节。
2. Windows / Linux 打包后分别运行 `npm run test:shortcuts` 中不依赖 macOS 菜单的脚本，并进行真实安装验收。
3. 如果要开放粗体、斜体、高亮等编辑器命令，先为表格、CodeMirror、中文输入法和 Review 场景补专项测试，再纳入命令注册表。
