# PDF 渲染内容导出修复报告

## 问题

Mermaid 围栏代码块在富文本中已经显示为图表，但打开 PDF 导出中心后只打印
Mermaid 源码。LaTeX 没有同样退化，因此这个问题容易被误判为 Mermaid 自身或
隐藏打印窗口不支持 SVG。

## 根因

PDF 源内容过去由 `editor-api.js` 直接克隆当前 ProseMirror DOM，然后按下面的
顺序处理：

1. 单独把 LaTeX 预览转换为 MathML。
2. 删除 `.preview-panel` 等编辑器界面节点。
3. 把剩余 CodeMirror 内容转换为 `<pre><code>`。

Crepe 的 Mermaid 图表和 LaTeX 一样，都位于代码块的 `.preview-panel`。由于
只有 LaTeX 在清理前被特殊处理，Mermaid SVG 会在第 2 步被删除，第 3 步自然
只能看到并打印源码。这个问题与图表是否已经在屏幕上显示、是否滚动到可视区
无关，本质是 PDF 导出转换顺序不完整。

## 修复

PDF 内容转换已集中到
`src/renderer/src/components/editor-pdf-content.js`，`editor-api.js` 只保留稳定的
异步公共 API：

```js
await editorApi.getPdfSource()
```

转换流程如下：

1. 同步克隆当前编辑器 DOM，冻结本次导出的文档状态。
2. 主动调用与富文本预览相同的 Mermaid 严格模式渲染器，不依赖图表是否在
   可视区、是否已挂载或是否刚好渲染完成。
3. 通过代码预览导出器，将 LaTeX 转为 MathML、Mermaid 转为经过清理的 SVG。
4. 物化任务列表复选框，再删除工具条、预览容器、拖拽柄和编辑器占位节点。
5. 普通代码块继续转换为 `<pre><code>`，不尝试按公式或图表解释。
6. 收集标题和图片资源，交给主进程生成最终 PDF。

Mermaid SVG 会移除脚本、事件属性和 `javascript:` 链接，并从 `viewBox` 固化
原始宽高，PDF 样式只做 `max-width` / `max-height` 约束，不把长图强塞进方形
区域。全部图表共用 12 秒转换截止时间，避免大量异常图表让导出无限等待。
语法无效或超时的 Mermaid 块保留为源码，用户仍能看到并修正内容。

## 行为合同

- PDF 导出不能依赖 live editor 预览是否可见或是否加载完成。
- Mermaid、LaTeX 等预览型代码块必须先物化，再删除编辑器 DOM。
- 普通 C++、JavaScript 等围栏代码必须始终按源码打印。
- 图表转换失败不能阻止整篇文档导出，也不能丢失原始代码。
- 生成的 SVG 不允许保留可执行脚本、事件处理器或危险链接。
- 生成 PDF source 期间的异步工作不能读取后续编辑产生的新 DOM；一次请求对应
  一个固定快照。
- 程序化生成 PDF source 不得把标签标为已修改。

## 自动化验证

`scripts/test-pdf-rendered-formats-ui.mjs` 在后台真实 Electron 中立即打开 PDF
导出，不等待屏幕上的 Mermaid 预览，覆盖：

| 类别 | 验证内容 |
| --- | --- |
| Mermaid | 流程图、时序图、饼图、类图、状态图、ER 图均导出为带尺寸的 SVG |
| 异常 Mermaid | 保留源码，不中止 PDF |
| 数学 | 行内公式保留；段落 LaTeX 导出为 MathML |
| 普通代码 | JavaScript 保留为 `<pre><code>` |
| Markdown 结构 | 标题、粗体、斜体、行内代码、引用、任务列表、表格 |
| HTML | 安全的原生 HTML 结构保留 |
| 编辑器 UI | 工具条、CodeMirror、预览面板和辅助节点不进入 PDF |
| 输出 | 真实 `printToPDF` 成功、PDF.js Canvas 完成绘制、无虚假图片警告 |

同时继续运行图片暂存、超宽表格、极长 LaTeX、普通代码块和 PDF Studio 的专项
回归。新增预览型格式时，应先接入代码预览导出器，再补充本矩阵，不能只在编辑器
中实现显示。
