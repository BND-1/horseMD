# Transaction Journal：Table Column Alignment Family

> 状态：HorseMD `0.13.144` 已迁移并通过生产门禁。<br>
> Family：`table-column-alignment`<br>
> Publication boundaries：`transaction-table-column-alignment-markdown-updated`、`transaction-table-column-alignment-forced-flush`

## 1. 范围

本 family 只认领一个已有 GFM simple-grid table 中的整列对齐变化：

- oldDoc 与 expectedDoc 只有一个顶层 `table` subtree 变化；
- previous/next table 的 row/column 数、table attrs 与 row attrs 不变；
- 只有一个 column ordinal 的 cell attrs 发生变化；
- 目标列所有 rows 的 cell content、cell type 与 alignment 之外的 attrs 不变；
- 目标列所有 rows 的旧 alignment 相同，新 alignment 也相同，且二者不同；
- journal 只有一个 transaction entry；
- entry 对 header 和每条 body row 各含一个真实 `ReplaceAroundStep(structure=true)`；
- 每个 Step 在自己的递进 `stepDoc` 上精确替换同一 column ordinal 的 cell wrapper attrs，gap 原样保留 cell content；
- source-map 能把作者 header row 的每个 cell 唯一映射到同一物理行，紧随其后的 delimiter row 合法且逐列匹配 previous PM alignment。

它不认领：

- 单个 cell alignment 变化；
- 一次选择多列；
- alignment 与正文、marks、atom、row/column topology 或其他 attrs 同时变化；
- 多个 transaction 依次改变同一列；
- colspan、rowspan、colwidth 或非矩形 topology；
- 空/多 paragraph、marks、inline atom 等非简单 cell；
- header/body 转换、表格创建/删除或邻块变化；
- source/canonical/doc stale、非法 delimiter、raw baseline 不匹配或 semantic/list-slot 不等价。

## 2. 真实 UI 与 Transaction 形状

Milkdown 表格列手柄的可见 button group 顺序为：

```text
left
center
right
delete
```

点击 left/center/right 时，组件先建立整列 `CellSelection`，再执行：

```text
setCellAttr('alignment', direction)
```

对一个包含 header 和 N 条 body rows 的 table，真实 transaction 在同一个 entry 中生成 N+1 个 `ReplaceAroundStep`：

```text
row 0 header wrapper attrs
row 1 body wrapper attrs
row 2 body wrapper attrs
...
row N body wrapper attrs
```

每个 Step 的核心形状：

```text
structure = true
from/to = 完整 cell node range
 gapFrom/gapTo = cell content range
slice = 一个无 child 的同类型 cell wrapper
insert = 1
```

`slice.attrs` 是目标 alignment 后的完整 cell attrs；gap 中原有 paragraph/content 不进入 slice，而由 ReplaceAroundStep 原样保留。

## 3. Stable Column 所有权

owner 对每个 column ordinal 做 old/new table 对齐，只允许一个 candidate：

```text
same row count
same column count
same table/row attrs
same non-target cells
same target cell content/type/non-alignment attrs
uniform previous alignment
uniform next alignment
previous != next
```

重复 header/body 文本不会造成歧义；所有权由：

```text
column ordinal
+ row-by-row changed cell path
+ staged ReplaceAroundStep boundaries
```

共同锁定，而不是搜索 canonical 中的冒号。

single-cell selection 只改变一行，multi-column selection改变多个 ordinals，二者都因唯一完整列 candidate 数不是 1 而 fail closed。

## 4. 逐 Step / stepDoc 合同

journal 只允许一个 entry，Step 数必须等于 table row 数。owner 按 rowIndex 维护 staged table：

```text
processed rows   = next table 对应 rows
unprocessed rows = previous table 对应 rows
```

对第 i 个 Step 必须同时证明：

1. `entry.stepDocs[i]` 等于前一步应用结果；
2. staged table 精确符合 processed/unprocessed 分界；
3. Step 是 `ReplaceAroundStep` 且 `structure === true`；
4. `from/to` 精确等于 `[tableIndex,i,columnIndex]` 的完整 cell node range；
5. `gapFrom/gapTo` 精确等于该 cell content range；
6. slice 恰有一个与 expected cell 同类型、同 attrs、无 child 的 wrapper；
7. Step apply 后只有该 cell path变化；
8. after cell 逐节点等于 next table 对应 cell；
9. 完整 Step 链最终等于 entry.afterDoc、journal expectedDoc 与 callback expectedDoc。

alignment+正文混改会在列分类阶段失败；多 transaction 则在 entry-count 阶段失败。owner 不尝试拆分或合并这些复合操作。

## 5. Alignment Attr 兼容与严格性

生产 Milkdown schema 使用：

```text
attrs.alignment
```

历史兼容 schema 可能使用：

```text
attrs.align
```

owner 统一读取两者：

- 未显式设置时按 GFM/Milkdown 默认 `left`；
- 只允许 `left`、`center`、`right`；
- 两个属性同时存在且值不同：fail closed；
- alignment 之外的 attrs 必须 old/new 完全相同。

cell 的 colspan/rowspan 必须为 1，colwidth 必须为 null。复杂 span/topology 不属于本 family。

## 6. Delimiter-Only Raw Patch

owner 不重写 header/body rows，也不序列化整张表。

首先用 previous PM table 与 `pmPosToMarkdownOffset()`：

1. 映射 header 每个 cell paragraph 的 source offset；
2. 要求全部 offsets 落在同一 authored 物理 header line；
3. 按 pipe 解析 header line，验证每个 PM occurrence 落在对应 cell segment；
4. 取 header EOL 后紧邻的物理 delimiter row；
5. 要求 delimiter row 的 cell 数等于 PM column count；
6. 逐列解析 `leading + colon/dashes + trailing`；
7. 每列 delimiter alignment 必须等于 previous PM header cell alignment。

目标 delimiter cell 的输出只改变冒号：

```text
left   → :-----
center → :---:
right  → -----:
```

原 dash 数、leading/trailing whitespace 和整行其他 bytes 保持不变。例如：

```md
| :----- | :---: | -------: | :-------- |
```

第三列 right→center 后：

```md
| :----- | :---: | :-------: | :-------- |
```

header、body rows、其它 delimiter cells、BOM、LF/CRLF/lone-CR、表格前后空行和邻段逐字保持。

next canonical 只参与 callback document equivalence 与最终 semantic validation，不用于判断目标列或输出冒号。

## 7. Production Registry

`Editor.jsx` 在既有 structural registry 中增加：

```text
table-column-alignment
```

它与 table cell/row/column insert/delete、list、code、blockquote owners 共用：

- 唯一 revision-bound `SourceSyncTransactionJournal`；
- callback document equivalence；
- strict semantic/list-slot gate；
- `SourceSyncCoordinator.publishOwned()`；
- 成功或 stale 才清 journal。

自然 settle 通过：

```text
transaction-table-column-alignment-markdown-updated
```

点击对齐后立即切源码通过：

```text
transaction-table-column-alignment-forced-flush
```

没有 alignment 专用 refs、canonical 冒号 shape owner、整表重写或 reason allowlist。

## 8. 永久回归

纯合同：

```bash
npm run test:table-column-alignment-transaction-owner
```

覆盖：

- 真实整列 CellSelection + `setCellAttr()`；
- 每行一个 ReplaceAroundStep 与递进 stepDoc；
- duplicate `Value` / `same` columns；
- right→center、center→left、left→right；
- BOM + CRLF 与作者自定义 delimiter dash 数/spacing；
- single-cell、multi-column、alignment+text、multi-transaction；
- marks、span、source baseline mismatch、malformed delimiter；
- semantic false/throw、callback mismatch、stale revision；
- constructor contract。

真实 Electron：

```bash
npm run test:table-column-alignment-transaction-ui
```

三个场景使用真实列手柄按钮：

```text
right → center，settled markdownUpdated
right → left，immediate source-mode forced flush
center → right，settled markdownUpdated
```

均验证：

- DOM header/body 目标列 alignment 全部正确；
- table path `[1]` 与目标 column ordinal；
- 一个 journal entry、5 个 ReplaceAroundStep；
- source 只改目标 delimiter cell；
- 作者 header/body spacing、其它列、BOM/CRLF 与邻段保持；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- Coordinator owner 为 `transaction`；
- 零 semantic diff、零 warning toast；
- source、save、disk、fresh-profile cold reopen 精确。

最终相邻矩阵还包括：

- 全部 table cell/row/column insert/delete/alignment pure + UI；
- `test:issue-86-ui`；
- source transaction、journal、Coordinator；
- table empty-cell normalization 与完整 Markdown preservation；
- source-fidelity probes 39/39 与异构 source-fidelity UI；
- RS-68 5ms / 18ms / 70ms；
- desktop production build 与 mobile build。

## 9. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. table 复杂 span/topology；
2. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 继续使用 transaction journal、逐 Step stepDoc 证明、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
