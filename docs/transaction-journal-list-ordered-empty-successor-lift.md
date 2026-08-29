# Transaction Journal：ordered middle-empty successor lift

> 源码版本：HorseMD 0.13.155
> Family：`list-ordered-empty-successor-lift`
> Owner：`createListOrderedEmptySuccessorLiftTransactionSourceSyncOwner`
> Boundary：`transaction-list-ordered-empty-successor-lift`

## 1. 迁移范围

本 family 只处理 RS-72 当前已经由真实物理操作证明的最窄形态：顶层 plain `ordered_list` 恰有三项 `[nonempty, empty, nonempty]`。用户把光标放在中间空 paragraph 中按一次 Backspace。

本 family 明确不处理四项及更长 ordered list、多个 successors、first/tail empty、isolated ordered→bullet lift、task、nested、多 empty、跨列表选区和其它 generated scratch 结构变化。这些不能通过扩大条件并入，必须先捕获真实 Step 链。

## 2. 真实两 Step journal

真实 RS-72 长文档中，Backspace 被捕获为同一本 revision-bound journal 中两笔 transaction：

```text
Step 1: ReplaceStep(from=18,to=20,structure=true,sliceSize=0)
Step 2: ReplaceAroundStep(from=21,to=28,gapFrom=22,gapTo=27,insert=1,structure=true,sliceSize=2,openStart=0,openEnd=0)
```

绝对位置随前文长度变化，owner 不依赖固定数字，而验证它们与稳定 PM node path / beforePos / contentStart / nodeSize 的关系。

## 3. Step 1 ownership

旧 list 为 `alpha / empty / beta`。第一笔 `ReplaceStep` 删除 item0 closing wrapper 与 item1 opening wrapper。apply 后 intermediate doc 必须精确变成：

```text
item 0
  paragraph("alpha")
  paragraph("")   ← editor-only transient
item 1
  paragraph("beta")
```

此时原 successor 的 PM label 仍是旧 ordinal `3.`。owner 要求 old list 恰有三项，三项均非 task、仅一个 direct plain paragraph，previous/successor 非空、removed 为空，list attrs/未编辑节点不变，并要求 Step 在自己的 `stepDoc` 上 apply 后等于下一真实 doc。

## 4. Step 2 ownership

第二笔 `ReplaceAroundStep` 不改 successor 正文，只重写 intermediate successor wrapper，使 label `3.` 变成 `2.`。`gapFrom..gapTo` 必须精确包住 successor content，slice 必须是空 list_item wrapper，`insert=1`、`structure=true`，并在 intermediate `stepDoc` 上 replay 到 live expectedDoc。

## 5. ordered labels 与 list order

当前三项 family 要求：

```text
previous = order
removed = order + 1
successor old = order + 2
successor final = order + 1
```

proof 记录 `listOrder`、`previousLabel`、`removedLabel`、`successorOldLabel`、`successorFinalLabel`。PM label证明事务语义；作者 raw delimiter仍由 source决定。

## 6. transient semantic proof

最终 live PM 中 previous item仍含唯一 editor-only empty paragraph：`transientEmptyListItemPath=[top,0]`，`transientEmptyParagraphPath=[top,0,1]`。validator 只在 reason/family/proof kind匹配、journal恰为两 transactions/两 steps、Step names依次正确、paths与Step shape/replay全部精确时忽略这一处。错 path、伪 proof、额外 transient继续 fail closed。

## 7. 专用 bounded raw adapter

迁移前 RS-72 虽被 `list-subtree-replace` 包装为 transaction publication，但 raw mapping仍会尝试多种 list mapper。0.13.155 新增 `preserveTransactionOwnedSingleEmptyOrderedBackspaceLift()`：

```text
bounded source/previous/next
→ EOL normalization
→ canonical ordered delimiter + empty placeholder normalization
→ preserveSingleEmptyOrderedBackspaceLift()
→ restore authored EOL
```

它不会尝试 stable-row、nested、generic list-block、batched 或其它 legacy list mapper。因此 focused raw rejection会真实保持 rejection。

## 8. raw source patch

作者源码（`[space]` 表示 marker 后真实存在的一个空格）：

```text
1) alpha

2)[space]

3) beta
```

成功后：

```text
1) alpha

2) beta
```

raw patch只拥有删除中间空 row与将唯一 successor数字前移一位；不拥有 delimiter、正文、block gaps、邻块、BOM、EOL风格或其它列表。因此 `)` 保持 `)`，`.` 保持 `.`。source/previous/next必须由 PM source-map定位到同一顶层 ordered block；bounded source出现 mixed EOL时专用 adapter直接拒绝。

## 9. legacy retirement

生产 registry 让 `list-ordered-empty-successor-lift` 位于 isolated/first/tail/interior/broad owners之前并设置 `legacyRetired:true`。PM topology/两 Step尚未证明时 `recognized=false`；一旦 family已证明，source range/authored bytes/mapper/semantic失败均为 `recognized=true`，从而 `legacyBlocked=true`，broad list-subtree与legacy canonical-diff不得救援。

## 10. 真实 fail-closed 负例

永久 Electron 负例使用 row 前一个空格（`[space]` 表示空 item marker 后的一个空格）：

```text
 1. alpha

 2.[space]

 3. beta
```

parser仍挂载为相同 ordered PM并产生同一两 Step Backspace，但 authored source range不满足 focused top-level proof。永久要求 rich编辑保留、warning出现、focused/broad/legacy/Coordinator均无成功 publication、disk原样不变。

## 11. 永久门禁

focused：`test:list-ordered-empty-successor-lift-transaction-owner`、`test:list-ordered-empty-successor-lift-transaction-ui`、`test:list-ordered-empty-successor-lift-legacy-retirement-ui`、`test:single-empty-ordered-backspace-successor-ui`。

正向覆盖 callback、forced flush、BOM+CRLF、`)` delimiter、source、save、disk、fresh-profile reopen、focused-only publication。

相邻覆盖 0.13.154 isolated ordered、first/tail/interior正负、RS-63/60/84/85/86、nested Enter、ordered Enter/exit/delimiter/repeated lists、generic list-subtree pure/UI。

全局覆盖 Journal、provenance、Coordinator、source transaction sync、完整 preservation、39/39 probes、mixed rich/source、heterogeneous fidelity、desktop/mobile build、`git diff --check`。

## 12. 下一 family

当前 owner刻意拒绝四项及更长 ordered list。下一步先捕获：

```text
1. alpha
2. [empty]
3. beta
4. gamma
```

以及非 `order=1` 起点、`.`/`)` delimiter下的真实行为，确认 `3→2, 4→3, ...` 是一笔还是多笔 transaction、多少 ReplaceAroundStep、每步 stepDoc/gap/insert/slice，以及多个 successor row 的 raw ownership。真实证据完成前不得把当前 owner直接改为 `childCount >= 3`。
