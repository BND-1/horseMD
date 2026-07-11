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
  main/index.js            主进程：窗口生命周期、IPC 装配、菜单
  main/documents.js        打开/保存对话框与 PDF 导出 IPC
  main/filesystem.js       文件读写、目录树与复制 IPC
  main/watchers.js         工作区与单文件监听 IPC
  main/pdf-document.js     PDF 文档外壳与打印样式（纯函数）
  main/security.js         权限与外部 URL 安全策略（纯函数）
  preload/index.js         contextBridge：window.api 桥接
  renderer/
    index.html             渲染入口（CSP、标题）
    src/
      main.jsx             React 挂载点
      App.jsx              应用外壳（最核心，详见下文）
      paths.js             纯工具：路径/文件名/版本/重文档判定/genId/会话
      find.js              文档内查找的高亮/匹配纯函数
      ui.js                fireToast + copyToClipboard（toast 通道单一来源）
      settings.js          用户偏好（排版/图床/拼写/隐藏文件）持久化 + CSS var 应用
      scrollAnchor.js      模式切换稳定 façade（仅 re-export 公共 API）
      mode-visible-map.js  源码/富文本可见字符 fallback 映射
      mode-caret-anchor.js 双向光标 capture/restore
      mode-viewport-anchor.js 阅读视口 capture/restore
      mode-source-headings.js 源码标题解析与跳转
      textarea-metrics.js textarea mirror 与字符/像素换算
      customThemes.js      注入用户 CSS 主题（迁移自 Typora 的 .css）
      blocks.js            块类型定义（正文/H1–H6）共享数据
      themes.js            主题注册表（6 套配色）
      i18n.jsx             中英文翻译表 + I18nProvider 上下文
      onboarding.js        首次启动的欢迎/介绍文档（中英）
      assets/logo.png      首页 logo（应用图标副本）
      hooks/
        useFileOps.js      文件与标签操作、单文件 watcher
        useWorkspace.js    多根工作区状态、目录 watcher 与命令面板文件列表
        useSidebarTree.js  文件树加载、展开与当前文件跟随
        useSourceModeSwitch.js per-tab 源码模式、内容同步与锚点恢复
        useOutline.js      大纲（标题列表 + scrollspy + jumpAndStabilize 跳转）
        useFindReplace.js  查找替换（CSS Highlight API）
        useAppLifecycle.js 会话持久化 + 恢复 + 更新检查
        usePopover.js      共享 popover hook（outside-click + Esc 关闭）
      components/
        Editor.jsx         Crepe 编辑器封装 + 块控件 + 灯箱 + 拼写检查
        SettingsView.jsx   设置页（排版/外观/校对/语言/图床/关于）
        editor-html.js     原生 HTML 节点视图（表格渲染）+ 块转换
        editor-images.js   相对图片路径解析为 file:// （纯函数）
        editor-copy.js     富文本复制的内联样式（纯函数）
        editor-mermaid.js  Mermaid widget 装饰插件（懒加载 mermaid）
        editor-highlight.js ==text== 高亮 mark + 工具栏颜色选择
        editor-review.js   审阅插件状态机与命令入口
        editor-review-card.js 审阅卡片 DOM、编辑和导航交互
        editor-review-decorations.js CriticMarkup 扫描与 Decoration 构建
        editor-md-paste.js 智能粘贴（Markdown → 富文本）
        editor-tablebreak.js 表格单元格内换行（<br> 往返）
        editor-codeblock-eager.js 代码块 eager-mount 根治跳页（#25 prototype 修改）
        LayoutControl.jsx  排版 popover（字号/行距/段距/页宽）
        ImageHostButton.jsx 顶栏图床配置按钮
        Sidebar.jsx        文件树侧边栏编排（支持多根与显示隐藏文件）
        SidebarContextMenu.jsx 文件树右键菜单视图
        Tabs.jsx           顶部标签条（拖拽排序 #31）+ 右键菜单
        Welcome.jsx        首页/欢迎页（logo、版本、最近文件）
        SaveFab.jsx        浮动保存按钮（dirty 时显示）
        WindowControls.jsx Windows 自绘窗口按钮
        UpdateToast.jsx    更新提示浮层
        RenameModal.jsx    标签重命名弹窗
        Outline.jsx        大纲面板（标题列表 + scrollspy + 软居中）
        CommandPalette.jsx 命令面板（Ctrl+P 模糊跳转）
        StatusBar.jsx      底部状态栏 + 块切换器 + 排版/主题/语言
        icons.jsx          内联 SVG 图标（paths 字典 + Icon 组件 + iconMarkup）
        ui/
          Toggle.jsx       通用开关（role=switch，DNA token）
          AdjustGroup.jsx  分段预设 + 微调滑块（排版共享控件）
        shell/
          ActivityBar.jsx  左侧活动栏（Home/Files/Outline/Settings/折叠）
          EditorArea.jsx   编辑区（lazy mount + 分屏 + heavy-doc 横幅 + .hm-cv）
          Topbar.jsx       顶栏（标签 + 新建 + 图床 + 命令面板入口）
      styles/app.css       全部样式 + 主题变量 + content-visibility
scripts/
  etv.mjs                  端到端测试工具（CDP 驱动，见 development.md）
  inspect.mjs              简易 CDP 状态检查器
build/
  icon.ico                 Windows 图标（多分辨率、圆角）
  icon.icns                macOS 图标（由 icon.png 生成）
```

> 跨平台：渲染层根节点按 `window.api.platform` 挂 `.app.is-win` / `.app.is-mac` 类，平台相关样式（标题栏让位红绿灯等）只写在这两个选择器下；主进程用 `process.platform` 分支。改顶栏/平台代码时两个系统都要顾到。

## App.jsx：外壳的核心职责

`App.jsx` 是外壳组合器。具体业务优先委托给 hook，当前主要负责：

- **标签页**：`tabs[]`（每个 `{id, path, title, content, savedContent, mtimeMs, reloadNonce}`）、`activeId`
- **文件与标签组合**：通过 `useFileOps` 接入打开、保存、关闭和单文件 watcher
- **工作区组合**：通过 `useWorkspace` 接入多根目录、目录 watcher 和会话恢复
- **模式切换组合**：通过 `useSourceModeSwitch` 接入 per-tab 模式、source/rich 同步和锚点恢复
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

> **编辑器路由**：`EditorArea.jsx` 根据 `paths.js` 的文档分类选择 rich/source/plain textarea。Markdown 富文本首次激活才挂载、之后常驻；源码模式只覆盖并隐藏 Crepe，不卸载它。

## 获取 ProseMirror view 的正确姿势

很多编辑器增强（快捷键、右键、复制、图片解析…）都依赖底层 ProseMirror 的 `EditorView`。在本项目的 Milkdown 版本里，要通过 **context** 拿：

```js
import { editorViewCtx } from '@milkdown/kit/core'
const view = crepe.editor.ctx.get(editorViewCtx)
// 注意：crepe.editor.view 在这个版本是 undefined
```
