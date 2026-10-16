# Transaction Journal：ordered empty successor chain

## 目标

本 family 迁移顶层 plain ordered list 中“删除一个 middle empty item 后，需要连续重编号多个后继项”的物理 Backspace。

0.13.155 已拥有三项列表 `[nonempty, empty, nonempty]` 的 single-successor RS-72。0.13.156 不扩大那个 owner，而是单独建立 `list-ordered-empty-successor-chain-lift`，只处理 empty 后至少还有两个 successor 的 relabel chain。

## 物理事务合同

真实 Backspace 被 SourceSyncTransactionJournal 捕获为两笔 transaction：

1. 第一笔只有一个 structural、closed、zero-slice `ReplaceStep`。
2. 该 Step 删除前一 list_item closing wrapper 与 empty list_item opening wrapper。
3. intermediate doc 中 removed item消失，前一 item保留原正文并新增一个 editor-owned trailing empty paragraph。
4. 所有 successor 在 intermediate doc 中仍保持旧正文、旧 attrs和旧 label。
5. 第二笔 transaction 内含 N 个 `ReplaceAroundStep`，N 必须严格等于 successorCount。
6. 每个 relabel Step 都是 `structure=true`、`sliceSize=2`、`openStart=0`、`openEnd=0`、`insert=1`。
7. 每一步 gap只包住当前 successor content，slice只提供新的空 `list_item` wrapper attrs。
8. 每个 Step 必须在其捕获时递进 `stepDoc` 上 apply，并精确得到下一 stepDoc；最后一步得到 live expectedDoc。

因此 owner 不根据 canonical 中“空 marker消失、数字变化”的形状猜测 family，而是依赖完整 PM Step 链、stepDoc和稳定 path。

## Topology ownership

old list必须满足：

- 顶层 `ordered_list`；
- 至少四个 items；
- 所有 items均为 non-task plain `list_item`；
- 每个 item只有一个直接 plain paragraph；
- 恰好一个 item为空；
- empty item不是首项，并且它后面至少有两个 successor；
- labels从 `ordered_list.attrs.order` 连续增长；
- old labels使用统一 `.` 或 `)` delimiter。

final list必须满足：

- item数量恰少 1；
- removed 前一 item只多一个 trailing empty paragraph；
- removed 前的更早 items完全不变；
- 每个 successor正文与 label以外 attrs完全不变；
- successor ordinal逐项减 1；
- final delimiter与PM family保持一致。

single-successor 明确返回未识别，由 0.13.155 owner继续处理。多个 empty items、首/尾 empty、nested、task、正文混改或其它 sibling变化均不属于本 family。

## Raw source patch

focused owner使用 `preserveTransactionOwnedOrderedEmptySuccessorChain()`，不进入 generic list mapper chain。

bounded source、previous canonical和next canonical只为比较做：

- 统一 LF逻辑视图；
- canonical empty-list placeholder normalization；
- canonical ordered delimiter normalization。

作者 source 本身不被 canonical 重写。

raw mapper要求：

- source bounded fragment不能混合 EOL；
- source顶层 ordered row数必须等于 old PM item数；
- authored ordinal必须从 list order连续增长；
- source只有 removedIndex 对应 row为空；
- 其它 source row的 visible body必须与 previous canonical对应 item一致；
- source delimiter在该 list内统一，但可以是 `.` 或 `)`；
- next canonical必须精确解释“删除 empty row + 所有 successor ordinal前移 1”。

成功 patch：

1. 为每个 successor记录 ordinal digit byte range和 `oldOrdinal - 1` replacement。
2. 记录 authored empty row从其 line.start 到下一 successor line.start 的删除范围。
3. 所有 patch按 raw offset 从后向前应用，避免前一 patch改变后一 patch坐标。
4. 只改 ordinal digits和删除 empty row；delimiter、spacing、body、BOM、EOL、邻块和其它字节逐字保持。

## Semantic transient

Backspace 后 live PM在 removed 前一 item末尾保留一个 Markdown 无法安全编码的空 paragraph。

validator只有在以下全部成立时才忽略该路径：

- reason为 `list-ordered-empty-successor-chain-lifted`；
- proof kind为 `transaction-list-ordered-empty-successor-chain-proof`；
- family为 `list-ordered-empty-successor-chain-lift`；
- snapshot/document均由 Transaction Journal证明；
- transactionCount恰为 2；
- stepCount恰为 `successorCount + 1`；
- firstStep是精确 structural zero-slice `ReplaceStep`；
- relabelSteps数量等于 successorCount，全部是精确 `ReplaceAroundStep`；
- removedPath、transient item path和paragraph path一致；
- old/final successor label数组长度与successorCount一致。

伪 proof、漏 Step、错 path、错 family或 single-successor proof都不能获得 semantic 例外。

## Legacy retirement

生产 structural registry顺序为：

1. multi-successor chain owner；
2. 0.13.155 single-successor owner；
3. isolated/first/tail/interior等其它 focused list owners；
4. broad list-subtree。

chain owner设置 `legacyRetired:true`。

PM topology与Step链尚未完整证明时返回 `recognized:false`，允许后续 owner继续分类。

一旦 PM chain 已证明，而 source range、row、EOL、body或 raw mapper无法安全证明，则返回 `recognized:true`。共享 registry随即标记 `legacyBlocked:true`：

- 不允许 single-successor owner重新解释；
- 不允许 broad list-subtree接管；
- 不允许 legacy canonical-diff mapper自愈；
- 不产生 Coordinator publication；
- rich edit保持可见；
- 显示 source-sync warning；
- disk保持原作者字节。

## 永久回归

### Pure owner

`test:list-ordered-empty-successor-chain-transaction-owner`

覆盖：

- 2 successors；
- 3 successors；
- removedIndex 1；
- removedIndex 2；
- non-1 list order；
- authored `)` delimiter；
- BOM + CRLF；
- authored empty row body不为空：recognized fail closed；
- mixed EOL：recognized fail closed；
- wrong relabel Step：recognized fail closed；
- single successor：recognized=false，留给0.13.155。

### Electron callback / forced

`test:list-ordered-empty-successor-chain-transaction-ui`

覆盖三个真实场景：

- callback、order=4、作者 `)`、2 successors；
- forced-flush、removedIndex=2、2 successors；
- callback、3 successors。

每个场景都要求：

- focused chain仅发布一次；
- single-successor与broad owner无成功 publication；
- integrity全程无 `ok=false`；
- source textarea精确；
- save磁盘字节精确；
- fresh-profile cold reopen恢复最终列表；
- editor-only transient paragraph不会持久化。

### Legacy retirement negative

`test:list-ordered-empty-successor-chain-legacy-retirement-ui`

使用 one-space authored四项 ordered rows，使PM仍产生 exact merge+relabel chain，但 source-map无法安全证明顶层作者 range。

要求：

- chain trace为 `recognized:true + legacyBlocked:true`；
- single/broad/legacy均不得成功；
- Coordinator无 publication；
- rich PM edit和transient paragraph仍保留；
- warning可见；
- disk保持 fixture原字节。

## 全局资格门禁

本 family 候选存在于工作树时已通过：

- SourceSyncTransactionJournal；
- SourceSyncCoordinator；
- source transaction sync；
- 完整 Markdown preservation；
- source-fidelity probes 39/39；
- mixed rich/source Electron；
- heterogeneous source-fidelity Electron；
- desktop build；
- mobile build；
- `git diff --check`。

相邻 list矩阵还覆盖 isolated、first/tail/interior、nested、task、cross-list、rapid Enter、ordered parent、ordered Enter/exit/delimiter/repeated-list，未出现 ownership抢占。

## 后续边界

0.13.156 只收口 ordered middle-empty Backspace 的 multi-successor relabel chain，不代表阶段 E 完成。

长期计划下一项进入 nested list split/join/indent/outdent。必须先捕获真实 Tab/Shift+Tab、Enter、Backspace/Delete 的 PM Step/stepDoc/path，再按 family拆 owner；不能因为 generic list-subtree当前能处理部分 nested变化，就直接将其视为已迁移。
