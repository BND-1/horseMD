# Mermaid 手动编辑刷新与保存回归报告

> 状态：已修复并自动化验证。更新：2026-08-02。

## 用户现象

在富文本里点击 Mermaid 的“编辑代码”后逐字修改流程图：

1. 图表预览停在旧图，或停在输入过程中的“语法错误”；
2. 即使界面里的 CodeMirror 已显示新源码，保存、切源码或关闭重开后，改动可能仍回到旧图。

典型输入是把一条新连线逐字输入为 `B --> C`。输入到 `B -->` 时 Mermaid
暂时不合法；如果这次异步报错晚于后续合法图的渲染完成，它会反过来覆盖新预览。

另一类现象出现在含多张图的长 Markdown 文件：单独粘贴一个 Mermaid 能立即显示，
但从磁盘打开整篇文档时，某张大图或所有图会永久停在“正在渲染图表…”。

## 根因

Crepe 的 CodeMirror 每次输入都会提交 ProseMirror transaction；Mermaid 渲染却是异步的。
此外 Milkdown 的 Vue `renderPreview` 回调在代码块初次创建时生成，不能假设每个字符输入
都会获得一个新的 callback。因此只按 callback 保存“最新源码”并不可靠：旧 callback 的结果仍可
在新源码已出现后写回预览。

保存链路又有独立风险：`markdownUpdated` 是异步通知，若保存只读 `lastMarkdownRef`，自定义
node view 的可见 transaction 可能尚未进入缓存，导致“富文本已删、源码/磁盘仍有，重开后复活”。

长文档问题的根因是两层错误叠加：

1. Markdown 围栏内可能保留 Windows `CRLF`，而 CodeMirror 对同一内容暴露为 `LF`；旧的“最新
   源码”比较把成功结果误判为过期。
2. 更严重的是 CodeMirror 会虚拟化长代码块，`.cm-line` 只保留可见约数十行。旧实现把这个局部
   DOM 当成完整 Mermaid 源码，首张长图被截断后变成无效语法；同时又因局部文本无法与完整
   ProseMirror 内容匹配，渲染结果永远不写回面板。

## 修复

- `editor-mermaid.js` 以实际 `.milkdown-code-block` DOM 作为 Mermaid 预览版本的归属；
  `CodeMirror` 编辑完成后经短暂 debounce 直接刷新该块的 `.preview`。需要完整内容时从
  ProseMirror `code_block` 读取，绝不把虚拟 `.cm-line` 当作完整源代码。
- 每个异步 Mermaid 回调在写入前核对该块当前源码；旧输入（如 `B -->`）的错误结果会被丢弃，
  不会覆盖完成后的 `B --> C` 图表。
- 所有 Mermaid 预览、缓存键和 freshness 比较统一为 `LF + trim` 的 canonical 源码；这只用于
  渲染判定，不会写回或修改用户 Markdown 的原始换行符。
- Mermaid 实际 `render()` 通过模块级队列串行运行，同图仍合并等待者。这样多张图首次打开不会
  竞争 Mermaid 的模块级渲染状态；失败重试也保留全部等待回调。
- `App.jsx#getMarkdownForTab()` 在**保存和导出**时调用 `flushMarkdown({ force: true })`，直接序列化
  当前 ProseMirror `doc`；阅读型模式切换继续使用非强制快照以避免大文档无谓全量序列化。

## 回归验证

`scripts/test-mermaid-edit-save-ui.mjs` 使用隔离 profile 的后台 Electron，并逐字输入：

1. 打开 `flowchart TD / A --> B`；
2. 以真实键盘事件逐字键入 `B --> C`，经过临时无效状态；
3. 断言预览最终包含 C 且没有 parse error；
4. 保存、切源码，确认磁盘和源码均包含新连线；
5. 用全新 profile 重开同一文件，再次确认图表和源码。

`scripts/test-issues-105-106-save-fidelity-ui.mjs` 还覆盖“富文本选中删除 → 立即保存 → 切源码 →
全新进程重开”，删除文本绝不能复活，同时继续检查两条图片链接不会重复。

`scripts/test-mermaid-long-document-ui.mjs` 使用含 97 行 CRLF Mermaid 图和两张相邻图的文件，
断言第一张图的 CodeMirror 行 DOM 已被虚拟化但三张预览仍全部成为 SVG、没有永久加载提示。

```bash
npm run test:mermaid-edit-save-ui
npm run test:mermaid-long-document-ui
npm run test:issues-105-106-ui
npm run test:mermaid-paste-ui
```

## 手工验收

1. 新建 Mermaid 块，点击“编辑代码”，在末尾慢速输入一条新连线；等待预览显示最新节点。
2. 故意停在不完整语法一秒，再补完语法；最终应显示新图，不应永久留下旧错误。
3. 立刻保存、切到源码、关闭文件并重开；图、围栏源码和新连线必须一致。
4. 在普通富文本段落选中一段文字删除后立刻保存，切源码和重开均不得重新出现该文字。
5. 打开含多张 Mermaid 的长文档（尤其来自 Windows 的 CRLF 文件）；每张图都应在短暂加载后
   显示 SVG，不能有任何一张永久停在“正在渲染图表…”。
