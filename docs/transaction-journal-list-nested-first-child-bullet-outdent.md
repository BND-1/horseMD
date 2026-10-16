# Transaction Journal：nested first-child bullet outdent

## 目标

0.13.161 迁移 Stage E nested-list 的第五个 focused family：顶层 plain bullet parent 下存在至少两个 nested plain bullet children 时，第一个 child 按物理 Shift+Tab 提升到顶层，同时原来的后继 nested children 继续挂在被提升 item 下。

这个 family 与 0.13.159 single-child、0.13.160 last-child 的物理 Step 都不同，必须独立证明。

## Scope

old doc 必须满足：

- 变化发生在一个顶层 `bullet_list`；
- parent 是 non-task plain bullet `list_item`；
- parent 直接 children 恰为一个无 marks 非空 paragraph + 一个 nested `bullet_list`；
- nested list `childCount >= 2`；
- nested 中每个 item 都是 non-task plain bullet item；
- 每个 nested item 恰含一个无 marks 非空 paragraph；
- target 固定为 nested index 0；
- 其它 top-level siblings / blocks 不变。

明确不属于本 family：

- single child；
- last child；
- empty child；
- task / ordered；
- marks、atoms、多 paragraph、多层复杂 nested；
- Tab sink；
- split/join。

## 真实两-Step Journal

真实 HorseMD 两子项与使用同款 list attrs 的 2/3-child `liftListItem` 一致：一次 document-changing transaction 内恰有两笔 `ReplaceAroundStep`。

### Step 1：把 successors 挂到 target

以 old nested `[gamma, delta]` 为例，target=`gamma`。

Step 1：

- `ReplaceAroundStep`；
- `structure=true`；
- `insert=1`；
- `sliceSize=3`；
- `openStart=1`；
- `openEnd=0`。

结构关系：

- `from = target.beforePos + target.nodeSize - 1`；
- `to = nested.beforePos + nested.nodeSize - 1`；
- `gapFrom = firstSuccessor.beforePos`；
- `gapTo = nested.beforePos + nested.nodeSize - 1`。

Step 1 的 slice 是一个 `list_item` wrapper，内部包含空 `bullet_list` wrapper；gap 把 target 后所有 successors 搬进这个 nested wrapper。

Step 1 必须在 Journal 捕获的第一个 `stepDoc` 上 apply，并精确等于第二个 `stepDoc`。

### Intermediate topology

Step 1 后 outer list childCount 尚未变化。

old：

```text
- beta
  - gamma
  - delta
```

intermediate：

```text
- beta
  - gamma
    - delta
```

3-child 情况 `[gamma, delta, epsilon]` 则 intermediate 为：

```text
- beta
  - gamma
    - delta
    - epsilon
```

proof 必须验证：

- parent paragraph不变；
- parent仍含一个nested list；
- 该nested list此时只有target；
- target attrs/paragraph不变；
- target新增nested list；
- 新nested list attrs等于old nested attrs；
- successors数量、顺序与节点逐项 `.eq()`；
- outer其它siblings不变。

### Step 2：完成 outer lift

Step 2：

- `ReplaceAroundStep`；
- `structure=true`；
- `insert=1`；
- `sliceSize=1`；
- `openStart=1`；
- `openEnd=0`。

它必须以 **Step 1 后的 stepDoc** 为输入。

在 intermediate doc 中：

- `from = intermediateNested.beforePos`；
- `to = intermediateParent.beforePos + intermediateParent.nodeSize`；
- `gapFrom = intermediateTarget.beforePos`；
- `gapTo = intermediateTarget.beforePos + intermediateTarget.nodeSize`。

Step 2 apply 后必须精确等于 live expectedDoc。

最终：

```text
- beta
- gamma
  - delta
```

3-child：

```text
- beta
- gamma
  - delta
  - epsilon
```

## Raw source patch

focused owner不尝试把 intermediate doc 写入源码；一次 publication只生成最终Markdown。

source-map 锚定：

- parent paragraph；
- target paragraph；
- 每个 successor paragraph。

当前安全 byte contract：

- parent indent = 0；
- 所有 nested rows indent恰为两个ASCII spaces；
- parent与全部nested rows物理连续；
- 全部使用同一作者 `-` / `+` / `*` token；
- marker spacing恰为一个space；
- raw body逐项等于old PM plain text。

成功 patch 只删除**第一 target row**开头两个spaces。

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

后继 rows 不移动、不改缩进。Markdown解析时它们自然成为 `gamma` 的 nested children，与最终 PM topology一致。

保留：

- 作者marker；
- BOM；
- LF/CRLF；
- 正文；
- successor bytes；
- outer siblings和邻块。

## Validation 与 retirement

本family不需要 semantic transient 例外；最终Markdown可以直接表达目标结构，必须通过生产 parser document equivalence 与 strict list-slot gate。

registry顺序保持 focused-first：single / last / first 均在 broad list-subtree 之前，first owner设置 `legacyRetired:true`。

若 topology + 两-Step chain 已证明，但 source byte contract不能证明，则返回 `recognized:true`，并由 registry 统一 `legacyBlocked:true`。

典型负例：

```text
+ beta
  +  gamma
  + delta
```

此时 rich outdent仍发生，但：

- first owner不publication；
- last/single owner不publication；
- broad/legacy不publication；
- Coordinator不publication；
- warning可见；
- disk不变。

## 永久回归

### Pure

`test:list-nested-first-child-bullet-outdent-transaction-owner`

覆盖：

- 2/3 nested children；
- Step 1 range/slice；
- Step 2 range/slice；
- `stepDocs[1]` intermediate topology；
- successor顺序与attrs；
- BOM+CRLF作者`+`；
- 最终source只删除target两个spaces；
- wide/mixed/wrong Step -> recognized fail closed；
- last/single/empty/task/ordered -> no-hit。

### Electron positive

`test:list-nested-first-child-bullet-outdent-transaction-ui`

覆盖：

- 2-child callback；
- 3-child forced-flush；
- `+` / `-` marker；
- source/save/disk；
- fresh-profile cold reopen；
- focused-only publication；
- successor继续nested在target下。

### Electron retirement

`test:list-nested-first-child-bullet-outdent-legacy-retirement-ui`

要求：

- marker spacing无法证明时 `recognized:true + legacyBlocked:true`；
- rich outdent保留；
- last/single/broad/legacy/Coordinator无publication；
- warning出现；
- disk逐字不变。

## 已通过相邻与全局门禁

相邻：

- 0.13.157 empty-tail indent；
- 0.13.158 nonempty middle/tail indent；
- 0.13.159 single-child outdent；
- 0.13.160 last-child outdent；
- continuous fidelity；
- nested 3×2 continuous/slow；
- generic list-subtree callback/forced。

全局：

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

仅存在既有 Vite large-chunk warning。

## 下一步

plain bullet 的基础 Tab / Shift+Tab 子族已按真实 Step 拆开。

下一阶段仍属于 Stage E，不跳阶段 F：先对 **nested split/join** 做真实 Electron 取证，比较 Enter split、Backspace/Delete join 的 transaction count、Step/stepDoc topology 与 source byte影响，优先迁移最小稳定子族。

之后再处理 task sentinel、conversion、input rules、跨列表/coalescing。
