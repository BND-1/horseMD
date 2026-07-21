# HorseMD AI 接手手册

> 面向全新的 AI / 开发者。先读这篇，再按链接深入。更新时间：2026-07-21。

## 0. 当前状态快照

- 当前主分支：`main`
- 当前测试版本号：`package.json` 为 `0.10.0`。已提交的功能包含移动端只读、可选同步 User-Agent、PDF 长公式分行、大文档代码块滚动稳定性、表格行列重复编辑保存修复、桌面悬浮章节导航，以及可组合的自定义 CSS 片段。
- 最近关键提交：
  - `2b31d93 fix(editor): preserve authored H5 and H6 case`
  - `4d76cd0 fix(outline): dismiss floating navigation on pointer leave`
  - `97b6c40 feat: improve editor and sync workflows`
  - `ab8f699 fix(pdf): render display latex in exports`
  - `0c1b3f0 fix(editor): protect inline math deletion`
  - `bdb73a5 fix(editor): refine outline and task list interactions`
  - `3d0a1f8 feat(shortcuts): add customizable keybindings`
- 最近完整验证：
  - `npm run build`
  - `npm run build:mobile`
  - `npm run guide:check`
  - `npm run test:ui-regression`（完整 UI 回归入口；新增专项后以脚本当前输出为准）
  - `npm run test:markdown-preservation`、`npm run test:issue-77-ui`（后者在 10 个隔离 Electron 进程中通过，并在已安装 macOS 包复跑）
  - `npm run test:outline-reorder`、`npm run test:issue-82-ui`（纯函数和真实 Electron 双向拖拽回归）
  - 云同步专项：`npm run test:sync-workspaces-ui`、`npm run test:sync-engine`、`npm run test:webdav-electron-sync`、`npm run test:webdav-apache`、`npm run test:s3-electron-sync`
  - 最近增量验证：`npm run test:floating-outline-ui`、`npm run test:heading-case-ui`、`node scripts/test-editor-inline-math.mjs`、`npm run test:table-ui`、`npm run test:issue-86-ui`
- 真实大文档回归依赖本机文件：
  - `/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md`
  - `/Users/yangtingyi/vibe_everything/电脑档案.md`

## 1. 先了解用户的工作方式

用户非常重视“真的改好”和“真实环境验证”。给他测试之前必须做到：

- 不要让用户测旧版本。每次请用户手测前，先从当前源码重新构建、安装、启动，并确认运行路径。
- 每开始一个独立新功能，先把测试包升级到下一个 minor 版本（例如 `0.7.1` 完成后，下一项新功能从 `0.8.0` 开始）。每次交付给用户测试的 bug 修复也必须升级 patch 版本（例如 `0.8.0` → `0.8.1`），不能让不同源码继续使用同一个版本号。
- 教程站的 `guide/package.json` 表示已发布教程与截图基准，不随本地测试包自动升级；页面可单独标注较新的测试功能版本。`npm run guide:check` 只禁止应用版本低于教程基准，避免把尚未发布的下载文件和截图伪装成新版本。
- 一个可手测的大功能完成并通过专项验证后，如用户没有要求暂停或改方向，默认立即构建、安装、启动当前源码版本交给用户验收；不要等待用户再次要求“打最新包”。
- 不要只说“理论上可以”。涉及 UI、PDF、编辑器、模式切换、表格、图片、移动端时，要用自动化或真实 app 复现。
- 不要把大文件、小文件、富文本、源码模式混为一谈。HorseMD 很多 bug 只在真实大文档、表格、代码块、LaTeX、远程图片、源码/富文本双向切换里出现。
- 不要轻易重写敏感状态机。源码/富文本切换、dirty 状态、保存、PDF 预览、编辑器生命周期都已经踩过坑。
- UI 需要“高级、优雅、和谐”。如果改视觉，至少检查浅色、深色、莫兰迪主题和窄屏，不要只看一个默认主题。
- 用户会直接指出不满意的点。接受反馈，回到代码和真实测试，不要争辩。
- 提交要聚焦。用户要求提交时再提交；不要擅自推送、发布、关闭 issue，除非他明确说。
- 发给用户验收的 macOS app 必须杀旧进程、覆盖 `/Applications/HorseMD.app`、清 quarantine、启动并验证 `app.asar` 包含本轮标记。

常用安装验证命令：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir

APP_SRC="/Users/yangtingyi/vibe_everything/horseMD/dist/mac-arm64/HorseMD.app"
APP_DST="/Applications/HorseMD.app"
pkill -f "/Applications/HorseMD.app" 2>/dev/null || true
pkill -f "HorseMD.app/Contents/MacOS/HorseMD" 2>/dev/null || true
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true
open -a "$APP_DST" --args --user-data-dir=/tmp/horsemd-latest --remote-debugging-port=9222
ps -ax | rg "HorseMD.app/Contents/MacOS/HorseMD"
```

## 2. 项目是什么

HorseMD 是一个 Typora 风格的 Markdown 编辑器：

- 桌面：Electron + Vite + React
- 编辑器：Milkdown Crepe / ProseMirror / CodeMirror
- 移动端：Capacitor，复用 renderer
- 用户教程站：`guide/`，VitePress
- 官网/下载页：`website/`

核心产品原则：

- 一个窗口内多标签，而不是每个文件一个进程。
- 富文本与源码模式都必须可用，且切换时光标/视口稳定。
- Markdown 源码要尽量可读，Review 标记、链接、图片、表格等都要能 round-trip。
- 大文档优先稳定和不卡，再谈花哨能力。
- 桌面和移动共用 renderer，平台能力通过 `window.api.capabilities` 和 `window.api.platform` 隔离。

## 3. 入口文档

建议阅读顺序：

1. [AGENTS.md](../AGENTS.md)：短规范，必须遵守。
2. [CLAUDE.md](../CLAUDE.md)：历史更长、更细的 AI/开发者指南。
3. [architecture.md](./architecture.md)：模块、进程、状态流。
4. [features.md](./features.md)：功能到具体文件的映射。
5. [manual-test-checklist.md](./manual-test-checklist.md)：人工验收基线。
6. [development.md](./development.md)：构建、CDP、发布验证。
7. [handoff-mode-switch.md](./handoff-mode-switch.md)：源码/富文本切换根因和修复历史。
8. [markdown-source-preservation.md](./markdown-source-preservation.md)：原始 Markdown 保真合同、粘贴边界与 Live Preview 远期决策。
9. [editor-refactor-strategy.md](./editor-refactor-strategy.md)：编辑器重构边界。
10. [performance-large-doc.md](./performance-large-doc.md)：大文档性能设计。
11. [user-guide-maintenance.md](./user-guide-maintenance.md)：教程站和截图规范。

历史文档说明：

- [triage-issues.md](./triage-issues.md) 是早期 issue 批处理记录，不是当前待办列表。
- `docs/release-v0.5.5.md`、`docs/release-v0.6.0.md`、`docs/release-v0.6.5.md` 是历史发布说明草稿/归档。

## 4. 目录地图

```text
src/main/
  index.js               Electron 主入口、窗口、菜单、单实例、启动参数
  documents.js           文档/对话框/PDF IPC 注册
  filesystem.js          文件读写、目录、复制、删除、图片保存
  watchers.js            chokidar watcher，必须防止系统根目录/受限目录
  security.js            外部协议、本地字体权限等安全口
  pdf-export.js          PDF 预览/保存、隐藏窗口、printToPDF、任务取消
  pdf-document.js        PDF HTML/目录/页眉页脚纯函数
  pdf-print-styles.js    PDF 打印 CSS

src/preload/index.js     安全的 window.api bridge

src/renderer/src/
  App.jsx                顶层 shell，tabs/session/split/settings/pdf/source-mode 接线
  components/Editor.jsx  Crepe 生命周期拥有者，避免继续膨胀
  components/editor-*.js 编辑器专项能力
  components/settings/   设置中心模块
  hooks/                 workspace/source-mode/pdf/find/sidebar 等 hooks
  lib/                   命令、菜单、纯工具
  platform/              Capacitor shim 和跨平台 API 合同
  styles/app.css         主样式和主题变量

scripts/                 CDP、纯函数和回归测试
docs/                    开发文档
guide/                   VitePress 用户教程站
website/                 官网/下载页
android/, ios/           Capacitor 原生壳
```

## 5. 最敏感的不变量

### 5.1 编辑器生命周期

- `Editor.jsx` 是 Crepe/ProseMirror 生命周期拥有者。
- 获取 ProseMirror view 必须用 `crepe.editor.ctx.get(editorViewCtx)`。
- `crepe.on(markdownUpdated)` 必须在 `crepe.create()` 前注册。
- 只有真实用户编辑可以让 tab dirty。
- 程序化初始化、源码/富文本同步、恢复内容、PDF source 生成不能标脏。
- ProseMirror 插件和 keymap 走 `prosePluginsCtx`。
- Milkdown node view 追加到 `nodeViewCtx`，不要设置 `editorViewOptionsCtx.nodeViews` 覆盖内置组件。

### 5.2 源码/富文本切换

- Crepe 在源码模式中必须保持挂载，只隐藏，不卸载。
- 源码 textarea 是非受控的，保留 `liveContentRef` / `commitLive` 流程。
- 只有源码真的改过，切回富文本才同步到 Crepe。
- Crepe 的 serializer 不保证原始 Markdown 写法；`lastMarkdownRef` 是用户源码，`canonicalMarkdownRef` 只用于识别局部富文本变更。不要在初始化、切换或局部编辑时用 canonical 内容覆盖整篇源码。
- 同时带 Markdown 和 HTML 的粘贴：Markdown 覆盖 HTML 语义时直接以 Markdown 插入并保留原文；网页 HTML 的纯文本回退不完整时必须保留 HTML。详见 [markdown-source-preservation.md](./markdown-source-preservation.md)。
- 光标映射不能用关键词匹配。主路径是 Markdown raw offset ↔ ProseMirror block-aware mapping。
- `npm run test:mode-switch-raw-offset-ui` 是当前的精确 UI 回归：它按 Markdown raw offset 覆盖正文、表格、列表、代码块，并执行两条连续切换链。不能只用相邻文本或关键词断言。
- `npm run test:issue-86-ui` 用真实表格手柄连续新增两行和两列，填写最后一行全部单元格、从富文本真实保存、彻底退出并以全新用户目录重开文件，保护单元格归属、表格维度、空单元格 `| |` 序列化，以及原有 `<br>` 单元格换行。表格变更必须使用完整 canonical Markdown；不要重新引入局部 raw-source 拼接或序列化中途删除空单元格占位。详见 `docs/issue-86-table-save-report.md`。
- 编辑状态：可见光标要跟随光标。阅读状态：光标不在可视区时保持视口。
- 回归必须覆盖：
  - 富文本 → 源码 → 富文本 → 源码
  - 源码 → 富文本 → 源码 → 富文本
  - 表格、代码块、行内代码、图片附近、大文档、重复文本

### 5.3 PDF 导出

- PDF 导出读取 `getPdfSource()` 生成的结构化 `{ html, headings, title }`，不是直接打印 live editor DOM。
- 普通 CodeMirror 代码块导出为 `<pre><code>`。
- LaTeX 段落公式不能导出源码；要先把预览块物化为可打印 MathML。
- 超宽行外 MathML 不得用比例缩小处理；PDF 临时文档中按顶层运算符拆成多行，编辑器内公式不变。
- PDF 预览是 latest-request-only；设置快速变化时旧任务必须取消。
- 打印目录页和 PDF 书签大纲是两个独立功能。
- 隐藏窗口临时 HTML 禁止脚本执行，保留 Electron 默认 web security。

### 5.4 工作区和文件系统

- 工作区是单一、多根，不是多 workspace 切换系统。
- `useWorkspace.js` 管 roots 和 watcher，`useSidebarTree.js` 管树加载和展开。
- watcher 必须拒绝相对路径、系统根、受限目录。
- 已打开文件被外部程序保存时：干净标签可自动刷新；脏标签必须保留本地内容并只提示一次外部冲突，不能静默覆盖或连续弹窗。保存会覆盖外部版本，用户可另存为保留两份。
- 主进程网络调用用 Electron `net.fetch`，不要用 Node global `fetch`。
- 外部链接协议必须通过 allowlist。

### 5.5 设置、快捷键和平台

- 设置 tab 是 transient，不进 session restore。
- 偏好在 `localStorage["horsemd.settings.v1"]`。
- 快捷键配置在 `localStorage["horsemd.keybindings.v1"]`。
- Ctrl/Cmd 一般都要支持。
- 编辑器内的粗体、斜体、表格结构键、CodeMirror 结构键、输入法相关键不能随意开放改绑。
- 移动端没有桌面文件系统/PDF 能力时必须 gate UI，不要让按钮假可用。

### 5.6 云同步

- 详细产品和数据模型见 [cloud-sync-prd.md](./cloud-sync-prd.md)。当前仅桌面端开放手动同步；Capacitor shim 必须保持 `cloudSync: false`，直到 [移动端同步架构](./mobile-cloud-sync-architecture.md) 所需的原生安全凭据、文件 adapter 与网络桥接都完成真机验证。
- 普通多根工作区和云同步工作区不是一件事。`useWorkspace` 继续管理可见文件树与 watcher；`useSyncWorkspaces` 只管理用户明确开启同步的根目录，不能扫描磁盘寻找 `.horsemd`。
- 阅读 `docs/cloud-sync-v2-prd.md` 和 `docs/cloud-sync-v2-architecture.md` 后再改同步逻辑。`merge`、`push`、`pull` 是不同策略：远端 manifest 缺失或异常清空时，`merge` 必须返回 `remote-reset`，绝不能据此生成 `deleteLocal`。
- `push`/`pull` 是用户明确发起的恢复操作。方向化覆盖或删除前需归档目标端旧文件；普通双向冲突保留双方。不要把对象存储的目录扫描结果当成可信删除日志。
- 每个同步根目录只有 `.horsemd/workspace.json` 一个标记，应用数据目录另有私有 registry。标记和 registry 不得包含密码、Secret 或用户内容；`.horsemd` 永远不能作为普通内容上传或被 watcher 展示。
- 渲染层只使用窄 `window.api.sync*` 接口，不能直接调用网络；主进程网络一律使用 Electron `net.fetch`，凭据使用 `safeStorage`。
- `SyncEngine` 的 manifest 必须最后条件提交；上传、下载、删除必须校验预览时的 revision/hash。不要把冲突改成最后写入者胜出。
- WebDAV PUT 可能不带 ETag，Provider 会 `PROPFIND` 补取；S3 要使用维护中的 SigV4 实现，且必须保持工作区 prefix 隔离。更改 provider 后同时跑 mock、真实服务和双 profile Electron 测试。

## 6. 近期功能与坑位

### 自定义快捷键

已落地第一版：

- 统一命令注册表
- 设置页录制
- 冲突和保留键校验
- 菜单 accelerator 同步
- 命令面板 hint 同步
- 设置页阻断后台快捷键

重点文档：

- [custom-shortcuts-architecture.md](./custom-shortcuts-architecture.md)
- [custom-shortcuts-implementation-checklist.md](./custom-shortcuts-implementation-checklist.md)
- [custom-shortcuts-verification-report.md](./custom-shortcuts-verification-report.md)

### LaTeX

最近修过：

- `$$` / `/math` 块公式输入焦点不中断。
- 行内公式纯数字和中间补写能实时预览。
- 行内公式编辑框支持“清空”。
- 行内公式默认保护删除：第一次删除先选中，第二次删除才移除。
- PDF 导出中段落公式打印为渲染公式，不再打印源码。

相关文件：

- `src/renderer/src/components/editor-inline-math.js`
- `src/renderer/src/components/editor-math-preview.js`
- `src/renderer/src/components/editor-api.js`
- `src/main/pdf-print-styles.js`
- `scripts/test-pdf-latex-ui.mjs`

### PDF 导出

第一版已经具备浏览器式预览中心：

- A4/A3/Letter/自定义尺寸
- 横向/纵向
- 边距、缩放
- 标题分页、目录页、PDF 书签
- 页眉页脚、日期、页码、页码范围
- 预览 buffer 与最终保存 buffer 一致

用户很在意 PDF 的真实预览和可配置项，不要退回简单保存对话框。

### 大纲

大纲支持折叠/展开，并默认保留前两层实际层级。近期修过：

- 父标题折叠时即使当前激活的是子标题，也要有反馈。
- 标题文字编辑后折叠状态不丢。
- 源码/富文本切换后目录层级不能跳。
- 桌面端拖动标题左侧抓手可重排**同一父级**下的章节，移动范围包含标题、后代标题和正文。必须调用 `outline-reorder.js` 的原始 Markdown 区段操作，不能取富文本 serializer 结果；不同父级或不同层级不允许落下，避免隐式重设层级。
- `FloatingOutline.jsx` 是纯渲染组件：默认只显示少量圆点，hover/focus 扩展标题列表，长标题以省略和原生 tooltip 处理。它必须复用 `useOutline.js` 的缓存 scrollspy，不能为了悬浮导航再注册 scroll listener 或逐帧读取全篇布局；移动端、无标题文档与侧栏“大纲”状态不显示。分屏时只跟随最后聚焦窗格。
- “折叠正文”不是当前大纲折叠的延伸。源码 textarea 无法隐藏局部行；富文本折叠须作为独立的、每 Tab 非持久 UI 状态设计，并先覆盖选区、查找、审阅、图片/代码块、模式切换和滚动锚点。

### 任务列表输入

近期改为 Typora 风格：

- 输入 `- [ ] ` 或 `- [x] ` 后直接转换任务列表。
- Enter 仍作兜底。

## 7. 测试策略

没有单一 `npm test`。按风险选择：

### 每次代码变更最低线

```bash
npm run build
git diff --check
```

### 共享 renderer / 设置 / 编辑器变更

```bash
npm run build:mobile
npm run test:core
```

### UI/编辑器/PDF/模式切换变更

```bash
npm run test:ui-regression
```

### 教程或用户文档变更

```bash
npm run guide:check
```

### 重点专项

```bash
npm run test:shortcuts
npm run test:settings-ui
npm run test:settings-layout-ui
npm run test:pdf-ui
npm run test:pdf-latex-ui
npm run test:math-ui        # 需要先以 scripts/fixtures/inline-math.md 启动 CDP app
npm run test:web-paste-ui
npm run test:table-ui
npm run test:lightbox-ui
npm run test:review-ui
npm run test:source-map
npm run test:markdown-preservation
npm run test:issue-77-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
```

`test:math-ui`、`test:pdf-ui` 等部分脚本连接已有 CDP session。单独跑时先按 fixture 启动，或参考 `scripts/run-ui-regression.mjs`。

## 8. CDP 实战注意

- 启动 Electron 时要加 `--remote-debugging-port=9222` 或脚本指定的端口。
- 多 tab / 分屏会有多个 `.ProseMirror`，必须用 `offsetParent` 找可见实例。
- 用真实 `Input.dispatchMouseEvent` / `Input.insertText`，不要只改 DOM selection。
- `Runtime.evaluate` 取值在 `msg.result.result.value`。
- macOS 可能复用旧 app 进程；安装前必须 kill。
- 如果脚本连接了错误窗口，结果没有意义。用隔离 `--user-data-dir=/tmp/...`。

## 9. 网站与教程

### `guide/`

VitePress 用户教程站，当前有：

- 入门安装
- 界面、文件、工作区、分屏
- 格式、表格、图片、链接、公式、Mermaid、斜杠菜单
- 查找、大纲、审阅、快捷键
- 主题、字体、设置
- PDF 导出、富文本复制、移动端
- FAQ 和故障排查

用户可见功能变更必须更新对应 guide 页面。截图必须来自“重新构建并安装后的当前 app”，用隔离 profile，不能包含私人路径或旧 UI。

命令：

```bash
npm run guide:dev
npm run guide:check
npm run guide:capture
```

### `website/`

静态产品/下载官网。包含 `index.html`、`styles.css`、`app.js`、SEO 文件和截图资源。它和 `guide/` 是两套站点：

- 官网用于介绍和下载。
- 教程站用于详细图文使用说明。

官网部署时注意 `website/.env.local`、`.vercel/` 等本地配置不要误提交敏感信息。

## 10. 发布与包

- 版本号必须单调递增。不要在发过内部 `0.5.29` 后发布 `0.5.5`，自动更新会认为旧。
- 开始新功能前先升级测试包版本；不要等到功能完成才升级，确保用户每次手测的包都能从版本号辨识来源。
- GitHub release tag 用 `vX.X.X`，标题用 `HorseMD vX.X.X`。
- Release note 用中文，结构建议：
  - 新功能
  - 改进
  - 修复
  - 安装
  - 关联 issue / full changelog
- macOS 包在 macOS 构建，Windows 包在 Windows 构建，Linux `.deb` 在 Ubuntu runner 构建并 `dpkg-deb --info` 验证。
- Linux release 工作流可能需要手动 `gh release upload --clobber` 上传 `.deb`。
- `.omc` 和 `.playwright-mcp` 是本机/工具目录，不要提交。

## 11. 当前 Roadmap 判断

近期优先级：

1. 稳定核心编辑链路：保存、dirty、源码/富文本切换、查找、大纲、表格、PDF。
2. 继续补自动化测试，特别是用户真实反馈路径。
3. 完善 Windows/Linux 实机包验证。
4. AI 能力先做架构方案，不急着写大模块。
5. 插件市场难度高，先不急；优先可控的自定义快捷键、同步、AI provider 合同。
6. 源码优先 Live Preview 是远期独立架构项目，不能作为当前 Crepe 模式切换的小修；先维护已落地的原文保真层。

已在 Roadmap 中记录：

- 自定义快捷键第一版已落地，后续谨慎开放编辑器内部命令。
- AI 能力后期探索，倾向原生体验 + provider 可插拔 + Review-first 修改。
- 云同步桌面端手动闭环已完成当前阶段；自动同步、移动端同步、历史恢复、E2EE、插件市场属于后续阶段。
- 当前公开 Issue 的分流、前置条件和验收边界见 [ROADMAP.md](../ROADMAP.md#当前-issue-分流2026-07-21)。其中 #62 必须 Windows 实机复现，#65 必须先定信息架构，#76/#23 都是原生平台项目；不要把它们当成可直接在 renderer 内完成的小修。

## 12. 新 AI 开始任务前的检查清单

1. `git status --short`，确认是否有用户未提交改动。
2. 读当前用户最新一句话，不要执行旧上下文遗留目标。
3. 如果是 bug，先复现或定位现有测试是否覆盖。
4. 找相关模块和历史文档，不要猜。
5. 设计最小改动，避开敏感状态机。
6. 写或更新专项测试。
7. 跑合适验证矩阵。
8. 用户要手测时，安装当前最新 app，并明确验证运行路径。
9. 用户确认后再提交/推送/发 release/回 issue。

## 13. 常见高风险文件

- `src/renderer/src/App.jsx`：shell 状态、source/rich、PDF、session 接线。不要随意塞逻辑。
- `src/renderer/src/components/Editor.jsx`：Crepe 生命周期拥有者。新功能尽量拆到 `editor-*.js`。
- `src/renderer/src/hooks/useSourceModeSwitch.js`：源码/富文本状态机，非常敏感。
- `src/renderer/src/scrollAnchor.js` 和 `mode-*.js`：光标/视口锚点 facade 和实现。
- `src/renderer/src/components/editor-source-map.js`：raw offset ↔ PM 映射，不能退化成关键词匹配。
- `src/renderer/src/components/editor-api.js`：PDF source、对外 editor API、source/rich restore。
- `src/main/pdf-export.js` / `pdf-document.js` / `pdf-print-styles.js`：PDF 预览、生成、打印样式。
- `src/main/filesystem.js` / `watchers.js` / `security.js`：本地文件和安全边界。
- `src/renderer/src/styles/app.css`：全局样式。改 UI 时查多个主题和移动端。

## 14. 最近一次稳定基线

截至 2026-07-18，下面这组已经跑通：

```bash
npm run build
npm run build:mobile
npm run guide:check
npm run test:ui-regression
node scripts/test-pdf-document.mjs
npm run test:pdf-latex-ui
npm run test:markdown-preservation
npm run test:issue-77-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
```

如果后续出现“之前明明是好的”，先回到这个基线和最近提交 diff 对照。
