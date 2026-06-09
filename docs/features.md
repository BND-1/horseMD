# 功能与实现

下面按功能列出**怎么用**和**怎么实现的**（附对应文件）。

---

## 1. 标签页 / 单窗口多文件

- 打开多个 `.md` 在同一窗口，`Ctrl+Tab` / `Ctrl+Shift+Tab` 循环切换
- 在资源管理器双击 `.md` → 不新开程序，而是在已有窗口加一个标签
- 新建：标签条末尾的 **+**、顶栏右侧独立的 **+** 按钮、`Ctrl+N`，都调同一个 `newTab`（新建未命名草稿，首次 `Ctrl+S` 选位置保存）

**实现**：
- 主进程 `requestSingleInstanceLock()` + `second-instance` 事件，把第二次启动的 argv 转发给已有窗口（`src/main/index.js`）
- 渲染层 `openPaths()` 用 `tabsRef` 同步快照去重，避免 setState 竞态导致重复标签（`App.jsx`）

## 2. 文件夹工作区（侧边栏文件树）

- `Ctrl+Shift+O` 打开文件夹，左侧树状浏览；右键可新建 / 重命名 / **复制一份** / 删除 / **导出为 PDF** / 在资源管理器中显示
- **拖拽移动**：把文件/文件夹拖到另一个文件夹（或根目录）即可移动，落点文件夹高亮提示
- 顶部 **展开全部 / 折叠全部** 按钮一键切换（图标随状态翻转，展开会递归展开所有子目录）
- 活动栏有**常驻的折叠 / 展开侧边栏**按钮（收起后图标翻转成"展开"样式）
- 在资源管理器右键文件夹 **"用 HorseMD 打开"** → 作为工作区打开（启动参数支持文件夹路径）
- 外部增删文件会自动刷新树

**实现**：`Sidebar.jsx` + 主进程 `fs:readDir` / `fs:duplicate` / `watch:start`（chokidar 监听文件夹，去抖后推 `watch:changed`）；文件夹启动参数见 `main/index.js` 的 `extractArgs()`（区分文件 vs 目录，目录走 `open-folder`）

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
- 主进程对每个打开的文件单独 chokidar 监听（`watch:file`），`change` 时推 `file:changed {path, mtimeMs}`（`src/main/index.js`）
- 渲染层 `App.jsx` 为打开的文件挂/卸监听，收到变更后：
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

## 8. 大纲 / 命令面板 / 查找

- 大纲（`Ctrl+Shift+L`）：从内容解析标题，点击跳转，随编辑实时更新（`Outline.jsx`）
- 命令面板（`Ctrl+P`）：模糊搜索文件与命令（`CommandPalette.jsx`）
- 查找（`Ctrl+F`）：文档内查找，实时显示 `当前/总数` 计数，next/prev 即时跳转

**查找实现**（`App.jsx` 的 find-in-document helpers）：用 **CSS Custom Highlight API**（`CSS.highlights` + `Highlight`）给匹配区间上色 —— **不改 DOM、不插标记节点**，所以不会污染文档、也不会触发编辑器重排。只在编辑器正文（富文本 `view.dom` 或源码 `<textarea>`）里搜，**绝不匹配查找框自己输入的文字**；上下一个全在前端完成，无 IPC 往返。当前命中用单独的 highlight 名（`hm-find-current`）区分高亮。不支持该 API 的环境会优雅降级。

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

## 13. 新文档从正文段落开始

新建/空文档第一行是**普通段落**，可以直接开始写正文；想要标题就用 `# `、`Ctrl+1`…`6` 或选中工具条转成标题。

> 历史：早期版本会把新文档首行**强制成一级标题**（Typora 式）。但这样用户**不写标题就没法写正文**（首行永远是标题、也没有正文块可点），只能"写完标题→回车→才到正文"。所以改为保留普通段落（`Editor.jsx` 不再做首块转 H1）。

## 14. 窗口拖拽

顶栏空白处（含标签条背景）和活动栏空白都能拖动窗口；标签、按钮、输入框可点。

**实现**：`styles/app.css` 用 `-webkit-app-region` —— `.topbar / .tabs / .tabs-scroll / .activity-bar` 设 `drag`，`.tab / .tab-new / .drag-no / input / .activity-item` 设 `no-drag`。

## 15. 纯文本（.txt）走快速编辑器

`.md/.markdown/.mdx` 用 Crepe 富文本；`.txt`（及其它带路径的非 Markdown 文件）用 `textarea` 纯文本编辑。这样：大文件秒开不卡、原始换行保留、不会把 `*`/`#` 误当 Markdown 语法。新建的未命名文档（无路径）仍是富文本。

**实现**（`App.jsx`）：`isPlainTextDoc(tab)`（路径存在且不匹配 `MD_DOC_RE`）决定每个标签的编辑器；富文本标签**首次激活才挂载、之后常驻**（懒加载，见 [implementation-notes.md](./implementation-notes.md) 的性能一节），纯文本标签只在激活时渲染（避免后台重型 txt 拖慢应用）。

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

**实现**：
- `Editor.jsx` 的 `getDocHTML()` 克隆 `view.dom`，剥掉所有控件类、把 CodeMirror 代码块压平成 `<pre><code>`、清掉 class/style/data-/aria- 属性，返回纯净 HTML
- 主进程 `export:pdf` 把这段 HTML + 一套专用打印样式（`PDF_CSS`）写进临时 HTML，丢进一个隐藏 `BrowserWindow`（`webSecurity:false` 以便加载本地图片），`webContents.printToPDF` 出文件后 `shell.openPath` 打开
- 多标签各自挂载（激活过的）下，导出的是**当前激活**文档：用 `editorApis`（按 `tab.id` 建的注册表）取对应编辑器的 `getDocHTML`，不会串成同一篇

## 18. 自定义窗口按钮（Windows）+ 关闭前确认

Windows/Linux 下不再用系统原生的标题栏覆盖层，改由渲染层自己画 **最小化 / 最大化(还原) / 关闭** 三个按钮，带自定义 hover 态（关闭悬浮变红）。macOS 仍用原生红绿灯。

**实现**：
- 主进程关掉 `titleBarOverlay`，提供 `window:minimize/toggleMaximize/close/isMaximized` IPC；并监听 `maximize/unmaximize` 推 `window:maximized` 给渲染层，让"最大化/还原"图标跟真实窗口状态同步（双击拖拽最大化、系统快捷键都能跟上）
- 渲染层 `WindowControls`（仅 `platform === 'win32'` 渲染，`App.jsx`），图标在 `icons.jsx`（`win-min/win-max/win-restore`）

**关闭未保存提醒**：关**标签**（`closeTab`）和关**窗口/退出**都会在有未保存修改时弹本地化确认框。
- 关标签：`App.jsx` 的 `closeTab` 直接 `window.confirm(confirm.closeUnsaved)`。
- 关窗口（macOS 红灯 / Windows 关闭按钮 / Cmd·Ctrl+Q）：主进程拦截窗口 `close`，用 `allowClose` 标志，未确认时 `preventDefault` 并发 `app-close-request`；渲染层查脏标签，干净或用户确认（`confirm.quitUnsaved`）后调 `confirmAppClose()` → 主进程置 `allowClose=true` 再关。干净时无弹窗、不卡。详见 [implementation-notes.md](./implementation-notes.md)。

## 19. 大文档加载骨架屏

打开大文档（渲染要花点时间）时，先显示一组**波动的灰色占位条**（骨架屏），加载完自动消失；小文件秒开、不显示。

**实现**（`Editor.jsx` + `styles/app.css`）：`loaded` 状态在 `crepe.create()` 完成后置 true；**按内容大小触发**（`initialContent.length > 20000`），而非时间延迟（同一大文档冷/热启动耗时差很多，时间方案不可靠）。骨架 `.editor-skeleton` 用主题变量 `--border-soft`、`opacity` 呼吸式波动，位置和正文对齐。

## 20. 更新提示（仅通知，不自动下载）

启动时查一次 GitHub 最新**正式** release（草稿/预发布被该接口排除），若有新版本则弹一个可关闭的"有新版本"提示；关掉后记住，不再骚扰。**不在应用内下载/安装**。

**实现**：主进程 `update:check` 用 `fetch` 打 `releases/latest`，比对 `app.getVersion()`；渲染层启动时调一次，记 `localStorage["horsemd.update.dismissed"]`（`App.jsx`）。

## 快捷键一览

| 操作 | 快捷键 |
| --- | --- |
| 新建 / 打开文件 / 打开文件夹 | `Ctrl+N` / `Ctrl+O` / `Ctrl+Shift+O` |
| 保存 / 另存为 | `Ctrl+S` / `Ctrl+Shift+S` |
| 导出为 PDF | `Ctrl+Shift+E` |
| 关闭标签 / 循环标签 | `Ctrl+W` / `Ctrl+Tab` |
| 命令面板 / 查找 | `Ctrl+P` / `Ctrl+F` |
| 侧边栏 / 大纲 | `Ctrl+B` / `Ctrl+Shift+L` |
| 源码模式 / 主题 | `Ctrl+/` / `Ctrl+Shift+T` |
| 标题层级 / 正文 | `Ctrl+1`…`6` / `Ctrl+0` |

> 注：`Ctrl+B` 现在固定用于切换侧边栏（不再触发加粗）；加粗请用选中工具条的 **B** 按钮或 `**文字**` 语法。
