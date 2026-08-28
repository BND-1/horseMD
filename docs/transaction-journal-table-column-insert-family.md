# Transaction Journal：Table Column Insert Family

> 状态：HorseMD `0.13.143` 已迁移并通过生产门禁。<br>
> Family：`table-column-insert`<br>
> Publication boundaries：`transaction-table-column-insert-markdown-updated`、`transaction-table-column-insert-forced-flush`

## 1. 范围

本 family 只认领一个已有 GFM simple-grid table 中新增一列：

- oldDoc 与 expectedDoc 只有一个顶层 `table` subtree 变化；
- previous/next table 的 row 数、table attrs 与 row attrs 不变；
- next table 每一行恰比 previous table 多一个 cell；
- 所有 rows 的剩余 cell stream 共同确定唯一 inserted column ordinal；
- journal 只有一个 transaction entry；
- entry 对 header 和每个 body row 各含一个 `from === to` 的 closed `ReplaceStep`；
- 每个 Step 都在自己的递进 `stepDoc` 上精确插入同一 column ordinal 的空 cell node；
- source-map 能把 previous header/body cell 唯一映射到作者物理表格行；
- 作者 delimiter/alignment row 能解析为与 previous table 相同列数的 GFM delimiter cells。

它不认领：

- table column delete；该 family 已由独立 owner 处理；
- alignment-only command、header/body 转换或其它 attrs 变化；
- colspan、rowspan、colwidth 或非矩形 topology；
- inserted cell 已含真实文本、marks、inline atom 或多个 paragraphs；
- 只在部分 rows 插入、一次插入多列或多个 transaction；
- 新增后在同一本 journal 立即输入正文；
- 邻块、其它 table、其它 rows/cells 同时变化；
- source/canonical/doc stale、raw mismatch、非法 delimiter 或 semantic/list-slot 不等价。

## 2. 真实 `addColumnBefore` / `addColumnAfter` Step 链

对一个包含 header 和 N 条 body rows 的简单表格，真实 ProseMirror column add command 会在**同一个 transaction** 中生成 N+1 个 `ReplaceStep`：

```text
row 0 header cell insertion
row 1 body cell insertion
row 2 body cell insertion
...
row N body cell insertion
```

每个 Step 满足：

```text
from === to
slice.openStart = 0
slice.openEnd = 0
slice contains exactly one cell node
structure = false（当前真实实现）
```

后续 Step 坐标基于前面 Step 已应用后的 `stepDoc`。owner 逐 Step 维护 staged table：

```text
已处理 rows = next table 对应 rows
未处理 rows = previous table 对应 rows
```

对 rowIndex=i 的 Step，必须同时证明：

1. `entry.stepDocs[i]` 等于前一步结果；
2. 当前 table 的前 i 行已经插入目标列，其余 rows 尚未变化；
3. insertion point 精确对应 `[tableIndex, i, insertedColumnIndex]` 的 cell boundary；
4. slice cell 类型与该 row 的 expected inserted cell 类型相同；
5. slice cell attrs、paragraph 与 expected inserted cell逐节点相等；
6. Step apply 后恰好把第 i 行推进为 next row；
7. 最后一步结果精确等于 entry.afterDoc、journal.expectedDoc 与 callback expectedDoc。

不能只看最终 table shape，也不能把多 Step transaction 拆成多次 source publication。

## 3. 唯一 Column Ordinal

owner 对每个可能的 inserted column ordinal 做 old/new rows 对齐：

```text
previous row = prefix cells + suffix cells
next row     = prefix cells + inserted cell + suffix cells
```

只有当**全部 rows** 在同一个 ordinal 上都满足其余 cells 逐节点相等，candidate 才成立。最终必须恰有一个 candidate。

重复列文本不会造成歧义。例如相邻两个 header 都为 `Value`、所有 body 对应列都为 `same`，仍由：

```text
column ordinal
+ 每一行 insertion boundary
+ 多 Step staged paths
```

锁定新增列的位置，而不是搜索 canonical 中的空 cell 或比较 pipe 数量。

## 4. Simple Grid 与空 Cell 安全边界

previous/next table 必须是简单矩形 grid：

- 至少 header + 一条 body row；
- 每行列数一致；
- header cell 为 `table_header`，body cell 为 `table_cell`；
- 兼容生产 `table_header_row` 与标准 ProseMirror header-row 形状；
- colspan/rowspan 必须为 1；
- colwidth 必须为 null；
- 每个 cell 恰有一个 paragraph。

inserted cells 必须在所有 rows 上 attrs 一致，并且 paragraph 只表示编辑器内部空值：

```text
paragraph with no content
或 paragraph whose sole content is standalone hard_break / hardbreak placeholder
```

真实正文、marks、atom、多 paragraph、span 或不同 row 使用不同 attrs 都会拒绝。

## 5. Alignment 由 Transaction Attrs 决定

真实 Milkdown schema 使用：

```text
attrs.alignment
```

历史纯测试和部分兼容 schema 使用：

```text
attrs.align
```

owner 统一读取两者：

- 两者都未设置：alignment 为 null；
- 只有一者设置：必须为 `left`、`center` 或 `right`；
- 两者同时存在且不同：fail closed；
- 其它值：fail closed。

新增列 delimiter 只由 transaction-owned inserted cell attrs生成：

```text
null   → -----
left   → :----
center → :---:
right  → ----:
```

不从 next canonical 的冒号形状反推 alignment。

真实 UI 首轮正是通过 semantic diff 发现：生产 cell 为 `attrs.alignment="left"`，旧测试 schema 只读取 `attrs.align`，导致正确空列被错误写成无对齐 delimiter。修复后纯测试也改用真实属性名，并保留兼容读取与冲突拒绝。

## 6. Shared Empty Placeholder Semantic Normalization

GFM 空 cell 重新解析后通常是无 content paragraph，而 live Milkdown 空 cell 可能保存 standalone hard-break placeholder。不同 schema 使用过两种节点名：

```text
hardbreak
hard_break
```

0.13.143 在共享 `source-transaction-sync.js` semantic normalization 中统一处理：

- paragraph 的全部 content 都是 standalone `hardbreak` / `hard_break` 时，视为无 authored content；
- hard break 前后存在真实 text 时，结构仍严格比较；
- 规则不绑定 table-column-insert reason，也不绕过 owner/Coordinator validation。

永久合同覆盖两种节点名和文本包围的负例。

## 7. 物理表格行与 Bounded Insertion

owner 分别在 authored source 与 previous canonical 上解析 previous table。

对 header 和每条 body row：

1. 为每个 existing cell 找到 direct paragraph path；
2. 用 `pmPosToMarkdownOffset()` 映射 paragraph start/end；
3. raw substring 必须逐字等于 PM plain text；
4. 同一 row 的全部 cells 必须落在同一物理行；
5. 物理行必须能按 pipe 分成 previous column count 个 cells；
6. 每个 mapped span 必须落在对应 pipe cell segment 内。

对普通 header/body 行，插入空 cell 时复用相邻作者 cell 的物理宽度与 spacing，只把正文区域清空。例如：

```md
| Key    | Value | Value    | Note      |
```

在第二个 `Value` 后新增列得到：

```md
| Key    | Value | Value    |     | Note      |
```

body rows 各自保留自己的 spacing，不按 header 列宽重排。

对 delimiter row，根据 inserted alignment 生成合法 cell，并在同一 ordinal 插入：

```md
| :----- | :---: | -------: | :-------- |
→
| :----- | :---: | -------: | :------- | :-------- |
```

所有 edits 按 raw offset 从后向前应用，BOM、LF/CRLF/lone-CR、其它 rows/columns、table 前后空行与邻段保持逐字不变。

## 8. Production Registry 与生命周期

`Editor.jsx` 只在既有 structural registry 增加：

```text
table-column-insert
```

owner 与 table cell/row/column-delete、list、code、blockquote families 共用：

- 唯一 revision-bound `SourceSyncTransactionJournal`；
- callback document equivalence；
- strict semantic/list-slot validator；
- `SourceSyncCoordinator` 原子 publication；
- 成功或 stale 才清 journal。

真实 Milkdown 操作链：

```text
hover 目标 header cell
→ y-line add button
→ addColumnAfter
```

自然 settle 通过：

```text
transaction-table-column-insert-markdown-updated
```

点击后立即切源码通过：

```text
transaction-table-column-insert-forced-flush
```

没有 column 专用 source ref、canonical 整表覆盖、空 cell reason allowlist 或按 `|` 数量猜 family。

## 9. 永久回归

纯合同：

```bash
npm run test:table-column-insert-transaction-owner
```

覆盖：

- 真实 add-column multi-Step/stepDoc 链；
- duplicate `Value` / `same` columns，在第二个 occurrence 后新增；
- header、delimiter 与全部 body row bounded insertions；
- BOM + CRLF、自定义每行 spacing、LF/lone-CR；
- `alignment` 真实属性、`align` 兼容属性与冲突/非法值；
- first/middle/end column ordinal；
- 部分 row 插入、多个 transaction、插入后继续输入；
- marked、non-empty、multi-paragraph、span；
- source mismatch、invalid delimiter、mapper throw、semantic false；
- callback mismatch、stale revision、constructor contract。

真实 Electron：

```bash
npm run test:table-column-insert-transaction-ui
```

两个场景都使用真实 y-line add button：

```text
settled markdownUpdated
immediate source-mode forced flush
```

均验证：

- DOM 所有 rows 只多一个目标空 cell；
- proof table path `[1]`、inserted column ordinal 3；
- 一个 journal entry、5 个 ReplaceStep；
- inserted alignment 为 `left`；
- 作者 header/body 每行独立 spacing 与 delimiter `:-------` 精确；
- 重复列、其它 rows/columns 与邻段保持；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- Coordinator owner 为 `transaction`；
- 零 semantic diff、零 warning toast；
- source、save、disk、fresh-profile cold reopen 精确。

最终相邻矩阵还包括：

- 全部 table cell/row/column delete/insert pure + UI；
- `test:issue-86-ui` 的重复行列编辑、保存与冷重开；
- source transaction、journal、Coordinator；
- 完整 Markdown preservation 与 table empty-cell normalization；
- source-fidelity probes 39/39 与异构 source-fidelity UI；
- RS-68 5ms / 18ms / 70ms；
- desktop production build 与 mobile build。

## 10. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. table 复杂 span/topology；
2. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 继续使用 transaction journal、逐 Step stepDoc 证明、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
