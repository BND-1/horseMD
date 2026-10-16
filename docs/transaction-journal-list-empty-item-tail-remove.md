# Transaction Journal：plain tail empty-item Backspace

> 源码版本：HorseMD 0.13.152
> Family：`list-empty-item-tail-remove`
> Owner：`createListEmptyItemTailRemoveTransactionSourceSyncOwner`
> Boundary：`transaction-list-empty-item-tail-remove`

## 1. 迁移范围

本 family 只处理顶层普通 bullet/ordered list 的最后一个空 item。removed item 必须非 task、只有一个空 paragraph；其 preceding item 必须非 task、只有一个非空 plain paragraph。first-empty、interior empty、nested preceding item、task、ordered lift、多 transaction 都不属于本 family。

## 2. 真实 ProseMirror Step

真实 Electron fixture：

```markdown
before

- left
-

after
```

物理 Backspace 后，列表由 `['left', '']` 变成一个 item，其 PM children 为 `['left', '']`。Journal 记录：

```text
ReplaceStep
from = 16
to = 18
structure = true
sliceSize = 0
```

与 0.13.151 interior family 类似，PM 删除 preceding item 的 closing wrapper boundary 和 tail empty item 的 opening wrapper boundary。owner 因而要求：

```text
removed.beforePos === preceding.endPos
step.from === preceding.endPos - 1
step.to === removed.contentStart
```

journal 必须只有一个 transaction 和一个 Step，Step 在捕获 stepDoc 上 apply 后必须精确等于 live expectedDoc。

## 3. 为什么不能与 nested tail 合并

初版 tail owner 允许 preceding item 已经包含 nested structure，导致 RS-63 `empty-list-item-merged-after-nested-list` 被错误抢占。相邻门禁因此失败。

正式边界收紧为：

```text
old preceding item childCount === 1
唯一 child === 非空 paragraph
new preceding item childCount === 2
child[0] === old paragraph
child[1] === empty paragraph
```

因此 nested list、blockquote 或其它 extra child 继续交给各自 family/legacy compatibility。RS-63 已恢复原 dedicated reason 并通过 source/save/reopen。

## 4. authored source patch

owner 用 PM source-map 分别锁定 `journal.source` 与 previous canonical 中的同一顶层 list，并要求同级 marker row 数等于 old PM item 数。

目标 row 必须是最后一行、同 list kind、作者 body 真为空；preceding row 必须同 kind 且与 tail row 物理连续。成功 patch 只删除 tail marker row 和自己的 EOL：

```text
source.slice(0, row.start) + source.slice(rowEnd)
```

因此列表后的 block gap、BOM、LF/CRLF、bullet marker、ordered delimiter、其它 rows 和邻块全部保持。

## 5. semantic transient

Backspace 后 preceding item 尾部多一个 GFM 无法安全编码的 editor-owned empty paragraph。validator 只有在以下 transaction proof 全部成立时才忽略精确 list-item path：

- reason=`list-empty-item-tail-removed`
- kind=`transaction-list-empty-item-tail-remove-proof`
- family=`list-empty-item-tail-remove`
- journal snapshot/document matched
- chainLength=1
- exact removed path
- exact preceding item path
- exact trailing paragraph path
- `ReplaceStep / structure=true / sliceSize=0 / from<to`

其它 proof、path 或 Step 不得复用该 semantic 例外。

## 6. legacy retirement

生产 registry 顺序：

```text
list-empty-item-tail-remove
→ list-empty-item-remove
→ list-subtree
→ list-item-paragraph
```

本 family 设置 `legacyRetired:true`。

PM topology 尚未证明 tail family 时返回 `recognized:false`。PM family 已证明，但 source row count、body、range 或物理连续性失败时返回 `recognized:true`；此时旧 `empty-list-item-removed` 和 generic canonical fallback不得接管。

loose-tail 永久负例：

```markdown
- left

-
```

物理 Backspace 后 rich PM edit 保留，但 owner 返回 `list-empty-item-tail-authored-row-unproven / recognized:true / legacyBlocked:true`，显示 warning，无 Coordinator publication，磁盘原字节不变。

## 7. 永久门禁

- `test:list-empty-item-tail-remove-transaction-owner`
- `test:list-empty-item-tail-remove-transaction-ui`
- `test:list-empty-item-tail-remove-legacy-retirement-ui`

正向 UI 覆盖 callback 与立即切源码 forced-flush、BOM+CRLF、source/save/disk/fresh-profile reopen和零 `<br />` 泄漏。负向 UI 覆盖 loose-tail fail-closed。

相邻门禁覆盖 0.13.151 interior、first-empty legacy控制、RS-63 nested continuation、task empty row、isolated ordered lift、RS-72 successor、cross-list selection、rapid double Enter、nested Enter与generic list-subtree callback/forced；全局门禁覆盖 Journal、Coordinator、source transaction sync、完整 preservation、39/39 probes、mixed rich/source、异构 source fidelity和desktop/mobile build。

## 8. 下一 family：first-empty Backspace

first-empty 已经由真实诊断证明是完全不同的 topology：

```text
before: list [empty, right]
after:  top-level empty paragraph + list [right]
Step:   ReplaceAroundStep from=8,to=13,structure=true,sliceSize=1
```

它不是 list-item trailing empty paragraph，而是把 editor-owned empty paragraph 提升到列表前的顶层。因此必须使用独立 owner、独立 semantic proof、独立 negative legacy-blocked gate和独立提交，不能扩宽 tail owner。
