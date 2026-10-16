# Transaction Journal：Table Cell Plain-Text Family

> 状态：HorseMD `0.13.139` 已迁移并通过生产门禁。
> Family：`table-cell-plain-text-replace`
> Publication boundaries：`transaction-table-cell-markdown-updated`、`transaction-table-cell-forced-flush`

## 1. 范围

本 family 只认领：

- GFM table 中一个稳定 cell path；
- cell 是 `table_cell`（实现同时容忍 schema 中独立 `table_header` 类型）；
- cell 恰有一个直接、非空、无 mark/atom 的 plain paragraph；
- journal 内全部 Step 是该 paragraph 内的 closed plain-text `ReplaceStep`；
- callback 和立即切源码 forced flush；
- source-map 能把 PM text position 唯一映射到作者表格 cell raw text。

它不认领：

- 空单元格、多个 paragraphs、marks、inline code/math/image 等 atom；
- `|`、换行或其它 Markdown-sensitive 输入；
- 跨 cell 选区、多 cell 同批编辑；
- row/column 结构变化或 header/body 转换；其中单空 body-row 新增与单 body-row 删除已分别由独立 `table-row-insert` / `table-row-delete` owner 处理；
- table/row/cell/paragraph attrs、colspan/rowspan/colwidth/alignment 变化；
- 表格整体创建、删除、移动或邻块变化；
- source/canonical/doc stale、raw mismatch 或 semantic/list-slot 不等价。

## 2. Stable Cell Path 所有权

owner 对 oldDoc/expectedDoc 分别调用 stable descendant classifier，要求：

```text
exactly one changed top-level subtree
exactly one changed table cell descendant
same child-index path old→new
```

对 path：

```text
[tableIndex, rowIndex, cellIndex]
```

进一步证明：

- parent type 是 `table_row`；
- grandparent type 是 `table`；
- table/row/cell attrs 不变；
- cell type 不变；
- cell childCount 始终为 1；
- direct child 是 attrs 不变的 non-empty plain paragraph；
- path 外所有 siblings 和 ancestors 保持 `eq`。

重复正文不会产生歧义：例如两个不同 rows 都含 `repeated`，PM stable path 与 GFM mdast occurrence 共同锁定目标 cell；不是通过全文字符串搜索。

## 3. Transaction / Step 合同

每个 journal entry 和 Step 必须满足：

1. `beforeDoc` 与前一步 `afterDoc` 连续；
2. Step 是 `ReplaceStep`，`structure !== true`；
3. slice 是 empty 或 closed plain-text，无 open fragment、mark 或 block node；
4. `from/to` 在捕获时 `stepDoc` 中 resolve 到同一 paragraph；
5. paragraph 位于 owned cell path 的直接 child ordinal 0；
6. Step apply 后只有同一 cell path变化；
7. 结果仍为同 cell type/attrs + 一个 non-empty plain paragraph；
8. 完整 Step 链最终等于 expectedDoc。

任一 Step 跨 cell、修改 cell/row attrs或使结果为空，整本 journal fail closed。

## 4. Raw Source Patch

owner 不自建 table parser，而复用已经覆盖 GFM table positions 的：

```text
pmPosToMarkdownOffset()
mapPlainTextTransactionsToSource()
```

流程：

```text
stable cell path + Step journal
→ 每个 PM from/to 映射到当前 raw Markdown
→ removed raw text 必须等于 PM removed text
→ bounded text patch
→ semantic validator against expectedDoc
```

因此只修改目标 cell text bytes，以下作者字节保持：

- leading/trailing table pipes；
- 每列 spacing；
- delimiter/alignment row；
- 其它 header/body cells；
- BOM、LF/CRLF/lone-CR；
- table 前后段落。

`|` 等语法敏感字符仍由通用 mapper 返回 `syntax-sensitive-insert`，不会自动加反斜杠或改写整行。

## 5. Production Registry

`Editor.jsx` 只在既有 structural registry 追加：

```text
table-cell
```

它与 list/code/blockquote owners 共用：

- 唯一 revision-bound journal；
- callback document proof；
- callback/forced-flush publication loop；
- semantic/list-slot integrity gate；
- `SourceSyncCoordinator.publishOwned()`；
- 成功或 stale 才清 journal。

没有独立 checkpoint、direct refs publication、canonical `|` 形状特判或 reason allowlist。

## 6. 永久回归

纯合同：

```bash
npm run test:table-cell-transaction-owner
```

覆盖：

- BOM + CRLF authored table；
- 自定义 column spacing 与 alignment delimiter；
- 两个重复 `repeated` cells，编辑第二个 occurrence；
- header row 与 body row；
- callback 前两笔快速 ReplaceStep；
- marks、空结果、`|`、跨 cell、多 cell；
- cell/row attrs、多个 paragraph；
- source mismatch、semantic false、callback mismatch、stale revision；
- constructor contract。

真实 Electron：

```bash
npm run test:table-cell-transaction-ui
```

真实 fixture 执行：

```text
定位第三行第三列重复单元格
→ 物理输入 X / Y
→ callback publication
或立即切源码 forced flush
→ source 检查
→ save
→ 完整退出
→ 全新 profile 冷重开
```

最终证明：

- proof path `[1,2,2]`、table `[1]`、row `[1,2]`；
- journal 含两笔 transaction；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- 零 warning toast；
- 作者 header spacing、alignment row、第一处重复 cell、BOM/CRLF 和后继段落保持；
- callback/forced-flush/source/save/disk/cold reopen 精确。

## 7. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. table 复杂 span/topology；
2. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 继续使用 transaction journal、stable path、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
