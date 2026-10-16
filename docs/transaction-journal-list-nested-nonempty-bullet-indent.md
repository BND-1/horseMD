# Transaction Journal：nested nonempty bullet indent

## 目标

0.13.158 迁移 Stage E nested-list 的第二个 focused family：顶层 plain bullet list 中一个非空 middle 或 tail item 按物理 Tab，通过 ProseMirror `sinkListItem` 成为紧邻前一 sibling 的 nested child。

0.13.157 已拥有 tail-empty Tab sink。0.13.158 不扩大 empty owner，而是建立 `list-nested-nonempty-bullet-indent`，因为非空 nested row有不同且更简单的 authored Markdown byte contract。

## Scope

old doc必须满足：

- 变化发生在一个顶层 `bullet_list`；
- target index ≥ 1，可为 middle 或 tail；
- target 是 non-task plain bullet `list_item`；
- target 只有一个直接 paragraph；
- paragraph非空，所有inline children都必须是无 marks text；
- 紧邻前一 item 是 non-task plain bullet item；
- parent 只有一个无 marks 非空 plain paragraph；
- parent old doc中没有任何 nested block；
- 其它 siblings未变化。

以下明确不属于本family：

- empty target（0.13.157）；
- first item；
- parent已有nested list；
- task item；
- ordered list；
- marks / inline atoms / 多paragraph item；
- Shift+Tab outdent；
- nested split/join。

## 真实物理 Step

最小schema使用当前依赖的真实 `sinkListItem`，以及HorseMD Electron物理Tab对tail/middle的trace都得到同一家族：

- 单次 document-changing transaction；
- 单一 `ReplaceAroundStep`；
- `structure=true`；
- `sliceSize=3`；
- `openStart=1`；
- `openEnd=0`；
- `insert=1`。

对于任意target：

- `target.beforePos === parent.beforePos + parent.nodeSize`；
- `step.from === target.beforePos - 1`；
- `step.gapFrom === target.beforePos`；
- `step.to === target.beforePos + target.nodeSize`；
- `step.gapTo === step.to`。

Step必须在捕获的 `stepDoc` 上apply，并精确得到Journal expectedDoc。

## old → new topology

old：

```text
- alpha
- beta
- gamma
```

若target为tail `gamma`，new语义为：

```text
- alpha
- beta
  - gamma
```

若target为middle `beta`，new语义为：

```text
- alpha
  - beta
- gamma
```

owner不根据Markdown形状识别，而要求：

- top-level list childCount减少1；
- parent仍位于 `targetIndex - 1`；
- parent attrs与原parent精确一致；
- parent原paragraph精确一致；
- parent新增长度为1的nested `bullet_list`；
- nested唯一child必须与old target `.eq()`；
- target之前除parent外siblings完全不变；
- target之后siblings只向前一位且逐项 `.eq()`。

这使middle与tail能共享一个family，而不会把其它list拓扑吞进来。

## Milkdown wrapper attrs

真实HorseMD Electron trace有一个重要细节：

- parsed top-level bullet list为 `spread:"false"`；
- `sinkListItem` 创建的nested list wrapper为 `spread:false`；
- Step slice中的外层临时 `list_item` wrapper可能是 `spread:true`；
- 但最终live newDoc parent attrs仍保持old parent的 `spread:"false"`。

因此：

- owner只把nested `bullet_list` wrapper的 `false` 与 `"false"` 视为同一语义；
- final parent attrs必须与old parent精确一致；
- moved target item必须与old target精确 `.eq()`；
- **不把Step slice外层list_item attrs当source ownership依据**。

这样避免将ProseMirror临时wrapper实现细节误当作者语义。

## Raw source patch

### Parser proof

CommonMark / remark实测：

```text
- beta
  - gamma
```

以及：

```text
+ beta
  + gamma
```

均稳定解析成parent + nonempty nested child，不需要0.13.157 empty nested item所需的额外blank line。

middle case：

```text
+ alpha
  + beta
+ gamma
```

也稳定解析成alpha parent + nested beta，并保持gamma为top-level sibling。

### Byte contract

source-map先用parent plain paragraph定位同一顶层作者list block。当前raw proof要求：

- source同级marker row数量等于old PM list item数；
- 所有top-level source rows indent为0；
- 所有rows使用同一作者bullet token `-` / `+` / `*`；
- marker spacing恰为一个ASCII space；
- parent source body精确等于PM parent plain text；
- target source body精确等于PM target plain text。

成功patch只有一个byte insertion：

`targetRow.start` 前插入两个ASCII spaces。

不新增EOL，不删除任何row，也不重写marker。

因此保持：

- 作者bullet token；
- marker spacing；
- parent/target正文；
- middle target之后的top-level siblings；
- BOM；
- LF/CRLF；
- list外所有邻块和其它字节。

## Validation

本family不需要semantic transient例外。

nonempty nested item具有直接合法Markdown表示，所以patch后必须通过生产 `validateTransactionMarkdown`：

- parser结果与live `expectedDoc` 等价；
- strict list-slot gate通过；
- 没有 `<br />` 或其它editor-only占位符。

proof记录：

- Journal id/revision/source/canonical provenance；
- `targetIndex` / `parentIndex`；
- `position: middle | tail`；
- parent/target/nested list/nested item paths；
- exact `ReplaceAroundStep`字段；
- source range与作者parent/target row；
- `rawInsertion = "  "`；
- source/canonical/result digests。

## Legacy retirement

production registry将nonempty owner放在：

1. 0.13.157 empty tail-indent owner之后；
2. ordered successor focused owners之前；
3. broad `list-subtree-replace`之前。

并设置 `legacyRetired:true`。

当PM topology/Step尚未证明时返回 `recognized:false`，其它owners仍可继续分类。

一旦exact nonempty sink family已证明，而source row无法按当前raw合同安全证明，则返回 `recognized:true`，共享registry设置 `legacyBlocked:true`。

典型永久负例为两空格marker spacing：

```text
-  alpha
-  beta
-  gamma
```

PM仍会产生相同 `sinkListItem` transaction，但当前source byte合同刻意不泛化。此时：

- rich Tab sink保持；
- nested item仍可见；
- empty owner不得接管；
- broad list-subtree不得接管；
- legacy canonical mapper不得接管；
- Coordinator不得publication；
- warning可见；
- disk保持原fixture。

raw target body与PM plain text不一致时也同样recognized fail closed。

## 永久回归

### Pure owner

`test:list-nested-nonempty-bullet-indent-transaction-owner`

使用当前真实 `sinkListItem`，覆盖：

- tail target；
- middle target；
- exact ReplaceAround Step字段和range/gap关系；
- BOM + CRLF；
- authored `+` marker；
- raw insertion只有两个spaces；
- wide marker spacing -> recognized rejection；
- raw target body mismatch -> recognized rejection；
- wrong Step gap -> recognized rejection；
- empty target -> no-hit；
- parent已有nested -> no-hit；
- task -> no-hit；
- ordered -> no-hit。

### Real Electron

`test:list-nested-nonempty-bullet-indent-transaction-ui`

包含两条真实物理输入：

- tail callback：BOM+CRLF，作者 `+`，target `gamma`；
- middle forced-flush：BOM+CRLF，作者 `-`，target `beta`。

两条都要求：

- focused owner仅成功publication一次；
- boundary分别为markdown-updated / forced-flush；
- 0.13.157 empty owner无publication；
- broad owner无publication；
- source只增加两个spaces；
- 作者marker保持；
- source/save/disk精确；
- fresh-profile cold reopen保持nested结构和原source bytes。

### Legacy retirement

`test:list-nested-nonempty-bullet-indent-legacy-retirement-ui`

两空格作者marker必须产生：

- focused `recognized:true + legacyBlocked:true`；
- no empty/broad/legacy publication；
- no Coordinator publication；
- rich indent保留；
- warning出现；
- disk不变。

## 已通过相邻矩阵

- 0.13.157 empty tail-indent正向与retirement；
- RS-64 empty Tab→继续输入→save/reopen；
- rich-source continuous fidelity；
- nested 3×2 continuous + slow；
- generated scratch empty ordered indent；
- nested Enter empty sibling；
- rapid nested parent Backspace；
- empty bullet after nested Backspace；
- empty ordered parent before nested Backspace；
- 0.13.154 isolated ordered；
- 0.13.155 single ordered successor；
- 0.13.156 multi-successor chain；
- generic list-subtree callback/forced。

## 已通过全局资格门禁

- SourceSyncTransactionJournal；
- SourceSyncCoordinator；
- source transaction sync；
- complete Markdown preservation；
- source-fidelity probes 39/39；
- mixed rich/source Electron；
- heterogeneous source-fidelity Electron；
- desktop build；
- mobile build；
- `git diff --check`。

## 后续边界：Shift+Tab outdent必须继续拆

0.13.158 收口时的 generic-minimal `liftListItem` 对比只用于证明“outdent不是一个可以直接做宽owner的单一族”。其中 single nested child 曾被记录为 `sliceSize=0`，这不是 HorseMD 真实产品合同。

0.13.159 后续真实 Electron 取证与使用 HorseMD 同款 list attrs 的最小 schema 已一致证明：single nested child 是单 `ReplaceAroundStep(structure=true,sliceSize=1,openStart=1,openEnd=0,insert=1)`，并已迁入独立 `list-nested-single-child-bullet-outdent` owner。

multi-child 的 first/last child 具体 Step 数量、slice size 与 open depth 仍必须重新用真实 HorseMD 取证；旧 generic-minimal 参数只保留为历史线索，不再作为正式合同。下一步先分别抓 first-child / last-child Shift+Tab，再决定是否能共享 family；nested split/join继续排在outdent子族之后。
