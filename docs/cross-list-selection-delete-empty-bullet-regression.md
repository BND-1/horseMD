# RS-84：跨列表选区删除为单个空 bullet 回归

> 修复版本：HorseMD 0.13.129  
> 首发现场：正式安装版 0.13.128，PID 90936  
> Trace：`horsemd-input-trace-90936.jsonl`  
> 第一处失败：2026-08-26 16:07:25.136，line 29，`unmapped-diverged-list-batch`  
> 第二处失败：2026-08-26 16:07:25.620，line 35，`source-list-structure-mismatch`

## 1. 真实操作

用户在长期编辑、source/canonical 已存在合法 marker、空行、U+200B 与嵌套列表拼写分叉的文档中创建了一个反向选区：

```md
- 看了呢分

2. 斛律v哦

- u高科技
- 1\. 色粉色分
```

选区从 `看了呢分` 正文的左边界开始，跨过独立 ordered item，结束于 `u高科技` 正文右边界。trace 中 selection 为 backward：anchor 77、head 53、from 53、to 77。

第一次 Backspace 的 ProseMirror replace 合法把整个选区替换成一个空 bullet item，保留原后继 bullet：

```md
* <br />

* 1\. 色粉色分
```

第二次 Backspace 再把该空 bullet 提升为顶层空 paragraph：

```md
<br />

* 1\. 色粉色分
```

这是两拍不同但连续的结构事务。

## 2. 第一拍旧链路为什么失败

旧 `preserveBatchedListBlockChanges` 将变化看成三棵列表的独立差异：

1. 前一 bullet list 删除；
2. 中间 ordered list 删除；
3. 后一 bullet list 首项删除并出现空首项。

但 ProseMirror 的真实语义是一次跨块 replace，三个旧块共同折叠成一个空 bullet。分块处理无法原子证明，返回：

```text
unmapped-diverged-list-batch
```

富文本 DOM 已正确删除内容，但 source/canonical baseline 没有推进。

## 3. 第二拍为什么又失败

第一拍 fail closed 后，第二拍仍拿旧 source 和旧 canonical 与新的 live canonical 比较。既有 `empty-list-item-removed` 只找到 source 中第一个候选 bullet `- 看了呢分`，删除它以后其余 selected rows 仍在，严格 list fingerprint 因此报：

```text
source-list-structure-mismatch
```

修复第一拍后，canonical baseline 会推进为“空 bullet + survivor”；第二拍就重新成为既有 `empty-list-item-removed` 能正确拥有的单空项删除。

## 4. 第一拍专用 raw owner

新增：

```text
preserveCrossListSelectionDeleteToEmptyBullet
```

发布 reason：

```text
diverged-cross-list-selection-delete-to-empty-bullet
```

它在 raw previous/next 阶段运行，排在 `<br />` normalization、RS-82 和 broad multi-list mapping 前。只有以下条件全部成立才认领：

1. previous 中是三个顶层、非任务、非空 list rows；
2. 三行结构严格为 bullet → ordered → bullet；
3. 第一与第三 bullet 使用同一 canonical token；
4. 第三行后紧跟一个未变化的同级 bullet survivor；
5. 第一/第二、第二/第三之间均有真实 block gap；
6. next 用一个同 token 的 `* <br />` 空 bullet 原位替换三行；
7. previous/next 在目标前缀与 survivor 起点后的后缀逐字相同；
8. 左侧非空可见锚、三个正文和 survivor 正文在 source 中唯一；
9. source 目标不在 fenced code 内；
10. 同 callback 无关正文变化、重复目标、非空 replacement 全部拒绝。

命中后只将 source 中三行完整范围替换为第一行作者 marker prefix，例如：

```md
- 
```

输出：

```md
吗；啊嗯

- 
- 1\. 色粉色分
```

作者 `-`、紧凑 survivor、EOL、CRLF、fence、U+200B 和其它字节全部不动。通用 semantic/list integrity 没有放宽。

## 5. 自动化额外发现的第二拍字节漂移

第一拍 owner 完成后，真实双 Backspace UI 的第二拍已经满足：

```text
reason=empty-list-item-removed
semanticOk=true
listSlotsMatch=true
ok=true
warning=0
```

但精确 source oracle 发现旧实现将：

```md
吗；啊嗯

- 1\. 色粉色分
```

静默压成：

```md
吗；啊嗯
- 1\. 色粉色分
```

解析语义仍可通过，因此普通 integrity 不会报告；只有字节级保存/冷重开断言能抓到。

根因是 `preserveEmptiedParagraph` 的 empty-list-item removal 将空项前所有多余换行都视为列表内部 Enter placeholder。RS-84 的空项却是一个新 bullet list 的第一项，前方空行属于普通 paragraph 到 surviving list 的作者 block boundary。

0.13.129 收窄 prefix collapse：仅当被删行属于列表内部时继续压缩；若满足以下严格形状则保留 block gap：

1. 被删行是顶层 bullet；
2. 后继仍是顶层 bullet；
3. 左侧最近非空 source 行不是 list row。

原有 list-internal empty bullet、nested bullet、task item 和 trailing-list exit 行为保持不变。

## 6. 永久回归

### 6.1 纯函数

```bash
npm run test:markdown-preservation
npm run test:source-fidelity-probes
```

覆盖：

- 第一拍 direct owner 与 facade reason；
- exact authored source；
- CRLF；
- 同 callback 无关正文变化拒绝；
- source 重复 target 拒绝；
- 非空 replacement 拒绝；
- 第二拍 `empty-list-item-removed`；
- 第二拍 LF/CRLF block gap；
- source probes 37/37。

PID 90936 的两拍完整 trace 已按修复后的正确 baseline 顺序回放：

```text
original source + original previous -> first canonical
first output source + first canonical -> second canonical
```

结果分别为：

```text
diverged-cross-list-selection-delete-to-empty-bullet
empty-list-item-removed
```

## 7. 真实 Electron 自测

```bash
npm run test:cross-list-selection-delete-empty-bullet-ui
```

测试不使用直接 source 注入模拟操作，而是在 DOM 中建立与 trace 相同的 backward selection，并发送两次物理 Backspace。每一拍单独清空并检查 preservation/integrity trace。

验收：

```text
第一拍：专用 RS-84 owner
第二拍：empty-list-item-removed
两拍 semanticOk=true
两拍 listSlotsMatch=true
两拍 ok=true
integrity false=0
warning toast=0
source exact
save exact
cold reopen exact
```

测试 fixture 还包含 fence、U+200B、混合 marker、nested list 和远端 ordered list，避免只在干净最小文档上通过。

## 8. 相邻门禁

已通过：

```text
完整 markdown-preservation
source probes 37/37
普通 empty bullet Backspace
nested-list 后 empty bullet Backspace
single-empty ordered successor
RS-59 escaped standalone paragraph
RS-68 5ms / 18ms / 70ms
RS-72 single empty ordered
RS-82 non-empty bullet merge
RS-83 thematic break
exit-list dash + Space
source transaction sync
heterogeneous source-fidelity UI
完整 build
```

本修复不尝试拥有任意跨块删除。只有严格的顶层 bullet→ordered→bullet 三行删除为单个空 bullet 才由 RS-84 owner 处理；其它结构继续走原 owner 或 fail closed。
