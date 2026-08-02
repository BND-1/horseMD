# 开发、构建与测试

## 本地开发

```bash
npm install
# 若 Electron 二进制下载被墙，先设镜像：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   (Windows cmd)
#   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" (PowerShell)
npm run dev
```

`npm run dev` 用 electron-vite 起开发模式：main/preload 用 esbuild 构建，renderer 用 Vite dev server（热重载）。

## 构建与打包

```bash
npm run build       # 构建到 out/（main + preload + renderer）
npm run test:core   # 运行可在 CI 中执行的确定性核心回归
npm run test:shortcuts      # 设置中心/自定义快捷键专项回归
npm run test:ui-regression  # 串行运行真实 Electron UI 回归 session
npm start           # 运行构建产物（electron-vite preview）
npm run dist        # 构建 + electron-builder 打**当前系统**的安装包 → dist/
npm run dist:dir    # 构建 + 打免安装目录版（dist/<platform>-unpacked/）
```

> `npm run dist` 按运行它的系统出包：Windows 上出 NSIS 安装包，macOS 上出
> `.dmg` + `.zip`，Linux 上出 `.deb`。安装包必须在对应平台构建和验证；尤其不要
> 把 macOS 交叉构建得到的 `.deb` 当作有效产物。

打包时若 electron-builder 的二进制下载慢，加镜像环境变量：
```
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

> 打包常见报错 `app-builder ... CANNOT_EXECUTE` 通常是 `dist/win-unpacked/HorseMD.exe` 被占用（有实例在跑）—— 先关掉所有 HorseMD 实例再打。

### 打包配置（package.json → build）

```jsonc
"build": {
  "appId": "com.horsemd.app",
  "productName": "HorseMD",
  "files": ["out/**/*"],
  "icon": "build/icon.ico",
  "mac": { "target": ["dmg", "zip"], "icon": "build/icon.icns", "category": "public.app-category.productivity", "fileAssociations": [/* .md/.markdown */] },
  "win": { "target": ["nsis"], "icon": "build/icon.ico", "fileAssociations": [/* .md/.markdown */] },
  "linux": { "target": [{ "target": "deb", "arch": ["x64"] }], "icon": "build/icons", "fileAssociations": [/* .md/.markdown */] },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "allowElevation": true, "installerIcon": "build/icon.ico", "uninstallerIcon": "build/icon.ico" }
}
```

- 安装包**未签名**：Windows 首次运行 SmartScreen 提示"未知发布者"，点"更多信息 → 仍要运行"；macOS 首次打开被 Gatekeeper 拦，右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/HorseMD.app`。需要免提示得配对应平台的签名证书（macOS 还需公证）。

### macOS 打包（已支持）

Windows 与 macOS 共用一份配置，在 macOS 上 `npm run dist` 即出 `.dmg` + `.zip`（默认 arm64；要 Intel 用 `"arch": ["x64", "arm64"]`）。

- 图标 `build/icon.icns` 由 `icon.png` 生成（mac 上 `iconutil`，或跨平台 `png2icns` / `electron-icon-builder`）。
- 跨平台已处理：快捷键同时认 `Ctrl`/`Cmd`（`metaKey`），`open-file`（Finder 打开）事件，标题栏 `hiddenInset` + 固定 `trafficLightPosition`，渲染层用 `.app.is-mac` / `.app.is-win` / `.app.is-linux` 区分平台样式。**改顶栏/平台相关代码时务必三个桌面系统都别弄坏。**

> dev 模式在 macOS 上用 `osascript tell application "Electron"` 驱动时，可能误启动 `node_modules` 里的通用 Electron 壳（同名冲突，显示默认页）。验证请用打好的 **HorseMD.app**（名字与 bundle id 唯一）。

### Linux 打包与发布

Linux 目前发布 `amd64.deb`，应在 Ubuntu x64 环境执行：

```bash
npm ci
npm run test:core
npm run build
npx electron-builder --linux deb --x64 --publish never

DEB_FILE=$(ls dist/*.deb | head -1)
dpkg-deb --info "$DEB_FILE"
dpkg-deb --contents "$DEB_FILE" >/dev/null
```

验证不只看打包命令退出码：历史上 macOS 交叉构建曾返回 0，却只生成约 96 字节的
无效 `.deb`。正式包必须在 Linux 上通过 `dpkg-deb --info`，并至少验证安装、卸载、
应用菜单启动、Markdown 文件关联、窗口拖动和最小化/最大化/关闭。

`.github/workflows/release.yml` 在 `v*` tag 上运行 Windows、macOS、Ubuntu matrix。
Linux job 安装桌面构建依赖，打包后执行 `dpkg-deb --info`；由于 electron-builder 对已经
发布的 Release 可能跳过 draft publish，工作流最后使用
`gh release upload "$TAG" dist/*.deb --clobber` 明确上传经校验的 `.deb`。

主进程输出是 `out/main/index.cjs`。`dev`、`preview` 和 `start` 用 `cross-env` 把可能从
外部工具继承的 `ELECTRON_RUN_AS_NODE` 清空，避免 Electron 被当作普通 Node 进程启动。

## 自动化测试：CDP 端到端验证

项目以 **Chrome DevTools Protocol** 端到端验证为主，同时为可纯函数验证的源码映射提供快速 Node 单测。CDP 连进运行中的 Electron，真实派发鼠标/键盘事件并回读 DOM，测的是"用户真实体验"。

自动化默认通过 `launchBuiltElectron()` 加入 `--horsemd-test-background`，主
窗口保持隐藏、不获取 macOS 原生焦点，同时关闭 Chromium 后台节流。CDP
事件只发送给隔离的 Electron renderer，不调用系统级键鼠，因此不会移动
用户的鼠标、输入到其他应用或把测试窗口切到前台。需要人工观察窗口时显式
传入 `{ background: false }`。

输入类测试遵循“增量输入优先”：

- Markdown 输入规则、行内代码/公式、Enter/退格、模式切换后立即输入和原文
  保真必须逐字符派发，不能一次性注入整句。
- 普通文本使用 `scripts/lib/human-input.mjs` 的
  `typeTextLikeUser()`；快捷键和特殊键使用 `pressKey()` 或原生
  `Input.dispatchKeyEvent`。
- 设置赋值、构造大文档和粘贴测试可以使用批量数据，因为这些路径并不声称
  模拟键盘逐字输入。
- 中文逐字输入表示“输入法已经提交一个汉字后的文本事件”。拼音候选、
  composition 更新和候选确认属于独立 IME 测试，不能用逐汉字注入冒充。

```bash
# 无需启动 Electron：Markdown raw offset ↔ ProseMirror 映射
npm run test:source-map

# 无需启动 Electron：局部富文本编辑保留未修改 Markdown 源码写法
npm run test:markdown-preservation

# 无需启动 Electron：textarea 的 CRLF、BOM、混合换行和 offset 保真
npm run test:source-text-fidelity

# 真实 Electron：异构 Markdown 多点编辑与真实写盘逐字节比较
npm run test:source-fidelity-ui

# 真实 Electron：120k+ BOM/CRLF 分块文档首次富文本 + 源码编辑
npm run test:large-source-fidelity-ui

# 真实 Electron：#77 原始空行、列表符和转义；含真实保存写盘
npm run test:issue-77-ui

# 真实 Electron：#98 系统剪贴板、长代码虚拟化复制、内部粘贴、撤销和会话恢复
npm run test:issue-98-ui

# 真实 Electron：preload clipboard IPC 与系统剪贴板写入
npm run test:clipboard-ipc-ui

# 真实 Electron：Mermaid 裸源码/围栏/二次粘贴一一对应
npm run test:mermaid-paste-ui

# 真实 Electron：正文单换行保真；Enter 新段落保存并重开
npm run test:paragraph-source-ui

# 真实 Electron：#79 无序/有序/嵌套列表跟随行距和段距设置
npm run test:issue-79-ui

# 无需启动 Electron：#82 同级大纲章节重排及原始 Markdown 区段保留
npm run test:outline-reorder

# 真实 Electron：#82 富文本/源码双向大纲拖拽，验证子级和源码均保留
npm run test:issue-82-ui

# 直接验证已安装的 macOS 应用包（不用 out/ 开发构建）
HORSEMD_APP_PATH=/Applications/HorseMD.app/Contents/MacOS/HorseMD npm run test:issue-77-ui

# CriticMarkup 输入守卫
node scripts/test-strike-guard.mjs

# 自定义快捷键专项回归
npm run test:shortcuts

# 真实 Electron UI 回归编排，串行启动隔离 profile，避免多个 CDP 脚本抢窗口
npm run test:ui-regression

# PDF 表格视觉保真：保留最终 PDF 和 PNG 便于人工核对
KEEP_PDF_ARTIFACTS=1 npm run test:pdf-table-layout-ui

# 验证测试窗口不抢原生焦点，且后台仍能逐字符输入
npm run test:background-ui
```

### 工具

- `scripts/run-ui-regression.mjs` —— 串行编排真实 UI 回归，覆盖 PDF Studio、Review、Lightbox、表格、#57-#60、#66/#67、#93、#98、精确 raw-offset 与零等待输入、真实大文档模式切换、源码查找和 `电脑档案.md` 双向切换链路
- `scripts/lib/electron-test-app.mjs`、`scripts/lib/human-input.mjs` —— 默认以隐藏且不抢原生焦点的 Electron 窗口运行 CDP；提供统一逐字符文本输入和特殊键工具
- `scripts/test-background-cdp-ui.mjs` —— 验证后台启动参数、初始原生焦点和隐藏窗口内逐字符输入，防止测试基础设施退化后再次抢用户窗口
- `scripts/test-inline-code-ui.mjs` —— 用原生键盘事件逐键输入 `` `awdawdwa`outside ``，验证闭合、首尾方向键退出、新段落以代码起笔、源码边界和连续三个普通反引号；禁止用 `Input.insertText` 代替真实字符键
- `scripts/test-issue-98-copy-undo-ui.mjs`、`scripts/test-session-restore-setting-ui.mjs` —— 验证系统剪贴板代码复制、段落纯文本无额外回车、列表纯文本无生成编号、HorseMD 内部 Markdown 结构粘贴、真实撤销及关闭会话恢复后的显式文件打开；代码复制夹具含 122 行 JSON，明确要求 CodeMirror DOM 发生虚拟化后，按钮和全选仍复制全文，而真实 Shift 选择 65 行只复制选区
- `scripts/test-clipboard-ipc-ui.mjs` —— 单独验证 renderer 经 preload 写入系统剪贴板；复制断言前必须先写 sentinel，避免沿用旧剪贴板造成假通过
- `scripts/etv.mjs` —— 端到端验证：命中测试每个按钮、读计算样式、检测 `-webkit-app-region`、驱动块切换器/右键菜单/选区等
- `scripts/test-issues-57-60-ui.mjs` —— 真实验证 `$$`/`/math` 连续输入、行内代码末端追加、底部文件菜单边界和 PDF 导出中心基础控件；文件树场景通过 `ISSUE59_DIR` 指向已由第二实例加入的测试目录
- `scripts/test-pdf-studio-ui.mjs` —— 真实 Electron PDF 导出中心回归：开关命中区域、页面方向、目录页、嵌入书签、页码范围、正文字号范围与最终 PDF 文字高度、整体缩放标签、快速设置、源码同步和快捷入口
- `scripts/test-pdf-preview-churn-ui.mjs` —— 生成 24 章节、8 页的长文档，以 190ms 间隔连续修改 9 次字号，监视瞬时错误并验证只生成最终 14pt；保护 `printToPDF()` 不被强杀及异步清理串行合同
- `scripts/test-pdf-latex-ui.mjs` —— 真实 Electron PDF 导出回归：段落 LaTeX 公式必须导出为渲染后的 MathML，不允许打印 `$$...$$` 源码或公式编辑控件
- `scripts/test-pdf-rendered-formats-ui.mjs` —— 不等待 live preview 就立即真实导出，验证流程图、时序图、饼图、类图、状态图和 ER 图均成为安全 SVG；同时覆盖异常 Mermaid 降级、LaTeX、普通代码、任务列表、表格、引用、HTML、无编辑器控件和 PDF.js 实际绘制
- `scripts/test-pdf-table-layout-fidelity-ui.mjs` —— 测量同一紧凑表在编辑器、结构化 PDF source 和最终 PDF 文字坐标中的列宽比例，并比较编辑器 row height 与 PDF 文字 Y 基线，要求不得退化为等分或重新叠加正文段落留白；再以真实长按拖动验证手动列宽，最后将第一页渲染为 PNG。设置 `KEEP_PDF_ARTIFACTS=1` 可在 `/tmp/horsemd-pdf-table-layout-*` 保留 `.pdf` / `.png`
- `scripts/test-pdf-images.mjs` / `scripts/test-pdf-images-ui.mjs` —— 验证本地与网络图片会先暂存到 PDF 临时目录；真实 Electron 覆盖 `%20` 相对路径、远程图片、无失败提示和实际 PDF 字节
- `scripts/test-editor-images.mjs` —— 验证 macOS、Linux 和 Windows 图片路径只编码一次，保护空格、中文与已编码 Markdown 地址
- `scripts/test-editor-style-settings-ui.mjs` —— 真实 Electron 设置页回归：编辑器页只保留行为设置；外观页按排版预览、自定义 CSS、表格、源码外观排序；CSS 片段、预览、字体和源码字号继续即时生效
- `scripts/test-selection-toolbar-ui.mjs` —— 真实 Electron 回归：块级公式紧凑留白不影响普通代码块；编辑器设置可即时关闭浮动选中文字工具栏；右键紧凑子菜单能实际悬停展开、保持原选区并执行格式和审阅标记
- `scripts/test-inline-html-block-handle-ui.mjs` —— 真实 Electron 验证行内 `<font>` / `<span>` 不会在正文中唤起块拖拽柄，左侧块操作热区仍保留该功能
- `scripts/test-block-handle-gutter-ui.mjs` —— 真实 Electron 覆盖窄、压缩、宽、全宽布局，以及标题、正文、一级/嵌套列表、有序列表和待办列表；验证所有块共用一条可见、可点击且不遮挡正文的操作轨道
- `scripts/test-table-scroll-ui.mjs` —— 真实 Electron 表格回归：未手动调整时长内容列必须宽于短内容列；同时覆盖短表自然宽度、手动列宽优先级、宽表内部滚动、主题表面、行列控件、长按实时列宽，以及最右端连续 10 次调整不回跳
- `scripts/test-task-list-persistence-ui.mjs` —— 真实文件任务清单回归：点击勾选、保存、彻底退出并重开，再取消勾选、保存并重开；每一步只允许目标 Markdown 标记在 `[ ]` 与 `[x]` 间变化
- `scripts/test-latest-task-runner.mjs` —— 验证同一渲染器仅运行一个 PDF 生成任务，旧任务异步清理完整结束后最新请求才可启动
- `scripts/test-editor-api-registry.mjs` —— 验证按 Tab 的编辑器 API ready、关闭释放与超时行为
- `scripts/test-pdf-studio-ui.mjs` —— 真实验证 PDF 横纵向、目录页、书签、页码范围、PDF.js Canvas 与快速设置更新的最终一致性
- `scripts/test-editor-inline-code.mjs`、`scripts/test-menu-position.mjs` —— 不启动 Electron 的输入边界与浮层几何回归
- `scripts/inspect.mjs` —— 简易状态检查器
- `scripts/test-mode-switch-chains.mjs` —— 双向连续切换、表格和 CodeMirror 光标语义匹配
  - 普通富文本点击会确认可见选区；首次点击仅恢复编辑器焦点时自动重试一次
- `scripts/test-mode-switch-10x.mjs` —— 5 个编辑态光标 + 5 个阅读态视口，附带大纲/dirty 稳定性检查
- `scripts/test-source-find.mjs` —— 源码查找 selection、居中滚动、高亮和连续上下一个
  - 对普通 Markdown 追加 `--mode-switch`，验证保持查找栏时源码→富文本→源码缓存重建
- `scripts/test-markdown-source-preservation.mjs` —— 纯函数验证普通文字只改目标字符；标题、分段、列表新增/转换和表格行列变化只改受影响行或块，不重写整篇原文
- `scripts/test-list-conversion-source-fidelity-ui.mjs` —— 后台 Electron 验证混合松散/紧凑嵌套列表：右键转换外层后零等待逐字输入，切源码逐字节比对，真实保存并以新 profile 完整重开；由 `npm run test:list-conversion-ui` 与原有菜单/层级用例串行运行
- `scripts/test-rich-list-source-preservation-ui.mjs` —— 后台 Electron 逐字验证已有正文后的 `Enter` → `-` → 空格 → 首个列表文字；刻意等待每个 `markdownUpdated` 时序，断言首项不并回正文、输入的 `-` 不退化为 `*`、内部 `<br />` 不泄漏，并覆盖源码切换、保存和全新 profile 重开。可单独运行 `npm run test:rich-list-source-ui`，也被 `npm run test:list-conversion-ui` 纳入。
- `scripts/test-new-document-list-source-preservation-ui.mjs` —— 后台 Electron 验证默认空 H1 + 正文路径：逐字键入标题、正文、`1. ` 有序列表、第二项目和 Tab 嵌套项目，不保存即连续源码↔富文本↔源码；同时覆盖稳定节奏、35ms 连续键入、标题 Enter 进入正文造成的合并 `markdownUpdated`，以及嵌套项退出后立刻输入 `- ` 无序项、**不等待回调立即切源码**、保存和全新进程重开。源码必须完整保留层级和用户的 `-` 标记，不能合并项目、残留空 `3.` 或只留下最深层。运行 `npm run test:new-document-list-source-ui`。
- `scripts/test-mode-switch-raw-offset-ui.mjs` —— 真实 Electron 在普通段落、重复文本、表格、列表、硬换行和代码等位置验证 source/rich 连续双向切换始终落在同一 raw offset；另覆盖源码切回富文本后零等待 Enter，并跨 90/220ms 恢复窗口继续输入
- `scripts/test-issue-77-source-preservation-ui.mjs` —— 真实 Electron 验证 #77：10 次源码快照覆盖标题、普通段落、单个 `~`、紧凑列表和列表硬换行；新增紧凑列表项后通过保存按钮写盘并逐字节读取文件；另覆盖源码→富文本→源码、Markdown + HTML 双 MIME 粘贴及网页 HTML 语义
- `scripts/test-paragraph-source-preservation-ui.mjs` —— 真实 Electron 验证空文档从默认 H1 或正文起笔、相邻单换行正文只改文字、文档末尾和后续块之前按 Enter 新建段落，以及非 canonical 前缀后以行内代码起笔；覆盖快速单事务与停顿后的 `<br />` 两阶段事务，再真实保存、退出并以全新用户目录重开，确认标题和 paragraph 节点没有丢失、合并或凭空增加
- `scripts/test-new-markdown-source-fidelity-ui.mjs` —— 后台真实 Electron 逐字输入 `-`、`*`、`+` 列表与连续空段落，执行多轮富文本/源码往返并真实保存，确认 marker 不被 serializer 替换且独立 `<br />` 不进入磁盘
- `scripts/test-soft-line-breaks-ui.mjs` —— 真实 Electron 验证普通源码单换行默认按多行显示、显式硬换行仍为 `<br>`、双向切换后的 textarea 与磁盘字节不变；设置开关接线由 `test-settings-view-ui.mjs` 保护
- `scripts/test-source-fidelity-audit-ui.mjs`、`scripts/test-large-doc-source-preservation-ui.mjs` —— 分别验证异构 Markdown 多点编辑后的逐字节局部性，以及 120k+ BOM/CRLF 分块文档的首次富文本编辑
- `scripts/test-issue-79-list-spacing-ui.mjs` —— 真实 Electron 验证 #79：通过设置页选项调整行距和段距后，正文无序/有序/嵌套列表以及设置预览的列表样本同步变化
- `scripts/test-review-ui.mjs` —— 真实源码同步后的 Review 高亮、同段批注堆叠、卡片编辑/取消/完成和 substitution DOM

### 用法

```bash
# 1) 带远程调试端口启动（注意：要先关掉别的实例，否则单实例锁会转发到旧实例）
npx electron . --remote-debugging-port=9222 "path\to\some.md"

# 2) 跑验证
node scripts/etv.mjs
```

### 关键经验（CDP 的坑）

- **后台运行**：自动化统一通过 `launchBuiltElectron()` 启动；不要为普通回归手工 `open -a` 或使用 AppleScript/系统级键鼠。人工验收和教程截图才使用可见窗口。
- **PDF 视觉问题必须验证最终 Buffer**：source HTML、隐藏打印 DOM 和最终 PDF 是不同层。布局修复至少读取 PDF.js 的 X/Y 坐标并渲染 PNG；完整流程见 [pdf-visual-fidelity-runbook.md](./pdf-visual-fidelity-runbook.md)。
- **逐字符不等于真实 IME**：逐字符 CDP 输入能覆盖 ProseMirror 的增量事务和 Markdown 输入规则，但不能覆盖 macOS/Windows 输入法候选框与 composition 生命周期；涉及输入法的缺陷必须增加平台专项人工验证。
- **响应取值路径**：`Runtime.evaluate` 的值在 `msg.result.result.value`（别写成 `msg.result.value`）
- **合成事件的局限**：
  - `Input.dispatchMouseEvent` 的合成**拖拽不驱动 ProseMirror 的 `state.selection`**（DOM 有选区但 PM 内部是空的）→ 测选区相关功能要用**键盘选区**（Shift+方向键）
  - 合成点击会**绕过 OS 级 `-webkit-app-region` 的拖拽吞噬**，所以它不能证明"真实鼠标可点"；判断拖拽区要读计算样式
  - `requestAnimationFrame` 在窗口被遮挡时被节流到几乎不触发 → 别在初始化逻辑里依赖 rAF
  - 原生监听器调 React `setState` 是异步渲染，查 DOM 前要等一拍
- `/json/new` 在新版 Chromium 被限制；要新开页面截图可直接 `Page.navigate` 现有页到目标 URL
- `System.Drawing.Icon` 读不了 PNG 内嵌的 ICO 帧（渲染噪点），验证圆角时直接渲染源 PNG

## 数据/状态约定

- 会话存于 `localStorage`，键 `minimd.session.v1`：`{workspace, theme, lang, recents, sidebarOpen, sidebarMode, openPaths, activePath}`
- 首次引导标记：`localStorage['horsemd.onboarded.v1']`
- 主题以 `body` 的 class 表达：`light|dark` 基类 + 可选 `theme-*` 覆盖类

### macOS 真实键盘/鼠标输入验证

需要核验前台焦点、输入规则或富文本/源码保真时，可使用 `CGEvent` 向真实 HorseMD 发布逐键 key-down/key-up，并通过源码截图、磁盘文件或按需的系统剪贴板读取结果。完整方法、键码和列表示例见 [macOS 真实输入测试方法](macos-real-input-testing.md)。
