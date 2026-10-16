# Transaction Journal：List interior empty-item Backspace

> 源码版本：HorseMD 0.13.151
> Family：`list-empty-item-remove`
> Owner：`createListEmptyItemRemoveTransactionSourceSyncOwner`
> Boundary：`transaction-list-empty-item-remove`

## 1. 迁移目标

这一阶段只迁移一个窄但高频的列表生命周期：顶层普通 bullet/ordered list 中，用户在一个中间空 item 上按 Backspace。目标 item 必须前后都有真实 sibling、不是 task、只含一个空 paragraph。

迁移前真实 trace 暴露了双重所有权：shared Transaction Journal 已捕获 Backspace，但 broad `list-subtree` 先生成含 `<br />` 的错误候选并得到 `semanticOk=false`，随后旧 `empty-list-item-removed` canonical mapper 再生成正确候选。最终看似成功，但违反“recognized transaction 不能先失败再由 legacy 自愈”的长期不变式。

## 2. 真实 ProseMirror Step

物理 Enter 在 `- left / - right` 中间建立空 item，随后 Backspace 的真实旧 PM 边界为：

```text
left item    [16, 23)
empty item   [23, 27)
right item   starts 27

ReplaceStep
from = 22
to = 24
structure = true
sliceSize = 0
```

ProseMirror 不是删除整个 empty `list_item`。它删除 preceding item 的 closing wrapper boundary 和 empty item 的 opening wrapper boundary，使 empty paragraph 并入 preceding item，空 wrapper因此消失。

owner 将 Step 绑定为：

```text
removed.beforePos === left.endPos
right.beforePos === removed.endPos
step.from === left.endPos - 1
step.to === removed.contentStart
```

journal 必须恰有一个 transaction、一个 Step，Step 在捕获时 `stepDoc` 上 apply 后必须精确等于 live `expectedDoc`。

## 3. PM topology 合同

oldDoc → expectedDoc 必须满足：

- 只有一个顶层 subtree 变化，始终是同一种 `bullet_list` 或 `ordered_list`；
- list attrs 不变；
- old list 恰比 new list 多一个 item；
- removed item 不是首项或尾项；
- removed item 是非 task `list_item`，唯一 child 是空 paragraph；
- preceding item 在 new list 中仅多一个 trailing empty paragraph；
- removed/preceding 之外的 sibling items按 ordinal逐节点不变；
- task、nested target、多目标、多 transaction、错误 Step shape不属于本 family。

PM 分类尚未完整成立时返回 `recognized:false`，让其它 focused owner继续尝试。

## 4. authored raw source patch

owner 不使用 next canonical 的 `<br />` 形状决定删除哪一行。它分别对 `journal.source` 与 `journal.canonical` 使用 PM source-map 锁定同一顶层 list，并解析同级 marker rows。

要求 source 与 previous canonical 的同级 row 数都等于 old PM item 数；previous canonical 的目标 ordinal 是 `<br />` empty row；source 同 ordinal作者 row body 真为空；目标前后 row 存在、同 list kind且物理连续。

成功 patch 只删除 empty marker row 及其自身 EOL，因此保留 BOM、LF/CRLF、`- / + / *` marker、ordered `.` / `)` delimiter、其它 rows spacing、邻块和所有未编辑字节。

## 5. editor-only semantic transient

Backspace 后 PM 中 preceding item 多出一个 trailing empty paragraph。GFM 无法在不泄漏 `<br />` 的前提下持久化它。

validator 仅在以下 proof 全部成立时忽略该精确 item path：

- reason=`list-empty-item-removed`；
- proof kind=`transaction-list-empty-item-remove-proof`；
- family=`list-empty-item-remove`；
- journal snapshot/document proof成立；
- chainLength=1；
- removedPath=`[topLevelIndex, removedIndex]`；
- transient item path=`[topLevelIndex, removedIndex - 1]`；
- transient paragraph path位于该 item尾部；
- Step 为 `ReplaceStep / structure=true / sliceSize=0 / from<to`。

伪 proof、错 path、漏 path、错 Step 都 fail closed。

## 6. legacy retirement 边界

生产 structural registry 顺序为：

```text
list-empty-item-remove
→ list-subtree
→ list-item-paragraph
→ ...
```

`list-empty-item-remove` 设置 `legacyRetired:true`。

PM topology/Step 尚不能证明此 family 时保持 `recognized:false`。PM 已证明 family，但 source row count、raw range、作者 body或物理连续性失败时返回 `recognized:true`；此时 generic/legacy mapper不得再接管。

真实 loose-list 负例：

```markdown
- left

-

- right
```

PM 仍执行同一 empty-item Backspace，但作者 rows 不物理连续。owner 返回 `list-empty-item-authored-row-unproven / recognized:true`，Editor trace 为 `legacyBlocked:true`；富文本操作留在 PM，显示 source-sync warning，不产生 Coordinator publication，磁盘保持原字节。

## 7. 永久回归

`test:list-empty-item-remove-transaction-owner` 覆盖 exact interior positive、BOM+CRLF、removed/transient paths、task/no-transient/source-mismatch负例。

`test:list-empty-item-remove-transaction-ui` 覆盖初始 BOM+CRLF interior empty bullet 的 callback 与立即切源码 forced-flush、exactly one publication、source/save/disk/fresh-profile reopen、零 `<br />`、零 integrity failure/warning。

`test:list-empty-item-remove-legacy-retirement-ui` 覆盖 loose-list 的 `recognized:true + legacyBlocked:true`、legacy no-hit、Coordinator no publication、warning、rich edit retained、source/disk unchanged。

既有 `test-empty-bullet-backspace-removal-ui.mjs` 同时要求真实 Enter→Backspace 不再出现 broad `list-subtree` 先失败再由 legacy 自愈。

相邻门禁重新通过 isolated ordered lift、RS-72、cross-list selection、nested empty removal、generated scratch、task continuation/empty task、nested Enter、rapid double Enter、generic list-subtree callback/forced、mixed rich/source、完整 preservation、39/39 probes与异构 source-fidelity UI。

## 8. 明确未迁移

0.13.151 不代表全部 empty-item lifecycle 已 transaction-owned。仍待后续独立 family：

- list 首项/尾项 empty Backspace；
- ordered lift / successor重编号；
- nested empty item；
- task item与 U+200B sentinel；
- Enter退出与 coalesced double-Enter；
- list conversion/input rule；
- 跨列表 selection/coalescing；
- generated scratch 专项。

这些 family 在完成真实 Step、raw range、callback/forced、negative legacy-blocked 合同之前，不删除共享 legacy `empty-list-item-removed` mapper。
