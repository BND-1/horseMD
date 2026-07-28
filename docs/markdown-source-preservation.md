# Markdown 原文保真与 Live Preview 架构决策

> 状态：当前实现已落地；源码优先 Live Preview 为远期独立方案。更新时间：2026-07-28。

## 为什么需要这份文档

HorseMD 的富文本编辑器是 Milkdown Crepe（ProseMirror + remark）。它会把 Markdown 解析为 ProseMirror 文档，再把整个文档序列化回 Markdown。这个过程保证的是语义等价，不保证字符级写法等价：例如单个 `~` 可能变为 `\~`，紧凑 `-` 列表可能变为 `*` 列表，标题/段落间可能加入空行。

用户把 Markdown 当作可读、可版本管理的源文件，未修改的部分不应因为查看富文本或编辑另一处文字而被格式化。因此，原文保真是核心编辑合同，不是单纯的显示优化。

## 当前合同

1. 打开 Markdown、只在富文本和源码之间切换，源码逐字符不变。
2. 在富文本中进行局部文字编辑时，未触及区域保留原有空行、列表标记和必要转义。
3. 新增列表项、切换列表类型、调整标题等级或增删表格行列时，规范化范围只能是用户实际修改的列表块、表格块或行，不能扩大到整篇文档。
4. 在富文本中粘贴原始 Markdown 时，即使剪贴板同时带有渲染 HTML，切到源码后仍保留该 Markdown 的原始写法。
5. 来自网页的富文本粘贴优先保留 HTML 语义；不能因为其 `text/plain` 回退内容像 Markdown 就丢失标题、加粗、链接或图片。
6. 只有真实用户编辑或粘贴才会标脏；纯模式切换和程序化源码同步不能标脏或再次改写源码。

## 当前实现

### 双快照，而非整篇回写

`Editor.jsx` 同时维护两份内容：

- `lastMarkdownRef`：用户当前的原始 Markdown，是 App、保存和源码 textarea 的来源。
- `canonicalMarkdownRef`：Crepe 最近一次序列化的规范 Markdown，只用于识别富文本事务实际改变了什么。

普通富文本编辑触发 `markdownUpdated` 后，`markdown-source-preservation.js` 会比较前后 canonical 快照，并把局部变更映射回原始源码：

- 普通文字输入只替换对应的 raw 字符区间；
- 文档末尾按 Enter 新建正文时，按源文件原有结尾换行风格写入标准段落边界；空段落没有 visible index，不能用最后一个可见字符位置代替；
- 列表结构变化只替换映射到的列表树，并保留原有 `-` / `*` 风格及紧凑列表间距；
- 表格行列变化只替换对应表格块，空单元格占位只在该表格内规范化；
- 标题等级、分段等结构变化只替换受影响的原始行；
- 映射无法证明安全时返回原文和失败原因，不允许用整篇 canonical Markdown 兜底。

源码模式修改后，`replaceAll` 产生的全部程序化 `markdownUpdated` 事务会持续隔离，直到下一次明确的用户输入。这样即使前一次富文本编辑的短时活动标记仍存在，也不会把同步事务再次当成用户编辑。

源码 textarea 为性能原因保持非受控。富文本输入后的 `markdownUpdated` 可能晚于用户点击模式切换；若先挂载 textarea，后到的 React 内容更新不会改变它的 `defaultValue`。因此富文本→源码必须先调用编辑器 API 的 `flushMarkdown()`，同步读取当前 Crepe 文档并执行同一套原文保真映射，再同步更新 `tabsRef` 和 tab state，最后才显示源码。禁止用固定延时或把大型 textarea 改成受控组件规避该竞态。

空文档会在 ProseMirror 中建立一个仅供起笔使用的“空一级标题 + 空正文”骨架，但磁盘源码仍是空字符串。这个 UI 骨架必须在 `canonicalForSource()` 中从 canonical 差异基线排除：用户跳过标题从正文起笔时不能凭空写入 `#`，用户在标题中输入后则立即把标题视为真实 Markdown。否则第一次输入会因 `#\n\n` 与空源码的 visible stream 不一致而被原文保护器拒绝，表现为未保存切源码后内容为空或仍是旧快照。

真实手打时，每一行通常会在 Enter 前完成一次独立的 `markdownUpdated`。Enter 创建的末尾空 paragraph 会被 Crepe 暂时序列化成独立的 `<br />` 块；它不是用户源码。原文保护层必须保留源码不变但推进 canonical 基线，等下一次输入把该占位块替换为文字时，再以标准空白行分隔追加正文。若直接把占位块当结构变化写回，下一次 visible-index 映射会把正文插入标题末尾，并最终把 `<br />` 留在文件中。UI 回归必须逐字输入并在每行停顿，不能只用会被 Crepe 合并成单次事务的高速 `Input.insertText`。

### 双 MIME Markdown 粘贴

浏览器/聊天工具常同时提供：

- `text/plain`：用户复制的 Markdown 原文。
- `text/html`：同一内容的渲染 HTML。

`editor-md-paste.js` 会先判断 Markdown 是否覆盖 HTML 中的关键语义：标题、列表、表格、粗斜体、链接、图片和硬换行。覆盖时直接解析 Markdown 并阻止默认 HTML 粘贴，Markdown 原文随该成功插入事务传入保存链路；不覆盖时保留原 HTML 路径。这避免了“先粘 HTML，再异步猜测恢复 Markdown”的时序依赖。

## 明确边界

- 富文本结构操作仍可能规范化“被修改的语法块”本身，例如表格对齐分隔符或真正切换后的列表标记；未触及的标题、段落、相邻列表和空行必须逐字符保持。需要逐字符控制目标语法块时使用源码模式。详见 [Issue #86 表格保存问题报告](./issue-86-table-save-report.md)。
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

# 真实 Electron：10 个快照、真实写盘、列表新增、双向切换和粘贴
npm run test:issue-77-ui

# 真实 Electron：空文档标题/正文起笔、单换行、Enter 新段落、保存重开
npm run test:paragraph-source-ui

# 真实 Electron：重复表格行列编辑、富文本保存、完全退出并重开文件
npm run test:issue-86-ui

# 已安装 macOS 包也必须至少跑一次
HORSEMD_APP_PATH=/Applications/HorseMD.app/Contents/MacOS/HorseMD npm run test:issue-77-ui
```

发布前使用不同 CDP 端口连续运行 `test:issue-77-ui` 和 `test:paragraph-source-ui` 10 次。后者以逐字输入和每行停顿强制覆盖独立事务，验证空文档从默认标题起笔、跳过标题从正文起笔、末尾空 paragraph 的 `<br />` 不进入源码、已有单换行正文只改文字、输入后立即切源码、新段落标准空行分隔，以及真实保存、退出和全新进程重开后的 paragraph 结构。人工验证另测微信公众号段落、标题、加粗、图片和表格。

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
