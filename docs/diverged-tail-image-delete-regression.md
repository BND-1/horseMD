# RS-73：分叉长文档尾部 image atom 删除未进入作者源码

## 状态

- 修复版本：0.13.118
- 首次稳定暴露：`npm run test:family-matrix-ui` 的 `123321.md + plain`
- 专属 preservation reason：`diverged-tail-image-delete`
- 目标：修复第一笔真实分叉，不放宽 generic visible-stream mapper

## 现象

在真实 `123321.md` 上，family matrix 会在文档末尾追加普通 marker，再连续 Backspace `marker.length + 3` 次。marker 自身删除正常；额外 Backspace 会继续跨过尾部空段落，进入前一个深层 ordered-list item。

修复前，用户看到的富文本已经删掉尾部图片，但作者源码仍保留：

```md
![image.png](assets/image-20260811035152751.png)
```

随后 preservation 返回 `visible-stream-mismatch`，integrity trace 出现失败并弹出“富文本与源码不一致” warning。即使后续 flush 能处理别的删除，也不能把这次 first divergence 当作自愈通过。

## First-divergence 时间线

逐键 DOM / ProseMirror / preservation trace 把原来一个“连续删除失败”拆成了三笔真实动作：

1. marker 文本删到空后，第一下额外 Backspace 产生真实结构事务，把 caret 从尾部空 paragraph 带回前一个深层 ordered item；
2. 第二下额外 Backspace 删除该 item 尾部的 inline image atom；
3. 第三下额外 Backspace 再删除紧邻 image 的 hardbreak。

marker 行删除已经由既有 `diverged-tail-line-delete` 正确拥有。真正第一笔没有 source owner 的事务是第 2 步 image atom 删除。

## 根因

作者源码与 Crepe canonical 对同一图片的结构归属不同。

作者源码把图片保留为顶格独立尾行：

```md
   3. 根据招标信息、组织知识库信息，形成一个标书demo（参考<https://biaoshu.lianqiai.cn/>）是的v啊是v
![image.png](assets/image-20260811035152751.png)
```

而 remark / Crepe canonical 把同一 image atom 序列化为最深 ordered item 的 continuation：

```md
   3. 根据招标信息、组织知识库信息，形成一个标书demo（参考<https://biaoshu.lianqiai.cn/>）是的v啊是v
      ![image.png](assets/image-20260811035152751.png)
```

同时，这个长文档更早位置已经存在合法的 marker、缩进、Tab 等 authored/canonical 拼写分歧。图片 atom 本身又不贡献 visible characters。因此 generic visible-stream mapper 无法通过全文可见流定位这次删除，最终 fail closed。

这里不能通过“让 visible mismatch 更宽松”解决。image atom 是结构实体，必须由能证明其 exact source row 的专属 owner 接管。

## 修复边界

`src/renderer/src/lib/markdown-preservation/regions.js` 新增 `preserveDivergedTailImageDelete()`。它只认领以下全部条件同时成立的事务：

1. previous canonical 最后一个非空行是 Markdown image token；
2. 删除这一条最终 image 行即可完整解释 previous → next canonical 变化，最多忽略 terminal line-ending 数量；
3. 作者源码中存在完全相同的 image token，且只出现一次；
4. 该 source image 同样是作者源码最后一个非空行；
5. canonical image 前一非空行与 source image 前一非空行具有相同 visible text anchor；
6. 命中后只删除 authored image row 与其一个直接跟随 EOL，不改 surrounding list marker、Tab、缩进、空行或其它 source bytes。

任一证明失败都返回 `null`，继续走既有 mapper；不会因为 RS-73 放宽 generic `visible-stream-mismatch` 或 integrity gate。

`preserveRichMarkdownSourceCore()` 仅在 `sourceVisible !== previousVisible` 的 diverged 分支最前面询问这个 owner。原因是 image atom 为 zero-visible entity：如果先交给 visible mapper 猜位置，已经丢失最关键的结构所有权信息。

## 永久回归

新增：

```sh
node scripts/test-rs73-diverged-tail-image-delete.mjs
```

fixture 来自真实 trace 的 authored/canonical 尾部缩减，而不是手写一个“看起来类似”的 serializer 结果。它验证：

- unique tail image deletion 返回 `diverged-tail-image-delete`；
- 图片只从作者源码中删除；
- surrounding `\t` 与 mixed indentation 原样保留；
- source 中相同 image token 出现两次时，RS-73 owner 不得认领；
- 非尾部 image deletion 不属于该 owner。

## 真实 UI 验证

在当前 `out` build 上重跑 `scripts/tmp-repro-rs73.mjs` 的真实 `123321.md` 连续 Backspace 路径：

- marker 删除：`diverged-tail-line-delete / preserved=true`；
- image atom 删除：`diverged-tail-image-delete / preserved=true`；
- 两笔 integrity 都为 `ok=true / semanticOk=true / listSlotsMatch=true`；
- 整个逐键窗口 `toastCount=0`；
- 切源码后 image row 已消失。

随后对 `123321.md` 运行 family matrix 的 ordered / unordered / plain / spaces / list-spaces，5 个 cell 全部 PASS；其中原先失败的 `plain` 已不再出现 `source-locked-after-delete`。

## 全家族矩阵当前状态

RS-73 的目标 fixture 已关闭，但不能把当前完整 4 文件 × 5 操作矩阵描述为 20/20。

0.13.118 候选上完整 `npm run test:family-matrix-ui` 仍暴露与 RS-73 不同的既有 baseline 问题，包括：

- `HorseMD-0.13.33-引用后输入手测.md` 的 ordered / unordered / plain / list-spaces；
- `反馈.md` 的 plain / list-spaces。

这些失败主要落在 `trailing-empty-block-filled`、`diverged-tail-line-delete` 与 `visible-stream-mismatch`，与 tail image owner 的命中形状不同。它们必须继续按各自 first divergence 排查，不能通过扩大 RS-73 owner 来追求矩阵表面全绿。

## 对 transaction-first 迁移的意义

RS-73 是在为 Phase 1 transaction-first 迁移做 clean-baseline A/B 时暴露的。临时移除 live shadow wiring 后失败仍可复现，恢复 shadow 后根因不变，因此该问题属于 legacy baseline，而不是 shadow instrumentation 改变行为。

这反过来确认了迁移门禁的必要性：在开启任何 live authority 前，必须区分“迁移引入的新分叉”和“旧发布链本身已有的未拥有事务”。Phase 1 继续保持 legacy publication，直到 clean baseline 与长文档 first-divergence 门禁真正稳定。
