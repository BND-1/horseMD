# 功能与实现

下面按功能列出**怎么用**和**怎么实现的**（附对应文件）。

---

## 1. 标签页 / 单窗口多文件

- 打开多个 `.md` 在同一窗口，`Ctrl+Tab` / `Ctrl+Shift+Tab` 循环切换
- 在资源管理器双击 `.md` → 不新开程序，而是在已有窗口加一个标签
- 新建：标签条末尾的 **+**、顶栏右侧独立的 **+** 按钮、`Ctrl+N`，都调同一个 `newTab`（新建未命名草稿，首次 `Ctrl+S` 选位置保存）

**实现**：
- 主进程 `requestSingleInstanceLock()` + `second-instance` 事件，把第二次启动的 argv 转发给已有窗口（`src/main/index.js`）
- 渲染层 `openPaths()` 用 `tabsRef` 同步快照去重，避免 setState 竞态导致重复标签（`useFileOps.js`）

## 2. 文件夹工作区（侧边栏文件树）

- `Ctrl+Shift+O` 打开文件夹，左侧树状浏览；右键可新建 / 重命名 / **复制一份** / 删除 / **导出为 PDF** / 在资源管理器中显示
- **拖拽移动**：把文件/文件夹拖到另一个文件夹（或根目录）即可移动，落点文件夹高亮提示
- 顶部 **展开全部 / 折叠全部** 按钮一键切换（图标随状态翻转，展开会递归展开所有子目录）
- 活动栏有**常驻的折叠 / 展开侧边栏**按钮（收起后图标翻转成"展开"样式）
- 在资源管理器右键文件夹 **"用 HorseMD 打开"** → 作为工作区打开（启动参数支持文件夹路径）
- 外部增删文件会自动刷新树

**实现**：`useWorkspace.js` 管理多根工作区和目录 watcher，`useSidebarTree.js` 管理树加载/展开，`Sidebar.jsx` 与 `SidebarContextMenu.jsx` 负责交互；主进程由 `filesystem.js`、`watchers.js` 提供 IPC。文件夹启动参数见 `main/index.js` 的 `extractArgs()`（区分文件 vs 目录，目录走 `open-folder`）。

> - 新建 / 重命名输入框带**行内确认（✓）/ 取消（✗）**按钮；**失焦即提交**（点别处不会丢掉已输入的名字）。
> - 重命名时输入框默认选中**文件名（不含扩展名）**，和新建一致（`onFocus` 里 `setSelectionRange(0, dotIndex)`）。
> - 展开的空目录会显示"空文件夹"提示，而不是一片空白。
> - 拖拽移动通过 HTML5 DnD（`draggable` + `dataTransfer`）+ 主进程的重命名/移动 IPC 完成（`dropProps()` / `moveItem()`）。

## 3. 所见即所得编辑 + 块级控件

WYSIWYG 由 Milkdown Crepe 提供。在它之上自研了**改标题层级**的多种入口（共用一条 `setBlock` → `convertBlock` 路径）：

| 入口 | 用法 |
| --- | --- |
| 键盘 | `Ctrl+1`…`Ctrl+6` 设标题、`Ctrl+0` 转正文 |
| 选中工具条 | 选中文字 → Crepe 工具条里注入的 **H** 按钮，悬浮展开 H1/H2/H3/¶ |
| 右键菜单 | 编辑区右键 → "转换为" 列出全部类型 |
| 状态栏切换器 | 右下角常驻显示当前块类型，点开可切换 |
| Crepe 原生 | 行首 `/` 斜杠菜单、行首 `# `、左侧块手柄 |

另外有一个**跟随光标的浮动块级标记**：光标落在标题/正文上时，行旁会浮出当前块类型（H1…H6 / 正文）；编辑器失焦或光标滚出视口时自动隐藏。选中工具条的按钮（加粗/斜体/删除线/行内代码/链接）也都带了 **tooltip**。

**实现**（`Editor.jsx`）：
- `convertBlock(view, type, attrs)` → `view.dispatch(state.tr.setNodeMarkup(pos, targetType, attrs))`，作用于光标所在的 textblock
- 工具条按钮：用 `MutationObserver` 监听 `.milkdown-toolbar` 出现，注入自定义 `.hm-heading-item`，CSS `:hover` 展开子菜单（并覆盖 Crepe 工具条的 `overflow:hidden` 以免裁掉子菜单）
- 浮动块级标记：监听光标位置/滚动，用 `view.coordsAtPos` 定位到当前行旁；只对标题和段落显示
- 块类型定义集中在 `blocks.js`，标签文案走 i18n

## 4. 当前文件自动刷新（外部修改）

外部程序（如 agent、其它编辑器）改了正在打开的文件 → 编辑器自动重载，无需手动关开。

**实现**：
- 主进程对每个打开的文件单独 chokidar 监听（`watchers.js` 的 `watch:file`），`change` 时推 `file:changed {path, mtimeMs}`
- 渲染层 `useFileOps.js` 为打开的文件挂/卸监听，收到变更后：
  - 若该标签**有未保存修改** → 不覆盖（保护你的编辑）
  - 否则从磁盘重载，并 bump `reloadNonce` 让 Editor 重挂载
  - 忽略自己保存产生的回声（比对 mtime）

## 5. Ctrl/Cmd + 点击链接

按住 `Ctrl`(Win)/`Cmd`(Mac) 点链接 → 系统浏览器打开。

**实现**：`Editor.jsx` 在 `view.dom` 捕获阶段拦截 `click`，命中 `http(s):`/`mailto:` 链接走 `shell.openExternal`。

## 6. 富文本复制（带 inline style）

复制内容时，剪贴板 HTML 版本注入内联样式，粘到微信公众号/邮件/Notion 等不读外部 CSS 的地方也能保留格式（加粗、标题大小、行内代码、代码块灰底、引用、表格边框等）。

**实现**：`Editor.jsx` 拦截 `copy` 事件，对选区 HTML 逐元素套用固定浅色配色的内联样式（`COPY_STYLES`），写入 `text/html`；CodeMirror 代码块内的复制交还给它自己处理。

## 7. 相对路径图片解析

`![](./img/foo.png)` 这类相对路径图片，按当前文件所在文件夹解析成 `file://` 绝对路径并正常显示。

**实现**：`Editor.jsx` 用 `MutationObserver` 把相对路径 `<img>` 的 `src` 改写成 `file://`。**只改 DOM 显示，不动文档模型** —— 保存时磁盘里仍是相对路径，不污染文件。

### 图片交互（双击放大 / 说明 / 本地化）

- **单击图片** → Crepe 原生交互：选中、并可加**图片说明（caption）**。点说明按钮后会**自动聚焦**说明输入框，直接打字即可（组件本身不聚焦，需我们补 `focus()`）。
- **双击图片** → 灯箱里放大查看（点背景 / ✕ / Esc 关闭）。
- 图片说明、上传按钮等文案**跟随中英文切换**。

**实现**（`Editor.jsx`）：
- 放大用**自己的双击判定**（同一 `img` 的 `src` 在 350ms 内点两次），不用原生 `dblclick`—— 图片是 Vue 组件，单击选中会重渲染，原生 `dblclick` 常不触发；详见 [implementation-notes.md](./implementation-notes.md)。判定**排除**说明输入框 / 说明按钮 / 缩放手柄，避免抢它们的点击。
- 灯箱 `.hm-image-lightbox` 是纯显示覆盖层，不改文档。
- 文案本地化：用 `imageBlockConfig` / `inlineImageConfig`，创建时按当前语言设置，切换语言时更新配置并直接改已渲染 `.caption-input` 的 placeholder。

## 8. 大纲 / 命令面板 / 查找替换

- 大纲（`Ctrl+Shift+L`）：从内容解析标题，点击跳转，随编辑实时更新（`Outline.jsx`）。标题可折叠/展开，顶部只有一个类似文件树的总开关；默认保留前两层真实目录层级（H1/H2/H3 显示 H1+H2，全 H1 文档则全部显示），折叠包含当前标题的父级时，父级保持高亮提示。源码模式使用标准 Markdown AST 解析标题，避免代码块、Setext、转义或行内格式造成两种模式目录不一致。
- 命令面板（`Ctrl+P`）：模糊搜索文件与命令（`CommandPalette.jsx`）
- 查找 / 替换（`Ctrl+F`）：文档内查找，实时显示 `当前/总数` 计数，next/prev 即时跳转；查找栏可展开**替换**，支持替换单个 / 全部，富文本与源码模式都可用

**查找实现**（`useFindReplace.js` + `find.js`）：富文本使用 **CSS Custom Highlight API**（`CSS.highlights` + `Highlight`），不改编辑器 DOM；源码 textarea 使用字符 offset + 同样排版参数的镜像测量，将当前命中居中并绘制主题感知的固定高亮层。搜索只覆盖编辑器正文，**绝不匹配查找框自己的文字**；上下一个全在前端完成，无 IPC 往返。

**替换实现**（issue #19，`useFindReplace.js` 的 `applyReplace`）：富文本里把 DOM Range 转成 ProseMirror 位置、**一笔事务**自下而上替换所有匹配（`tr.insertText`，程序化、不走输入规则，不会误触发审阅标记守卫）；源码 textarea 走偏移量、同样自下而上。替换后重跑搜索保持计数正确，单个替换会把光标落到下一个匹配。

## 8b. 源码可读审阅标记

做审阅时，标记**仍留在 Markdown 源码里可见**，而不是藏在编辑器私有状态里；源码模式、磁盘文件、交给 AI 的文本都读同一套标注。支持新增 `{++new++}`、删除 `{--old--}`、替换 `{~~old~>new~~}`、高亮评论 `{==text==}{>>note<<}`。

- 选中工具条和命令面板都能插入这些审阅标记。
- **审阅：复制 AI 提示词**（AI handoff）会复制一段 prompt + 带审阅标注的全文，方便交给外部 AI 继续处理。
- PR1 先做 **inline-first / single-paragraph-first**；复杂线程、跨段元数据和多轮状态留作后续范围。
- **Accept All / Reject All** 可一键接受或拒绝全部标记，把文档清回普通 Markdown。

**实现**：
- `reviewMarkup.js` 负责扫描、包裹、接受/拒绝和 AI prompt；`editor-review-decorations.js` 构建装饰，`editor-review-card.js` 管理卡片 DOM，`editor-review.js` 保留插件状态机和命令入口
- `Editor.jsx` 负责选区工具条入口，`App.jsx` 把命令面板、源码模式、Accept All / Reject All 和 AI handoff 接到同一套逻辑
- **渲染**：4 种标记在富文本里都**实时渲染**（新增/删除/替换/高亮各用一套 `hm-review-*` 装饰，替换还带 `->` 箭头小部件），磁盘与源码模式里仍是原始 `{++…++}` 等字面文本
- **替换标记的删除线碰撞修复**：`{~~旧~>新~~}` 的波浪号会撞上 GFM 删除线输入规则，曾导致富文本里打字就吞掉标记/删行（Mac 上尤甚）。两层修复——守卫插件 `createStrikeGuardPlugin`（prepend 到 `prosePluginsCtx` 最前，`handleTextInput` 抢在输入规则前按字面插入）+ `appendTransaction` 兜底用 `oldState` 还原 compositionend 路径（macOS 输入法）的破坏。详见 [implementation-notes.md](./implementation-notes.md) 的"bug 22"

## 9. 主题（含莫兰迪）

6 套配色：暖光、暖夜、莫兰迪·灰绿 / 豆沙 / 雾蓝 / 暮。右下角状态栏带色块的主题选择器；`Ctrl+Shift+T` 循环切换。

**实现**：
- `themes.js` 注册表，每套主题 = 一个 `base`（light/dark，驱动 Crepe 明暗规则）+ 可选 `theme-*` 类（覆盖调色板变量）
- `applyTheme(id)` 设置 `body.className = base [+ ' theme-*']`
- 调色板变量在 `styles/app.css`（`body.light` / `body.dark` / `body.theme-morandi*`）

## 10. 多语言（中 / 英）

整个界面可在英文/中文间实时切换，默认跟随系统语言。状态栏有 🌐 切换。

**实现**：
- `i18n.jsx`：`STRINGS{en,zh}` 翻译表 + `I18nProvider` 上下文 + `useI18n()` 的 `t(key, vars)`
- 各组件用 `t('...')` 取文案；`App.jsx` 自身用 `translate(lang, key)`
- 编辑器占位符通过 Crepe `featureConfigs[Placeholder].text` 本地化

## 11. 首次引导

全新安装首次打开 → 自动弹出本地化的《欢迎使用 HorseMD》文档（介绍软件、功能、快捷键）。只出现一次。

**实现**：`App.jsx` 检测 `localStorage` 无 `horsemd.onboarded.v1` 且无恢复标签时，把 `onboarding.js` 的内容作为一个标签打开。

## 12. 首页（欢迎页）+ 最近文件 + 主页按钮

无打开文件时显示欢迎页：Logo + 标题（带**版本号**，如 `HorseMD v0.1.6`）+ 标语 + 三个操作按钮 + **最近文件列表** + 快捷键提示。活动栏**最上方有一个 App 图标按钮（主页）**，随时点它回到欢迎页。

**实现**（`App.jsx` 的 `Welcome` 组件 + 活动栏）：
- 最近文件：每次打开文件时 `remember()` 记录 `{path, name, dir, openedAt}`，去重、上限 8、持久化在会话
- 相对时间 `relTime()`：刚刚 / N 分钟前 / N 小时前 / 昨天 / 日期（本地化）
- 点击条目打开文件；**没有"清空"按钮**（产品决策）
- **版本号**：构建时由 Vite `define` 注入 `__APP_VERSION__`（取自 `package.json`，见 `electron.vite.config.mjs`），和 `app.getVersion()` 一致
- **主页按钮**：`home` 状态控制显示欢迎页，但**保留已打开标签的编辑器挂载**（只隐藏），所以回到文档不会重建编辑器、不卡；点任意标签 / 新建 / 打开 / 大纲跳转 / 查找都会退出主页

## 13. 新文档：一级标题 + 正文段落

新建/空文档第一行是**空的一级标题**（Typora 式标题），**下面带一个空的正文段落**。想写标题就写;想跳过标题直接写正文,点一下下面那行(或按 ↓)即可。

**实现**（`Editor.jsx`,在设基线前完成、所以新标签不会被标"已修改"）：若文档是单个空段落,则把首块转成 H1,并在其后插入一个空段落,光标默认留在标题。

> 历史:早期只把首行转成 H1、**没有正文块**,导致"不写标题就没法写正文"(整篇只有一个标题、也没正文块可点),只能"写完标题→回车→才到正文"。补上正文段落后即可跳过标题直接写。

## 14. 窗口拖拽

顶栏空白处（含标签条背景）和活动栏空白都能拖动窗口；标签、按钮、输入框可点。

**实现**：`styles/app.css` 用 `-webkit-app-region` —— `.topbar / .tabs / .tabs-scroll / .activity-bar` 设 `drag`，`.tab / .tab-new / .drag-no / input / .activity-item` 设 `no-drag`。

## 15. 纯文本（.txt）走快速编辑器

`.md/.markdown/.mdx` 用 Crepe 富文本；`.txt`（及其它带路径的非 Markdown 文件）用 `textarea` 纯文本编辑。这样：大文件秒开不卡、原始换行保留、不会把 `*`/`#` 误当 Markdown 语法。新建的未命名文档（无路径）仍是富文本。

**实现**（`EditorArea.jsx` + `paths.js`）：`isPlainTextDoc(tab)` 决定每个标签的编辑器；富文本标签**首次激活才挂载、之后常驻**，纯文本标签只在激活时渲染。

### 15b. 每个标签独立的源码 / 富文本视图状态

`Ctrl+/` 或底部状态按钮只切换**当前标签**的视图模式。切到另一个标签时，那个标签保持自己的富文本/源码状态；再切回来也恢复原状态。这是 UI 视图状态，不写入 Markdown，也不持久化到会话。

**实现**（`useSourceModeSwitch.js` + `EditorArea.jsx`）：
- `sourceModeIds` 用 `tab.id` 记录哪些标签当前在源码模式，关闭标签时清理。
- 源码 textarea 是非受控输入，内容写入 `liveContentRef`；textarea 因切 tab 重挂时用 live buffer 作为 `defaultValue`，避免未保存源码编辑丢失。
- `sourceEditedIds` 只标记真正改过的源码 buffer；切回富文本时仅这些标签调用 `replaceMarkdown()` 同步到已挂载 Crepe，未编辑的源码切换不触发 dirty。

### 16b. 重文档自动用纯文本极速模式打开

有些 Markdown 文件**几乎没有空行**（笔记/转写直接粘进来，几千行连续不空行）。Markdown 会把它们压成几个超大段落、段内有上千个换行节点，ProseMirror 近乎平方级渲染 → **主线程能卡死十几秒**（实测一个 81KB 文件冻结 10.2 秒）。

为此 HorseMD **自动识别"重文档"**，默认用纯文本极速模式打开（瞬间、零卡顿），顶部给一个 **「渲染为富文本」** 按钮，需要时再按需加载（这时才会有几秒解析 + 骨架屏）。

**实现**（`App.jsx`）：`isHeavyDoc(content)` —— 单段落**连续非空行 > 150 行**，或总长 > 400KB，即判定为重文档（结构而非单纯大小：结构良好的 120KB 文档照常富文本）。`heavy` 标记在文件载入时算一次存到标签上；`richForced`（Set）记录用户对某标签的"仍要富文本"选择。重文档默认走 `usesTextarea` 分支（和 `.txt` 同款 textarea）。

## 16. 原生 HTML 表格渲染

文档里直接写的 HTML 表格（`<table><tr><td>…</td></tr></table>`）会**渲染成真正的表格**，而不是显示成转义后的源码（Typora 也是这个行为）。其它块级 HTML（`<div>`、`<details>` 等）同样渲染。

**实现**（`Editor.jsx`）：Milkdown 默认的 `html` 节点把内容当转义文本显示。我们给它加了一个 **ProseMirror node view**（`renderHtmlNodeView`）渲染真实 HTML：
- **只改显示，不动文档模型** —— 节点仍通过 `attrs.value` 原样进出，保存时磁盘里还是原始 HTML，不破坏文件
- 只对识别到的**块级标签**（`<table>` 等，见 `RENDER_HTML_RE`）渲染；零散的内联片段（落单的 `<b>`）退回默认文本显示，避免不闭合标签把版面搞乱
- 渲染前 `sanitizeHtml()` 去掉 `<script>/<style>` 和 `on*` 事件属性、`javascript:` 链接（在 `<template>` 里解析,表格片段能正确解析）
- 节点是 atom（不可编辑内部），`ignoreMutation` 让 ProseMirror 不去 reconcile 渲染出的 HTML
- 注册入口：`crepe.editor.config` 里 `ctx.update(nodeViewCtx, (v) => [...v, ['html', …]])`（在 `crepe.create()` 之前）—— **必须走 `nodeViewCtx`**（`$view` 的同款通道），不能用 `editorViewOptionsCtx.nodeViews`，否则会覆盖图片/代码块/表格等组件的节点视图。详见 [implementation-notes.md](./implementation-notes.md) 的"致命 bug 12"
- 样式 `.hm-html-block`（`styles/app.css`），表格边框/表头用主题变量,跟随明暗与莫兰迪配色

## 17. 导出为 PDF

`文件 → 导出为 PDF…`（`Ctrl/Cmd+Shift+E`，或命令面板）把当前文档导成排版干净的 PDF —— **不带编辑器自身的控件**（代码块工具条、表格手柄、块手柄、加号按钮等）。

导出前可选择 A4、A3、Letter 或 50–1000 mm 的自定义尺寸，并设置纵向/横向。分页既可交给 Chromium 自动处理，也可在一级、二级或三级标题前强制换页，或把 Markdown 分隔符作为“本页结束”标记。

**实现**：
- `Editor.jsx` 的 `getDocHTML()` 克隆 `view.dom`，剥掉所有控件类、把 CodeMirror 代码块压平成 `<pre><code>`、清掉 class/style/data-/aria- 属性，返回纯净 HTML
- `PdfExportDialog` 只收集用户意图；主进程 `normalizePdfOptions` 再对白名单、范围和打印尺寸做校验，CSS 使用 mm，Electron `printToPDF` 的自定义 `Size` 按其接口要求换算为英寸，随后把 HTML + 动态 `@page` / 分页样式写进临时 HTML，丢进隐藏 `BrowserWindow`（`webSecurity:false` 以便加载本地图片），出文件后 `shell.openPath` 打开
- 多标签各自挂载（激活过的）下，导出的是**当前激活**文档：用 `editorApis`（按 `tab.id` 建的注册表）取对应编辑器的 `getDocHTML`，不会串成同一篇

## 18. 自定义窗口按钮（Windows / Linux）+ 关闭前确认

Windows/Linux 下不再用系统原生的标题栏覆盖层，改由渲染层自己画 **最小化 / 最大化(还原) / 关闭** 三个按钮，带自定义 hover 态（关闭悬浮变红）。macOS 仍用原生红绿灯。

**实现**：
- 主进程关掉 `titleBarOverlay`，提供 `window:minimize/toggleMaximize/close/isMaximized` IPC；并监听 `maximize/unmaximize` 推 `window:maximized` 给渲染层，让"最大化/还原"图标跟真实窗口状态同步（双击拖拽最大化、系统快捷键都能跟上）
- 渲染层 `Topbar` 在 `platform === 'win32' || platform === 'linux'` 时渲染
  `WindowControls`。Windows 使用宽扁的 `win-*` 按钮；Linux 使用独立 `.is-linux` 类和
  `gtk-min/gtk-max/gtk-restore` 图标，按钮间距与 hover 形态按 GTK 桌面习惯处理。

**关闭未保存提醒**：关**标签**（`closeTab`）和关**窗口/退出**都会在有未保存修改时弹本地化确认框。
- 关标签：`App.jsx` 的 `closeTab` 直接 `window.confirm(confirm.closeUnsaved)`。
- 关窗口（macOS 红灯 / Windows 或 Linux 关闭按钮 / Cmd·Ctrl+Q）：主进程拦截窗口 `close`，用 `allowClose` 标志，未确认时 `preventDefault` 并发 `app-close-request`；渲染层查脏标签，干净或用户确认（`confirm.quitUnsaved`）后调 `confirmAppClose()` → 主进程置 `allowClose=true` 再关。干净时无弹窗、不卡。详见 [implementation-notes.md](./implementation-notes.md)。

## 19. 大文档加载骨架屏

打开大文档（渲染要花点时间）时，先显示一组**波动的灰色占位条**（骨架屏），加载完自动消失；小文件秒开、不显示。

**实现**（`Editor.jsx` + `styles/app.css`）：**按内容大小触发**（`initialContent.length > 8000`），而非时间延迟（同一大文档冷/热启动耗时差很多，时间方案不可靠）。骨架 `.editor-skeleton` 用主题变量 `--border-soft`、`opacity` 呼吸式波动，位置和正文对齐。

> **关键时序**：`loaded` 必须在 `crepe.create()` 一完成（内容已进 DOM）就**用 `flushSync` 同步置 true**，而不是普通 `setState`。否则 React 会把它和紧随其后的重活（`getMarkdown()` 整篇序列化 + `onChange` 触发大纲/字数重算）批处理到一起，导致**正文已渲染、骨架屏却还压在上面几百毫秒**（切换源码↔富文本时尤其明显）。序列化/`onChange` 这步也推迟到下一帧再做，让骨架屏先消失。详见 [implementation-notes.md](./implementation-notes.md)。

## 20. 更新提示（仅通知，不自动下载）+ 更新内容

启动时查一次 GitHub 最新**正式** release（草稿/预发布被该接口排除），若有新版本则弹一个可关闭的"有新版本"提示;关掉后记住,不再骚扰。**不在应用内下载/安装**。提示里**自动展示该 release 的更新说明**(GitHub release notes),内容长则在卡片内滚动(细滚动条)。

**实现**：主进程 `update:check` 用 `net.fetch` 打 `releases/latest`，比对 `app.getVersion()`，并把 `data.body`(发布说明)截断后作为 `notes` 一并返回；渲染层启动时调一次,记 `localStorage["horsemd.update.dismissed"]`（`App.jsx`）。`UpdateToast.jsx` 把 `notes`(Markdown)**用纯 React 元素**轻量渲染成标题/要点/粗体/行内代码(**不注入 HTML,无 XSS**),版本号显示为"旧版删除线 → 新版药丸"。

## 21. 分屏（左右双栏）

两个文档**左右并排、都可编辑**。开启方式：
- 标签或文件树**右键 → 「在右侧分屏打开」**（文件树的还能直接把未打开的文件开到右栏）；
- 顶栏的**分屏按钮**（田字格图标）切换；
- 右栏右上角一个**淡色 ✕**（悬停显示「关闭分屏」）关闭。
- 中间的 **1px 发丝分隔条可拖动**调整左右比例（20%–80%，悬停变主题色）。
- **点哪一栏，再点标签栏就切换那一栏的文件**（聚焦栏由其标签的强调色下划线标示，另一栏标签为淡色下划线）。

**实现**（`App.jsx` + `styles/app.css`）：
- `splitId` = 右栏显示的标签 id；`split` 为派生标志（右栏标签存在、且 ≠ 活动标签、且不在主页）；`focusedPane`（'left'/'right'）决定标签点击切换哪一栏。
- 两栏是 `.editor-area`（flex 行）里的**同级兄弟**，靠每个标签的 `display` / `order` 控制显隐 —— **不重新挂载、不重复实例**，所以切换/开关分屏不会重建编辑器、不重新解析。
- `splitRatio` + `.hm-split-divider`（`startSplitDrag` 按鼠标 x 算比例，给左栏设 `flex-basis`）。
- `editorHostRef` 始终指向左/活动栏（查找、大纲、滚动比例都作用于它）；`focusedTabRef` 记录最后获得焦点的栏，让保存/导出作用于你正在编辑的那一栏。右栏不显示全局源码模式。
- 聚焦提示走标签下划线（`.tab.active` 强调色 vs `.tab.active.split-peer` 淡色），编辑区不画任何额外色条，保持简约。
- 大纲以最后聚焦的窗格为目标：点击左右编辑区会切换标题列表、滚动高亮和跳转目标；富文本容器按 tab id 注册，左栏源码与右栏富文本并存时也不会串文档（#66）。

## 22. 统一的右键菜单（标签 / 文件树）

标签页和侧边栏文件树的右键菜单提供**一致的文件操作**：在右侧分屏打开 · 复制文件路径 · 复制文件名 · 打开所在文件夹 · 重命名 · 创建副本 · 导出为 PDF（md）· 删除。标签页额外有 关闭 / 关闭其他；文件树额外有 新建文件 / 新建文件夹。未保存（无路径）的标签里，依赖路径的项自动置灰。

**实现**（`Tabs.jsx` / `Sidebar.jsx` / `App.jsx`）：
- 标签的文件操作（重命名 / 复制 / 删除 / 导出）在 `useFileOps.js`，复用与文件树相同的 IPC，完成后 bump `refreshNonce` 刷新树。
- **重命名走自研的内联弹窗 `RenameModal`，不能用 `window.prompt`** —— Electron 渲染层不支持 `prompt()`（直接抛 "prompt() is not supported"，导致重命名静默失效）。`window.confirm` / `window.alert` 仍可用。
- 复制路径/文件名用 `navigator.clipboard` + 一个 `hm:toast` 提示；"打开所在文件夹"走 `shell:showInFolder`。

## 23. 复制按钮反馈

代码块右上角的 **「复制」** 按钮点击后会**闪一个绿色 ✓** 并弹出 **「已复制」** 轻提示（toast），不再点了没反应。

**实现**：`Editor.jsx` 委托监听 `.copy-button` 点击 → 给按钮加瞬时 `.hm-copied` 类（CSS 变绿加 ✓）+ 派发 `hm:toast` 事件；`App.jsx` 监听该事件显示底部居中 toast（`copyText` 文案也本地化）。

## 24. 未保存草稿跨重启恢复

新建但没保存的临时文档（未命名标签），**关掉 HorseMD 再打开还在**（标签带"已修改"红点）。

**实现**（`App.jsx`）：会话持久化里新增 `untitled: [{title, content}]`，只存**有内容且脏**的无路径标签（未动过的欢迎页/空白页不会反复回来）；启动时重建这些标签（`savedContent:''` 让它们保持"未保存"）。有路径的文件仍从磁盘重开。

> 持久化**防抖 400ms**（并在关闭/刷新时兜底刷一次），避免大文档每敲一个字就整篇序列化写盘导致打字卡顿。

## 25. 可配置图床（类 Typora 自定义命令）

**右上角图片按钮**配置一条上传命令(如 `picgo upload`)。之后**粘贴 / 拖入 / 上传**图片会:把图片写到临时文件 → 运行 `<命令> "<临时文件>"` → 取它打印到 stdout 的图片 URL 插入文档。命令留空 = 保持默认(图片为本地引用,不拦截粘贴/拖入,避免插入刷新即失效的 `blob:`)。

**实现**：`ImageHostButton.jsx`(顶栏 popover,`position:fixed` 避开顶栏 `overflow:hidden`;配置后图标带强调色小点)+ `Editor.jsx` 的 `onUpload` / 粘贴 / 拖放钩子(代码块内不拦截)+ 主进程 `image:upload` IPC(临时文件 + `exec` + 解析最后一个 http(s) URL)。命令存 `localStorage["horsemd.settings.v1"]`。

## 26. 自定义页面宽度

状态栏**页宽按钮** → 小弹窗:分段预设(窄 / 中 / 宽 / 全宽,选中胶囊滑动)+ 「微调」滑块(像素级)。

**实现**：`StatusBar.jsx` 的 `PageWidthControl`;CSS 变量 `--editor-max-width` 驱动 `.editor-host` / `.source-editor` / 骨架屏宽度,「全宽」用 `body.hm-full-width` 类(源码模式靠 calc 居中,变量无法单独表达"无上限")。值存 settings.js。

## 27. Mermaid 图表 + LaTeX 公式

- ` ```mermaid ` 代码块下方**实时渲染图表**(可编辑源码不变)。
- 行内 `$…$`、块级 `$$…$$`(`$$` 单独成行)经 **KaTeX** 渲染;过长的显示公式在列内**横向滚动**,不溢出。
- Mermaid/LaTeX 默认显示渲染预览；正在 CodeMirror 中输入时，即使预览首次出现也不会隐藏编辑器或抢走焦点，离开编辑后仍保持原来的紧凑预览。

**实现**：Mermaid 走 Crepe 代码块自带的 **"preview" 机制**（与 LaTeX 同款）；Mermaid 和 LaTeX 都注册了 `renderPreview`，所以**链式分发**——`mermaid` 语言走我们的渲染器、其余（`latex` 等）回落到 Crepe 自带的，否则 mermaid 会把 `$$…$$` 盖掉回退成裸代码块（`editor-mermaid.js`，`mermaid` 动态 `import()` 懒加载，装饰 key 含渲染状态）。

公式启用 `CrepeFeature.Latex`（默认关），KaTeX/latex 样式随主题 CSS 已打包；`.katex-display { overflow-x:auto }`。**单行 `$$x^2$$` 在解析前由 `normalizeDisplayMath`（`editor-math.js`）改写成块级多行形式**（`$$\nx^2\n$$`），否则 remark-math 会把 `$$` 压成单个 `$` 当行内公式（issue #18）。该函数幂等、代码安全（围栏代码块与行内代码先 stash，`$$` 只在"整行恰好是 `$$…$$`"时改），对行内 `$x$` 和行中 `text $$x$$ text` 不动。

## 28. 自定义主题（可迁移 Typora 主题）

把 `.css`(或整个下载来的主题文件夹)丢进**主题文件夹**,状态栏主题菜单的「自定义」区即可选用;另有「打开主题文件夹」「获取更多主题」(theme.typora.io)。Typora 主题可**直接迁移**。

**实现**(`main` themes IPC + `customThemes.js` + `StatusBar.jsx`):`themes:list` **递归扫描**子目录(Typora 主题常是文件夹);`themes:read` 把相对 `url(...)` 改写成绝对 `file://`(字体/图能加载);CSS 注入到一个 `<style>`,编辑器内容带 Typora 的 `#write` / `markdown-body` 钩子;激活时(`body.hm-has-custom-theme`)正文区背景/宽度与文字 `color:inherit` 让位给主题,应用外壳保持自身风格;`applyTheme` 保留 `hm-*` body 类(切主题不丢全宽/自定义标记)。选择存于会话(`customTheme`)。

## 29. 表格单元格内换行

表格单元格内按 **Enter / Shift+Enter** 换行,保存为 `<br>`(GFM 表格仍是单行,**不损坏**),重开能正确解析回换行。

**实现**(`editor-tablebreak.js`,接入 `Editor.jsx`):keymap 在单元格内插入 hardbreak(渲染为 `<br>`);自定义 remark stringify `break` 处理器**仅在 `tableCell` 上下文**输出 `<br>`(其它走默认,段落换行不变);remark 解析插件把内联 `<br>` 转回 break(顺带修了"单元格 `<br>` 被丢")。

## 30. 表格排版优化

Markdown 表格渲染更紧凑:去掉单元格内段落的上下 margin、收紧内边距与行高(单行行高约从 84px 降到 45px),并对超列宽内容/行内代码自动换行(`word-break`),不再与相邻列重叠。

## 31. 设置页（一站式配置）

- 左下角齿轮（ActivityBar）/ 移动端 ••• 打开设置标签页
- **排版**：字号 / 行距 / 段距 / 页宽，带**实时预览**（右侧 HorseMD 介绍样例，拖滑块即时反映）
- **外观**：6 套内置主题 + 自定义 Typora 主题 + 「显示隐藏文件」开关
- **校对**：英文拼写检查（红色下划线）开关，默认关
- **语言**：中文 / English
- **图床**：Typora 式自定义上传命令
- **关于**：版本号 + 官网 + GitHub / Gitee 链接
- 打开设置时侧栏自动收起；设置标签页不持久化（纯 transient）

**实现**：`SettingsView.jsx`（kind:'settings' tab）；`ui/Toggle.jsx`（DNA 开关）；`ui/AdjustGroup.jsx`（从 LayoutControl 抽出，共享）；`settings.js`（spellcheck / showHiddenFiles 等 pref）。

## 32. Mermaid 全屏灯箱

- 点击渲染好的 Mermaid 流程图 → 全屏灯箱弹出
- 按 SVG `viewBox` / 图片原始尺寸保持精确宽高比，不再强制固定方形画布
- 顶部提供缩小 / 倍率 / 放大 / 适应窗口 / `1:1` 原始尺寸控制
- **Ctrl+滚轮**缩放（0.2×–10×）+ **按住拖拽**平移
- Esc / 点背景关闭；拖拽后的 click 不会误关

**实现**：`editor-dom-bindings.js` 的 `onMermaidClick` 克隆 SVG，并从 `viewBox` 记录原始宽高；`editor-lightbox.js` 统一管理按钮、滚轮缩放、1:1 比例和拖拽。CSS 只做视口上限约束，不设置会改变长宽图展示画布的固定最小尺寸。初始社区实现来自 @digyear PR #27。

## 33. 标签页拖拽排序

- 按住标签左右拖 → 松手固定到新位置，顺序持久化（重启保持）
- 拖拽时有 accent 色插入指示线；关闭按钮 / 右键菜单 / 中键关闭不受影响

**实现**：`Tabs.jsx`（draggable + onDragStart/Over/Drop/End）+ `useFileOps.js` `reorderTabs(from,to)`。无新依赖。

## 34. 拼写检查开关

- 设置 → 校对 → Toggle（默认关）。仅作用于 `.ProseMirror` contenteditable；其它输入框始终 spellCheck={false}。跨 tab 一致 + 持久化。

**实现**：`settings.js` `spellcheck:false`；`Editor.jsx` 给 `view.dom` 设 `spellcheck` 属性（mount + effect on change）。不需要 IPC。

## 35. 文件树显示隐藏文件

- 设置 → 外观 →「显示隐藏文件」开关（默认关）。开 → `.claude` / `.cursor` / `.github` 等出现；`.git` / `node_modules` 始终隐藏。

**实现**：`main/index.js` `showHidden` 全局 + `settings:setShowHidden` IPC；`readTree` + `listFilesFlat` 检查它；`preload` + `App.jsx` useEffect 同步 + 刷新。

## 36. 大纲跳转 + 模式切换位置保持

**大纲跳转**（根治多轮）：
- 点击大纲标题 → 自定义 **ease-out 动画**（200–500ms）→ **poll-and-stabilize**（每 200ms 检查，异步内容把位置漂了就重新跳，连续 2 次稳定才恢复锚定）
- **forcedActiveRef**：跳转期间强制高亮点击的那条（scrollspy 的 tops 缓存可能过期）
- 大文档分块加载中：不显示部分标题 + 排队跳转，加载完再跳
- 根因：`overflow-anchor:auto`（#25 修复）和 `scrollIntoView` 打架 → 跳转时临时关锚定

**模式切换位置保持**（#28 / #41 / #42）：
- 源码模式显示 textarea 时，已激活的富文本 Crepe **保持挂载但隐藏**，未编辑源码时切回富文本不重新解析整篇文档，也不重新加载图片。
- 阅读态（没有可见光标 / 光标离屏）优先保留视口；编辑态（可见光标）优先跟随光标并保证光标可见。
- 源码改动只在 `sourceEditedIds` 标记后同步回富文本；普通视图切换不触发 dirty。
- 光标映射不依赖关键词：Crepe 初始化规范化和真实编辑后都会同步当前 Markdown 快照，源码与富文本双向优先使用同一快照上的块级 raw offset。刚从源码恢复到富文本且用户没有移动/编辑时，会保留来源 raw offset，使连续往返严格可逆；全局可见字符索引、文本上下文和比例只作异常兜底。代码块进入 CodeMirror 后，按真实 `.cm-line` DOM selection 计算块内源码位置，并用 caret rect 保证光标可见。阅读态视口采用 textarea 像素位置、可见字符索引和 ProseMirror 坐标组合映射，避免图片在源码和富文本中高度不同造成的非线性漂移。
- 表格坐标映射会把 ProseMirror `table_cell` 内部的 paragraph 归类为 Markdown `tableCell`,再按单元格文本和块内字符定位；普通单元格文字、重复内容和反引号内联代码不会退化成全文段落序号匹配。

## 37. 代码块跳页根治（#25 最终修复）

- 滚到代码块、停下、选中文字 → 内容**不再上蹿**（纯滚动 / 选区 / 代码块组合全部不跳）

**根因**：Milkdown `CodeMirrorBlock` node view 懒挂载（IntersectionObserver 200px + 5s teardown）→ placeholder↔mounted 高度差（127px）+ Chromium 选区时禁用 `overflow-anchor` → 跳。

**修复**：`editor-codeblock-eager.js`（prototype 修改 `CodeMirrorBlock`）：`renderPlaceholder`→立即 `initializeCodeMirror`（打开即挂载）+ `scheduleTeardown`→no-op（永不卸载）。高度恒定 → delta=0 → 无论纯滚动还是选区都不跳。带 API 漂移 guard。

## 38. 插入附件（非图片文件）

`文件 → 插入附件…` 或命令面板「插入附件…」可选择 PDF、DOCX、ZIP、音频等任意普通文件。HorseMD 不预览附件，只把它们复制到当前 Markdown 文件同级的 `assets/` 文件夹，并在光标处插入普通 Markdown 链接：

```md
[report.pdf](<assets/report.pdf>)
```

**实现**（desktop only）：
- 主进程 `dialog:openAttachments` 打开多选文件选择器；`attachment:save` 校验文件、创建 `assets/`、去重命名并复制文件。
- 渲染层 `attachFiles()` 先要求当前文档已保存，再按当前源码/富文本模式插入链接；源码模式写 textarea selection，富文本模式用当前 Markdown offset 插入。
- `window.api.capabilities.fileAttachments` 控制入口显示；移动端 shim 返回 unsupported，避免出现不可用 UI。

## 快捷键一览

| 操作 | 快捷键 |
| --- | --- |
| 新建 / 打开文件 / 打开文件夹 | `Ctrl+N` / `Ctrl+O` / `Ctrl+Shift+O` |
| 保存 / 另存为 | `Ctrl+S` / `Ctrl+Shift+S` |
| 导出为 PDF | `Ctrl+Shift+E` |
| 关闭标签 / 循环标签 | `Ctrl+W` / `Ctrl+Tab` |
| 命令面板 / 查找 | `Ctrl+P` / `Ctrl+F` |
| 侧边栏 / 大纲 | `Ctrl+Shift+B` / `Ctrl+Shift+L` |
| 源码模式 / 主题 | `Ctrl+/` / `Ctrl+Shift+T` |
| 标题层级 / 正文 | `Ctrl+1`…`6` / `Ctrl+0` |

> 注：`Ctrl+B` 使用编辑器的标准加粗行为；侧边栏使用 `Ctrl+Shift+B`。

---

## 38. 文档 / 代码字体设置（#38）

### 怎么用

设置 → 排版 → 顶部两个选择器：**文档字体**（`--font-write`，影响正文 + 标题）和**代码字体**（`--font-mono`，影响代码块）。空 = 默认栈。

### 交互

- 点击字段 → 弹出**搜索 + 列表**，每个字体用它**自己的字形**渲染样例（文档显示"永和九年 Aa 123"，代码显示"const x = 'hi'"）—— 一眼看出字体长啥样。
- **鼠标悬停** → 预览 + 编辑器**实时变成**那个字体（不用点击）。
- 点击 → 设为该字体并关闭；空 = "默认"。
- 列表底部有外部链接：文档字体 → [方正字库](https://www.foundertype.com/)（国内官方），代码字体 → [Nerd Fonts](https://www.nerdfonts.com/)。

### 怎么实现

- `settings.fontWrite` / `settings.fontMono` 存在 `localStorage`，通过 `fontStack(name, base)` 组合成 CSS font-family 栈。
- 在 `App.jsx` 以 **inline CSS var** 设到 `.app` 根元素（`--font-write` / `--font-mono`），覆盖 `body.light/dark` 的默认值 + Windows 的 `.app.is-win` Consolas 覆盖。
- **悬停预览**：`hoverFont` state 在 `App.jsx`，FontPicker 的 `onHover` 回调临时覆盖 settings 值 → 预览 + 编辑器实时变。
- **queryLocalFonts**（Local Font Access API）枚举系统字体，权限在 `main/index.js` 的 `session.setPermissionRequestHandler` 授权。
- **CodeMirror 字体修复**：CM 默认主题把 `.cm-content` 钉死 `monospace`，app.css 用高特异性规则 `.milkdown .cm-editor .cm-content { font-family: var(--font-mono) }` 覆盖 —— 这是 #34 弯引号 + #38 代码字体能生效的前提。
- **设置预览**：`.settings-preview` 必须显式设 `font-family: var(--font-write)`（否则继承 body 的 `--font-ui` 界面字体，不反映文档字体变化）。
