# Markdown 原文保真与 Live Preview 架构决策

> 状态：当前实现已落地；源码优先 Live Preview 为远期独立方案。更新时间：2026-07-18。

## 为什么需要这份文档

HorseMD 的富文本编辑器是 Milkdown Crepe（ProseMirror + remark）。它会把 Markdown 解析为 ProseMirror 文档，再把整个文档序列化回 Markdown。这个过程保证的是语义等价，不保证字符级写法等价：例如单个 `~` 可能变为 `\~`，紧凑 `-` 列表可能变为 `*` 列表，标题/段落间可能加入空行。

用户把 Markdown 当作可读、可版本管理的源文件，未修改的部分不应因为查看富文本或编辑另一处文字而被格式化。因此，原文保真是核心编辑合同，不是单纯的显示优化。

## 当前合同

1. 打开 Markdown、只在富文本和源码之间切换，源码逐字符不变。
2. 在富文本中进行局部文字编辑时，未触及区域保留原有空行、列表标记和必要转义。
3. 在富文本中粘贴原始 Markdown 时，即使剪贴板同时带有渲染 HTML，切到源码后仍保留该 Markdown 的原始写法。
4. 来自网页的富文本粘贴优先保留 HTML 语义；不能因为其 `text/plain` 回退内容像 Markdown 就丢失标题、加粗、链接或图片。
5. 只有真实用户编辑或粘贴才会标脏；纯模式切换不能标脏。

## 当前实现

### 双快照，而非整篇回写

`Editor.jsx` 同时维护两份内容：

- `lastMarkdownRef`：用户当前的原始 Markdown，是 App、保存和源码 textarea 的来源。
- `canonicalMarkdownRef`：Crepe 最近一次序列化的规范 Markdown，只用于识别富文本事务实际改变了什么。

普通富文本编辑触发 `markdownUpdated` 后，`markdown-source-preservation.js` 会比较前后 canonical 快照，并把局部变更映射回原始源码。可见文本流不一致、无法映射或纯结构性编辑时，宁可退回该受影响结果的规范化输出，也不能在错误的 raw 位置补写语法。

### 双 MIME Markdown 粘贴

浏览器/聊天工具常同时提供：

- `text/plain`：用户复制的 Markdown 原文。
- `text/html`：同一内容的渲染 HTML。

`editor-md-paste.js` 会先判断 Markdown 是否覆盖 HTML 中的关键语义：标题、列表、表格、粗斜体、链接、图片和硬换行。覆盖时直接解析 Markdown 并阻止默认 HTML 粘贴，Markdown 原文随该成功插入事务传入保存链路；不覆盖时保留原 HTML 路径。这避免了“先粘 HTML，再异步猜测恢复 Markdown”的时序依赖。

## 明确边界

- 富文本里修改标题等级、列表类型等没有可见文本跨度的结构操作，当前可能规范化结果。表格行列结构变更会明确采用本次完整规范 Markdown，避免把 `|` 和换行按普通字符拼错；空单元格的序列化占位 `<br />` 只会在完整表格输出后规范为 `| |`。需要逐字符控制复杂语法时使用源码模式。详见 [Issue #86 表格保存问题报告](./issue-86-table-save-report.md)。
- 已被旧版本保存为 `\~` 的文件不会自动还原为 `~`：反斜杠可能本来就是用户有意写入，程序不能猜测并改写历史文件。
- 不要用全文关键词/片段匹配来定位光标或恢复原文；重复文本会造成错误命中。模式切换继续以块级 raw offset 映射为主。
- 不能为了原文保真把所有网页 HTML 都强行按 `text/plain` 解析，否则会回归微信公众号标题、格式和图片粘贴。

## 关键文件

- `src/renderer/src/components/Editor.jsx`：原始/规范快照、真实用户编辑回写、成功 Markdown 粘贴事务。
- `src/renderer/src/markdown-source-preservation.js`：局部 serializer delta 到原始源码的纯函数映射。
- `src/renderer/src/components/editor-md-paste.js`：Markdown 与网页 HTML 的粘贴路由和语义覆盖判断。
- `src/renderer/src/components/editor-source-map.js`：Markdown raw offset ↔ ProseMirror position 映射。
- `src/renderer/src/hooks/useSourceModeSwitch.js`：源码/富文本状态机；源码真的改过才同步回 Crepe。

## 回归矩阵

```bash
# 纯函数：局部编辑不改写无关原文
npm run test:markdown-preservation

# 映射：重复文本、表格、代码、图片、HTML
npm run test:source-map

# 真实 Electron：10 个局部编辑快照、双向切换、Markdown 双 MIME 粘贴、网页 HTML 语义
npm run test:issue-77-ui

# 真实 Electron：重复表格行列编辑、富文本保存、完全退出并重开文件
npm run test:issue-86-ui

# 已安装 macOS 包也必须至少跑一次
HORSEMD_APP_PATH=/Applications/HorseMD.app/Contents/MacOS/HorseMD npm run test:issue-77-ui
```

人工验证使用连续标题、单个 `~`、紧凑 `-` 列表和列表硬换行的 Markdown：无编辑往返、局部富文本编辑、富文本全选粘贴后切源码都应逐字符符合预期。网页粘贴另测微信公众号段落、标题、加粗、图片和表格。

## 市场调研与长期决策

公开资料显示，MarkText 也有独立 WYSIWYG 与 CodeMirror 源码编辑器，并在切换时导出/再导入 Markdown；这与 HorseMD 当前双视图转换模型相近，不应假设它能天然保持每个字符写法。Joplin 明确说明富文本保存会规范化某些 Markdown 表达。Milkdown 的公开 API 也以 Markdown parser/serializer 为中心。

Obsidian 的 Live Preview 和 Source mode 都运行在 CodeMirror 编辑态，公开插件文档说明它使用 CodeMirror 6 与 view extension。由此可以合理推断，它更接近“Markdown 文本为唯一事实来源，渲染只是编辑器装饰”的模型。Typora 闭源，不能把其体验推断为某一具体实现。

参考：

- [Obsidian 编辑模式](https://obsidian.md/help/edit-and-read)
- [Obsidian 编辑器开发文档](https://docs.obsidian.md/Plugins/Editor/Editor)
- [MarkText 架构](https://github.com/marktext/marktext/blob/develop/docs/dev/ARCHITECTURE.md)
- [Joplin 富文本限制](https://joplinapp.org/help/apps/rich_text_editor/)
- [Milkdown Transformer](https://milkdown.dev/docs/api/transformer)

### 远期：源码优先 Live Preview

若未来要达到架构上的字符级源码稳定性，应另立项目，把 CodeMirror 6 Markdown 文本编辑器作为唯一数据模型，在非活动行/块上通过 decorations、widgets 和 node views 展示标题、公式、图片、表格等 Live Preview。此时“源码”和“富文本”不再是两个互相同步的文档。

这不是当前 #77 的后续小修：它会影响 Crepe 表格、代码块、Mermaid、图片粘贴、Review、查找替换、光标/视口、PDF source 和移动端共享 renderer。只有完成独立设计、功能盘点、迁移试验和完整回归矩阵后才可启动；在此之前，继续维护当前保真层，不要仓促替换编辑器内核。
