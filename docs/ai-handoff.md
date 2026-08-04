# HorseMD AI 接手手册

> 面向全新的 AI / 开发者。先读这篇，再按链接深入。更新时间：2026-08-04。

## 0. 当前状态快照

- 当前主分支：`main`
- 当前测试版本号：`package.json` 为 `0.12.68`。在 0.12.34 原文保真与模式切换基线之上，0.12.35–0.12.47 完善 PDF、源码单换行、设置架构、Mermaid/LaTeX、表格、任务清单、打印竞态和三通道剪贴板保真；0.12.48 新增带真实预览的 HTML 导出、受控 Pandoc 多格式转换，并落地无 UI/无网络的 AI Phase 0 契约；0.12.49–0.12.58 修复图片导出、列表转换、长代码复制和新文档列表竞态；0.12.63 新增富文本即时 dirty 提示并修复本地 Markdown 绝对路径跳转、编辑器初始基线竞态，以及连续“正文转列表”只在富文本生效的源码保真问题；0.12.64 新增桌面端同一文档“左源码、右富文本”双栏实时预览，复用现有 textarea 与 Crepe 实例并保持统一保存边界；0.12.65 将入口收进富文本右键菜单，并让两侧按面板宽度工作，避免单栏阅读最大宽度造成空白条；0.12.66 将双栏收敛为左源码唯一编辑、右富文本只读预览，避免两个表面竞争内容真相；0.12.67 修正源码粗光标的字符边界、统一双栏尾部留白，并加入面板内直接关闭入口；0.12.68 再修 Chromium 将行首字符点击误判为 offset +1 的实际选区问题。
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
  - 0.12.46：`npm run test:mermaid-paste-ui` 以隔离 profile 连续 10/10 通过；完整 UI 回归为 `7 sessions + 25 standalone`
  - 0.12.51：`npm run test:issue-98-ui` 使用 122 行 JSON 强制触发 CodeMirror 虚拟化，验证按钮全文复制、全选复制和 65 行部分选择；系统剪贴板每次先写 sentinel，避免旧内容造成假通过
  - 0.12.52：`npm run test:list-conversion-ui` 覆盖当前层级/任务/正文转换，并用混合松散-紧凑嵌套列表验证转换后立即逐字输入、源码逐字节、保存和新进程重开
  - 0.12.63：`npm run test:rich-dirty-indicator-ui`、`npm run test:issues-105-106-ui`、`npm run test:local-markdown-links`、`npm run test:block-list-source`、`npm run test:list-conversion-ui`、`npm run test:security` 与 `npm run guide:check` 均通过；已构建并安装 `/Applications/HorseMD.app`，`Info.plist` 与运行进程均为 0.12.63。
  - 0.12.67（已安装、待人工验收）：`npm run test:source-rich-split`（含同步 revision 合同、源码立即保存、双栏/独占源码真实鼠标行首光标、匹配的尾部留白、十次交替滚动与面板内关闭）、`npm run test:source-map`、`npm run test:rich-dirty-indicator-ui`、`npm run build`、`npm run build:mobile` 与 `npm run guide:check` 通过。已用 `dist:dir` 构建并替换 `/Applications/HorseMD.app`；`Info.plist`、asar 内 `package.json` 与运行进程均验证为 0.12.67。双栏尚需在当前构建包上进行含图片/表格/代码块的大文档和真实中文输入法人工回归。
  - 0.12.68（已安装、待人工验收）：补足 Chromium 对非空行首字符点击的实际选区校正，并修正 textarea mirror 对行首折叠 Range 的首字符右缘定位。`npm run build`、`npm run test:source-rich-split`（精确覆盖 `## 页面对应关系` 在独占源码与源码预览左栏的首个 `#` 点击）、`npm run test:source-map`、`npm run test:rich-dirty-indicator-ui` 和 `git diff --check` 通过；已用 `dist:dir` 构建并替换 `/Applications/HorseMD.app`，`Info.plist`、asar 内 `package.json` 与运行进程均验证为 0.12.68。
  - 0.12.47：`npm run test:settings-ui` 额外测量页宽预览几何变化，并验证滑杆尚未松手时已经实时反馈；详见 `docs/settings-page-width-preview-regression.md`
  - 跨编辑器换行对照：Typora 0.11.18、Obsidian 1.12.7 与 HorseMD 0.12.47 对普通单换行均采用“一个段落、多条视觉行”；HorseMD 的 CSS 软换行必须在剪贴板克隆中物化，详见 `docs/cross-editor-line-break-comparison.md`
  - `npm run test:markdown-preservation`、`npm run test:issue-77-ui`（后者在 10 个隔离 Electron 进程中通过，并在已安装 macOS 包复跑）
  - `npm run test:outline-reorder`、`npm run test:issue-82-ui`（纯函数和真实 Electron 双向拖拽回归）
  - 云同步专项：`npm run test:sync-workspaces-ui`、`npm run test:sync-engine`、`npm run test:webdav-electron-sync`、`npm run test:webdav-apache`、`npm run test:s3-electron-sync`
  - 最近增量验证：`npm run test:mermaid-paste-ui`、`npm run test:floating-outline-ui`、`npm run test:heading-case-ui`、`node scripts/test-editor-inline-math.mjs`、`npm run test:math-ui`、`npm run test:display-math-scroll-ui`、`npm run test:tagged-display-math-ui`、`npm run test:pdf-latex-ui`、`npm run test:table-ui`、`npm run test:issue-86-ui`、`npm run test:issue-79-ui`、`npm run test:editor-style-settings-ui`、`npm run test:inline-html-block-handle-ui`
- 真实大文档回归依赖本机文件：
  - `/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md`
  - `/Users/yangtingyi/vibe_everything/电脑档案.md`

## 1. 先了解用户的工作方式

用户非常重视“真的改好”和“真实环境验证”。给他测试之前必须做到：

- 不要让用户测旧版本。每次请用户手测前，先从当前源码重新构建、安装、启动，并确认运行路径。
- 每次交付给用户测试的普通改动都必须升级 patch 版本，包括小功能、bug 修复、交互和视觉调整（例如 `0.12.0` → `0.12.1`），不能让不同源码继续使用同一个版本号。只有用户明确认定为独立“大功能/模块”时才升 minor（例如 `0.12.x` → `0.13.0`）；代理不能自行把一般功能算作 minor。
- 教程站的 `guide/package.json` 表示已发布教程与截图基准，不随本地测试包自动升级；页面可单独标注较新的测试功能版本。`npm run guide:check` 只禁止应用版本低于教程基准，避免把尚未发布的下载文件和截图伪装成新版本。
- 一个可手测的大功能完成并通过专项验证后，如用户没有要求暂停或改方向，默认立即构建、安装、启动当前源码版本交给用户验收；不要等待用户再次要求“打最新包”。
- 不要只说“理论上可以”。涉及 UI、PDF、编辑器、模式切换、表格、图片、移动端时，要用自动化或真实 app 复现。
- 自动化测试不能抢用户的 macOS 键鼠和前台窗口。通过
  `scripts/lib/electron-test-app.mjs` 启动时保持默认 `background: true`；
  只有人工观察或教程截图才显式使用可见窗口。
- 输入规则、Enter/退格、模式切换后立即输入和源码保真必须逐字符派发，优先
  使用 `scripts/lib/human-input.mjs`。批量 `Input.insertText` 只能用于粘贴、
  数据准备或与逐键行为无关的测试；中文逐字提交不能代替真实 IME composition。
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
BACKUP="/tmp/HorseMD.app.before-$(date +%Y%m%d-%H%M%S)"
pkill -f "$APP_DST/Contents/MacOS/HorseMD" 2>/dev/null || true
if [ -e "$APP_DST" ]; then mv "$APP_DST" "$BACKUP"; fi
cp -R "$APP_SRC" "$APP_DST"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true
open -a "$APP_DST" --args --user-data-dir=/tmp/horsemd-latest --remote-debugging-port=9222
plutil -extract CFBundleShortVersionString raw "$APP_DST/Contents/Info.plist"
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
9. [rich-dirty-indicator-regression.md](./rich-dirty-indicator-regression.md)：富文本未保存提示的 200ms 防抖根因、即时反馈合同和回归命令。
10. [local-markdown-links-regression.md](./local-markdown-links-regression.md)：富文本本地绝对/相对链接跳转、安全 IPC 边界与回归命令。
11. [source-rich-split-view-prd.md](./source-rich-split-view-prd.md)：已实现的“左源码、右富文本”双栏实时预览用户范围、状态和验收标准。
12. [source-rich-split-view-architecture.md](./source-rich-split-view-architecture.md)：双栏同步、滚动联动、保真与性能边界；后续扩展必须遵守。
11. [editor-source-switch-regression-0.12.34.md](./editor-source-switch-regression-0.12.34.md)：段落合并、切换后即时输入、硬换行光标偏移和行内代码边界的联合根因报告。
12. [editor-refactor-strategy.md](./editor-refactor-strategy.md)：编辑器重构边界。
13. [performance-large-doc.md](./performance-large-doc.md)：大文档性能设计。
14. [user-guide-maintenance.md](./user-guide-maintenance.md)：教程站和截图规范。
15. [issue-101-pdf-images-table-density-report.md](./issue-101-pdf-images-table-density-report.md)：PDF 图片二次加载、路径双重编码与表格固定行高的根因。
16. [soft-line-break-display-report.md](./soft-line-break-display-report.md)：普通源码单换行在富文本中显示为空格的根因、显示合同和防回归测试。
17. [pdf-table-layout-fidelity-report.md](./pdf-table-layout-fidelity-report.md)：PDF 表格列宽与行距两次修复的完整事故复盘。
18. [pdf-visual-fidelity-runbook.md](./pdf-visual-fidelity-runbook.md)：所有“编辑器正常、PDF 不一致”问题的工程化排查和验收流程。
19. [long-code-copy-virtualization-regression.md](./long-code-copy-virtualization-regression.md)：长代码块复制截断的虚拟化根因、正确数据源和防回归停止条件。

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
  pdf-images.js          PDF 图片暂存、单图/总量限制、资源地址替换
  pdf-document.js        PDF HTML/目录/页眉页脚纯函数
  pdf-print-styles.js    PDF 打印 CSS
  html-export.js         HTML 预览 token、图片内嵌、保存与资源清理
  html-document.js       独立 HTML 模板、主题、目录和 CSP 纯函数
  pandoc-export.js       Pandoc 检测、选择、转换与错误映射
  pandoc-core.js         Pandoc 格式白名单、版本与参数纯函数
  subprocess.js          无 shell 子进程、超时与输出上限
  ai/                    AI 上下文快照与变更提案纯逻辑

src/preload/index.js     安全的 window.api bridge

src/renderer/src/
  App.jsx                顶层 shell，tabs/session/split/settings/pdf/source-mode 接线
  components/Editor.jsx  Crepe 生命周期拥有者，避免继续膨胀
  components/editor-*.js 编辑器专项能力
  components/settings/   设置中心模块
  hooks/                 workspace/source-mode/pdf/html/pandoc/find/sidebar 等 hooks
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
- 富文本 UI 的未保存提示不得等待 Milkdown 的 200ms `markdownUpdated`；使用 `pendingRichEdit` 即时提示、使用后续源码保真结果结算。所有消费方通过 `isTabDirty(tab)` 判断，不要直接比较 `content` 与 `savedContent`。
- ProseMirror DOM 可见不等于可安全编辑：初始 canonical baseline、公开 API 与 `ready` 都完成前必须保持不可编辑；完成后才标记 `data-horsemd-ready="true"`。否则极早输入可能被吞入初始化基线而无法保存或切到源码。
- Markdown 链接 Ctrl/Cmd+点击：网页链接只走 `openExternal`；本地 `file://`、POSIX 绝对路径、Windows 盘符/UNC 和相对路径都必须先规范为 file URL，再仅通过 `openFileUrl` IPC 打开。主进程必须校验发送者，不能让任意 renderer 调用系统 shell。
- 程序化初始化、源码/富文本同步、恢复内容、PDF source 生成不能标脏。
- ProseMirror 插件和 keymap 走 `prosePluginsCtx`。
- Milkdown node view 追加到 `nodeViewCtx`，不要设置 `editorViewOptionsCtx.nodeViews` 覆盖内置组件。

### 5.2 源码/富文本切换

- Crepe 在源码模式中必须保持挂载，只隐藏，不卸载。
- 源码 textarea 是非受控的，保留 `liveContentRef` / `commitLive` 流程。
- 普通源码单换行由 Milkdown 保留为 `data-is-inline="true"` 的 hardbreak 节点。默认多行显示只能通过 `hm-preserve-soft-breaks` 做视觉处理；禁止把它序列化为 `<br>`、尾随空格或空段落。Enter 与 Shift+Enter 的编辑语义不得随该偏好变化，修改后必须运行 `npm run test:soft-break-ui`、`test:paragraph-source-ui` 和 `test:mode-switch-raw-offset-ui`。
- textarea DOM 会把 CRLF 变成 LF；任何源码输入或源码命令写回 `liveContentRef` 前必须经过 `source-text-fidelity.js`，禁止直接保存 `textarea.value`。
- 只有源码真的改过，切回富文本才同步到 Crepe。
- Crepe 的 serializer 不保证原始 Markdown 写法；`lastMarkdownRef` 是用户源码，`canonicalMarkdownRef` 只用于识别局部富文本变更。普通文字只允许字符级回写；结构操作最多替换受影响列表、表格或行；映射失败必须保留原文并报告失败。唯一例外是从空白起步、全程仅富文本写作的新文档：它没有既有源码格式，嵌套列表退出的中间空项不能进入增量基线，应以完整实时 canonical 建立结构并恢复已记录 marker；一旦用户实际编辑源码，立刻关闭该例外。
- 分块大文档追加完成后必须记录完整 `canonicalMarkdownRef`，但绝不能用 canonical 重建 `lastMarkdownRef`。富文本插入类命令必须以 `tab.content` / `lastMarkdownRef` 为全文基底，不得以 `getMarkdown()` 为基底。
- 源码调用 `replaceAll` 同步到 Crepe 时可能连续发出多个 `markdownUpdated`。`programmaticReplaceRef` 必须保持到下一次明确的 `markUserEdit`，不能只跳过第一条回调，否则前一次用户编辑的 TTL 会把后续同步事务误判为用户编辑。
- Crepe canonical 始终带结尾换行，文档末尾新建的空 paragraph 又没有 visible index。不能把其后续输入映射到“最后一个可见字符”；`preserveAppendedParagraph` 必须按用户源码原有结尾换行数追加标准段落边界。修改后运行 `npm run test:paragraph-source-ui`，并确认测试包含保存、退出和全新进程重开。
- 源码 textarea 是非受控组件，`defaultValue` 只在挂载时读取。富文本→源码切换前必须调用 `editorApis[id].flushMarkdown()`，同步更新 `tabsRef` 和 tab state 后再挂载 textarea；不能只依赖异步 `markdownUpdated`，否则立即切换会显示旧内容且后续 state 更新无法回填。专项测试必须在最后一次 `Input.insertText` 后零等待切换。
- 空文档的默认“空 H1 + 空正文”只属于富文本起笔 UI，磁盘源码仍是空字符串。`canonicalForSource()` 必须在标题保持为空时剥离该骨架；用户在标题输入后才将其纳入 canonical。移除这层会使首次输入因 `#\n\n` 与空源码基线不一致而被原文保护器拒绝。`test:paragraph-source-ui` 必须同时覆盖从 H1 起笔和跳过 H1 从正文起笔。
- Enter 创建的末尾空 paragraph 会被 Crepe canonical 暂时写成独立 `<br />` 块。`preserveTrailingEmptyBlock()` 必须在创建时只推进 canonical、不改 raw source，填入文字时再调用文档末尾块追加逻辑；否则真人慢速输入会把正文并入标题并残留 `<br />`。CDP 测试必须逐字输入且每行停顿到上一条 `markdownUpdated` 已提交，高速整句输入会掩盖该问题。
- 在已有块之间按 Enter 还有两条独立路径：快速输入可能直接产生一个新 paragraph，停顿输入会先产生 `<br />` 占位。`preserveMiddleEmptyBlock()` 只可用前后未变化可见行的序号映射替换中间 raw 间隙，不能用零可见字符 affinity；并且必须把列表、表格、标题、引用和 fenced code 排除，让专用结构处理器保留原有语法风格。
- ProseMirror 的 `bullet_list` 节点不保存用户触发输入规则时键入的 `-`、`*` 或 `+`。必须在空段落输入空格前记录 marker intent，再把它恢复到刚创建的列表层级；不能全局替换 serializer 的 `*`。松散列表可跨项目间空行，但顶层有序/无序类型变化必须截断；转换后 canonical 若把相邻同类型列表合并，`replaceMarkdownListBlock()` 必须按转换前项目内容缩小到原列表子区间。详见 [0.12.45 新输入源码保真报告](./new-input-source-fidelity-report.md)。
- 正文转列表必须与“已有列表类型转换”分开：前者需要在 dispatch 前记录该普通段落的 raw offset，dispatch 后用 `serializerCtx(view.state.doc)` 取得实时 canonical，并且只向对应 authored 行写入 `- `、`1. ` 或 `- [ ] `。禁止读取 `crepe.getMarkdown()` 缓存或用全篇 canonical 覆盖；实现见 `editor-block-list-source.js`，回归为 `npm run test:block-list-source` 和 `npm run test:list-conversion-ui`。
- 新建空列表项的 Crepe `<br />` 是内部占位，不是用户 Markdown：源码只能短暂表示为用户输入的 `- ` / `* ` / `+ ` / `1. ` / `1) `，首个列表文字必须按列表树顺序填回该项，绝不能落到上一段。物理键盘必须在 Space 的 `keydown` 记录 marker；连续 Enter、marker、Space 时若原始源码尚未发布空段落，禁止使用失真的 raw offset，改以 canonical 前/后快照在前后可见内容边界插入仅该列表（末尾与中间均覆盖）。若新文档的首次 `markdownUpdated` 已合并标题、正文和嵌套列表，source/canonical 都为空时必须保留完整 canonical，不能让当前内层 selection 的输入规则补丁覆盖外层；生成的全新列表采用紧凑间距。嵌套项退出后紧接无序项时，`markdownUpdated` 和立即源码切换的 `flushMarkdown()` 必须共用完整 canonical 生成路径并恢复未发布的 `-` marker，避免中间空 `3.` 或默认 `*` 固化；用户实际编辑源码后关闭该路径。输入规则意图在首次成功重建该列表后必须立即清除；不得在后续 Enter/Tab 的嵌套列表操作中重放旧 source snapshot。初始化与 `flushMarkdown()` 必须同用 `serializerCtx(view.state.doc)`；缓存 serializer 与实时 serializer 的尾换行差异也必须视为非用户编辑。修改此边界后运行 `npm run test:rich-list-source-ui`、`npm run test:new-document-list-source-ui`、`npm run test:new-source-fidelity-ui` 和 `npm run test:list-conversion-ui`。
- 同时带 Markdown 和 HTML 的粘贴：Markdown 覆盖 HTML 语义时直接以 Markdown 插入并保留原文；网页 HTML 的纯文本回退不完整时必须保留 HTML。详见 [markdown-source-preservation.md](./markdown-source-preservation.md)。
- 光标映射不能用关键词匹配。主路径是 Markdown raw offset ↔ ProseMirror block-aware mapping。
- `npm run test:mode-switch-raw-offset-ui` 是当前的精确 UI 回归：它按 Markdown raw offset 覆盖正文、表格、列表、代码块，并执行两条连续切换链。不能只用相邻文本或关键词断言。
- 该模式切换回归还必须覆盖硬换行后的 raw offset，以及源码→富文本后零等待 Enter、跨 `90/220ms` 分段输入。首次恢复在 layout 阶段同步执行；富文本一旦收到真实键盘、输入法或鼠标交互，延迟 settle 重试必须终止，不能覆盖用户的新选区。
- `npm run test:issue-86-ui` 用真实表格手柄连续新增两行和两列，填写最后一行全部单元格、从富文本真实保存、彻底退出并以全新用户目录重开文件，保护单元格归属、表格维度、空单元格 `| |` 序列化，以及原有 `<br>` 单元格换行。表格结构变化只替换对应 canonical 表格块，禁止扩大到整篇源码；不要在序列化中途删除空单元格占位。详见 `docs/issue-86-table-save-report.md`。
- `npm run test:table-ui` 保护另一条独立的表格 UI 合同：短表自然宽度、宽表内部横向滚动和不撑开页面；列边缘的短暂悬停仍用于加行/加列，只有按住约 220ms 才实时调整列宽；宽表最右端连续 10 次悬浮/调整均不得把 `scrollLeft` 重置为 0。不要重新注册 `columnResizingPlugin`，它会与 Crepe 自定义 `TableNodeView` 竞争 hover transaction，重新引入跳回和非确定性预览。
- `npm run test:task-list-persistence-ui` 保护任务复选框的完整写盘链路：勾选、保存、退出重开、取消、保存、再次重开。Crepe 的任务标签在 `pointerdown` 阶段更新节点并阻止兼容 `mousedown`，因此根节点必须在 capture 阶段标记用户编辑；不要用全篇重新序列化或单独改文件绕过现有 `markdownUpdated` 与原文保真链路。
- `editor-block-handle-guard.js` 只负责块操作条的触发过滤和滚动隐藏；横向位置由 `Feature.BlockEdit.blockHandle.getPosition` 交给 Milkdown BlockProvider 一次性计算，禁止再用 `translate`、MutationObserver 或 ResizeObserver 二次改坐标。标题、正文和各级列表必须共用正文左边界这一条轨道。修改 BlockEdit、插件顺序或 editor gutter 时，必须同时运行 `npm run test:block-handle-gutter-ui` 与 `npm run test:inline-html-block-handle-ui`。
- 编辑状态：可见光标要跟随光标。阅读状态：光标不在可视区时保持视口。
- 回归必须覆盖：
  - 富文本 → 源码 → 富文本 → 源码
  - 源码 → 富文本 → 源码 → 富文本
  - 表格、代码块、行内代码、图片附近、大文档、重复文本

### 5.2b CodeMirror 与剪贴板

- CodeMirror 长代码块使用虚拟化 DOM，`.cm-line` 只代表当前渲染窗口，不能作为“完整代码”的数据源。
- 代码块右上角复制按钮必须解析完整 ProseMirror `code_block`；解析失败时应停止且不能显示成功反馈，禁止回退拼接 `.cm-line`。
- CodeMirror 内部的全选和部分选区复制由其文档状态负责。修复“复制整块”时不能拦截或扩大原生选区，否则选择 65 行会错误复制全文。
- 复制测试必须读取真实系统剪贴板，并在每次操作前写入 sentinel；只检查 toast、按钮颜色或未清空的旧剪贴板会产生假通过。
- 修改代码块 node view、复制事件、DOM 映射或 clipboard IPC 后，先运行 `npm run build`，再运行 `npm run test:issue-98-ui` 和 `npm run test:clipboard-ipc-ui`。构建与 UI 测试不能并行，否则测试可能加载旧 `out/`。
- 完整根因和验收数据见 [长代码块复制截断事故复盘](./long-code-copy-virtualization-regression.md)。

### 5.3 PDF 导出

- PDF 导出读取 `getPdfSource()` 生成的结构化 `{ html, headings, title }`，不是直接打印 live editor DOM。
- `getPdfSource()` 是异步快照 API；调用方必须 `await`。DOM 在异步 Mermaid 渲染前立即克隆，不能在等待期间重新读取 live editor。
- `getPdfSource()` 会把非 data URL 图片替换为唯一占位符，并附带图片清单。主进程 `pdf-images.js` 必须先把本地和网络图片暂存到 PDF 临时目录，再生成打印 HTML；不要让隔离的 `file://` 隐藏窗口按原 URL 二次加载。暂存失败才回退原地址并由真实加载结果决定是否警告。
- Markdown 图片相对路径只能解码并编码各一次。尤其要保护空格、中文、Windows 盘符和已写成 `%20` 的路径，禁止产生 `%2520`。
- 普通 CodeMirror 代码块导出为 `<pre><code>`。
- LaTeX 段落公式不能导出源码；要先把预览块物化为可打印 MathML。
- Mermaid 不能依赖 `.preview-panel` 当前是否挂载或可见；`editor-pdf-content.js` 必须主动通过 `renderMermaidForExport()` 生成并清理 SVG，再删除预览 DOM。语法错误或总截止时间耗尽时保留源码。
- 超宽行外 MathML 不得用比例缩小处理；PDF 临时文档中按顶层运算符拆成多行，编辑器内公式不变。
- PDF 预览是 latest-request-only；设置快速变化时旧任务必须取消。
- PDF 表格不能统一强制 `table-layout: fixed; width: 100%`。`editor-pdf-content.js` 在清理 DOM 前用可见表格实测总宽度和每列比例，紧凑表保留自然宽度，宽表才收敛至打印区域。`npm run test:pdf-table-layout-ui` 会同时检查 source `<colgroup>` 和最终 PDF 文字 X 坐标；只断言 HTML 存在表格不足以保护视觉一致性。
- PDF 表格单元格通常包含内层 `<p>`。必须保留 `.doc th > p, .doc td > p { margin: 0; padding: 0; line-height: inherit; }`，否则全局正文段落间距会把每一行撑高。表格回归同时检查最终 PDF 的纵向文字基线距离。
- 打印目录页和 PDF 书签大纲是两个独立功能。
- 隐藏窗口临时 HTML 禁止脚本执行，保留 Electron 默认 web security。

### 5.3b HTML、Pandoc 与 AI 基础

- HTML 与 PDF 共用异步结构化导出快照，但页面模板和设置独立。不要 clone live DOM，也不要把 PDF 打印 CSS 当网页 CSS。
- HTML 预览由主进程生成最终字节并返回 token；保存必须写 token 对应的同一份 HTML，不能在保存时重新生成。
- HTML 输出和预览必须保持无脚本：结构快照移除危险节点/属性，模板带严格 CSP，renderer iframe 使用无权限 sandbox。
- Pandoc 只接收当前聚焦标签的最新 Markdown。源码读取 live textarea，富文本先 `flushMarkdown()`；导出不得改变 dirty、光标或磁盘源文件。
- Pandoc 可执行路径必须通过绝对路径、文件名和 `--version` 验证；目标格式是白名单，参数由主进程构造，Markdown 走 stdin，`shell: false`，两分钟超时。
- `src/shared/ai-contracts.js` 与 `src/main/ai/` 是 Phase 0 基础，不代表 AI 已对用户开放。后续 Provider、密钥、网络和 UI 不能绕过 revision 校验与 ChangeProposal 直接写文档。
- 详细边界见 [document-export-architecture.md](./document-export-architecture.md)、[document-export-prd.md](./document-export-prd.md) 和 [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md)。

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
- Crepe 的块公式位于 `.milkdown-code-block .preview` flex 容器。带 `\tag{...}` 的 KaTeX 公式必须保持 `flex-basis: 100%`，并给 `.katex-html` 的编号预留右侧空间；否则短公式会 shrink-to-fit，绝对定位编号会压到公式本体。用 `npm run test:tagged-display-math-ui` 保护这条布局合同。
- 块公式预览不能常驻 `overflow: auto`：Windows 会为即使未溢出的容器显示滚动箭头。`editor-katex-dom-prune.js` 根据实际 `scrollWidth` 标记 `data-hm-math-overflow`；仅标记为 `true` 的公式横向滚动，外层 `.preview` 不再形成第二个滚动面。用 `npm run test:display-math-scroll-ui` 同时保护短公式和长公式。
- 已渲染的块公式必须覆盖 Crepe 通用代码块的 `8px/20px` 内边距；只在 `.preview > .katex-display` 出现时压紧外层留白，不能影响普通代码块、公式源码编辑态、编号布局、横向溢出或 PDF。

### 选中文字工具栏

- 桌面端设置 `selectionToolbar` 默认开启；关闭时只以 CSS 隐藏现有 Crepe 工具栏，绝不因偏好变更重建已挂载的编辑器。
- 关闭后，富文本选区右键菜单必须以“文字格式”“审阅标记”“转换为”的悬停/焦点子菜单保持紧凑，提供粗体、斜体、删除线、行内代码、链接、高亮，以及完整审阅标记（新增、删除、替换、高亮 + 评论）；列表转换或块类型转换也必须继续保留。根菜单不能用 `overflow` 裁掉横向子菜单，靠近窗口右边时子菜单要向左展开。菜单打开时保存精确的 ProseMirror `anchor/head`，所有选区命令执行前恢复它，不能依赖浏览器在右键/菜单焦点切换后仍保留内部选区。
- 移动端仍只显示系统原生选中文字菜单。

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
- 边距、8–24pt 正文字号、整体缩放
- 标题分页、目录页、PDF 书签
- 页眉页脚、日期、页码、页码范围
- 预览 buffer 与最终保存 buffer 一致

用户很在意 PDF 的真实预览和可配置项，不要退回简单保存对话框。
PDF 设置采用 latest-request-only，但进入 `printToPDF()` 后不能通过销毁隐藏窗口
来取消；必须等待当前打印自然结束并丢弃 stale 结果。详见
[pdf-preview-printing-race-report.md](./pdf-preview-printing-race-report.md)。

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
npm run test:paragraph-source-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
npm run test:issue-98-ui
npm run test:clipboard-ipc-ui
```

`test:math-ui`、`test:pdf-ui` 等部分脚本连接已有 CDP session。单独跑时先按 fixture 启动，或参考 `scripts/run-ui-regression.mjs`。

## 8. CDP 实战注意

- 启动 Electron 时要加 `--remote-debugging-port=9222` 或脚本指定的端口。
- 自动化优先使用 `launchBuiltElectron()`；它默认追加
  `--horsemd-test-background`，隐藏主窗口并避免获取 macOS 原生焦点。
- 多 tab / 分屏会有多个 `.ProseMirror`，必须用 `offsetParent` 找可见实例。
- 用真实 `Input.dispatchMouseEvent`；输入敏感路径通过
  `typeTextLikeUser()` 逐字符提交或使用 `Input.dispatchKeyEvent`，不要只改
  DOM selection，也不要一次注入整句来替代真人输入。
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
4. AI Phase 0 的合同、上下文快照和变更提案纯逻辑已落地；下一步仍先做只读 Provider，不急着开放自动写入或 Agent 权限。
5. 插件市场难度高，先不急；优先可控的自定义快捷键、同步、AI provider 合同。
6. 源码优先 Live Preview 是远期独立架构项目，不能作为当前 Crepe 模式切换的小修；先维护已落地的原文保真层。

已在 Roadmap 中记录：

- 自定义快捷键第一版已落地，后续谨慎开放编辑器内部命令。
- AI 能力倾向原生体验 + provider 可插拔 + Review-first 修改；VMark 参考结论和具体分期见 [vmark-reference-review.md](./vmark-reference-review.md) 与 [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md)。
- 云同步桌面端手动闭环已完成当前阶段；自动同步、移动端同步、历史恢复、E2EE、插件市场属于后续阶段。
- 当前公开 Issue 的分流、前置条件和验收边界见 [ROADMAP.md](../ROADMAP.md#当前-issue-分流2026-07-21)。#62 已加 Windows 专属 compositor 降级，但仍必须 Windows 实机复现；#65 必须先定信息架构，#76/#23 都是原生平台项目；不要把它们当成可直接在 renderer 内完成的小修。

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
- 设置页排版预览是实际编辑器的缩尺模型。页宽不能直接套用低于真实预设的固定 `max-width`；测试必须测量可见宽度，不能只检查设置值和 CSS 变量。

## 14. 最近一次稳定基线

截至 2026-07-31，`0.12.50` 在原有 0.12.47 基线之外新增以下必测项（`npm run test:document-export` 已含子进程 / Pandoc 核心 / HTML 文档 / 导出保存目录 per-file 语义 / PDF 密度 no-op 基线共 5 个纯模块回归；0.12.50 紧凑密度实测同一文档从 43 页降到 35 页）：

```bash
npm run build
npm run build:mobile
npm run guide:check
npm run test:document-export
npm run test:document-export-ui
npm run test:ai-core
npm run test:ui-regression
node scripts/test-pdf-document.mjs
npm run test:pdf-latex-ui
npm run test:markdown-preservation
npm run test:issue-77-ui
npm run test:paragraph-source-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
```

其中 0.12.47 的 `npm run test:ui-regression` 最终结果为 `7 sessions + 25 standalone`；0.12.48 再次跑出同样的全绿结果。导出专项使用后台 Electron 验证 HTML 四主题/四宽度、结构化 Mermaid/LaTeX/表格/任务列表/图片、设置入口和模拟 Pandoc 异常；本机 Pandoc 3.10.1 还实际生成并检查了 docx、tex、epub。SVG 写入部分格式会按 Pandoc 规则要求额外的 `rsvg-convert`，不能由 HorseMD 静默伪装。

如果后续出现“之前明明是好的”，先回到这个基线和最近提交 diff 对照。

### 真实 macOS 输入补充

疑难编辑问题除后台 CDP 回归外，可用 `CGEvent` 在前台 HorseMD 中逐键输入，并以截图、保存重开和按需 `pbpaste` 交叉核验；方法见 [macOS 真实输入测试方法](macos-real-input-testing.md)。英文原始键码与中文拼音组合输入需分别覆盖。
