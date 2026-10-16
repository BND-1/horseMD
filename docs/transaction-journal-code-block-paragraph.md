# Transaction Journal：代码块转换为普通段落

> 源码版本：HorseMD 0.13.150  
> Family：`code-block-to-paragraph`  
> Owner：`createCodeBlockParagraphTransactionSourceSyncOwner`  
> Boundary：`transaction-code-block-to-paragraph`

## 1. 迁移目标

用户通过真实块类型菜单把一个非空 fenced code block 转换为普通段落时，ProseMirror 会通过 `setBlockType(paragraph)` 改写节点 wrapper，并保留原代码正文。若用户随后立即输入文字，多笔 transaction 可能在同一个 `markdownUpdated` 或 forced-flush 边界前合并。

旧 canonical-diff 路径只能从最终 Markdown 推测“fence 消失了”，无法可靠证明转换命令、原始代码块范围和后续文字编辑属于同一操作，也可能只删除 opening fence、残留 closing fence，或改写作者 fence/EOL。

0.13.150 将该反向块类型转换迁移为 revision-bound focused owner，不根据最终 canonical 的 fence 消失形状推断；同时通过 `legacyRetired + recognized` 正式阻断该 family 的 generic canonical-diff fallback。

## 2. 真实事务链

永久纯合同直接调用 ProseMirror `setBlockType(paragraph)`。第一笔事务可表现为严格的：

```text
ReplaceAroundStep
  wrapper: paragraph
  gap: 原 code_block content
  structure=true
```

或等价的完整节点 `ReplaceStep`。两种形状都必须覆盖旧 code block 的精确 node range，并在应用后只改变同一个 top-level path。

随后快速输入 `x`、`y` 形成同一个 paragraph 内的纯文字 `ReplaceStep`。

## 3. 所有权合同

Owner 只有在以下条件全部成立时才认领：

1. journal、Coordinator revision、source/canonical digest 与 live expected doc 完全匹配；
2. old/final doc childCount 相同，只有一个 top-level path 变化；
3. old node 是非空、单行、无 marks/atom 的 `code_block`；
4. final node 是非空、单行、无 marks/atom 的 paragraph；
5. 第一笔 Step 精确把旧 code block wrapper 转换为 paragraph，且转换后正文与旧代码正文完全相同；
6. 后续 Step 只编辑同一个 paragraph；
7. 后续 Step 不得带 marks、atom、跨 block 或邻块变化；
8. PM→Markdown offset 在 authored source 和 previous canonical 中都唯一落入同一个完整 fenced range；
9. opening fence 不得缩进，raw fence 内容必须逐字符等于 old PM code text；
10. 原子替换后的 Markdown 必须重新解析为 expected PM doc。

空代码块、多行代码块、Markdown 敏感正文导致语义变化、邻块混改、缩进/歧义 range、raw content mismatch、callback mismatch、semantic mismatch 或 stale revision 均 fail closed。

## 4. Raw source replacement

该 family 不逐行删除 fence，也不复制 canonical 的 paragraph 拼写。它把作者源码中的完整范围：

```text
opening fence
code content
closing fence
```

一次性替换为 final paragraph text。

因此可以保持：

- BOM；
- LF、CRLF 或 lone CR；
- 前后块和作者空行；
- 未编辑字节；
- 原 fence 类型、长度和 info string 不会泄漏到结果中。

例如：

```md
~~~js
alpha
~~~
```

转换并快速输入 `xy` 后原子变为：

```md
alphaxy
```

而不是先删 opening fence、再由后续 callback 清理 closing fence。

## 5. 永久回归

纯合同：

```bash
npm run test:code-block-paragraph-transaction-owner
```

覆盖：

- 真实 `setBlockType(paragraph)` transaction；
- 两笔 coalesced 文字 Step；
- conversion-only；
- BOM + CRLF；
- tilde/backtick fence 与 info string；
- 完整 fence 原子删除；
- 空代码块；
- 多行代码块；
- Markdown 敏感正文的 semantic rejection；
- 邻块混改；
- 缩进 fence、坏 range、content mismatch；
- callback mismatch 和 stale revision。

真实 Electron：

```bash
npm run test:code-block-paragraph-transaction-ui
```

覆盖：

- 真实右键块类型菜单；
- 可见“正文 / Paragraph”菜单项；
- 快速输入 `xy`；
- callback publication；
- 立即切源码 forced-flush publication；
- 专用 owner reason 与 Coordinator boundary；
- 零 integrity false、零 warning toast；
- source 精确；
- 保存到磁盘；
- 完整停止进程；
- 全新 profile 冷重开。

## 6. 架构边界

本 family 只处理顶层、非空、单行 code block 通过真实块类型命令转换为普通 paragraph。

以下仍不归它所有：

- 空代码块 Backspace 解包；
- 多行 code block 转 paragraph；
- Markdown 敏感正文需要转义的转换；
- code block 正文、info string、显式退出、paragraph→code block；
- nested 或跨 block selection。

这些操作由已有 focused owner 或后续独立 lifecycle family处理，不回到 canonical diff 特判。
