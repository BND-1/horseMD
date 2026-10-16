# Transaction Journal：nested last-child bullet outdent

## 目标

0.13.160 迁移 Stage E multi-child outdent 的第一个 focused family：顶层 plain bullet parent 下有至少两个 plain nested bullet children 时，最后一个非空 child 按物理 Shift+Tab 提升为紧随 parent 的 top-level bullet item。

0.13.159 已处理 nested list 只有一个 child 的情况。真实 HorseMD 取证证明 multi-child 的 first child 与 last child 不是同一 PM family，所以 0.13.160 只处理 last-of-multiple。

## Scope

old doc 必须满足：

- 变化只发生在一个 top-level `bullet_list`；
- parent 是 non-task plain bullet item；
- parent 直接children恰为一个无marks非空paragraph + 一个 nested `bullet_list`；
- nested list `spread` 为 false-like；
- nested list childCount >= 2；
- nested 中每个 child 当前都要求 non-task plain bullet item；
- 每个 nested child 恰有一个无marks非空 paragraph；
- target 固定为 nested list 的最后一项；
- 其它 top-level siblings 与 blocks 不变。

明确排除：

- first-of-multiple；
- single child（0.13.159）；
- empty target；
- task；
- ordered nested list；
- marks、atoms、多paragraph或更复杂nested children；
- nested split/join。

## 真实 Step

真实 HorseMD 两子项：

```text
- alpha
- beta
  - gamma
  - delta
- omega
```

对 `delta` Shift+Tab，doc-changing transaction 只有一笔 `ReplaceAroundStep`：

- `structure=true`；
- `insert=2`；
- `sliceSize=2`；
- `openStart=2`；
- `openEnd=0`。

HorseMD 同款 attrs 的最小 schema 对2个和3个 nested children均得到同一结构公式。

设：

- parent path = `[topLevelIndex,parentIndex]`；
- nested path = `[topLevelIndex,parentIndex,1]`；
- target path = `[topLevelIndex,parentIndex,1,targetIndex]`；
- `targetIndex === nestedCount - 1`。

则必须：

- `step.from === target.beforePos`；
- `step.gapFrom === target.beforePos`；
- `step.gapTo === target.beforePos + target.nodeSize`；
- `step.to === parent.beforePos + parent.nodeSize`。

slice 外层是一个空 `list_item` wrapper：

- attrs 与 old target attrs 精确一致；
- 唯一 child 是空 `bullet_list` wrapper；
- nested wrapper attrs 与 old nested list attrs 精确一致。

Step 必须在捕获 `stepDoc` 上 apply，并精确得到 expectedDoc。

## Topology

两子项 old：

```text
- beta
  - gamma
  - delta
```

new：

```text
- beta
  - gamma
- delta
```

三子项 old：

```text
- alpha
  - beta
  - gamma
  - delta
- omega
```

new：

```text
- alpha
  - beta
  - gamma
- delta
- omega
```

focused owner 要求：

- top-level list attrs不变；
- new top-level childCount = old + 1；
- parent 保持原 index；
- parent paragraph精确不变；
- parent nested list保留 old target 前全部children，attrs不变、prefix逐项`.eq()`；
- target提升到`parentIndex+1`且与old target `.eq()`；
- parent后的old top-level siblings整体后移一位且逐项不变。

## Raw source byte contract

为了避免 broad list serializer 改写作者marker，本owner同时source-map parent与全部nested child paragraphs。

当前安全合同要求：

- parent authored row indent = 0；
- 所有 nested authored row indent恰为两个ASCII spaces；
- parent与全部nested rows物理连续，无blank/continuation；
- 全部rows使用同一个作者bullet token `-` / `+` / `*`；
- marker spacing恰为一个ASCII space；
- 每行raw body精确等于对应PM plain text。

成功patch只有：

- 删除最后target row开头两个spaces。

不会：

- 改前面nested prefix缩进；
- 改marker；
- 改正文；
- 新增/删除EOL；
- 改BOM或LF/CRLF；
- 改邻块。

例如：

```text
+ beta
  + gamma
  + delta
```

变为：

```text
+ beta
  + gamma
+ delta
```

## Validation

last-child outdent 有直接合法 Markdown 表示，不需要 semantic transient 例外。

candidate 必须直接通过生产 `validateTransactionMarkdown`：

- parser doc 与 live expectedDoc等价；
- strict list-slot gate通过；
- 无editor-only placeholder。

proof绑定：

- Journal provenance；
- `nestedCount` / `targetIndex`；
- parent/nested/target old paths与target new path；
- exact ReplaceAround fields；
- parent + 全部nested source rows；
- `rawRemoval.removed === '  '`；
- source/canonical/result digests。

## Legacy retirement

registry 顺序：

1. empty-tail indent；
2. nonempty indent；
3. single-child outdent；
4. last-child outdent；
5. ordered focused owners；
6. broad list-subtree。

本 family 设置 `legacyRetired:true`。

PM topology/Step尚未证明时`recognized:false`，继续其它owner。

一旦exact last-child family已证明，而raw source当前合同失败，则`recognized:true + legacyBlocked:true`。

永久负例使用 target marker padding：

```text
+ beta
  + gamma
  +  delta
```

PM仍是相同plain nested list，但当前byte合同不猜测padding归一化。此时：

- rich outdent保留；
- target成为top-level；
- single-child/broad/legacy均不得publication；
- Coordinator不得publication；
- warning出现；
- disk保持fixture。

## 永久回归

### Pure

`test:list-nested-last-child-bullet-outdent-transaction-owner`

覆盖：

- 2-child last target；
- 3-child last target；
- exact `insert=2/sliceSize=2/openStart=2`；
- exact from/to/gap relation；
- BOM+CRLF `+`；
- raw只删除target两个spaces；
- wide indent / mixed marker / wrong gap -> recognized rejection；
- first-child -> no-hit；
- single-child -> no-hit；
- empty/task/ordered -> no-hit。

### Real Electron positive

`test:list-nested-last-child-bullet-outdent-transaction-ui`

- 2-child callback：作者`+`，target `delta`；
- 3-child forced：作者`-`，target `delta`。

要求：

- focused publication一次；
- callback/forced boundary正确；
- proof nestedCount/targetIndex正确；
- single-child和broad无publication；
- prior nested prefix保持；
- source/save/disk/fresh-profile reopen精确。

### Retirement

`test:list-nested-last-child-bullet-outdent-legacy-retirement-ui`

两空格marker padding target必须：

- `recognized:true + legacyBlocked:true`；
- rich outdent保持；
- no single/broad/legacy/Coordinator publication；
- warning出现；
- disk不变。

## First-child isolation

真实multi-child diagnostic在production接线后再次证明：

- first child `gamma`：同一个doc-changing transaction内有两笔`ReplaceAroundStep`；
- 第一笔先把后继`delta`挂到`gamma`下；
- 第二笔完成`gamma`从`beta`下提升到top-level；
- 最终source为 `- gamma` + `  - delta`；
- 0.13.160 last-child owner no-hit；
- 当前继续由 `list-subtree-replace` 发布。

因此 first-of-multiple 必须是下一独立 family，不能扩宽当前owner。

## 已通过门禁

focused：

- pure；
- desktop build；
- 2-child callback；
- 3-child forced；
- marker-padding retirement。

相邻：

- 0.13.159 single-child正向/retirement；
- 0.13.157/158 indent；
- real multi-child first/last diagnostic；
- continuous/nested 3×2 fidelity；
- nested Enter；
- RS-68/63/85；
- 0.13.154–156 ordered families；
- generic list-subtree callback/forced。

全局：

- Journal；
- Coordinator；
- source transaction；
- full Markdown preservation；
- 39/39 probes；
- mixed rich/source；
- heterogeneous fidelity；
- desktop build；
- mobile build；
- `git diff --check`。

仅有既有Vite large-chunk warning。

## 下一步

0.13.161 候选是 **first-of-multiple plain bullet Shift+Tab outdent**。

必须先把真实两Step链写成stepDoc-bound pure contract：

1. 第一 `ReplaceAroundStep` 重构target与后继nested siblings；
2. 第二 `ReplaceAroundStep` 完成外层lift；
3. 中间doc必须与第一Step apply结果一致；
4. raw source只给target行去两个spaces，后继rows保持两个spaces，从而转为target的nested children；
5. callback/forced、BOM/CRLF、source/save/reopen和retirement都独立验证。

完成first-of-multiple后再进入nested split/join。