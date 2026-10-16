# Transaction Journal：nested single-child bullet outdent

## 目标

0.13.159 迁移 Stage E nested-list 的第三个 focused family：顶层 plain bullet parent 下唯一一个非空 nested bullet child 按物理 Shift+Tab，通过 ProseMirror `liftListItem` 提升回同一顶层 bullet list。

0.13.157 / 0.13.158 已分别拥有 empty-tail 与 nonempty middle/tail 的 Tab sink。0.13.159 只处理最窄 outdent，不把 multi-child、empty、task 或 ordered 一并泛化。

## Scope

old doc 必须满足：

- 变化发生在一个顶层 `bullet_list`；
- parent 是 non-task plain bullet `list_item`；
- parent 直接 children 恰为两个：一个无 marks 非空 plain paragraph + 一个 nested `bullet_list`；
- nested `bullet_list` 的 `spread` 为 false-like；
- nested list 恰有一个 child；
- target 是 non-task plain bullet item；
- target 恰有一个无 marks 非空 plain paragraph；
- 其它 top-level siblings 和 blocks 不变。

以下明确不属于本 family：

- nested list 有两个或更多 children；
- empty target；
- task target / task parent；
- nested ordered list；
- marks、inline atoms、多 paragraph 或更多 nested blocks；
- Tab sink；
- nested split/join。

## 真实物理 Step

最初在 0.13.158 收口时做过一个 generic-minimal `liftListItem` 比较，其中 single-child 被暂记为 `sliceSize=0`。该结果不是 HorseMD 的真实合同。

0.13.159 用两层证据重新钉死：

1. HorseMD Electron 对真实 authored Markdown 执行物理 Shift+Tab；
2. 使用 HorseMD 同款 list attrs（`spread:"false"`、`listType:'bullet'`、`label:'•'`）的最小 schema 调用当前依赖的真实 `liftListItem`。

两者完全一致：

- 单次 document-changing transaction；
- 单一 `ReplaceAroundStep`；
- `structure=true`；
- `sliceSize=1`；
- `openStart=1`；
- `openEnd=0`；
- `insert=1`。

设 old path 为：

- parent：`[topLevelIndex, parentIndex]`；
- nested list：`[topLevelIndex, parentIndex, 1]`；
- target：`[topLevelIndex, parentIndex, 1, 0]`。

精确边界为：

- `step.from === nestedList.beforePos`；
- `step.to === parent.beforePos + parent.nodeSize`；
- `step.gapFrom === target.beforePos`；
- `step.gapTo === target.beforePos + target.nodeSize`；
- `target.beforePos === nestedList.contentStart`。

Step slice 唯一 child 是一个空 `list_item` wrapper；它的 attrs 必须与 old target attrs 精确一致。

Step 必须在 Journal 捕获的 `stepDoc` 上 apply，并精确得到 live `expectedDoc`。

## old → new topology

old：

```text
- alpha
- beta
  - gamma
```

new：

```text
- alpha
- beta
- gamma
```

如果 parent 本身是第一项且后面还有 sibling：

```text
- alpha
  - beta
- gamma
```

Shift+Tab 后必须是：

```text
- alpha
- beta
- gamma
```

focused owner 要求：

- top-level `bullet_list` attrs 不变；
- new childCount = old childCount + 1；
- old parent 保持原 index；
- new parent 只保留 old parent paragraph，attrs 与 paragraph均精确不变；
- old target 被提升到 `parentIndex + 1`，节点与 old target `.eq()`；
- old parent 之前 siblings 不变；
- old parent 之后 siblings只整体后移一位并逐项 `.eq()`；
- 其它 top-level blocks 完全不变。

## Raw source patch

### 当前安全 byte contract

owner 通过 parent paragraph 与 target paragraph 的 PM source-map offset 锚定作者两行。

当前成功合同要求：

- parent row 是顶层 bullet：indent = `''`；
- target row indent 恰为两个 ASCII spaces；
- parent / target 都是 `-`、`+` 或 `*` bullet；
- 两行使用同一个作者 bullet token；
- 两行 marker spacing 都恰为一个 ASCII space；
- parent raw body 精确等于 parent PM plain text；
- target raw body 精确等于 target PM plain text；
- target 物理行紧跟 parent 行，中间没有 blank line 或 continuation。

成功 patch 只有一个 byte removal：

`targetRow.start` 开始删除两个 ASCII spaces。

不会：

- 改写作者 marker；
- 改正文；
- 新增或删除 EOL；
- canonicalize LF/CRLF；
- 改 BOM；
- 改 sibling 或邻块。

因此：

```text
+ beta
  + gamma
```

只变为：

```text
+ beta
+ gamma
```

## Validation

本 family 不需要 semantic transient 例外。

single nonempty nested child 提升为 top-level item 有直接合法 Markdown 表示，所以 patch 后必须直接通过生产 `validateTransactionMarkdown`：

- parser document 与 live `expectedDoc` 等价；
- strict list-slot gate 通过；
- 无 `<br />` 或 editor-only placeholder。

proof 记录：

- Journal id / base revision / source / canonical provenance；
- `topLevelIndex` / `parentIndex`；
- parent / nested list / nested item old paths；
- target new path；
- exact `ReplaceAroundStep` fields；
- 作者 parent / target row；
- `rawRemoval.removed === '  '`；
- source / canonical / result digests。

## Legacy retirement

production registry 顺序：

1. `list-nested-empty-bullet-tail-indent`；
2. `list-nested-nonempty-bullet-indent`；
3. `list-nested-single-child-bullet-outdent`；
4. ordered focused list owners；
5. broad `list-subtree-replace`。

本 owner 设置 `legacyRetired:true`。

PM topology / Step 尚未完整证明时返回 `recognized:false`，让其它 family 继续分类。

一旦 exact single-child lift 已证明，但 raw source 当前合同无法证明，则返回 `recognized:true`，registry 统一设置 `legacyBlocked:true`。

永久 fail-closed 例子：

```text
+ beta
  * gamma
```

PM 仍可产生同一个 plain bullet lift，但作者 parent/target marker 不同。当前不猜“提升后应该保留哪个 marker”，因此：

- rich Shift+Tab outdent 保持；
- target 在 rich editor 中成为 top-level；
- 0.13.157/158 indent owners 不得接管；
- broad list-subtree 不得接管；
- legacy mapper 不得接管；
- Coordinator 不 publication；
- warning 可见；
- disk 保持原 fixture。

四空格 target indentation、raw body mismatch 也按同样方式 fail closed。

## 永久回归

### Pure owner

`test:list-nested-single-child-bullet-outdent-transaction-owner`

覆盖：

- 真实 `liftListItem`；
- exact `ReplaceAroundStep` range / gap / slice；
- `sliceSize=1/openStart=1/openEnd=0/insert=1`；
- BOM + CRLF；
- authored `+` marker；
- source 只删除两个 spaces；
- four-space indent -> recognized rejection；
- mixed marker -> recognized rejection；
- wrong gap Step -> recognized rejection；
- multi-child -> no-hit；
- empty target -> no-hit；
- task -> no-hit；
- ordered nested list -> no-hit。

### Real Electron

`test:list-nested-single-child-bullet-outdent-transaction-ui`

两条真实物理 Shift+Tab：

- callback：parent 是第二项，BOM+CRLF，作者 `+`，target `gamma`；
- forced-flush：parent 是第一项且后面仍有 sibling，BOM+CRLF，作者 `-`，target `beta`。

要求：

- focused owner 仅成功 publication 一次；
- boundary 分别为 markdown-updated / forced-flush；
- 0.13.157 / 0.13.158 indent owners 无 publication；
- broad owner 无 publication；
- source 只少两个 indentation spaces；
- 作者 marker 不变；
- source/save/disk 精确；
- fresh-profile cold reopen 为三个 top-level items。

### Legacy retirement

`test:list-nested-single-child-bullet-outdent-legacy-retirement-ui`

mixed marker authored fixture 必须产生：

- focused `recognized:true + legacyBlocked:true`；
- no indent / broad / legacy publication；
- no Coordinator publication；
- rich outdent 保留；
- warning 出现；
- disk 不变。

## 已通过相邻矩阵

- 0.13.157 empty tail-indent；
- 0.13.158 nonempty middle/tail-indent + retirement；
- rich-source continuous fidelity；
- nested 3×2 continuous + slow；
- nested Enter empty sibling；
- rapid nested parent Backspace；
- empty bullet after nested Backspace；
- empty ordered parent before nested Backspace；
- generated scratch nested empty Backspace；
- generated scratch empty ordered indent；
- 0.13.154 isolated ordered；
- 0.13.155 single ordered successor；
- 0.13.156 multi-successor chain；
- generic list-subtree callback/forced。

相邻矩阵第一次执行最后一项时因既有 CDP 端口被占用退出；该项随后使用独立端口单独重跑并通过。没有把端口占用误判成代码失败。

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

仅存在既有 Vite large-chunk warning，无 build failure。

## 下一步边界

0.13.160 已完成 multi-child 的 **last-of-multiple** 子族：nestedCount>=2 的最后一项是单 `ReplaceAroundStep(insert=2,sliceSize=2,openStart=2)`，只删除目标作者行两个spaces并保留nested prefix。

真实 HorseMD 已同时证明 **first-of-multiple 是不同 family**：两子项场景在同一个 document transaction 中有两笔 `ReplaceAroundStep`。第一步先重构被提升项与剩余nested siblings的归属，第二步再完成外层lift；最终被提升的第一项成为top-level，同时仍持有原后继nested siblings。它不能与single-child或last-child owner合并。

下一轮只迁移 first-of-multiple，必须绑定两Step各自的`stepDoc`、slice attrs与中间doc，并证明raw source只对被提升第一行去缩进、后继nested rows仍保持原两个spaces且语义转为被提升项的nested children。完成后再进入nested split/join；task sentinel、conversion、input rules与跨列表/coalescing继续排后。