# Transaction Journal：Table Column Delete Family

> 状态：HorseMD `0.13.142` 已迁移并通过生产门禁。
> Family：`table-column-delete`
> Publication boundaries：`transaction-table-column-delete-markdown-updated`、`transaction-table-column-delete-forced-flush`

## 1. 范围

本 family 只认领一个已有 GFM simple-grid table 中删除一列：

- oldDoc 与 expectedDoc 只有一个顶层 `table` subtree 变化；
- previous/next table 的 row 数、table attrs 与 row attrs 不变；
- previous table 每一行恰比 next table 多一个 cell；
- 所有 rows 的剩余 cell stream 共同确定唯一 deleted column ordinal；
- journal 只有一个 transaction entry；
- entry 对 header 和每个 body row 各含一个 empty closed-slice `ReplaceStep`；
- 每个 Step 都在自己的递进 `stepDoc` 上精确删除同一 column ordinal 的完整 cell node；
- source-map 能把 header/body 每个 plain cell text 唯一映射到作者物理表格行；
- 作者 delimiter/alignment row 能解析为同列数的 GFM delimiter cells。

它不认领：

- table column insert 已由独立 `table-column-insert` owner 处理；
- alignment command 已由独立 `table-column-alignment` owner 处理；本 owner 仍不认领 header/body 转换或其它 attrs 变化；
- colspan、rowspan、colwidth 或非矩形 topology；
- 删除唯一一列；底层 `deleteColumn` 在该场景必须直接返回 `false` 且不 dispatch；
- mark、inline atom、空 cell 或多个 paragraphs；
- 只删除部分 rows 的 cell、一次删除多列或多个 transaction；
- 删除后在同一 journal 继续输入正文；
- 邻块、其它 table、其它 rows/cells 同时变化；
- source/canonical/doc stale、raw mismatch、非法 delimiter 或 semantic/list-slot 不等价。

## 2. 真实 `deleteColumn` Step 链

对一个包含 header 和 N 条 body rows 的简单表格，真实 ProseMirror `deleteColumn` 会在**同一个 transaction** 中生成 N+1 个 `ReplaceStep`：

```text
row 0 header cell deletion
row 1 body cell deletion
row 2 body cell deletion
...
row N body cell deletion
```

每个 Step 满足：

```text
slice.size = 0
slice.openStart = 0
slice.openEnd = 0
from..to = target cell complete node range
structure = false（当前真实实现）
```

关键点是后续 Step 的坐标不再基于初始 oldDoc，而基于前面 Step 已经应用后的 `stepDoc`。owner 因此逐 Step 维护 staged table：

```text
已处理 rows = next table 对应 rows
未处理 rows = previous table 对应 rows
```

对 rowIndex=i 的 Step，必须同时证明：

1. `entry.stepDocs[i]` 等于前一步结果；
2. 当前 table 的前 i 行已删除目标列，其余 rows 尚未变化；
3. cell path 精确为 `[tableIndex, i, deletedColumnIndex]`；
4. `from` 等于 cell beforePos；
5. `to` 等于 beforePos + cell.nodeSize；
6. Step apply 后恰好把第 i 行推进为 next row；
7. 最后一步结果精确等于 entry.afterDoc、journal.expectedDoc 与 callback expectedDoc。

不能只看最终 table shape，也不能把多 Step transaction 拆成多次 source publication。

## 3. 唯一 Column Ordinal

owner 对每个可能的 deleted column ordinal 做 old/new rows 对齐：

```text
previous row = prefix cells + deleted cell + suffix cells
next row     = prefix cells + suffix cells
```

只有当**全部 rows** 在同一个 ordinal 上都满足剩余 cells 逐节点相等，candidate 才成立。最终必须恰有一个 candidate。

这解决了重复列文本歧义。例如两个相邻 header 都是 `Value`、每个 body row 对应 cell 都是 `same`，仍由：

```text
column ordinal
+ 每一行 cell path
+ 多 Step exact ranges
```

锁定被删的第二个重复列，而不是通过全文字符串搜索或 canonical diff 猜测。

## 4. Simple Grid 安全边界

previous/next table 都必须是简单矩形 grid：

- 至少 header + 一条 body row；
- 每行列数一致；
- header cell 为 `table_header`，body cell 为 `table_cell`；
- 兼容生产 `table_header_row` 与标准 ProseMirror header-row 形状；
- colspan/rowspan 必须为 1；
- colwidth 必须为 null；
- 每个 cell 恰有一个 paragraph；
- deleted column 的所有 cell 都必须是 non-empty plain text，无 marks/atoms。

如果 span 删除会连带修改相邻 row/cell attrs，staged table proof 会立即失败。多个 paragraphs、空 cell 或 inline code/math/image 也不尝试做 raw pipe 解析。

## 5. Shared Source-Map 表头修复

真实 schema 的表头结构是：

```text
table_header → paragraph → text
```

此前 `editor-source-map.js` 的祖先检测只识别 `table_cell`，导致表头 paragraph 被当作普通 paragraph，重复/ordinal 匹配可能漂移到表格后的正文。

0.13.142 新增统一 `isPmTableCellName()`，识别：

- `table_cell`；
- `table_header`；
- 兼容其它 `table*cell` 命名。

`pmKind()` 与 `isInsideTableCell()` 共用该判断；永久 source-map 回归使用真实 `table_header` schema，并验证表头 source→PM 与 PM→source 双向坐标。

该修复属于共享映射根因，不在 column owner 内另写表头字符串搜索。

## 6. 物理表格行证明

owner 分别在 authored source 与 previous canonical 上解析 previous table。

对 header 和每条 body row：

1. 为每个 cell 找到 direct paragraph path；
2. 用 `pmPosToMarkdownOffset()` 映射 paragraph start/end；
3. raw substring 必须逐字等于 PM plain text；
4. 同一 row 的全部 cells 必须落在同一物理行；
5. 物理行必须能按 pipe 分成 previous column count 个 cells；
6. 每个 mapped span 必须落在对应 pipe cell segment 内。

物理行扫描原生支持：

- LF：`\n`
- CRLF：`\r\n`
- lone-CR：`\r`
- BOM；
- 不同 rows 各自不同的列 spacing。

作者 source 和 previous canonical 都必须独立通过证明；任一侧漂移、跨行或 raw 文本不等即 fail closed。

## 7. Delimiter / Alignment Row

GFM table 的 delimiter row 没有独立 ProseMirror row node，但删除列必须同步删除对应 alignment cell。

owner 从作者 header 物理行的完整 EOL 后定位 delimiter 行，并要求：

```text
column count 与 previous table 相同
每个 cell 匹配 ^:?-{1,}:?$
```

随后对 header、delimiter 和所有 body rows 使用同一个 deleted column ordinal。

删除后 delimiter 剩余 cells 仍必须全部满足 GFM delimiter 语法。非法或已经漂移的 delimiter row 不会被 canonical 结果覆盖，而是直接拒绝接管。

## 8. Bounded Pipe-Segment 删除

每条物理表格行先记录：

- 是否有 leading pipe；
- 是否有 trailing pipe；
- 每个 pipe 的物理 offset；
- 每个 cell segment 的 start/end/raw bytes。

删除规则保持剩余列的作者拼写：

- 删除第一列：删除第一 cell 与其后的 separator；
- 删除中间/最后一列：删除该 cell 之前的 separator 与该 cell bytes；
- trailing pipe、其它 cells 和行尾完全保留。

例如：

```md
| Key    | Value | Value    | Note      |
| :----- | :---: | -------: | :-------- |
```

删除第二个 `Value` 后得到：

```md
| Key    | Value | Note      |
| :----- | :---: | :-------- |
```

body rows 可各自拥有不同 spacing；owner 对每一行独立计算 raw range，不按 header 列宽重排。

所有 edits 按 raw offset 从后向前应用，保证早期编辑不会使后续物理坐标漂移。只删除 pipe segment，不增删整行，因此原 BOM、EOL、邻段和 table 前后空行保持。

## 9. Production Registry 与生命周期

`Editor.jsx` 只在既有 structural registry 增加：

```text
table-column-delete
```

owner 与 table cell/row、list、code、blockquote families 共用：

- 唯一 revision-bound `SourceSyncTransactionJournal`；
- callback document equivalence；
- strict semantic/list-slot validator；
- `SourceSyncCoordinator` 原子 publication；
- 成功或 stale 才清 journal。

真实 Milkdown 操作链：

```text
hover 目标 header cell
→ col-drag-handle
→ click handle
→ 四按钮菜单最后一个 delete button
→ deleteColumn
```

自然 settle 通过：

```text
transaction-table-column-delete-markdown-updated
```

点击删除后立即切源码通过：

```text
transaction-table-column-delete-forced-flush
```

没有 column 专用 source ref、canonical 整表覆盖或 reason allowlist。

## 10. 永久回归

纯合同：

```bash
npm run test:table-column-delete-transaction-owner
```

覆盖：

- 真实 `deleteColumn` multi-Step/stepDoc 链；
- duplicate `Value` / `same` columns，删除第二个 occurrence；
- header、delimiter 与全部 body row bounded edits；
- BOM + CRLF、自定义每行 spacing、lone-CR；
- custom markdown-updated boundary；
- 部分 row 删除、多个 transaction、删除后继续输入；
- marked、empty、multi-paragraph、span；
- sole-column command 不 dispatch；
- source mismatch、invalid delimiter、mapper throw、semantic false；
- callback mismatch、stale revision、constructor contract。

真实 Electron：

```bash
npm run test:table-column-delete-transaction-ui
```

两个场景都使用真实 `col-drag-handle` 与四按钮菜单最后一个 delete button：

```text
settled markdownUpdated
immediate source-mode forced flush
```

均验证：

- DOM 只少目标 duplicate column；
- proof table path `[1]`、deleted column index `2`；
- 五条 row-local ReplaceStep 与 cell paths `[1,0,2]` 至 `[1,4,2]`；
- source layout 含 header、delimiter 与四条 body row 共六处 edits；
- header/delimiter/body result lines 与 CRLF 精确；
- 第一处 duplicate column、其它 columns/rows 与邻段保持；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- Coordinator owner 为 `transaction`；
- 零 warning toast；
- source、save、disk、fresh-profile cold reopen 精确。

最终矩阵还包括：

- 真实 `table_header` source-map 13 组；
- source transaction、journal、Coordinator；
- 完整 Markdown preservation 与 table empty-cell normalization；
- table cell/row delete/row insert pure + UI；
- issue-86 重复行列新增、编辑、保存和冷重开；
- source-fidelity probes 39/39；
- production build。

## 11. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. table 复杂 span/topology；
2. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 继续使用 transaction journal、逐 Step stepDoc 证明、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
