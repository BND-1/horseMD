# Transaction Journal：Table Column Width Metadata Family

> 状态：HorseMD `0.13.145` 已迁移并通过生产门禁。<br>
> Family：`table-column-width`<br>
> Publication boundaries：`transaction-table-column-width-markdown-updated`、`transaction-table-column-width-forced-flush`

## 1. 为什么这是 PM-only family

HorseMD 的列边界长按拖拽会把宽度存入 ProseMirror table cell attrs：

```text
attrs.colwidth = [pixelWidth]
```

GFM Markdown 没有列宽语法。因此本 family 的正确持久化合同不是把宽度写进作者源码，而是：

```text
source       原样不变
canonical    原样不变
PM expectedDoc 推进到含 colwidth 的 live document
App dirty    不产生
cold reopen  从 GFM source 恢复自动宽度
```

它仍然必须经过 journal、ownership proof、完整性校验和 Coordinator；不能因为 source 没变化就绕过同步生命周期。

## 2. 真实拖拽 Transaction

`editor-dom-layout.js` 的 `persistColumnWidth()` 与 prosemirror-tables 的更新模型一致。对目标逻辑列，按 header 到 body 逐 row 执行：

```js
tr.setNodeMarkup(cellPos, null, { ...attrs, colwidth })
```

真实 transaction 是一个 entry，包含 rowCount 个：

```text
ReplaceAroundStep(structure=true)
```

每个 Step：

- `from/to` 覆盖完整 cell node；
- `gapFrom/gapTo` 覆盖 cell content；
- slice 只含一个无 child 的同类型 cell wrapper；
- wrapper attrs 等于该 row 的最终 cell attrs；
- gap 原样保留 paragraph/text；
- Step 按 header→body 在递进 `stepDoc` 上应用。

生产 Milkdown 的首行类型是 `table_header_row`；标准 prosemirror-tables fixture 使用 `table_row + table_header`。owner 只接受这两种 header schema，body 仍严格为 `table_row + table_cell`。

## 3. Focused 所有权

oldDoc→expectedDoc 必须只有一个顶层 table subtree 变化。候选列必须唯一，并满足：

- table row 数与 column 数不变；
- table attrs、所有 row attrs 不变；
- 无 colspan/rowspan，`colwidth` 为 null 或单元素正整数数组；
- 非目标 cells 逐节点相等；
- 目标 cells 的 type、content 与 colwidth 之外 attrs 不变；
- 所有 rows 的 previous width 相同；
- 所有 rows 的 next width 相同、为整数且不少于 25；
- previous width 与 next width 不同；
- journal 只有一个 entry；
- Step 数等于 table row 数。

对第 i 个 Step，owner 还必须证明：

1. `stepDocs[i]` 等于前一步应用结果；
2. 已处理 rows 与 next table 相同，未处理 rows 与 previous table 相同；
3. Step 是精确的 `ReplaceAroundStep(structure=true)`；
4. range/gap 精确对应 `[tableIndex,i,columnIndex]`；
5. slice wrapper type/attrs 精确等于 expected cell；
6. apply 后只有该 cell path变化；
7. after cell 等于 expected cell；
8. 最终 doc 等于 entry.afterDoc 和 callback expectedDoc。

单 cell resize、多个 columns 同时变化、每 row 不同 width、多 transaction 连续 resize、正文或 alignment 混改、复杂 span、邻块变化和 stale revision全部拒绝。

## 4. Source-Unchanged Publication

owner 成功时返回：

```text
markdown = journal.source
canonical = journal.canonical
notifyChange = false
```

proof 记录 table path、column ordinal、previous/new width、全部 cell paths、每个 Step range/gap、journal proof 和 source/canonical/markdown digest。Coordinator 仍推进 revision 和 expectedDoc checkpoint，但不会调用 App source `onChange`，不会出现保存按钮，也不会写磁盘。

## 5. Exact Path-Bound Semantic Proof

普通 source parse 没有 `colwidth`，live expectedDoc 有，因此默认文档等价必须是 false。只有以下条件全部成立时，semantic comparator 才在指定 paths 删除 `attrs.colwidth` 后比较：

- reason 精确为 `table-column-width-changed`；
- proof kind 精确为 `transaction-table-column-width-proof`；
- family 精确为 `table-column-width`；
- source/canonical unchanged flags 为 true；
- `cellPaths.length === rowCount`；
- 每条 path 恰为 `[topLevelIndex,rowIndex,columnIndex]`；
- row ordinals 唯一。

漏 path、重复 row、错 table/column、错 reason、伪 proof 都不能经过 direct、transition 或 trusted-checkpoint 通道。alignment、content、span 等其它差异从不被忽略。

## 6. 共享生命周期修复

### Shared proof reference

owned candidate 同时把同一 proof 放入 `ownershipProof` 与 `preservationProof`。旧 `stableValue()` 使用全局 WeakSet，会把第二个兄弟引用误判成循环并替换为 `[Circular]`。现在只追踪当前递归祖先链：共享兄弟引用完整复制，真正自引用仍安全截断。

### Preflight diagnostics

structural registry 在 owner 规划前检查 canonical parse 与 live doc 是否普通等价。列宽场景预期为 false，但这只是 preflight。`areSourceDocumentsEquivalent()` 的 `recordDifference:false` 让预判保持严格结果而不污染 first-divergence trace；最终 validator 仍记录真实错误。

### Canonical-unchanged forced flush

`publishPendingSourceSyncJournalForFlush()` 在 generated scratch 之外始终先询问 pending journal，即使 canonical 未变化也可提交 PM-only expectedDoc；未认领时继续原 committed-baseline validation。生产 editor-api与 Node 纯合同共用该 policy。

### Dispatch 前用户意图

列宽 mouseup 在 `view.dispatch(tr)` 前调用 `markUserEdit()`，确保 journal observer 将 colwidth batch 绑定到当前 Coordinator revision。

## 7. 永久回归

纯合同：

```bash
npm run test:table-column-width-transaction-owner
npm run test:source-transaction-sync
npm run test:source-sync-coordinator
npm run test:editor-api-transaction-flush
```

覆盖真实逐 row ReplaceAroundStep、null/已有 width 更新、两种 header schema、exact cell paths、单/多列、mixed width、过小 width、span、正文混改、多 transaction、source/canonical/semantic/stale、proof reason/path绑定、shared reference/真实循环以及 canonical不变 forced flush。

真实 Electron：

```bash
npm run test:table-column-width-transaction-ui
```

BOM+CRLF、自定义 spacing 表格中真实长按拖拽第二列，覆盖自然 callback和立即切源码 forced flush。两场均要求当前会话宽度生效、唯一 owner/Coordinator publication、完整 integrity成功、零 warning、source/disk/dirty逐字不变，以及 fresh profile冷重开恢复GFM自动宽度。

## 8. 最终矩阵

收口前已通过全部 table cell/row/column insert/delete/alignment/width pure + UI、table basic/save/scroll/resize、PDF table layout、issue-86、list subtree、code-block info、blockquote exit、transaction sync LF/CRLF/BOM、完整 Markdown preservation、39/39 probes、异构 source-fidelity UI、desktop production build与 mobile build。

长串 Electron矩阵曾在 list-subtree第二个 profile挂载时超时；该脚本随后单独重跑 callback/forced-flush均通过，属于连续进程启停资源时序，不是产品回归。

## 9. 下一迁移顺序

产品未暴露 merge/split cell 命令；colspan/rowspan也没有GFM持久化语法，因此保持显式 fail closed。下一阶段回到可由Markdown表达的 code-block生命周期：

1. empty fenced code block Backspace 解包为 paragraph；
2. code block创建/删除；
3. code block split/join和围栏结构变化。

每个 family继续使用真实PM transaction、stable path、逐Step stepDoc、bounded raw range、semantic/structure validation和Coordinator原子发布，不增加canonical形状特判。
