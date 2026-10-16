# 文档导出架构

## 1. 模块边界

```text
Renderer
  hooks/useHtmlExport.js
  components/html-export/*
  hooks/usePandocExport.js
          │ window.api contract
          ▼
Electron main
  html-export.js ─ html-document.js ─ export resources
  pandoc-export.js ─ child process runner
```

`App.jsx` 只负责装配 hook 和懒加载 Studio；菜单只发起用户命令。格式构建、进程执行和任务生命周期不得写入 `App.jsx`、`Editor.jsx` 或 `documents.js`。

标签页与文件树的右键导出入口共用 `components/ExportContextSubmenu.jsx`，只展示一个“导出”一级项；PDF、HTML 与 Pandoc 格式在 Portal 二级菜单中展开，避免被父菜单的滚动区域裁切，并支持键盘和窗口边缘翻转。按路径准备文件的逻辑统一由 `useFileOps.js` 的 `resolveExportTab`、`exportPathAsRendered` 和 `exportPathWithPandoc` 负责：结构化格式等待目标编辑器挂载后读取共享快照，Pandoc 读取目标 tab 的当前 Markdown。不得在 `Tabs.jsx` 或 `SidebarContextMenu.jsx` 复制格式分支和编辑器等待逻辑。

PDF 导出在以上三链路之外，但在「密度」上与 HTML 共用一份间距约定：

- **排版密度（0.12.50）**：`src/shared/pdf-options.js` 的 `PDF_DENSITY_VALUES`（comfort/standard/compact）是单一事实源；`pdf-print-styles.js` 把 12 条间距规则改成 `var(--hm-pdf-*, 旧字面量)`，并按 `page.densityPreset` 在 `:root` 注入对应数值。`standard` 逐字等于改动前的硬编码值（no-op 基线）。标题行高 1.3、代码 1.6、表格单元格 1.4 与 `th/td > p` 复位保持硬编码，不作为密度杠杆（保护表格测量与标题层级）。`em` 间距不随 `line-height` 变化，因此必须把全部间距规则一起参数化才能均匀紧凑。预览的真实页数通过 `onPageCount` 回调上抛到设置面板实时显示。`pdf-document.js` 无需改动：`densityPreset` 经 `normalizePdfOptions` 自动透传到 `buildPdfPrintStyles`。

保存位置（0.12.50，0.12.51 补齐 PDF 参数链）是三链路共享的能力：

- **`export-prefs.js`** 持久化用户按文件记住的保存目录（`userData/export-prefs.json`）。PDF/HTML/Pandoc 的保存对话框都先调 `getSaveDirFor(sourcePath)`：同一文件记得它上次被改存到的目录；不同文件各自回到源 Markdown 所在目录；未命名文档回退到全局上次目录。保存成功后调 `recordSaveDir(sourcePath, dir)`。首次读取共用一个加载 Promise，写入通过串行队列落盘，避免三个导出入口并发时读到空缓存或互相覆盖。纯决策逻辑拆到 `export-prefs-logic.js`，便于 `scripts/test-export-prefs.mjs` 在无 Electron 环境锁定 per-file 语义。
- **调用链不变量**：菜单导出与文件树右键导出都必须把 `tab.path` 传入 `requestPdfExport`；`usePdfPreview` 再把 `request.sourcePath` 作为 `previewPDF` 的第四个参数传入 preload。任何一层遗漏都会把有路径文件误判为未命名文档，使 PDF 串用全局保存目录。

## 2. 共享快照，不共享格式实现

PDF 与 HTML 使用编辑器 API 的结构化快照：

```js
{ html, title, headings: [{ id, level, text }], images: [{ placeholder, src }] }
```

快照负责把可交互编辑 DOM 变成静态语义内容，包括渲染 Mermaid、MathML、任务列表和表格列宽。PDF/HTML 再分别负责打印分页或浏览器阅读样式。

当前公共 API `getPdfSource()` 保持不变，避免破坏已有调用；新增实现优先通过兼容别名 `getExportSource()` 使用同一快照。后续重命名必须单独做行为保持型重构。

Pandoc 不使用该 HTML 快照。它只读取当前 tab 的最新原始 Markdown：源码 textarea 存在时读取 DOM 当前值；富文本 editor API 可用时调用 `flushMarkdown()`；仅在编辑器尚未挂载时回退 `tab.content`。

## 3. IPC 安全

- PDF、HTML、Pandoc 的 preview/save/dispose/export IPC 都校验 `event.sender` 是主窗口 renderer。
- 限制字符串大小和对象字段。
- Pandoc 格式使用白名单，输出路径只能来自主进程保存窗口。
- 子进程使用 `spawn/execFile` 且 `shell: false`；用户不能输入额外命令参数。
- 自定义 Pandoc 路径只有经系统文件选择器选中并通过 `pandoc --version` 验证后才持久化。
- 任务超时后 kill 并等待退出；stderr 持续读取但最多保留 64 KiB。
- HTML 文档转义标题，内容来自已经净化的静态快照；默认 CSP 禁止脚本、对象、frame 和网络样式。

## 4. 任务模型

HTML 复用 PDF 已验证的 latest-request-only 语义：每个 renderer 同时只有一个活动预览；新设置使旧任务变 stale；主进程保存 token 对应的最终字节，保存不重新渲染；renderer 销毁时清理 token 和临时资源。

Pandoc 是用户显式的一次性任务：同一窗口同时只运行一个。导出请求返回结构化结果 `{ ok, canceled, path, error }`，已取消保存和执行失败分开处理。

## 5. 测试层

- 纯逻辑：HTML 选项、主题、CSP、TOC、标题转义；Pandoc 白名单、参数、版本解析。
- 主进程：fixture executable 模拟成功、stderr、超时和非零退出，不依赖真实 Pandoc。
- 后台 CDP：表格、任务列表、公式、Mermaid、图片和代码；HTML 设置/预览/保存；Pandoc 缺失引导；导出前后 dirty 与选择不变。

## 6. 平台

首版 Pandoc 和 HTML Studio 是 Electron 桌面能力。Capacitor shim 显式声明 capability 为 false，移动端不显示入口。未来 HTML 移动分享需要单独使用 Capacitor Filesystem/Share，不复用 Electron IPC。
