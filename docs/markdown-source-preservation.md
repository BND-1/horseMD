# Markdown 原文保真与 Live Preview 架构决策

> 状态：当前实现已落地；源码优先 Live Preview 为远期独立方案。更新时间：2026-07-30。

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
8. 段落内的普通单换行可在富文本中按行显示，但这只能是视觉策略；不得把它改写为两个尾随空格、`<br>` 或空白段落。详见 [源码单换行显示问题报告](./soft-line-break-display-report.md)。
9. 从富文本新建 Markdown 结构同样受保护：手打 `-`、`*` 或 `+` 创建列表时保留实际输入的符号；连续回车产生的内部空 paragraph 不得以独立 `<br />` 写入源码。
10. “正文 → Enter → 手打 `- ` → 输入首项”必须形成独立的 `-` 列表项；慢速逐字输入、立即切源码、保存和完整重开均不得把首项并回正文、退回为 `*` 或留下 `<br />`。
11. 纯富文本新建文档在用户尚未编辑源码前，没有既有 Markdown 排版可保护。嵌套列表退出时出现的空有序项属于编辑器中间态，不得成为增量映射基线；应从完整实时 canonical 文档生成结构，再逐项带回已记录的 `-` / `*` / `+` marker。用户实际编辑源码后，立即回到普通局部原文保真路径。
12. 相邻的 `-`、`+`、`*` 在 ProseMirror 中可能合并为一棵 bullet tree，但在作者原文中仍可代表独立列表。延迟 `markdownUpdated` 合并多次编辑时，必须按作者列表的文字围栏分别回写；不得用宽泛 canonical tree 把某个列表的 marker、空行或 `<br />` 占位扩散到相邻列表。混乱编辑回归与根因见 [富文本源码保真：混乱编辑回归计划](./rich-source-chaos-regression-plan.md)。
13. `Tab` 自动生成子列表时没有可捕获的字面 marker；若该子层尚无作者源码行，必须继承紧邻父级的 bullet marker。显式手打的子级 `-` / `+` 优先级更高，不能被父级风格覆盖。
14. 富文本事务已经可见但 `markdownUpdated` 尚未发布时，立即保存、切源码和导出仍必须读取当前 ProseMirror `doc` 的序列化结果；不得写入滞后的 `tab.content`，也不得在下一次同步中重复追加现有图片链接。完整根因与回归见 [Issue #105/#106 富文本保存保真报告](./issues-105-106-save-fidelity-regression.md)。
15. 保存和导出是数据持久化边界，必须强制序列化 live ProseMirror `doc`；不得因“尚未观察到 pending edit”而复用 Markdown 缓存。富文本删除后，源码、磁盘和重开结果必须同时删除，不能在重开后复活。仅阅读型的模式切换可复用已提交快照以保护长文档性能。
16. 富文本把段落文字删光（或在空段落里输入再删光）时，Crepe 用独立 `<br />` 占位表示该空段落，它是编辑器内部状态而非作者内容：源码中只能把该段落变成空行、删除作者文字，两侧空行和其余字节保持不变，绝不允许把 `<br />` 写入源码或磁盘。
17. 引用块内的空段落序列化为 `> <br />`，同样属于编辑器占位：清空后应留下空的 `>` 引用行，不得把 `<br />` 写进源码。独立 `<br />` 的识别必须同时接受裸行和带引用前缀两种形态。
18. 相邻同种列表（`-` 与 `-`、`1.` 与 `1.`）之间的空行是作者排版：仅当 canonical 的空行位置变化（松散↔紧凑）而可见内容不变时，一律保留作者源码，不能因 Milkdown 重新序列化而改写 marker 或合并；只有当合并伴随真实文字变化时才在源码中产出紧凑列表。
19. 新建文档（generated scratch 路径）的源码以单个 `\n` 结尾。Milkdown 可能在最后一块后追加序列化空行或骨架的空段落 `<br />`，它们不是作者内容，不能变成源码尾部的幻影空行；已有文档的结尾换行运行（0、1 或多行）是作者格式，输出绝不能超出它的长度。

## 当前实现

### 双快照，而非整篇回写

`Editor.jsx` 同时维护两份内容：

- `lastMarkdownRef`：用户当前的原始 Markdown，是 App、保存和源码 textarea 的来源。
- `canonicalMarkdownRef`：Crepe 最近一次序列化的规范 Markdown，只用于识别富文本事务实际改变了什么。

普通富文本编辑触发 `markdownUpdated` 后，`markdown-source-preservation.js` façade 会比较前后 canonical 快照，并把局部变更路由到内部纯函数模块，再映射回原始源码：

- 普通文字输入只替换对应的 raw 字符区间；
- 文档末尾按 Enter 新建正文时，按源文件原有结尾换行风格写入标准段落边界；空段落没有 visible index，不能用最后一个可见字符位置代替；
- 在已有块之间按 Enter 新建正文时，以前后两个未变化的可见行作为边界，只替换它们之间的 raw 间隙；快速输入和停顿输入分别对应单事务块插入、`<br />` 占位后填充两条路径；
- 列表结构变化只替换映射到的列表树，并保留原有 `-` / `*` / `+` 风格及紧凑列表间距；新列表在输入规则吞掉 marker 前记录用户意图，转换后 canonical 合并相邻列表时再按转换前项目内容缩小写回区间；
- 表格行列变化只替换对应表格块，空单元格占位只在该表格内规范化；
- 表格单元格的普通文字输入只映射真实 cell 文本 delta，不采用 serializer 重新对齐后的整张表；
- 标题等级、分段等结构变化只替换受影响的原始行；
- 映射无法证明安全时返回原文和失败原因，不允许用整篇 canonical Markdown 兜底。

#### 段落被清空

富文本删除一个段落的所有文字后，ProseMirror 保留空 paragraph 节点，Milkdown 把它序列化为独立 `<br />` 行（与列表项、表格单元格里的 `<br>` 不同，后者是作者可见内容）。旧保真层只覆盖了“插入空段落”和“空段落填入文字”两个方向，缺少“文字被删光变回空段落”的反向映射：中间段落到 `exact-canonical-baseline` 或 `localized-change` 路径时会原样拼入 canonical 的 `<br />`；尾部段落则被 `trailing-empty-block-created` 保留旧文字，形成“富文本已删、源码仍留”的不一致。

新增 `preserveEmptiedParagraph()`：当整段变化恰好是“作者文字 → 空段落占位”，且前后 canonical 其余字节完全一致、源码可见流与上一基线一致时，把该段落映射回源码的空行形式——删除作者段落行（含行内语法），保留两侧空行。例如 `# 测试\n\n你好\n\n再见\n` 清空中间段落后变为 `# 测试\n\n\n\n再见\n`；再次输入或删光都能稳定往返，不累积空行。此外给 `exact-canonical-baseline`、`localized-change` 和零宽结构替换三处兜底出口统一剥离独立 `<br />` 行，避免“一次清空多个段落”等组合路径漏出占位符。真实回归：`npm run test:empty-paragraph-source-ui`，纯函数回归见 `npm run test:markdown-preservation`。

一个隐蔽的边界：文档里同时存在**多个**空段落时，`preserveEmptiedParagraph` 早期版本要求“所有 `<br />` 行都在变更区间内”，另一个无关空段落会让映射整体失效并回退到 `locally-aligned-change`，把被编辑空段落的 `<br />` 漏进源码。正确语义是只要求变更区间内**至少一个**空段落行（`.some`）：其他空段落位于未被触碰的源码字节中，局部替换根本不会经过它们。真实用户场景（标题后按 Enter 建空段落 + 文档另有一处空段落 + 输入 `.`/`/` 再删除）已固化为 UI 回归。

另一个更隐蔽的否决条件：处理器曾要求**全文可见流相等**。真实文档里如果存在“源码是普通段落、remark 却把行中 `* ` 解析成列表项”的结构（例如 `…快速存取。* **输入设备：** …`，`。*` 无空格粘连），源码与 canonical 的可见流会在文档中部永久分叉。此时清空段落的映射（位置可能在分叉点之前）被这个全局守卫整体否决，`<br />` 照常泄漏。正确语义是只要求**变更区间局部对齐**：`preserveChangedLineRegion` 内部已校验映射区域可见文本一致并失败回退，全文相等检查纯属多余且有害。该场景（`CSP-J初赛讲义 第1单元 计算机通识.md` 第 111 行）已固化为纯函数回归。

### 源码边界的硬性不变式

这一族 bug 反复出现、每次只修掉一条泄漏路径的深层原因：**“内部 `<br />` 占位符绝不能进入作者源码”这个不变式，从来没有在源码边界被强制执行，而是散落在各处理路径里靠守卫保障**。任何守卫（空段落行数、全文可见流相等、变更区间包含关系）都可能因文档结构而否决，一旦否决就静默回退到通用路径把占位符漏进源码。

因此 `preserveRichMarkdownSource` 现在在**所有**路径之后执行硬性后置条件：统一剥离独立 `<br />` 占位行（保留引用前缀 `>`），再按源文件尾部换行风格钳制。无论未来哪条启发式路径出错，占位符都到不了源码；行内 `text<br>text` 与表格单元格 `<br>` 不是独立行，不受影响。这属于防御纵深：即使映射逻辑未来再次出现漏洞，边界也会兜住。长期来看，这类问题只能靠“源码即数据模型”的 Live Preview 架构（Obsidian/Typora 模式）从根本上消除——见“远期：源码优先 Live Preview”一节。

#### 相邻列表合并与格式漂移

`- 甲\n\n- 乙\n` 按 CommonMark 是同一棵松散列表；Milkdown 重新序列化时可能在松散/紧凑之间漂移，也可能在真实编辑后把两棵相邻列表合并。`listStructure` 现在把「列表项之间的空行」纳入结构特征：仅空行位置变化的 canonical 差异（可见内容不变）走 `formatting-only-drift` 保留作者源码；伴随文字变化的合并才走列表保真分支，产出紧凑且保留作者 marker（`-`/`1.`）的结果。真实回归见 `npm run test:source-fidelity-probes`（35 组异构探针）与 `npm run test:list-conversion-ui`。

#### 尾部空行钳制

Milkdown 会在最后一块后追加序列化空行（`块\n\n`）或骨架空段落（`<br />`），二者都会让源码尾部多出幻影空行。两条修复：已有文档在 `preserveRichMarkdownSource` 出口统一执行 `capOutputTrailingNewlines()`——输出尾部换行数绝不超出源文件既有的尾部换行数（作者原有的尾部空行可被追加段落合法使用为分隔符，因此只钳制上限、不强求相等）；新建文档在 `generatedScratchMarkdown` 统一收敛为单个 `\n`。这同时修掉了新文档“立即切源码多一个空行”的旧问题。真实回归：`npm run test:paragraph-source-ui`、`npm run test:new-document-list-source-ui`、`npm run test:new-source-fidelity-ui`。

当原始源码与上一份 canonical 基线逐字完全一致时，不存在需要保留的非 canonical 写法。完成空段落占位、列表和表格等专用分支后，可直接采用下一份 canonical 结果（同时规范化表格空单元格）。若全文不一致，但变更位于最后一个独立单行块，且该块在原始源码与 canonical 中逐字相同，则只替换这一行，保留之前的紧凑单换行、额外空行和其他原始写法。这两个确定性路径共同保护“新段落首个内容是行内代码”的时序：左反引号会先形成仅含 `\`` 的临时段落，它没有稳定可见字符；若继续走 visible offset，首个代码字符可能被错误映射到上一段行尾并吞掉段落分隔符，随后令模式切换光标整体偏移一行。

这个“可采用 canonical”的例外还包括从空白启动、全程只在富文本写作的新文档；它不等于用 canonical 覆盖已存在或已从源码提交的用户文档。特别是“嵌套有序项 → Enter ×3 → `- ` 无序项”会发布短暂空的有序项，逐回调增量拼接会把空 `3.` 或默认 `*` 固化。此时 `markdownUpdated` 与 `flushMarkdown()` 必须共享同一完整 canonical 生成函数，并在立即切源码时消费尚未发布的物理 Space marker 意图。

源码模式修改后，`replaceAll` 产生的全部程序化 `markdownUpdated` 事务会持续隔离，直到下一次明确的用户输入。这样即使前一次富文本编辑的短时活动标记仍存在，也不会把同步事务再次当成用户编辑。

源码 textarea 为性能原因保持非受控。富文本输入后的 `markdownUpdated` 可能晚于用户点击模式切换；若先挂载 textarea，后到的 React 内容更新不会改变它的 `defaultValue`。因此富文本→源码必须先调用编辑器 API 的 `flushMarkdown()`，同步读取当前 Crepe 文档并执行同一套原文保真映射，再同步更新 `tabsRef` 和 tab state，最后才显示源码。禁止用固定延时或把大型 textarea 改成受控组件规避该竞态。

浏览器会把 textarea 中的 CRLF 和单独 CR 统一呈现为 LF，因此 DOM `value` 不是可直接保存的原始源码。`source-text-fidelity.js` 在 DOM 之外维护 raw snapshot，把每次 normalized 输入的局部 delta 打回原文；查找替换、源码审阅、附件插入和大纲移动也必须使用该入口。光标与视口的 textarea offset 和 raw source offset 必须通过同一模块互转。

超过 `CHUNK_THRESHOLD` 的文档在后台追加完所有块后，必须记录完整 canonical baseline，但不得用它重建 `lastMarkdownRef`。缺少这个基线会导致首次富文本输入被丢弃或扩大替换范围。

空文档会在 ProseMirror 中建立一个仅供起笔使用的“空一级标题 + 空正文”骨架，但磁盘源码仍是空字符串。这个 UI 骨架必须在 `canonicalForSource()` 中从 canonical 差异基线排除：用户跳过标题从正文起笔时不能凭空写入 `#`，用户在标题中输入后则立即把标题视为真实 Markdown。否则第一次输入会因 `#\n\n` 与空源码的 visible stream 不一致而被原文保护器拒绝，表现为未保存切源码后内容为空或仍是旧快照。

真实手打存在两种时序。停顿输入时，Enter 创建的空 paragraph 会先被 Crepe 序列化成独立 `<br />` 块；原文保护层必须只推进 canonical 基线，等文字填入后再写入真实段落。连续回车还可能生成多个中间占位，写回前必须统一移除独立 `<br />` 行，但不能删除用户原文或表格单元格里的真实 `<br>`。快速输入时，Enter 和文字可能被合并成一次块插入事务，完全不出现 `<br />` 中间态。文档末尾通过结尾边界追加，中间位置通过前后未变化可见行的序号映射定位 raw 间隙。不能把零可见字符位置当作前一段末尾，否则正文会拼接，且占位符会泄漏。列表、表格、标题、引用和代码围栏必须绕过这个普通段落分支，继续走各自的结构映射。

列表输入规则有另一种信息丢失：ProseMirror 只保留“这是无序列表”，不保留触发符号。`editor-dom-interactions.js` 必须在物理 Space 的 `keydown`（`beforeinput` 仅作 IME/辅助输入兜底）记录 `-`、`*` 或 `+`，`lists.js` 再按结构序号恢复刚创建的列表层级。连续 Enter、marker、Space 时，源码快照可能尚未包含空 paragraph 或转义 marker；此时不能相信 `pmPosToMarkdownOffset()` 返回的旧位置，必须用该次输入规则的 canonical 前/后快照，在前后可见内容边界处重建**这一个**列表。真实 macOS 键盘路径还可能先发布字面 marker 的中间 `markdownUpdated`，再发布 list input rule；输入意图只有在确实修改了序列化 marker 后才可消费，不能在中间回调提前丢弃。文档末尾与正文中间都要覆盖。这个意图只在光标仍位于对应无序列表时短期有效，不能变成全文 marker 偏好。Crepe 对刚创建的空列表项会输出 `* <br />` 一类内部占位；保真层必须把它写作用户可见的空项 `- `，并在首个文字输入时按列表树顺序回填该项，不能按零可见字符位置落到上一段。`Tab` 生成的全新子列表没有输入规则 marker，应在没有同层作者行时继承父级 marker；一旦子层有显式作者 marker，必须以子层为准。空白新文档的嵌套列表退出场景则不重放逐次局部快照，而以实时完整 canonical 建立结构、再恢复所有已知 marker；源码实际编辑后关闭该生成路径。列表块扫描允许同类型松散项目跨空行，但顶层类型变化必须截断；列表转换后 canonical 若把相邻同类型列表合并，必须用转换前项目内容定位原列表子区间，否则会复制相邻任务列表。

右键列表类型转换还必须处理 transaction 回调时序：`markdownUpdated` 可能在 dispatch 内触发，也可能延迟到下一次输入或源码 flush。转换链路因此在 dispatch 前序列化目标 ProseMirror `doc`，按实际右键文字位置只修改当前层级 marker，并立即建立新的 authored/canonical 基线；紧接着的输入再走普通局部文字差分。禁止用整棵 canonical 列表覆盖“外层松散、内层紧凑”的用户源码。完整事故记录见 [0.12.52 列表转换源码竞态报告](./list-conversion-source-race-regression.md)。

正文右键“转为有序/无序/待办列表”是不同的结构操作：它把一个普通段落包进新列表，Crepe 的 `getMarkdown()` 在 dispatch 后可能仍是旧缓存，且通用差分面对“仅增加 marker、可见文本不变”时会保守拒绝覆盖。该路径必须序列化当前 `view.state.doc`；再用转换前记录的 raw offset，仅给被操作的 authored 段落行添加 `- `、`1. ` 或 `- [ ] `。实现位于 `editor-block-list-source.js`，只接受普通非空段落，拒绝标题、引用、已有列表和空行。它不可退化为重写整篇 canonical Markdown。回归：`npm run test:block-list-source` 与 `npm run test:list-conversion-ui`。

强制保存/切换的 `flushMarkdown()` 必须序列化当前 `view.state.doc`，不能把 `crepe.getMarkdown()` 的 listener 缓存当作实时文档；后者在输入 transaction 已提交但 `markdownUpdated` 尚未发布时可能落后一拍。初始化 canonical baseline 也必须使用同一 `serializerCtx(view.state.doc)` 路径；缓存与直接序列化在列表末尾换行上可能不同，把它们混用会把纯模式切换误判为编辑并删除用户的尾部空行。

这里的“强制”只用于保存与导出：`getMarkdownForTab()` 调用 `flushMarkdown({ force: true })`，确保
自定义节点视图的 transaction 即使漏过 edit-intent 回调也会持久化。只读的富文本→源码阅读切换仍只在
确有 pending rich edit 时 flush，避免 400KB+ 文档每次阅读切换都全量序列化。

中间块定位只能校验编辑点相邻的前后块，不能要求整篇文档的可见行逐项完全一致。Crepe 对前部表格的列对齐空格、紧凑列表的空行和标记符进行 canonical 化时，这些无关差异不得让后部段落插入降级为普通字符映射。若后继块包含代码围栏等没有可见文本的语法前缀，应从 `nextGap` 中剥离原有 canonical gap，只把新增 gap 插入原源码，不能连带重写用户的围栏写法。

源码→富文本的首次 raw-offset 恢复必须在 `useLayoutEffect` 中同步执行，保证新视图接收输入前选区已就位。`90/220/450ms` 与后续布局稳定重试只用于图片、代码块等异步高度变化；富文本根节点发生任意真实键盘、`beforeinput`、输入法完成或鼠标按下后，所有旧重试必须终止并清除 round-trip offset。否则用户切回后立即输入时，旧恢复会在单词中途把光标拉回上一段，随后源码结构和光标同时失真。

raw offset ↔ ProseMirror 映射不能以 `textContent.length` 代表 textblock 的位置长度。硬换行和行内图片在 ProseMirror 中各占一个位置但不进入 `textContent`；两侧现在都构建逐字符/逐原子 item 序列并按 item index 对齐。新增映射类型时必须同时测试节点之前、节点之后和段尾。

行内公式也属于这一类 atom：mdast 的 `inlineMath` 有 TeX 原文，而 ProseMirror 的 `math_inline` 不会把 TeX 放入段落 `textContent`。块定位不能直接拿两种文本做相等判断；`editor-source-map.js` 必须另外使用**同时忽略 inline math、图片和硬换行 atom 的比较投影**先锁定同一段，再用完整 inline item 序列计算段内 raw offset。否则某一段中的 `$…$` 会让块匹配失败，并在长文档的 index fallback 下把光标送到无关段落。该回归由 `inline math atom position` 与 `HORSEMD_RAW_OFFSET_TARGET=inline-math npm run test:mode-switch-raw-offset-ui` 覆盖，事故和真实文档验证见 [Issue #104 长文档模式切换报告](./issue-104-long-document-mode-switch.md)。

只滚动阅读而可见区没有 caret 时，富文本编辑器保持挂载，原有 selection 已足以供返回富文本时保留；此时不得为了计算一个未使用的 caret/raw viewport offset 而重新序列化或完整解析整篇 Markdown。`useSourceModeSwitch.js` 仅在可见 caret 跟随路径调用 `markdownOffsetFromSelection()`；阅读路径只保存 DOM viewport 的 snippet + 比例锚点。`flushMarkdown()` 也仅在真实用户编辑尚未被 `markdownUpdated` 提交时读取 `view.state.doc`。这既避免 400KB+ 文档的纯阅读切换卡顿，也避免把 atom 结构上的错误 raw offset 用作滚动恢复优先级。

### 多 MIME 复制与 Markdown 粘贴

HorseMD 富文本复制提供三个语义不同的通道：

- `text/plain`：用户实际选中的可见文字，供外部纯文本目标使用。
- `text/html`：带内联样式的渲染 HTML，供富文本目标使用。
- `text/markdown`：选区对应的结构化 Markdown，供 HorseMD 内部粘贴恢复结构。

`text/plain` 绝不能使用块级 Markdown serializer：serializer 会为段落补分隔换行、为列表补 marker，这些字符并不是用户选中的外部纯文本。`editor-md-paste.js` 优先读取 HorseMD 提供的 `text/markdown`；对于其他应用只提供 `text/plain` + `text/html` 的情况，再判断 Markdown 是否覆盖 HTML 中的关键语义。覆盖时直接解析 Markdown 并阻止默认 HTML 粘贴，不覆盖时保留原 HTML 路径。

裸 Mermaid 是该合同中的特殊结构输入：富文本会创建 `code_block`，因此源码快照也
必须同步写成一个合法的 Mermaid 围栏，不能继续保存为普通裸文字。一份 Mermaid
剪贴板内容只允许生成一个节点、一个预览和一个围栏；完整事故与测试见
[Mermaid 粘贴重复渲染问题报告](./mermaid-paste-duplicate-render-report.md)。

## 明确边界

- 富文本结构操作仍可能规范化“被修改的语法块”本身，例如表格对齐分隔符或真正切换后的列表标记；未触及的标题、段落、相邻列表和空行必须逐字符保持。需要逐字符控制目标语法块时使用源码模式。详见 [Issue #86 表格保存问题报告](./issue-86-table-save-report.md)。
- 已被旧版本保存为 `\~` 的文件不会自动还原为 `~`：反斜杠可能本来就是用户有意写入，程序不能猜测并改写历史文件。
- 不要用全文关键词/片段匹配来定位光标或恢复原文；重复文本会造成错误命中。模式切换继续以块级 raw offset 映射为主。
- 不能为了原文保真把所有网页 HTML 都强行按 `text/plain` 解析，否则会回归微信公众号标题、格式和图片粘贴。

## 关键文件

- `src/renderer/src/components/Editor.jsx`：原始/规范快照、真实用户编辑回写、成功 Markdown 粘贴事务。
- `src/renderer/src/markdown-source-preservation.js`：稳定公共入口与策略编排；公开原文保真入口以及 front matter、列表精确写回和新输入 marker 恢复 helper，调用方不得越过 façade 依赖内部实现。
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

# 映射：重复文本、表格、代码、硬换行、行内公式、行内/块级图片、HTML
npm run test:source-map

# 精确 raw offset：表格、代码、行内公式、硬换行、连续双向切换及切回后立即输入
npm run test:mode-switch-raw-offset-ui

# 仅运行行内公式位置的双向 UI 回归
HORSEMD_RAW_OFFSET_TARGET=inline-math npm run test:mode-switch-raw-offset-ui

# 真实 Electron：10 个快照、真实写盘、列表新增、双向切换和粘贴
npm run test:issue-77-ui

# 真实 Electron：空文档起笔、文档末尾与中间 Enter 新段落、保存重开
npm run test:paragraph-source-ui

# 真实 Electron：逐字手打 -/*/+ 列表、连续空段落、往返切换和真实写盘
npm run test:new-source-fidelity-ui

# 真实 Electron：已有正文后逐字 Enter、-、空格和首个列表文字；检查 - 标记、源码切换、保存和完整重开
npm run test:rich-list-source-ui

# 真实 Electron：八次“富文本逐字编辑 → 立即保存 → 源码往返”并完整重开；正文不得回退，图片链接各一份
npm run test:issues-105-106-ui

# 真实 Electron：默认 H1 + 正文的新文档，逐字创建 1. 有序列表和 Tab 嵌套项；未保存连续切源码
npm run test:new-document-list-source-ui

# 真实 Electron：普通单换行视觉显示、显式硬换行和源码/磁盘字节保真
npm run test:soft-break-ui

# 真实 Electron：重复表格行列编辑、富文本保存、完全退出并重开文件
npm run test:issue-86-ui

# 真实 Electron：异构 Markdown 多点编辑后全文与磁盘逐字节比较
npm run test:source-fidelity-ui

# 真实 Electron：清空段落、空段落内输入再删光、多次切换源码后不得出现 <br />
npm run test:empty-paragraph-source-ui

# 纯函数：35 组异构富文本增量探针（转义/列表/引用/图片/合并/空段落/CRLF/BOM）
npm run test:source-fidelity-probes

# 真实 Electron：120k+ BOM/CRLF 分块文档首次富文本和源码编辑
npm run test:large-source-fidelity-ui

# 标准逐键输入、方向键退出、新段落首个内容为行内代码；发布前连续运行 10 次
npm run test:inline-code-ui

# 已安装 macOS 包也必须至少跑一次
HORSEMD_APP_PATH=/Applications/HorseMD.app/Contents/MacOS/HorseMD npm run test:issue-77-ui
```

发布前使用不同 CDP 端口连续运行 `test:issue-77-ui` 和 `test:paragraph-source-ui` 10 次，并运行 `test:new-source-fidelity-ui`、`test:source-fidelity-ui` 与 `test:large-source-fidelity-ui`。段落测试必须同时覆盖快速输入的单事务块插入、停顿输入的 `<br />` 两阶段事务、连续回车、文档末尾和后续块之前的中间插入；列表测试必须逐字输入 `-`、`*`、`+`，再执行多次富文本/源码往返、保存和磁盘比较。人工验证另测微信公众号段落、标题、加粗、图片和表格。

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
