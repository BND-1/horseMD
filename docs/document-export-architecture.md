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

## 2. 共享快照，不共享格式实现

PDF 与 HTML 使用编辑器 API 的结构化快照：

```js
{ html, title, headings: [{ id, level, text }], images: [{ placeholder, src }] }
```

快照负责把可交互编辑 DOM 变成静态语义内容，包括渲染 Mermaid、MathML、任务列表和表格列宽。PDF/HTML 再分别负责打印分页或浏览器阅读样式。

当前公共 API `getPdfSource()` 保持不变，避免破坏已有调用；新增实现优先通过兼容别名 `getExportSource()` 使用同一快照。后续重命名必须单独做行为保持型重构。

Pandoc 不使用该 HTML 快照。它只读取当前 tab 的最新原始 Markdown：源码 textarea 存在时读取 DOM 当前值；富文本 editor API 可用时调用 `flushMarkdown()`；仅在编辑器尚未挂载时回退 `tab.content`。

## 3. IPC 安全

- 校验 event.sender 是主窗口 renderer。
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

