# Markdown 原文保真与 Live Preview 架构决策

> 状态：当前实现已落地；源码优先 Live Preview 为远期独立方案。更新时间：2026-07-29。

0.12.34 对“切换后立即输入”“复杂文档中间段落合并”“硬换行/行内图片后的光标偏移”和“新段落以行内代码起笔”进行了一次联合根因排查。具体症状、失败方案、证据和复现步骤见 [0.12.34 编辑器源码保真与模式切换疑难问题报告](./editor-source-switch-regression-0.12.34.md)。

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
7. UTF-8 BOM、CRLF 和混合换行属于原文的一部分。源码模式只改一个字符时，不得把整篇文件统一成 LF。

## 当前实现

### 双快照，而非整篇回写

`Editor.jsx` 同时维护两份内容：

- `lastMarkdownRef`：用户当前的原始 Markdown，是 App、保存和源码 textarea 的来源。
- `canonicalMarkdownRef`：Crepe 最近一次序列化的规范 Markdown，只用于识别富文本事务实际改变了什么。

普通富文本编辑触发 `markdownUpdated` 后，`markdown-source-preservation.js` façade 会比较前后 canonical 快照，并把局部变更路由到内部纯函数模块，再映射回原始源码：

- 普通文字输入只替换对应的 raw 字符区间；
- 文档末尾按 Enter 新建正文时，按源文件原有结尾换行风格写入标准段落边界；空段落没有 visible index，不能用最后一个可见字符位置代替；
- 在已有块之间按 Enter 新建正文时，以前后两个未变化的可见行作为边界，只替换它们之间的 raw 间隙；快速输入和停顿输入分别对应单事务块插入、`<br />` 占位后填充两条路径；
- 列表结构变化只替换映射到的列表树，并保留原有 `-` / `*` 风格及紧凑列表间距；
- 表格行列变化只替换对应表格块，空单元格占位只在该表格内规范化；
- 表格单元格的普通文字输入只映射真实 cell 文本 delta，不采用 serializer 重新对齐后的整张表；
- 标题等级、分段等结构变化只替换受影响的原始行；
- 映射无法证明安全时返回原文和失败原因，不允许用整篇 canonical Markdown 兜底。

当原始源码与上一份 canonical 基线逐字完全一致时，不存在需要保留的非 canonical 写法。完成空段落占位、列表和表格等专用分支后，可直接采用下一份 canonical 结果（同时规范化表格空单元格）。若全文不一致，但变更位于最后一个独立单行块，且该块在原始源码与 canonical 中逐字相同，则只替换这一行，保留之前的紧凑单换行、额外空行和其他原始写法。这两个确定性路径共同保护“新段落首个内容是行内代码”的时序：左反引号会先形成仅含 `\`` 的临时段落，它没有稳定可见字符；若继续走 visible offset，首个代码字符可能被错误映射到上一段行尾并吞掉段落分隔符，随后令模式切换光标整体偏移一行。

源码模式修改后，`replaceAll` 产生的全部程序化 `markdownUpdated` 事务会持续隔离，直到下一次明确的用户输入。这样即使前一次富文本编辑的短时活动标记仍存在，也不会把同步事务再次当成用户编辑。

源码 textarea 为性能原因保持非受控。富文本输入后的 `markdownUpdated` 可能晚于用户点击模式切换；若先挂载 textarea，后到的 React 内容更新不会改变它的 `defaultValue`。因此富文本→源码必须先调用编辑器 API 的 `flushMarkdown()`，同步读取当前 Crepe 文档并执行同一套原文保真映射，再同步更新 `tabsRef` 和 tab state，最后才显示源码。禁止用固定延时或把大型 textarea 改成受控组件规避该竞态。

浏览器会把 textarea 中的 CRLF 和单独 CR 统一呈现为 LF，因此 DOM `value` 不是可直接保存的原始源码。`source-text-fidelity.js` 在 DOM 之外维护 raw snapshot，把每次 normalized 输入的局部 delta 打回原文；查找替换、源码审阅、附件插入和大纲移动也必须使用该入口。光标与视口的 textarea offset 和 raw source offset 必须通过同一模块互转。

超过 `CHUNK_THRESHOLD` 的文档在后台追加完所有块后，必须记录完整 canonical baseline，但不得用它重建 `lastMarkdownRef`。缺少这个基线会导致首次富文本输入被丢弃或扩大替换范围。

空文档会在 ProseMirror 中建立一个仅供起笔使用的“空一级标题 + 空正文”骨架，但磁盘源码仍是空字符串。这个 UI 骨架必须在 `canonicalForSource()` 中从 canonical 差异基线排除：用户跳过标题从正文起笔时不能凭空写入 `#`，用户在标题中输入后则立即把标题视为真实 Markdown。否则第一次输入会因 `#\n\n` 与空源码的 visible stream 不一致而被原文保护器拒绝，表现为未保存切源码后内容为空或仍是旧快照。

真实手打存在两种时序。停顿输入时，Enter 创建的空 paragraph 会先被 Crepe 序列化成独立 `<br />` 块；原文保护层必须只推进 canonical 基线，等文字填入后再写入真实段落。快速输入时，Enter 和文字可能被合并成一次块插入事务，完全不出现 `<br />` 中间态。文档末尾通过结尾边界追加，中间位置通过前后未变化可见行的序号映射定位 raw 间隙。不能把零可见字符位置当作前一段末尾，否则正文会拼接，且占位符会泄漏。列表、表格、标题、引用和代码围栏必须绕过这个普通段落分支，继续走各自的结构映射。

中间块定位只能校验编辑点相邻的前后块，不能要求整篇文档的可见行逐项完全一致。Crepe 对前部表格的列对齐空格、紧凑列表的空行和标记符进行 canonical 化时，这些无关差异不得让后部段落插入降级为普通字符映射。若后继块包含代码围栏等没有可见文本的语法前缀，应从 `nextGap` 中剥离原有 canonical gap，只把新增 gap 插入原源码，不能连带重写用户的围栏写法。

源码→富文本的首次 raw-offset 恢复必须在 `useLayoutEffect` 中同步执行，保证新视图接收输入前选区已就位。`90/220/450ms` 与后续布局稳定重试只用于图片、代码块等异步高度变化；富文本根节点发生任意真实键盘、`beforeinput`、输入法完成或鼠标按下后，所有旧重试必须终止并清除 round-trip offset。否则用户切回后立即输入时，旧恢复会在单词中途把光标拉回上一段，随后源码结构和光标同时失真。

raw offset ↔ ProseMirror 映射不能以 `textContent.length` 代表 textblock 的位置长度。硬换行和行内图片在 ProseMirror 中各占一个位置但不进入 `textContent`；两侧现在都构建逐字符/逐原子 item 序列并按 item index 对齐。新增映射类型时必须同时测试节点之前、节点之后和段尾。

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
- `src/renderer/src/markdown-source-preservation.js`：稳定公共入口与策略编排；仅公开 `preserveRichMarkdownSource`、`replaceMarkdownFrontmatterBlock`、`replaceMarkdownListBlock`，调用方不得越过该入口依赖内部实现。
- `src/renderer/src/lib/markdown-preservation/core.js`：通用差分、可见字符与 raw offset 转换。
- `src/renderer/src/lib/markdown-preservation/frontmatter.js`：YAML front matter 块替换。
- `src/renderer/src/lib/markdown-preservation/lists.js`：列表边界、结构变化与同块保真。
- `src/renderer/src/lib/markdown-preservation/tables.js`：表格结构/单元格文字变化与空单元格规范化。
- `src/renderer/src/lib/markdown-preservation/paragraphs.js`：文档末尾和中间位置的新段落、空块时序。
- `src/renderer/src/lib/markdown-preservation/regions.js`：普通行、局部文字与结构前缀变化。
- `src/renderer/src/source-text-fidelity.js`：非受控 textarea 的 raw snapshot、CRLF/BOM 保真和 offset 转换。
- `src/renderer/src/components/editor-md-paste.js`：Markdown 与网页 HTML 的粘贴路由和语义覆盖判断。
- `src/renderer/src/components/editor-source-map.js`：Markdown raw offset ↔ ProseMirror position 映射。
- `src/renderer/src/hooks/useSourceModeSwitch.js`：源码/富文本状态机；源码真的改过才同步回 Crepe。

内部模块保持单向依赖：façade 可以组合各模块，领域模块只依赖 `core.js`、`mode-visible-map.js` 或同领域纯函数，不能反向导入 façade、React、Editor 或 App。新增语法保真能力时优先进入对应领域模块；只有跨领域决策和最终降级顺序留在 façade。该边界于 2026-07-29 从原 993 行单文件完成行为保持型拆分，公共导出和调用方均未改变。

## 回归矩阵

```bash
# 纯函数：局部编辑不改写无关原文
npm run test:markdown-preservation

# 纯函数：源码 textarea 保留 CRLF、BOM、混合换行
npm run test:source-text-fidelity

# 映射：重复文本、表格、代码、硬换行、行内/块级图片、HTML
npm run test:source-map

# 精确 raw offset：表格、代码、硬换行、连续双向切换及切回后立即输入
npm run test:mode-switch-raw-offset-ui

# 真实 Electron：10 个快照、真实写盘、列表新增、双向切换和粘贴
npm run test:issue-77-ui

# 真实 Electron：空文档起笔、文档末尾与中间 Enter 新段落、保存重开
npm run test:paragraph-source-ui

# 真实 Electron：重复表格行列编辑、富文本保存、完全退出并重开文件
npm run test:issue-86-ui

# 真实 Electron：异构 Markdown 多点编辑后全文与磁盘逐字节比较
npm run test:source-fidelity-ui

# 真实 Electron：120k+ BOM/CRLF 分块文档首次富文本和源码编辑
npm run test:large-source-fidelity-ui

# 标准逐键输入、方向键退出、新段落首个内容为行内代码；发布前连续运行 10 次
npm run test:inline-code-ui

# 已安装 macOS 包也必须至少跑一次
HORSEMD_APP_PATH=/Applications/HorseMD.app/Contents/MacOS/HorseMD npm run test:issue-77-ui
```

发布前使用不同 CDP 端口连续运行 `test:issue-77-ui` 和 `test:paragraph-source-ui` 10 次，并至少各运行一次 `test:source-fidelity-ui` 与 `test:large-source-fidelity-ui`。段落测试必须同时覆盖快速输入的单事务块插入、停顿输入的 `<br />` 两阶段事务、文档末尾和后续块之前的中间插入；并验证空文档从默认标题起笔、跳过标题从正文起笔、输入后立即切源码、标准空行分隔，以及真实保存、退出和全新进程重开后的 paragraph 结构。人工验证另测微信公众号段落、标题、加粗、图片和表格。

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
