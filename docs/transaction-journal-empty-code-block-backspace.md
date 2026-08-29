# Transaction Journal：空代码块 Backspace 解包

> 源码版本：HorseMD 0.13.146
>
> Family：`empty-code-block-backspace-unpack`
>
> Owner：`createEmptyCodeBlockUnpackTransactionSourceSyncOwner`
>
> Owner 默认 boundary：`transaction-empty-code-block-backspace-unpack`
>
> Runtime boundaries：`transaction-empty-code-block-unpack-markdown-updated` / `transaction-empty-code-block-unpack-forced-flush`

## 1. 迁移目标

当光标位于一个空 fenced code block 中并按 Backspace 时，ProseMirror 会把整个 `code_block` 原位替换为普通 paragraph。若用户随后快速输入正文，多个 transaction 可能在同一个 `markdownUpdated` 或 forced-flush 边界前合并。

旧 canonical-diff 路径只看最终 Markdown 字符串，可能删除 opening fence 却残留 closing fence：

```md
XY
~~~
```

严格完整性校验会正确拒绝该 candidate，但用户会看到源码不一致提示。

0.13.146 不再增加 canonical 形状特判，而是由 revision-bound `SourceSyncTransactionJournal` 直接证明完整操作。

## 2. 真实事务链

失败优先 Electron 回归捕获的真实 Step 链：

```text
ReplaceStep from=39 to=41 sliceSize=2
  空 code_block → 空 paragraph

ReplaceStep from=40 to=40 sliceSize=1
  插入 X

ReplaceStep from=41 to=41 sliceSize=1
  插入 Y
```

第一笔 Step 直接覆盖旧节点的完整 ProseMirror node range；后续 Step 只编辑同一 top-level paragraph。

## 3. 所有权合同

Owner 只有在以下条件全部成立时才认领：

1. journal、Coordinator revision、source digest、canonical digest 与 live expected doc 完全匹配；
2. old doc 与 final doc 只有一个相同 top-level path 发生变化；
3. old node 是内容为空的 `code_block`；
4. 第一笔是 closed `ReplaceStep`，精确把旧 code block 的完整 node range替换为空 paragraph；
5. 后续每一笔都是同一 paragraph 内的 closed plain-text `ReplaceStep`；
6. 后续 Step 不得带 marks、atom、跨段、跨 block 或邻块变化；
7. final paragraph 必须是单行、无 marks/atom 的 plain paragraph；非空结果可在 callback 发布，空结果只保留同一本 journal 并由 forced flush 提交；
8. PM→Markdown offset 在 authored source 和 previous canonical 中都唯一落入一个完整 fenced range；
9. opening/closing marker 必须配对，代码内容区必须为空；
10. 原子替换后的 Markdown 必须重新解析为 expected PM doc。

任何一步不满足都 fail closed，不会把该事务交给更宽的 lifecycle owner静默猜测。

## 4. Raw source patch

Owner 不修改 canonical marker 拼写，也不逐行删除 fence。它把作者源码中的完整范围：

```text
opening fence
empty content range
closing fence
```

一次性替换为 final paragraph text。

因此可以保持：

- backtick 或 tilde fence；
- fence 长度；
- info string；
- BOM；
- LF 或 CRLF；
- 前后块、空行和未编辑字节。

例如：

```md
~~~js
~~~
```

原子变为：

```md
XY
```

而不是先删除 opening fence、再依赖 serializer 猜测 closing fence。

## 5. 永久回归

纯合同：

```bash
npm run test:empty-code-block-unpack-transaction-owner
```

覆盖：

- 真实 structural `ReplaceStep` + 两笔文字 Step；
- BOM + CRLF；
- tilde 与 backtick fence；
- info string；
- 精确 raw range 与 proof；
- structural-only pending 状态与同 journal `holdJournal`；
- 非空代码块；
- 同一结构 Step 夹带正文；
- 邻块混改；
- offset/range 无法唯一证明；
- raw fence 内容非空；
- callback mismatch、semantic rejection 和 stale revision。

真实 Electron：

```bash
npm run test:empty-code-block-unpack-transaction-ui
```

覆盖：

- 物理 Backspace；
- 快速输入 `XY`；
- 快速 `XY` 的 callback publication；
- 空解包后立即切源码的 forced-empty publication；
- 专用 owner reason 与 Coordinator boundary；
- 零 integrity false、零 warning toast；
- source 精确；
- 保存到磁盘；
- 完整停止进程；
- 全新 profile 冷重开。

## 6. 架构边界

本 family 只处理“空 code block 原位解包为 paragraph”这一 PM lifecycle。

以下仍不归它所有：

- 非空代码块转普通段落；
- 修改 fence 类型、长度或 info string；
- 创建代码块；
- 多行 paragraph 或跨 block selection；
- 代码块正文普通编辑。

代码块正文编辑与 info string 已由各自 transaction owner处理；后续 lifecycle family继续按真实 ProseMirror Step 迁移，不回到 canonical diff 猜测。
