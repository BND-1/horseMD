# 架构

## 技术栈

- **Electron 34** —— 桌面外壳（主进程 + 渲染进程）
- **electron-vite + Vite 6** —— 构建工具
- **React 18** —— 渲染层 UI
- **Milkdown Crepe 7**（基于 ProseMirror）—— 所见即所得 Markdown 编辑器引擎
- **chokidar** —— 文件/文件夹监听
- **electron-builder** —— 打包（Windows NSIS 安装包 + macOS dmg/zip）

## 进程模型

```
┌─────────────────────────────────────────────────────────┐
│ 主进程 (src/main/index.js)                                │
│  · BrowserWindow（无边框标题栏；mac 红绿灯 / win 自绘按钮）   │
│  · 单实例锁：第二次启动把文件/文件夹转发给已有窗口            │
│  · 文件系统 IPC：读写/重命名/删除/新建/复制/列目录          │
│  · 文件夹监听（刷新文件树） + 单文件监听（自动重载内容）       │
│  · 窗口控制 IPC（win 自绘按钮）+ 导出 PDF + 更新检查         │
│  · 关闭拦截：未保存时先问渲染层（app-close-request）         │
│  · 应用菜单（主要用于快捷键加速器）                          │
└───────────────▲───────────────────────────┬──────────────┘
                │ ipcRenderer.invoke / on    │ 事件推送
┌───────────────┴───────────────────────────▼──────────────┐
│ 预加载 (src/preload/index.js)                              │
│  · contextBridge 暴露白名单 API 到 window.api              │
└───────────────▲───────────────────────────────────────────┘
                │ window.api.*
┌───────────────┴───────────────────────────────────────────┐
│ 渲染进程 (src/renderer/src/*)                              │
│  · App.jsx —— 外壳：标签页、状态、会话、主题、语言、首页     │
│  · Editor.jsx —— Crepe 编辑器 + 自研块级控件               │
│  · Sidebar / Tabs / Outline / CommandPalette / StatusBar  │
└────────────────────────────────────────────────────────────┘
```

## 目录结构

```
src/
  main/index.js            主进程：窗口、IPC、文件监听、菜单
  preload/index.js         contextBridge：window.api 桥接
  renderer/
    index.html             渲染入口（CSP、标题）
    src/
      main.jsx             React 挂载点
      App.jsx              应用外壳（最核心，详见下文）
      paths.js             纯工具：路径/文件名/版本/重文档判定/genId/会话
      find.js              文档内查找的高亮/匹配纯函数
      ui.js                fireToast + copyToClipboard（toast 通道单一来源）
      blocks.js            块类型定义（正文/H1–H6）共享数据
      themes.js            主题注册表（6 套配色）
      i18n.jsx             中英文翻译表 + I18nProvider 上下文
      onboarding.js        首次启动的欢迎/介绍文档（中英）
      assets/logo.png      首页 logo（应用图标副本）
      components/
        Editor.jsx         Crepe 编辑器封装 + 块控件 + 各种增强
        editor-html.js     原生 HTML 节点视图（表格渲染）+ 块转换（Editor 的纯函数）
        editor-images.js   相对图片路径解析为 file:// （纯函数）
        editor-copy.js     富文本复制的内联样式（纯函数）
        Sidebar.jsx        文件树侧边栏
        Tabs.jsx           顶部标签条 + 右键菜单
        Welcome.jsx        首页/欢迎页（logo、版本、最近文件）
        WindowControls.jsx Windows 自绘窗口按钮
        UpdateToast.jsx    更新提示浮层
        RenameModal.jsx    标签重命名弹窗（Electron 无 window.prompt）
        Outline.jsx        大纲面板（从内容解析标题）
        CommandPalette.jsx 命令面板（Ctrl+P 模糊跳转）
        StatusBar.jsx      底部状态栏 + 块切换器 + 主题/语言选择
        icons.jsx          内联 SVG 图标
      styles/app.css       全部样式 + 主题变量
scripts/
  etv.mjs                  端到端测试工具（CDP 驱动，见 development.md）
  inspect.mjs              简易 CDP 状态检查器
build/
  icon.ico                 Windows 图标（多分辨率、圆角）
  icon.icns                macOS 图标（由 icon.png 生成）
```

> 跨平台：渲染层根节点按 `window.api.platform` 挂 `.app.is-win` / `.app.is-mac` 类，平台相关样式（标题栏让位红绿灯等）只写在这两个选择器下；主进程用 `process.platform` 分支。改顶栏/平台代码时两个系统都要顾到。

## App.jsx：外壳的核心职责

`App.jsx` 是整个外壳的状态中枢，负责：

- **标签页**：`tabs[]`（每个 `{id, path, title, content, savedContent, mtimeMs, reloadNonce}`）、`activeId`
- **打开文件**：`openPaths()` —— 去重（用 `tabsRef` 同步快照避免 setState 竞态）、读盘、建标签
- **保存**：`saveTab/writeTab`，脏判断 = `content !== savedContent`
- **会话持久化**：把 `workspace/theme/lang/recents/openPaths/...` 存进 `localStorage`（键 `minimd.session.v1`），启动时恢复
- **主题/语言**：`theme`（主题 id）、`lang`（en/zh），分别 `applyTheme()` 与 `I18nProvider`
- **最近文件**：`recents[]`，每次打开文件时记录，持久化，首页展示
- **首次引导**：首启动（无 `horsemd.onboarded.v1` 标记且无恢复标签）打开欢迎文档
- **快捷键**：菜单加速器（主进程）+ 渲染层监听（Ctrl+Tab 切标签、Ctrl+B 切侧边栏）

## 编辑器内容数据流（重要）

```
用户敲键 → Crepe/ProseMirror 改文档
        → markdownUpdated 回调（必须在 create() 之前注册！）
        → onChange(md, false)
        → App.updateContent(tabId, md)
        → tab.content 更新
        → 派生：大纲、字数、脏标记、保存内容 全部跟着更新
```

> ⚠️ 这条链路曾经断过：监听器注册晚了导致 `markdownUpdated` 从不触发，详见 [implementation-notes.md](./implementation-notes.md)。

> **编辑器路由**：`App.jsx` 按扩展名决定每个标签用哪种编辑器 —— `.md/.markdown/.mdx`（及无路径的新建文档）走 Crepe 富文本，**首次激活才挂载、之后常驻**（懒加载，加快启动/会话恢复）；`.txt` 等纯文本走 `textarea`，只在激活时渲染。纯文本过 Markdown 引擎会丢换行、且大文件卡死，故单独走快路径（`MD_DOC_RE` / `isPlainTextDoc`）。

## 获取 ProseMirror view 的正确姿势

很多编辑器增强（快捷键、右键、复制、图片解析…）都依赖底层 ProseMirror 的 `EditorView`。在本项目的 Milkdown 版本里，要通过 **context** 拿：

```js
import { editorViewCtx } from '@milkdown/kit/core'
const view = crepe.editor.ctx.get(editorViewCtx)
// 注意：crepe.editor.view 在这个版本是 undefined
```
