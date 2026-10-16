# Transaction Journal：Table Row Insert Family

> 状态：HorseMD `0.13.141` 已迁移并通过生产门禁。
> Family：`table-row-insert`
> Publication boundaries：`transaction-table-row-insert-markdown-updated`、`transaction-table-row-insert-forced-flush`

## 1. 范围

本 family 只认领一个已有 GFM table 中新增一个**空 body row**：

- oldDoc 与 expectedDoc 只有一个顶层 `table` subtree 变化；
- next table 恰比 previous table 多一个 row；
- journal 只有一个 transaction、一个真实 `ReplaceStep`；
- Step 满足 `from === to`，slice 是 closed slice 且只含一个 `table_row`；
- slice row 与 expectedDoc 中唯一新增 row 完全相等；
- 新增 row 与原表列数相同，全部 cell 都是空 paragraph 或 Milkdown 的 hardbreak-only 空占位；
- table 是无 colspan/rowspan/colwidth 的简单矩形网格；
- source-map 能把一个相邻非空 body row 的全部 cell text 映射到同一作者物理表格行。

它不认领：

- header 前新增 row 或 header/body 类型转换；
- 新增 row 已包含正文、mark、inline atom 或多个 paragraph；
- 同一个 transaction 或后续 transaction 已立即向新增 row 输入文字；
- 一次新增多行、多个 transaction 或同时修改其它 row/cell；
- 空 template row、多个 paragraph、mark、inline code/math/image 等 atom；
- colspan、rowspan、colwidth、列数、alignment 或其它 topology 同步变化；
- table 创建、整表移动、邻块变化或与 column command 混合；
- row deletion、column insertion/deletion 已由独立 focused owners 处理；本 owner 仍不认领 alignment command；
- source/canonical/doc stale、raw mismatch 或 semantic/list-slot 不等价。

## 2. 真实 Transaction 证据

真实 Milkdown 行尾 `x-line-drag-handle` 的新增按钮最终调用 `addRowAfter`，对简单网格产生：

```text
ReplaceStep
from = to = insertion boundary
slice.openStart = 0
slice.openEnd = 0
slice.content.childCount = 1
slice.content.firstChild = one empty table_row
```

owner 不只依赖 Step 名称。它同时计算 previous/next row stream 的插入候选：

```text
previous rows = prefix + suffix
next rows     = prefix + inserted row + suffix
```

每个 candidate 还必须同时满足：

1. candidate ordinal 大于 0，禁止插到 header 前；
2. Step `from/to` 等于 oldDoc 中该 ordinal 的精确 PM 插入边界；
3. slice 中唯一 row 与 expected inserted row `eq`；
4. inserted row 是等列数空 body row；
5. Step apply 后精确等于 entry afterDoc、journal expectedDoc 和 callback expectedDoc。

因此，即使表格中存在多个正文完全相同的 rows，插入位置仍由 row ordinal、PM boundary 和 Step slice 唯一证明，不会通过 canonical Markdown 行号或全文字符串搜索猜位置。

journal 必须满足：

1. 恰有一个 entry；
2. entry 恰有一个 `ReplaceStep`；
3. stepDoc 等于 journal oldDoc；
4. table attrs 不变；
5. header、全部旧 body rows 与邻块逐节点相等；
6. inserted row 在 callback 前仍为空，不能把“新增行 + 快速输入”混入本 family。

## 3. GFM Grid 与空行合同

生产 Milkdown GFM schema 使用：

```text
table
├─ table_header_row
│  └─ table_header+
└─ table_row+
   └─ table_cell+
```

纯合同同时覆盖标准 ProseMirror tables 的 header 形状。owner 对二者只在 header row 节点名上兼容，body 严格要求：

- row type 为 `table_row`；
- cell type 为 `table_cell`；
- 每行列数相同；
- colspan/rowspan 为 1；
- colwidth 为 null；
- cell childCount 为 1；
- 已有 template row 的 paragraph 非空、纯文字、无 mark；
- inserted row 的 paragraph 必须真正为空，或仅含 Crepe/Milkdown 的 hardbreak 空占位。

复杂 span、multi-paragraph template 或非空 inserted cell 直接 fail closed，不尝试把 PM topology 猜成一条 Markdown 行。

## 4. 作者行模板与 Raw Insertion

GFM 空 row 不能直接采用 serializer 的 canonical 整表，因为那会改写作者的：

- leading/trailing pipes；
- 列间空格；
- 每列宽度；
- delimiter/alignment row；
- BOM 和行尾。

owner 因此选择一个**已有、非空、简单 body row**作为模板：

```text
insertedRowIndex > 1 → previous row
insertedRowIndex = 1 → old table 的第一条 body row
```

随后分别在作者 source 与 previous canonical 上对 template row 的每个 cell 执行：

```text
paragraph PM start/end
→ pmPosToMarkdownOffset()
→ raw cell text 必须逐字等于 PM text
→ 全部 cells 必须位于同一物理行
```

在作者物理行副本中，从右向左删除所有正文 span，得到作者风格的空行。例如：

```md
| same  | beta  | repeated  |
```

生成：

```md
|   |   |   |
```

只移除正文，不规范化任何 pipe 或 spacing，也不写入 `<br />`。

## 5. 精确插入位置与 EOL/EOF

raw insertion 分三种：

### Header 后第一条 body row

若 `insertedRowIndex === 1`，在原第一条 body row 的物理行开始前插入：

```text
blank template row + document EOL
```

### 中间或末尾、template row 有终止 EOL

在 template row 完整物理行之后插入：

```text
blank template row + same EOL
```

### Table 位于 EOF 且最后 row 无终止换行

在 template row text end 插入：

```text
document EOL + blank template row
```

物理行处理原生支持：

- LF：`\n`
- CRLF：`\r\n`
- lone-CR：`\r`
- BOM；
- table 后无邻段且文件无尾换行。

EOL 优先复用 template row 自身行尾；若该行无终止符，则向前后搜索最近的文档行尾。无法证明文档 EOL 时拒绝接管。

插入后必须通过共享 parser、semantic identity 与 strict list-slot validator，最终文档必须等于 expectedDoc。

## 6. Production Registry 与真实生命周期

`Editor.jsx` 在既有 structural registry 追加：

```text
table-row-insert
```

它与其它 focused owners 共用：

- 唯一 revision-bound `SourceSyncTransactionJournal`；
- callback document proof；
- semantic/list-slot integrity gate；
- `SourceSyncCoordinator` 原子 publication；
- 成功或 stale 后才清 journal。

生产真实操作链为：

```text
hover body row bottom edge
→ x-line-drag-handle
→ click .add-button
→ addRowAfter / addRowWithAlignment
```

真实门禁覆盖两条 publication 路径：

- 等待自然 settle：`transaction-table-row-insert-markdown-updated`；
- 点击后立即切源码：`transaction-table-row-insert-forced-flush`。

两者使用同一本 journal、同一 ownership proof 和同一 Coordinator，不新增 table 专用 source ref 或 canonical 形状分支。

## 7. 永久回归

纯合同：

```bash
npm run test:table-row-insert-transaction-owner
```

覆盖：

- 真实 `addRowAfter` Step 与 exact insertion boundary；
- BOM + 自定义 spacing/alignment；
- 多个语义相同、作者 spacing 不同的 duplicate rows，在第二处 occurrence 后新增；
- header 后第一条 body row、中间 row、末尾 row；
- LF、CRLF、lone-CR 与 EOF 无尾换行；
- markdown-updated 自定义 boundary planning；
- 多 Step、多 transaction、多行、header 前插入；
- 非空 inserted row、同 journal 后续输入；
- marked、empty、multi-paragraph template 与 span/topology；
- source mismatch、mapper throw、semantic false、callback mismatch、stale revision；
- constructor contract。

真实 Electron：

```bash
npm run test:table-row-insert-transaction-ui
```

两个场景均使用真实 `.x-line-drag-handle .add-button`：

```text
settled markdownUpdated
immediate source-mode forced flush
```

均验证：

- DOM 只多一条目标空 body row；
- proof table path `[1]`、inserted row path `[1,4]`、template path `[1,3]`；
- exactly one ReplaceStep / journal capture；
- template raw line、blank line、placement 与 CRLF 精确；
- 第一处 duplicate row、目标 template row、后继 row 与邻段保持；
- source 中不出现 sole-cell `<br />`；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- Coordinator owner 为 `transaction`；
- 零 warning toast；
- source、save、disk、fresh-profile cold reopen 精确。

相邻门禁包括：

- `test:table-row-delete-transaction-owner` / UI；
- `test:table-cell-transaction-owner` / UI；
- `test:issue-86-ui` 的重复行列新增、编辑、保存和冷重开；
- GFM source-map、source transaction、journal、Coordinator；
- 完整 markdown preservation 与 table empty-cell normalization；
- source-fidelity probes 39/39；
- production build。

## 8. 安全边界与下一迁移顺序

本 owner 刻意不处理“新增空 row 后，在同一个 delayed journal 中立即输入正文”。该行为会把结构插入与 cell text owner 合并为复合 family；在没有稳定 inserted path rebase 与双阶段 raw slot 证明前继续 fail closed。

不扩大本 owner，后续独立 family 依次为：

1. table 复杂 span/topology；
2. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 继续使用 transaction journal、stable path、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
