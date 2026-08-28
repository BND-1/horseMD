# Transaction Journal：Table Row Delete Family

> 状态：HorseMD `0.13.140` 已迁移并通过生产门禁。
> Family：`table-row-delete`
> Publication boundaries：`transaction-table-row-delete-markdown-updated`、`transaction-table-row-delete-forced-flush`

## 1. 范围

本 family 只认领一个已有 GFM table 中的单个 body row 删除：

- oldDoc 与 expectedDoc 只有一个顶层 `table` subtree 变化；
- previous table 恰比 next table 多一个 row；
- journal 只有一个 transaction、一个真实 `ReplaceStep`；
- Step slice 是 empty closed slice；
- Step `from..to` 精确覆盖唯一被删除 `table_row` 的完整 node range；
- table 是无 colspan/rowspan/colwidth 的简单矩形网格；
- 被删 body row 的每个 cell 只有一个非空、无 mark/atom 的 plain paragraph；
- source-map 能把该 row 的全部 cell text 映射到同一作者物理表格行。

它不认领：

- header row 删除；
- 删除最后一个 body row；
- 一次删除多行、多个 transaction 或后续快速正文编辑；
- 空 cell、多个 paragraphs、mark、inline code/math/image 等 atom；
- colspan、rowspan、colwidth、列数或 alignment/topology 同步变化；
- table 创建、整表删除、移动或邻块变化；
- row insertion 已由独立 `table-row-insert` owner 处理；column insertion/deletion 与 alignment command 仍不认领；
- source/canonical/doc stale、raw mismatch 或 semantic/list-slot 不等价。

## 2. 真实 Transaction 证据

真实 `@milkdown/prose/tables` `deleteRow` 对一个中间 body row 产生：

```text
ReplaceStep
structure = false
slice.size = 0
slice.openStart = 0
slice.openEnd = 0
from = row.beforePos
to = row.beforePos + row.nodeSize
```

owner 不只依赖 Step 名称。它同时计算 previous/next row stream 的删除候选：

```text
previous rows = prefix + deleted row + suffix
next rows     = prefix + suffix
```

只有一个 candidate 的完整 PM range 与 Step range 相等时，才能确定 `deletedRowIndex`。因此两个正文完全相同的 rows 仍由 row ordinal 和 Step bytes 唯一分辨，不会用全文字符串搜索删除第一处匹配。

journal 必须满足：

1. 恰有一个 entry；
2. entry 恰有一个 `ReplaceStep`；
3. stepDoc 等于 journal oldDoc；
4. Step apply 成功且精确等于 entry afterDoc、journal expectedDoc 和 callback expectedDoc；
5. table attrs 不变；
6. header、其它 body rows 与邻块逐节点相等。

## 3. GFM Grid 合同

生产 Milkdown GFM schema 使用：

```text
table
├─ table_header_row
│  └─ table_header+
└─ table_row+
   └─ table_cell+
```

纯合同还覆盖标准 ProseMirror tables 的：

```text
table_row + table_header
```

owner 对二者只在 header row 节点名上兼容，body 仍严格要求：

- row type 为 `table_row`；
- cell type 为 `table_cell`；
- 每行列数相同；
- colspan/rowspan 为 1；
- colwidth 为 null；
- cell childCount 为 1；
- paragraph 非空、纯文字、无 mark。

复杂 span 或 multi-paragraph cell 直接 fail closed，不尝试把 PM topology 猜成 Markdown 行。

## 4. Raw Physical-Line 删除

owner 分别在作者 source 与 previous canonical 上对被删 row 的每个 cell 执行：

```text
paragraph PM start/end
→ pmPosToMarkdownOffset()
→ raw cell text 必须逐字等于 PM text
→ 所有 cells 必须落在同一物理行
```

随后只删除：

```text
row line start .. row line EOL end
```

物理行扫描器原生识别：

- LF：`\n`
- CRLF：`\r\n`
- lone-CR：`\r`

因此以下作者字节保持：

- leading/trailing pipes；
- 每列 spacing；
- header 与 delimiter/alignment row；
- 其它 duplicate rows；
- BOM；
- 文档自身的 LF/CRLF/lone-CR；
- table 前后段落。

删除后仍通过共享 parser、semantic identity 与 strict list-slot validator 验证 expectedDoc。

## 5. Production Registry 与真实生命周期

`Editor.jsx` 在既有 structural registry 追加：

```text
table-row-delete
```

它与其它 focused owners 共用：

- 唯一 revision-bound `SourceSyncTransactionJournal`；
- callback document proof；
- semantic/list-slot integrity gate；
- `SourceSyncCoordinator` 原子 publication；
- 成功或 stale 后才清 journal。

生产 Milkdown 行操作链是：

```text
hover body row
→ row-drag-handle
→ click handle selecting the row
→ button-group delete button
→ deleteSelectedCellsCommand / deleteRow
```

该按钮同时调用 `onRichEditPending()`。当前实测中，表格控件没有在 dirty-reconcile 前及时提供可消费的 `markdownUpdated`，所以：

- 等待自然 settle：260ms dirty-reconcile 经 `transaction-table-row-delete-forced-flush` 发布；
- 立即切源码：源码切换前经同一 forced-flush boundary 发布。

这不是 legacy fallback；proof、family 和 owner 均为 transaction。纯合同另外使用自定义 boundary 证明 `transaction-table-row-delete-markdown-updated` 也能生成同一 owned publication，避免把 registry callback 路径写死。

## 6. 永久回归

纯合同：

```bash
npm run test:table-row-delete-transaction-owner
```

覆盖：

- 真实 `deleteRow` Step；
- BOM + 自定义 spacing/alignment；
- 两个语义相同、作者 spacing 不同的 duplicate rows，删除第二个 occurrence；
- LF、CRLF、lone-CR；
- markdown-updated boundary planning；
- header row、最后 body row、多行、多 transaction、邻块混改；
- marked、empty、multi-paragraph、span cell；
- source mismatch、mapper throw、semantic false、callback mismatch、stale revision；
- constructor contract。

真实 Electron：

```bash
npm run test:table-row-delete-transaction-ui
```

两个场景都使用真实行柄与删除按钮：

```text
settled dirty-reconcile
immediate source-mode flush
```

均验证：

- DOM 只少目标 duplicate row；
- proof table path `[1]`、row path `[1,3]`；
- exactly one ReplaceStep / journal capture；
- source raw line与 CRLF EOL精确；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- Coordinator owner 为 `transaction`；
- 零 warning toast；
- source、save、disk、fresh-profile cold reopen精确。

相邻门禁还包括：

- `test:table-cell-transaction-owner` / UI；
- `test:issue-86-ui` 的重复行列新增、保存和冷重开；
- GFM source-map、source transaction、journal、Coordinator；
- 完整 markdown preservation；
- table empty-cell normalization；
- list/code/blockquote focused owners；
- source-fidelity probes 39/39；
- production build。

## 7. 空表格占位符安全网

相邻矩阵发现：新建全空表格可能先被通用 `diverged-tail-block-append` 认领，从而绕过 table 专项分支并把 Milkdown 的：

```md
| <br /> | <br /> |
```

写入作者源码。0.13.140 因此把既有 `normalizeEmptyTableCells()` 放到 `preserveRichMarkdownSource()` 的统一 post-condition：

- 只移除单元格唯一内容为 `<br>` / `<br />` 的占位符；
- 转成标准 GFM 空 cell；
- `first<br>second` 等真实 cell break 完全保留；
- 不依赖某个内部 preservation reason。

## 8. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. table column insert/delete；
2. table alignment changes 与复杂 span/topology；
3. code-block 创建/删除/拆分/合并与围栏结构。

每个 family继续使用 transaction journal、stable path、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
