# 事务优先源码同步架构（方案一）

> 状态：2026-08-28，HorseMD `0.13.145`。当前仍是**混合架构迁移状态**，但生产事务生命周期已经收敛：普通用户编辑先进入一个绑定 `SourceSyncCoordinator` revision、source、canonical 与 oldDoc 的 `SourceSyncTransactionJournal`；structural owner registry 中的列表子树、已有代码块正文、已有代码块 info string、已有 blockquote text/split/join/exit、单一 table cell plain text、已有 table body-row insert/delete、simple-grid table column delete/insert/alignment/width，以及普通段落 owner，共享同一份不可变 journal。可证明的列表子树变化、已有 fenced code block 正文/语言变化、稳定 blockquote path 上的 text/split/join/exit、稳定 table cell path 内的纯文字 ReplaceStep、真实 `addRowAfter` / `deleteRow` 的 exact insertion/range Step、`deleteColumn` / `addColumnBefore` / `addColumnAfter` 的逐 row ReplaceStep 链、整列 alignment 与 colwidth 的逐 row ReplaceAroundStep/stepDoc 链，可直接 transaction-owned 发布；其中列宽属于 GFM 不可编码的 PM-only 元数据，成功后 source/canonical 原样不动，只推进 Coordinator expectedDoc。普通段落默认仍走 legacy，显式 shadow/authority 门禁从共享 journal 规划候选。代码块围栏结构与块生命周期、表格 span/merge/split 等 GFM 不可表达 topology、插入空行/空列后同 journal 快速输入、输入规则及其他未迁移 family 继续使用既有 fail-closed owner。
>
> `Editor.jsx` 已删除生产路径上的 `transactionFirstShadowPending`、逐回调 SourceRangeMap checkpoint 和私有 chain rebase。旧 `lib/transaction-first-source-sync.js` 暂时仅保留给历史策略/兼容纯测试，不再拥有生产生命周期。当前不能描述为“全部迁移完成”：完成的是 revision-bound journal、逐 Step 文档/StepMap 证据、focused family owner 与 Coordinator 原子发布；未完成的是把其余结构 family 逐个迁入同一 journal → bounded source patch 管线并删除对应 legacy 分支。
>
> `markdownUpdated` 与 forced flush 现在都先遍历共享 structural owner registry，再由严格 semantic/list-slot integrity gate 和 `SourceSyncCoordinator` 发布。journal 只在成功提交或证明 revision/source/doc 已陈旧时清空，不允许某个 family 私下重启基线。inline-code、frontmatter、Slash code/math、列表转换、paste/whole-document 等已登记入口继续共用 Coordinator snapshot/candidate/proof/validation 合同；generated scratch 与尚未迁移的结构仍保持 legacy fallback。代码块正文 family 的完整合同与 BOM 根因见 [`transaction-journal-code-block-content-family.md`](./transaction-journal-code-block-content-family.md)，语言 info family 见 [`transaction-journal-code-block-info-family.md`](./transaction-journal-code-block-info-family.md)，引用同段纯文字 family 见 [`transaction-journal-blockquote-paragraph-family.md`](./transaction-journal-blockquote-paragraph-family.md)，引用拆分 family 见 [`transaction-journal-blockquote-split-family.md`](./transaction-journal-blockquote-split-family.md)，引用合并 family 见 [`transaction-journal-blockquote-join-family.md`](./transaction-journal-blockquote-join-family.md)，引用退出 family 见 [`transaction-journal-blockquote-exit-family.md`](./transaction-journal-blockquote-exit-family.md)，表格单元格 family 见 [`transaction-journal-table-cell-family.md`](./transaction-journal-table-cell-family.md)，表格行删除 family 见 [`transaction-journal-table-row-delete-family.md`](./transaction-journal-table-row-delete-family.md)，表格行新增 family 见 [`transaction-journal-table-row-insert-family.md`](./transaction-journal-table-row-insert-family.md)，表格列删除 family 见 [`transaction-journal-table-column-delete-family.md`](./transaction-journal-table-column-delete-family.md)，表格列新增 family 见 [`transaction-journal-table-column-insert-family.md`](./transaction-journal-table-column-insert-family.md)，表格列对齐 family 见 [`transaction-journal-table-column-alignment-family.md`](./transaction-journal-table-column-alignment-family.md)，表格列宽 family 见 [`transaction-journal-table-column-width-family.md`](./transaction-journal-table-column-width-family.md)，Coordinator 合同见 [`source-sync-coordinator-phase-a.md`](./source-sync-coordinator-phase-a.md)。

## 1. 目标与不变量

HorseMD 保留 Milkdown/ProseMirror 的现有富文本能力，但逐步把写回模型从：

```text
ProseMirror 文档 → 整篇 Markdown serializer → canonical/source 猜测对账
```

迁移为：

```text
用户 ProseMirror transaction → 有边界的 raw source patch → 作者源码
```

必须同时满足：

1. 用户原始 Markdown 是保存、源码模式和导出的事实源；
2. 未触及字节绝不重排、转义、换 marker 或补空行；
3. 一个 transaction batch 全部成功才提交，任一步不确定则整批回滚；
4. 不支持的结构继续走现有 fail-closed 保真层，不能半接管；
5. 迁移期间保存失败仍保留原文件，并允许另存 recovery copy；
6. 富文本、源码、磁盘和冷重开必须逐字符一致。

## 2. 已落地模块

### `components/editor-source-transactions.js`

- 通过 `prosePluginsCtx` 注册只观察、不修改 ProseMirror 的插件；
- 在其他插件完成 `appendTransaction` 后取得完整 transaction batch；
- 测试可显式启用 `window.__hmSourceTransactionTrace = []`，记录真实 step、old/new doc；
- 生产环境不初始化数组，不记录用户文档内容。

### `lib/source-sync/transaction-journal.js`

- 每个正常用户 dispatch batch 绑定一个不可变 `baseRevision`、source/canonical digest、oldDoc 与最终 expectedDoc；
- 保存完整 transaction batch、逐 Step `stepDoc`、StepMap 和受限 step metadata，后续 family owner 可重建真实事务链而无需从 delayed canonical 反推操作；
- 后续 batch 只有在 revision、source、canonical 与 `expectedDoc → oldDoc` 连续时才可追加；任何 gap、外部发布、容量超限或 stale snapshot 都整本 journal fail closed；
- journal 自身不生成 Markdown，也不决定 family；它只提供统一生命周期和可审计证据。

### `lib/source-sync/plain-paragraph-transaction-owner.js`

- 只认领顶层、无 mark/atom、非空普通段落内的 closed plain-text `ReplaceStep`；
- 对 journal 中每个 Step 使用对应 stepDoc 重新应用并验证完整 oldDoc → finalDoc 链；
- 语法敏感插入、开放 slice、段落 split、列表内编辑、空段结果和陈旧 revision 均拒绝；
- callback 与 forced flush 均通过相同 owner + Coordinator 发布，不再维护独立 shadow checkpoint。

### `lib/source-sync/list-subtree-transaction-owner.js`

- 消费同一 journal，只在 oldDoc → finalDoc 恰有一个顶层列表子树变化且邻块完全不变时认领；
- transaction journal 负责生命周期与 StepMap 证据，owner 只负责拓扑分类、精确 source/canonical 范围和 bounded list mapper；
- callback 与立即切源码 forced flush 使用同一 ownership proof、Coordinator revision guard、保存与冷重开合同。

### `lib/source-sync/code-block-transaction-owner.js`

- 消费同一 journal，只认领已有顶层 `code_block` 内、attrs 不变的 closed plain-text `ReplaceStep` 链；
- 每个 Step 都在其捕获时 stepDoc 上验证同父节点、目标顶层序号、邻块不变和完整 oldDoc → finalDoc 连续性；
- 分别解析作者 source、previous canonical 和 next canonical 的 fenced range，只替换作者围栏内部正文；BOM、CRLF、围栏字符/长度、info string 和邻块保持 byte-stable；
- `editor-source-map.js` 统一把 remark 去除的 BOM offset 恢复为物理 raw 坐标，空代码块不再落到 opening fence 前的换行；
- callback 与立即 forced flush 均通过 structural registry + Coordinator 发布；attrs/fence 变化、跨块编辑和围栏冲突继续 fail closed。完整合同见 [`transaction-journal-code-block-content-family.md`](./transaction-journal-code-block-content-family.md)。

### `lib/source-sync/code-block-info-transaction-owner.js`

- 消费同一 journal，只认领已有顶层 `code_block` 的 `language` attr 变化；正文与其它 attrs 必须不变；
- journal 中每个 Step 必须是命中同一节点位置的 `AttrStep`，attr 恰为 `language`，并在捕获时 stepDoc 上完整重放；
- 通用 fence scanner 暴露 opening fence 与 info string 的物理字节范围；owner 分别验证作者 source、previous canonical 和 next canonical 的语言 token，只替换作者 `infoStart..infoEnd`；
- 作者围栏字符/长度、info 前后 padding、BOM、EOL、正文和邻块保持 byte-stable；metadata、多 token、非法语言、正文混改、其它 attrs、跨块事务和 stale revision 均拒绝；
- callback 与立即 forced flush 分别通过 `transaction-code-block-info-markdown-updated` / `transaction-code-block-info-forced-flush` 进入 structural registry + Coordinator。完整合同见 [`transaction-journal-code-block-info-family.md`](./transaction-journal-code-block-info-family.md)。

### `lib/source-sync/blockquote-paragraph-transaction-owner.js`

- 只认领稳定 ProseMirror `nodePath` 上一个 `blockquote` 中恰好一个直接子 `paragraph` 的非空、无 mark 纯文字变化；引用可位于文档顶层或列表项等稳定容器内，但祖先路径、attrs、兄弟节点、直接子数量、其它段落和邻块必须不变；
- journal 中每个 Step 必须是 closed plain-text `ReplaceStep`，在对应 stepDoc 上仍落在同一引用 path、同一直接子段落，并完整重放到 expectedDoc；
- 严格路径分类后复用 `mapPlainTextTransactionsToSource()`：该 mapper 逐 Step 比较 PM 删除文字与作者 raw textblock、只做 bounded byte patch，并由共享 semantic/list-slot validator 验证候选；
- 作者 quote marker/前导空格、BOM、EOL、其它引用行和邻接结构保持 byte-stable；清空、split/join/退出、marks、heading/list/nested quote、跨段/跨块和 syntax-sensitive insert 均拒绝；
- callback 与立即 forced flush 分别通过 `transaction-blockquote-paragraph-markdown-updated` / `transaction-blockquote-paragraph-forced-flush` 进入 structural registry + Coordinator。完整合同见 [`transaction-journal-blockquote-paragraph-family.md`](./transaction-journal-blockquote-paragraph-family.md)。

### `lib/source-sync/blockquote-split-transaction-owner.js`

- 只认领稳定 `nodePath` 上一个已有 blockquote 的单个非空 plain paragraph 被真实结构性 `ReplaceStep` 从中间拆成两个非空 plain paragraphs；同一 delayed callback 内随后对右段的快速纯文字输入可继续包含在同一本 journal；
- 每个 Step 都在捕获时 stepDoc 上验证目标引用 path、直接子 ordinal、父节点与祖先兄弟不变，完整 oldDoc→expectedDoc 链可重放；同一顶层容器内多个引用同时变化、引用 attrs/marks/其它 child/邻块变化全部拒绝；
- raw patch 由 PM split offset 映射到作者引用正文，只替换一条 authored quote line，并复用其精确 indentation、`>` 后 spacing、BOM 和 EOL 插入左段、quote-only blank line 与右段；不从 next canonical 的 `>` 形状推断 source；
- callback 与立即 forced flush 分别通过 `transaction-blockquote-split-markdown-updated` / `transaction-blockquote-split-forced-flush` 进入 structural registry + Coordinator。完整合同见 [`transaction-journal-blockquote-split-family.md`](./transaction-journal-blockquote-split-family.md)。

### `lib/source-sync/blockquote-join-transaction-owner.js`

- 只认领稳定 `nodePath` 上一个已有 blockquote 中两个相邻、非空、无 mark plain paragraphs 被段首 Backspace 合并；同一 delayed callback 内随后对合并段的快速纯文字输入可继续包含在同一本 journal；
- 真实 join Step 必须是空 closed slice 的 `ReplaceStep`，范围宽度 2，从左段正文末尾跨 paragraph boundary 到右段正文开头；Step apply 后 childCount 恰减 1，结果段正文为左右正文拼接，attrs/其它 quote children/祖先和邻块不变。`structure` 只记录在 proof，不作为所有权条件，因为 Milkdown DOM Backspace 为 false，而 ProseMirror `joinBackward` command 为 true；
- raw patch 映射左右作者正文和它们之间的 quote-only separator，只把整个 raw span替换为最终合并正文；保留左段作者 quote prefix、BOM/EOL、父容器与全部其它字节，并再次执行 semantic validator；
- callback 与立即 forced flush 分别通过 `transaction-blockquote-join-markdown-updated` / `transaction-blockquote-join-forced-flush` 进入 structural registry + Coordinator。完整合同见 [`transaction-journal-blockquote-join-family.md`](./transaction-journal-blockquote-join-family.md)。

### `lib/source-sync/blockquote-exit-transaction-owner.js`

- 只认领稳定 parent/blockquote path 上已有引用末尾的双 Enter exit；第一拍 `ReplaceStep` 新增 trailing empty quote paragraph，第二拍 `ReplaceAroundStep` 将该空段提升为 quote 后同级 paragraph，后续 Step 只能在退出段内追加 closed plain text；
- pending 第一拍由同一 owner 以 source 不变的 `trailing-empty-blockquote-paragraph-created` proof 提交 canonical baseline；最终 owner同时支持 coalesced journal（split + lift + text）和 staged journal（lift + text），避免第一拍落回 legacy 后污染第二拍 baseline；
- parent 类型只允许 `doc` 或 `list_item`，引用必须是 parent 的直接 child，退出段必须插入其后；Step 在捕获时 stepDoc 上完整重放，parent attrs、quote prefix children、祖先 path、siblings 和邻块必须不变；空退出、marks、nested quote parent、邻块混改和多目标均拒绝；
- raw patch 映射作者最后一条 quote paragraph，仅在其物理行后插入 block gap + 退出段：顶层 prefix 为空，list item 内 prefix 等于 quote indentation；不写 transient quote-only line，保留作者 `>` spacing、BOM/EOL、列表 marker 和其余字节；
- callback 与立即 forced flush 分别通过 `transaction-blockquote-exit-markdown-updated` / `transaction-blockquote-exit-forced-flush` 进入 structural registry + Coordinator。完整合同见 [`transaction-journal-blockquote-exit-family.md`](./transaction-journal-blockquote-exit-family.md)。

### `lib/source-sync/table-cell-transaction-owner.js`

- 只认领一个稳定 `table_cell`/兼容 header cell path 内、唯一直接 non-empty plain paragraph 的纯文字 ReplaceStep journal；table/row/cell/paragraph attrs、child counts、其它 rows/cells 和 path 外祖先/邻块必须保持；
- 每个 Step 必须在同一 cell paragraph 内，closed plain-text slice、非结构、`stepDoc` 可重放，应用后只有该 cell path变化；marks/atoms、空结果、跨 cell、多目标、row/column/alignment/topology变化均拒绝；
- raw patch 复用 `mapPlainTextTransactionsToSource()` 与 GFM source-map，重复 cell text 由 PM path/occurrence 区分，只改目标 cell text bytes；作者 pipe/spacing/alignment row、BOM/EOL、其它 cells和邻段保持；`|` 等语法敏感输入继续由 mapper fail closed；
- callback/forced flush 通过 `transaction-table-cell-markdown-updated` / `transaction-table-cell-forced-flush` 进入 structural registry + Coordinator。完整合同见 [`transaction-journal-table-cell-family.md`](./transaction-journal-table-cell-family.md)。

### `lib/source-sync/table-row-delete-transaction-owner.js`

- 只认领一个顶层 table 的单 body-row 删除：previous table 恰多一行，唯一 deleted ordinal 由 old/new row stream 与真实 empty `ReplaceStep` 的完整 row node range共同证明；header、最后 body row、多行/多 transaction 和邻块混改均拒绝；
- 只支持无 span 的简单 GFM grid；生产 `table_header_row + table_header` 与标准 header schema均可识别，body 严格为 `table_row + table_cell`，每个 cell 只有一个 non-empty plain paragraph；
- 对被删行每个 cell 分别映射 PM→source/previous-canonical，要求原文逐字相等且全部位于同一物理表格行；raw patch 只删除该行及其 LF/CRLF/lone-CR EOL，重复正文行由 ordinal + Step range区分；
- 生产真实行控件的自然 dirty-reconcile 与立即切源码目前都通过 `transaction-table-row-delete-forced-flush` 发布；`transaction-table-row-delete-markdown-updated` 由纯合同单独验证。完整合同见 [`transaction-journal-table-row-delete-family.md`](./transaction-journal-table-row-delete-family.md)。

### `lib/source-sync/table-row-insert-transaction-owner.js`

- 只认领一个顶层 table 的单空 body-row 插入：next table 恰多一行，唯一 inserted ordinal 由 old/new row stream、真实 `from === to` ReplaceStep 边界、closed slice 单 row 与 expected inserted row 等价共同证明；
- inserted row 必须是等列数的空简单 row；同一 transaction 或后续 transaction 已向新行输入、非空 slice、header 前插入、span/marks/空或多 paragraph template、邻块混改均拒绝；
- raw patch 逐 cell 映射相邻非空作者 body row，将正文 spans 从该物理行删除以生成作者风格空行模板；header 后首行在原首 body row 前插入，其余在前一 row 后插入，支持 BOM、LF/CRLF/lone-CR 与 EOF 无尾换行；
- 自然 settle 通过 `transaction-table-row-insert-markdown-updated` 发布，立即切源码通过 `transaction-table-row-insert-forced-flush` 发布。完整合同见 [`transaction-journal-table-row-insert-family.md`](./transaction-journal-table-row-insert-family.md)。

### `lib/source-sync/table-column-delete-transaction-owner.js`

- 只认领一个 simple-grid table 的单列删除：row 数与 attrs 不变，previous table 每行恰比 next table 多一个 cell，所有 rows 的剩余 cell stream 必须共同确定唯一 deleted column ordinal；
- 真实 `deleteColumn` journal 必须只有一个 entry，并按 header + body row 数量包含多个 empty closed-slice `ReplaceStep`；每个 Step 在自己的递进 `stepDoc` 上精确覆盖 `[tableIndex,rowIndex,deletedColumnIndex]` 的完整 cell node，已处理 rows 必须等于 next table、未处理 rows 必须等于 previous table；
- 只支持等列数、无 colspan/rowspan/colwidth、每 cell 单 non-empty plain paragraph 的矩形 grid；删除唯一一列时命令不 dispatch，marks、空/多 paragraph、span、部分 rows、后续输入、邻块混改均拒绝；
- raw patch 对 source/previous-canonical 的 header 与全部 body cells 做 PM 映射，再在作者 header、delimiter/alignment row 与所有 body rows 中删除同一 pipe segment；重复列由 ordinal + 多 cell paths 区分，BOM、LF/CRLF/lone-CR、每行 spacing、其它列/行和邻段保持；
- 本轮共享 source-map 同时把真实 `table_header → paragraph` 归类为 `tableCell`，防止表头坐标漂移。自然 settle 经 `transaction-table-column-delete-markdown-updated`，立即切源码经 `transaction-table-column-delete-forced-flush`。完整合同见 [`transaction-journal-table-column-delete-family.md`](./transaction-journal-table-column-delete-family.md)。

### `lib/source-sync/table-column-insert-transaction-owner.js`

- 只认领 simple-grid table 的单空列插入：row 数与 attrs 不变，next table 每行恰比 previous table 多一个 cell，全部 rows 的剩余 cell stream 必须共同确定唯一 inserted column ordinal；
- 真实 `addColumnBefore` / `addColumnAfter` journal 必须只有一个 entry，并按 header + body row 数量包含多个 `from === to` closed-slice `ReplaceStep`；每个 Step 在自己的递进 `stepDoc` 上精确插入 `[tableIndex,rowIndex,insertedColumnIndex]` 的空 cell，已处理 rows 等于 next table、未处理 rows 等于 previous table；
- inserted cells 必须类型/attrs一致、唯一 paragraph 且只含 standalone `hard_break` / `hardbreak` 空占位；非空、marks、span、部分 rows、后续输入、邻块混改均拒绝；alignment 从 transaction attrs 的真实 `alignment` 或兼容 `align` 唯一解析，冲突/非法值 fail closed；
- raw patch 对 source/previous-canonical 的 header 与全部 body cells 做 PM 映射，并在作者 header、delimiter/alignment row 与所有 body rows 中插入同一 pipe ordinal；普通行复用相邻作者 cell spacing，delimiter 由 inserted alignment 生成，BOM、LF/CRLF/lone-CR、其它列/行和邻段保持；
- 共享 semantic normalization 仅把整段 standalone `hard_break` / `hardbreak` 视为无作者内容，文本包围的 hard break 仍严格。自然 settle 经 `transaction-table-column-insert-markdown-updated`，立即切源码经 `transaction-table-column-insert-forced-flush`。完整合同见 [`transaction-journal-table-column-insert-family.md`](./transaction-journal-table-column-insert-family.md)。

### `lib/source-sync/table-column-alignment-transaction-owner.js`

- 只认领 simple-grid table 中一个稳定 column ordinal 的统一 alignment 变化：row/column 数、table/row attrs、cell content 与 alignment 之外的 attrs、其它 columns 和邻块必须不变；所有 rows 的旧 alignment 与新 alignment 分别唯一且不同；
- 真实整列 `CellSelection + setCellAttr('alignment', direction)` journal 必须只有一个 entry、Step 数等于 row 数，并按 header→body 形成逐 row `ReplaceAroundStep(structure=true)`；每个 Step 在递进 `stepDoc` 上精确替换目标 cell wrapper，gap 与原 cell content 完全相等，已处理 rows 等于 next table、未处理 rows 等于 previous table；
- `alignment` 与兼容 `align` 只允许 left/center/right，双属性冲突拒绝；single-cell、multi-column、alignment+text、multi-transaction、marks/atoms、多 paragraph、span/colwidth 和其它 attrs 混改均 fail closed；
- raw patch 用 header cell source-map 锁定 authored header line，要求下一物理行是与 previous PM alignment 全列一致的合法 delimiter row，只替换目标 delimiter cell 的冒号并保留 dash 数、cell padding、其它列、BOM/EOL、header/body rows 和邻段；next delimiter 不从 canonical 反推；
- 自然 settle 经 `transaction-table-column-alignment-markdown-updated`，立即切源码经 `transaction-table-column-alignment-forced-flush`。完整合同见 [`transaction-journal-table-column-alignment-family.md`](./transaction-journal-table-column-alignment-family.md)。

### `lib/source-sync/table-column-width-transaction-owner.js`

- 只认领 simple-grid table 中一个稳定 column ordinal 的统一 `colwidth` 变化：row/column 数、table/row attrs、cell content/type 与 colwidth 之外 attrs、其它 columns 和邻块必须不变；全部 rows 的 previous/new width 分别唯一且不同，new width 必须为不少于 25 的整数；
- 真实列宽拖拽 journal 只有一个 entry，Step 数等于 row 数，并按 header→body 形成逐 row `ReplaceAroundStep(structure=true)`；每个 Step 在递进 `stepDoc` 上精确替换目标 cell wrapper，gap 保留全部 content，已处理 rows 等于 next table、未处理 rows 等于 previous table；
- GFM 无列宽语法，因此 owner 不生成 raw patch：`markdown === journal.source` 且 `canonical === journal.canonical`，`notifyChange=false`，只推进 Coordinator 的 PM expectedDoc。完整性 gate 仅在 exact reason/proof 和全部 `[table,row,column]` paths 成立时忽略对应 cell 的 `colwidth`；其它 attrs/content/topology仍严格；
- 鼠标释放前先 `markUserEdit()` 再 dispatch，确保 journal 捕获 PM-only transaction；正常 settle 经 `transaction-table-column-width-markdown-updated`，立即源码切换在 canonical 未变化时仍由 journal-first `flushMarkdown()` 经 `transaction-table-column-width-forced-flush` 发布。完整合同见 [`transaction-journal-table-column-width-family.md`](./transaction-journal-table-column-width-family.md)。

### `lib/source-sync/top-level-subtree.js`（稳定 descendant path）

- 顶层 diff 只用于证明整篇文档恰有一个 top-level subtree 变化；family owner 再用 `classifySingleAnchoredSubtreeChange()` 找到唯一承担全部变化的目标 node path；
- `sourceSyncNodeEntryAtPath()` 提供稳定 PM before/content 位置，`sourceSyncResolvedPositionMatchesPath()` 校验每个 Step 的 resolved path，`onlySourceSyncNodePathChanged()` 保证祖先路径外的任何兄弟都未变化；
- 若同一 changed top-level subtree 内有多个目标类型节点同时变化，候选数不是 1，整个 family fail closed。该机制供后续 table cell/row 和其它嵌套结构 owner 共用，不是 blockquote 专项 Markdown 规则。

### `lib/source-transaction-sync.js`

- 当前接收纯文本 `ReplaceStep` 和受限的尾段 paragraph/heading split；
- 同一 batch 使用局部副本计算，最终 doc 不一致或任一步失败时返回原源码；
- 同块文字修改必须同时证明：
  - PM from/to 位于同一个无 mark、无 atom 的 textblock；
  - raw range 与 PM 被删除文字逐字符相等；
  - 整个 textblock 的 raw span 与 PM 文字逐字符相等；
- 反引号、内联语法、开放 slice、跨块删除、列表结构等均拒绝猜测；
- **字节归一化视图**：入口把 BOM 剥离、全部行尾归一化为单个 `\n`，remark/PM 的坐标只在归一化视图上精确；编辑同步应用到原始副本，出口返回作者原始 BOM/CRLF/lone-CR 拼写。这修复了 remark 剥 BOM 导致全部偏移差 1、以及旧回退把新文字插进 `\r\n` 中间产生 `\r文字\n` 的家族根因；
- **前导空格哨兵**由事务层直接维护（`U+200B + 字面空格`），不再回退到 serializer 的 `&#x20;` 拼写；
- Enter 新尾段使用临时 block hint 记录“新 PM 块 → raw 空槽”；槽坐标指向**完整段落分隔（两对换行）之后**，即使源里已存在部分换行（separator 较短）也不漂移；
- 顶层空段只有带 hint 时才可接管；**嵌套空 textblock（列表项/引用内）一律拒绝**，其容器 marker 在槽之前，写字符会落到 marker 前面，必须交给列表/引用 preservation；
- 一个 textblock 被整个删空（`textblock-emptied`）也拒绝接管：常见后继是反引号围栏或 Enter 退出列表这类结构事务，混合两套基线会污染空块；
- LF、CRLF、lone-CR 分别处理（各自保持原行尾）；mixed EOL 的结构拆分拒绝接管，普通纯文本编辑（不引入换行）允许。

### `components/editor-source-transactions.js`（dispatch 边界）

- 从 `appendTransaction` 观察改为包装 `dispatchTransaction`：一次 `state.applyTransaction()` 返回**完整 root + 递归 append 链**，整批一次交给 mapper；
- batch 前缀不可能在 append 事务之后先提交，违反整批原子性的结构问题被消除；
- 测试 trace 保留完整事务链。

### 列表输入意图与跨块编辑

- 列表输入规则（`- `、`1. `）的意图捕获 mapper 建立的空槽（`sourceSlotRawStart`）；
- 意图回调延迟期间，其他块的编辑可能已被 mapper 接管；意图重建**只在当前源快照（`insertionSource`）上插入/替换自己的列表块**，绝不用捕获时的旧快照整体覆盖——否则会静默丢掉其他块的编辑；
- 槽字节验证：插入前比较捕获时与当前的槽周边字节，漂移则拒绝；
- 槽后已存在 canonical 列表（旧保真层先写入了 `* item`）时，把槽、该列表块与多余空行整体替换为作者 marker 的紧凑块；
- 列表意图未落定时，`canonical === canonicalMarkdownRef` 的快确认分支与 pending-publish 分支都让路，确保意图先完成 marker/空行修复。
- 完整 slot 重建或 marker 恢复任一成功后，意图立即从单值和队列同时消费。旧实现只在完整重建时消费，导致列表正文下一回调再次使用旧 slot，把正确空行边界覆盖掉。
- EOF slot 只属于 `depth === 1` 的顶层末尾 paragraph placeholder。最终顶层列表内部的嵌套/中间 item 即使后面没有其他顶层块，也不能把文档 EOF 当作自己的 raw slot；缺少精确 block hint 时继续 fail closed。

### `Editor.jsx` 迁移控制器

- `markdownUpdated`、强制 flush、保存和源码切换仍保留原有安全网；
- 所有普通用户 transaction batch 先进入唯一的 `pendingSourceSyncTransactionJournal`；list/code/plain focused owner 不得保留自己的生命周期 token，也不得在其他 publication 后静默 rebase；
- structural registry 依次让 list subtree、existing code-block content、code-block info、blockquote paragraph/split/join/exit、table-cell、table-column-width、table-column-alignment、table-column-delete、table-column-insert、table-row-delete 与 table-row-insert owner 处理可证明 family；普通段落 shadow/authority 再从同一 journal 规划。authority 成功时在 legacy diff 前发布，shadow 只比较 transaction 与 legacy candidate；
- `globalThis.__hmTransactionFirstAuthority = true` 仅放行已验收的普通段落 family；默认发布仍由 legacy 处理该 family。历史 broad `__hmTransactionSourcePrimary` 仅供专项测试/迁移实验；
- callback 与 forced flush 共用 journal、ownership proof 和 Coordinator revision guard，成功时原子推进 source/canonical/checkpoint，失败时保持 authored baseline；forced flush 即使 canonical 未变化也先询问 pending journal，以支持列宽等 PM-only metadata family；
- 不支持的结构继续走既有 legacy owner。只有 stale revision/source/doc 或成功 publication 会清空 journal，family rejection 本身不能销毁其它 owner 仍可能消费的证据；
- 通用 normalized→raw mapper 已按“边界”而非“字符”维护插入后的坐标，支持同一本 journal 中先插入、后在另一段替换而不吞掉终止换行。

### 斜杠菜单结构命令的原子边界

- `/code` 的用户意图由“删除临时 query”和“paragraph → code_block”两条命令共同表达，不能作为两个互不相关的 canonical diff 提交；
- `editor-slash-source.js` 在命令前捕获精确 authored 行，命令后只序列化当前 code block，验证完整 fence 后一次替换并推进双基线；
- 该处理器只覆盖已验收的代码类 slash 命令，不代表 transaction-primary 已放行任意代码块编辑；代码内容后续仍走现有保真链；
- 重复 query 无精确 PM 映射、目标不是完整 fence 或行槽无法证明时继续 fail closed。完整事故记录见 `slash-code-source-sync-regression.md`。
- **验收边界更正**：上述处理器只证明 `/code` 创建瞬间的 authored slot。0.13.47
  正式安装包在同一真实文档继续编辑代码、后文和其他结构后仍会再次分叉。接手者必须
  同时跟踪 live doc、authored、canonical、tab mirror、textarea live value 和 disk，
  找出首次失去共同所有权的 transaction；不得将 RS-40 的专项绿色结果扩张为架构完成。

## 3. 为什么没有立即全量打开

第一次尝试默认接管后，完整 `test:paragraph-source-ui` 捕获到一个真实回归：

1. 用户在已有块之前连续创建多个空段落；
2. 结构性 Enter 不属于首批 plain-text 范围；
3. 下一字符到来时，空 PM 块没有可见锚点，旧 offset mapper 把字符映射到前一段或相邻块；
4. 最终多个段落被合并。

该失败证明“单个简单 demo 通过”不能作为生产放行证据。当前实现因此恢复为**发布构建默认关闭、开发可影子、测试显式接管**：保留事务基础设施和可重放证据，但不会让未完成的 mapper 写用户文件或增加发布版逐键开销。

## 4. 当前已证明范围

`npm run test:source-transaction-sync`：

- 普通段落插入；
- 顶层尾段 Enter / 中间 split；
- split 后首字通过 block hint 定位；
- CRLF Enter 不混入 LF；
- BOM+CRLF 文档普通插入与 Enter 拆分后 BOM/CRLF 逐字节保留；
- lone-CR 文档 Enter 保持 `\r` 行尾；mixed EOL 结构拆分原子拒绝、普通编辑允许；
- hint 在“前段补字后空槽输入”双坐标同步不漂移；
- 前导空格哨兵的写入与移除；
- 列表项文字删光只留下作者 `- `，不产生 `*` 或 `<br />`；整个 textblock 删空拒绝接管；
- 跨块、反引号等结构/语法敏感事务原子拒绝。

`npm run test:source-transaction-sync-ui`：

- 后台真实 Electron；
- 每个字通过 `human-input.mjs` 逐字输入；
- 正文、引用、`-` 列表项的增加/删除；
- LF、CRLF、BOM+CRLF 三种磁盘拼写 + undo/redo 立即切源码、保存、冷重开逐字节断言；
- 测试显式打开 transaction primary；
- 断言新路径被使用且 canonical preservation 调用次数为 0；
- 立即切源码、保存、退出、全新 profile 冷重开逐字符一致。

`npm run test:list-intent-cross-block-ui`（primary 专项，非 primary 构建自动 SKIP）：

- 段落 Enter → 快速 `- item` → 列表回调未落定时立即编辑另一个块；
- 延迟列表意图不得覆盖跨块编辑（丢字回归），marker 保持 `-`，空行不重复，保存与冷重开逐字节一致。

`npm run test:family-multicycle-ui`：

- 默认使用脚本内生成的 BOM + mixed-EOL + 重复文本 + 分叉列表 fixture，不依赖个人文件；
- 连续 4 轮编辑/保存和 5 次全新 profile 打开，覆盖已有列表文字修改/删除、续项、退出、手打 sibling list、fence、再次续写和后续正文；第四轮在正文与后续 fence 之间从空段创建有序列表并再次退出，专门验证 middle-slot 原子映射；
- 默认发布路径与显式 transaction-primary 各跑一遍；每轮严格比较源码、磁盘字节和富文本列表/代码块结构；
- 可用 `FILE=/absolute/file.md node scripts/test-family-multicycle-ui.mjs` 对真实文件做同序列验证，原文件只读，操作发生在 `/tmp` 副本。

## 5. 放行顺序

1. 普通已有 textblock：插入、删除、选区替换、undo/redo；
2. Enter、Backspace/Delete 合段、连续空段和新文档 bootstrap；
3. 列表/引用结构：输入规则、续项、退出、缩进、类型转换、任务项；
4. 行内 mark/atom：粗斜体、链接、行内代码、公式、图片；
5. 代码块、表格、Mermaid、LaTeX、HTML、frontmatter、Review；
6. 大文档性能与移动端 IME。

每一类必须同时通过：纯事务测试、真实逐字 UI、立即源码切换、立即保存、磁盘字节、冷重开、家族完整回归。未完成分类继续走旧路径，不能因相邻分类通过而顺带放行。

## 6. 回归命令

```bash
npm run test:source-transaction-sync
npm run test:source-transaction-sync-ui
npm run test:code-block-transaction-owner
npm run test:middle-codeblock-source-ui
npm run test:code-block-info-transaction-owner
npm run test:code-block-info-transaction-ui
npm run test:blockquote-paragraph-transaction-owner
npm run test:blockquote-paragraph-transaction-ui
npm run test:list-intent-cross-block-ui
npm run test:family-multicycle-ui
npm run test:paragraph-source-ui
npm run test:empty-paragraph-source-ui
npm run test:leading-space-entity-ui
npm run test:list-item-literal-marker-source-ui
npm run test:literal-triple-backtick-source-ui
npm run test:code-fence-delete-source-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:diverged-ordinary-save-ui
npm run test:mode-switch-raw-offset-ui
npm run test:mode-switch-caret-settle-ui
npm run test:list-conversion-ui
npm run test:task-list-persistence-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-chaos-ui
npm run test:new-document-list-source-ui
npm run test:nested-number-list-source-ui
npm run test:diverged-list-structure-ui
npm run test:diverged-delete-source-ui
npm run test:diverged-partial-delete-ui
npm run test:full-doc-delete-source-ui
npm run test:empty-blockquote-removal-ui
npm run test:ime-source-fidelity-ui
npm run test:source-fidelity-probes
```

以上矩阵在 `VITE_HM_TRANSACTION_PRIMARY=1 npm run build` 的实验构建上全绿；同一组回归在默认发布构建上也全绿（primary 专项测试自动 SKIP），证明 regions/list preservation 的修复不破坏旧路径。

## 7. 本轮同时修复的旧路径家族 bug

1. **源末尾空行 + 新块粘行**（`preserveChangedLineRegion`）：零宽变化落在 previous 末尾空行/行边界时，可见字符映射把源区域拉进上一行，新列表/引用/标题行被粘到上一行尾（`正文* `）。修复：零宽且位于行边界的变化，源区域就是该空行本身。`已有正文\n\n` + 列表创建现在输出 `已有正文\n\n* \n\n` 而不是 `已有正文* \n\n`。该修复不依赖 primary，默认构建同样生效。
2. **BOM/CRLF 文档普通编辑损坏**：旧回退在 CRLF 上把新文字插进 `\r\n` 中间（`正文\r追加\n`），后续进入“保存已暂停”。primary 归一化视图接管后此类文档不再落到该回退。

## 8. 仍未放行的分类（默认关闭）

- 行内 mark/atom（粗斜体、链接、行内代码、公式、图片）；
- 代码块围栏结构与创建/删除/拆分/合并、引用 split/join/退出与嵌套结构、表格、Mermaid、LaTeX、HTML、frontmatter、Review；
- 列表/引用结构的输入规则与退出、缩进、类型转换（仍走专门 preservation，仅空槽协调已打通）；
- 大文档逐键性能：当前成功事务仍同步执行两次全文 parse 与一次全文 serializer，未做增量索引；默认开启前必须补 100K–400K 文档的逐键延迟门禁。

## 9. 禁止回退的修法

- 不得让 serializer 结果直接覆盖作者源码；
- 不得把空 PM paragraph 序列化为独立 `<br />`；
- 不得用全文字符串查找解决重复文本或空块定位；
- 不得在 transaction batch 失败后保留前半段 source patch；
- 不得为追求“测试绿”而关闭 fail-closed 或 recovery；
- 不得在缺少全家族回归时默认打开新的接管分类。
