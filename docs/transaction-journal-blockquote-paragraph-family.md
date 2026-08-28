# Transaction Journal：Blockquote 同段纯文字 Family

> 状态：HorseMD `0.13.135` 完成顶层引用迁移；`0.13.136` 复用稳定 descendant path，支持列表项等容器内的已有引用，并通过新增歧义负例。
> Family：`blockquote-paragraph-text-replace`
> Publication boundaries：`transaction-blockquote-paragraph-markdown-updated`、`transaction-blockquote-paragraph-forced-flush`

## 1. 范围

本 family 只认领：

- 已有、位于稳定 ProseMirror `nodePath` 的 `blockquote`，可在文档顶层或列表项等容器内；
- 引用中恰好一个**直接子** `paragraph` 变化；
- 前后段落均非空、无 mark、无 atom；
- 变化由一个或多个连续 closed plain-text `ReplaceStep` 构成；
- 同一个 delayed callback 窗口中的快速逐字输入；
- callback 正常发布与立即切源码触发的 forced flush；
- 作者 quote 前缀、BOM、EOL、其它引用段和邻块保持逐字不变。

它不认领：

- 把引用段落删空；
- Enter 拆成多个引用段；
- Backspace/Delete 合并段落或退出引用；
- 修改 quote attrs 或 paragraph attrs；
- 粗体、斜体、链接、行内代码、图片、公式等 mark/atom；
- 目标引用自身包含 heading、list、nested blockquote 或其它非 plain-paragraph 结构（引用作为整体嵌套在列表项内则允许）；
- 同时修改两个引用段；
- 同时修改引用外邻块；
- 语法敏感字符的 raw 转义转换；
- baseline/source/doc 无法证明或 revision stale。

这些事务继续 fail closed，由已有 legacy owner 或后续独立结构 family 处理。完成本 family 不代表 blockquote split/join/退出已迁移。

## 2. Family 分类只使用 Transaction 证据

旧 canonical-first 路径只能看到：

```diff
- > quoted alpha
+ > quoted alphaXY
```

但该 diff 不能证明：

- 变化属于哪个 blockquote；
- 是引用中的第几个直接子段落；
- 同一 callback 内是否还发生 split/join、清空、mark 或邻块变化；
- 作者源码使用 `>`、` >`、`>   ` 还是其它合法前缀；
- source/canonical 其它位置的合法拼写分叉是否影响全文可见偏移。

本 family 改为：

```text
PM dispatch batches
  -> SourceSyncTransactionJournal
  -> blockquote paragraph focused owner
  -> mature plain-text bounded raw patch
  -> semantic/list-slot validation
  -> SourceSyncCoordinator atomic publication
```

认领条件：

1. oldDoc→finalDoc 恰好一个顶层 subtree 变化，该 subtree 内恰有一个 `blockquote` descendant path 承担全部变化；
2. quote attrs 不变、直接子节点数量不变；
3. 恰好一个直接子节点变化，且前后均为非空、无 mark 的普通 `paragraph`；
4. 其它直接子节点、顶层前缀和顶层后缀完全相同；
5. journal 中每个 Step 都是非 structural `ReplaceStep`；
6. inserted slice 是 closed plain text；
7. 每个 Step 的 from/to 在对应 stepDoc 上同父，depth 必须精确等于 `quotePath.length + 1`；
8. parent 是目标 paragraph，`node(quoteDepth)` 是目标 blockquote；
9. resolved child indexes、`$from.before(quoteDepth)`、quote child ordinal 与分类得到的稳定 path 完全一致；
10. Step apply 后只有同一 anchored quote path、同一直接子段落变化，祖先 path 外的兄弟保持 `eq`；
11. 完整 journal 链连续并收敛到 expectedDoc。

canonical 只证明 callback 与 expectedDoc 对应并参与最终 semantic validation；它不决定 family。

## 3. Raw Source Patch 合同

严格路径分类通过后，owner 复用 `mapPlainTextTransactionsToSource()`。该 mapper 对每个 Step：

- 用 ProseMirror 位置映射到作者 Markdown 物理 offset；
- 确认 from/to 落在同一 raw textblock；
- 比较 PM 被删除文字与 raw source 对应字节；
- 比较整个 raw textblock 与 PM paragraph text；
- 拒绝开放 slice、syntax-sensitive insert 和跨父节点变化；
- 只在已证明的 raw from/to 范围内替换；
- 最后验证映射后的文档与 expectedDoc 等价。

owner 再通过共享 `validateTransactionMarkdown()` 执行 semantic document 与 strict list-slot 双重验证。任何 mapper 或验证失败都会拒绝，不回退为 canonical 整块替换。

例如作者源码：

```markdown
 > quoted alpha
```

物理输入 `XY` 后得到：

```markdown
 > quoted alphaXY
```

保持稳定的字节包括：

- quote marker 前的 0–3 个作者空格；
- `>` 后的作者 spacing；
- BOM；
- LF / CRLF；
- 引用中其它行；
- 引用前后的空行；
- 邻接列表 marker 与全部其它未触及字节。

## 4. Production Structural Registry

`Editor.jsx` 的 structural registry 当前注册：

- `list-subtree-replace`；
- `code-block-content-replace`；
- `code-block-info-string-change`；
- `blockquote-paragraph-text-replace`；
- `blockquote-paragraph-split`。

五个 family 共用：

- 唯一 `pendingSourceSyncTransactionJournal`；
- 相同 revision/source/canonical/doc stale guard；
- 相同 callback document proof；
- 相同 `SourceSyncCoordinator.publishOwned()`；
- 相同 callback 与 forced-flush 循环；
- 相同成功后 journal 清理规则。

普通 family rejection 不清空 journal，因此前面的 owner 明确拒绝后，blockquote owner仍能消费同一份证据。

## 5. Fail-Closed 边界

永久负向合同覆盖：

- 段落被删空；
- 一个 quote 中两个段落同时变化；
- Enter split 改变直接子数量；
- quote 与邻块同一 batch 变化；
- 添加 marks；
- 引用内 heading；
- 目标引用内部 nested list（引用嵌套在 list item 内的稳定 path 正向用例另有覆盖）；
- syntax-sensitive `*`；
- 作者 source 正文与 PM baseline 不一致；
- callback document 不对应；
- stale revision/source/canonical/doc；
- Step 类型、slice、路径、stepDoc 或 apply 结果不符合合同。

## 6. 验证证据

Focused 与相邻门禁：

```text
npm run test:blockquote-paragraph-transaction-owner
npm run test:blockquote-paragraph-transaction-ui
npm run test:plain-paragraph-transaction-owner
npm run test:list-subtree-transaction-owner
npm run test:source-sync-transaction-journal
npm run test:source-sync-coordinator
npm run test:source-transaction-sync
npm run test:empty-blockquote-removal-ui
npm run test:empty-blockquote-ime-fill-ui
npm run test:generated-scratch-blockquote-empty-paragraph-ui
npm run test:middle-blockquote-empty-paragraph-ui
npm run build
```

纯合同证明：

- BOM+CRLF 与作者 quote spacing 保留；
- 两个连续字符共享一个 journal；
- 重复 quote 正确命中指定顶层序号；
- 同一 quote 的第二个直接子段落可精确修改；
- 清空、双段修改、split、邻块、marks、heading、nested list、syntax、baseline mismatch 和 stale snapshot 全部拒绝。

真实 Electron 回归证明：

- 两个物理字符形成同一两步 journal；
- callback 命中 `transaction-blockquote-paragraph-markdown-updated`；
- 立即切源码命中 `transaction-blockquote-paragraph-forced-flush`；
- 作者 ` > quoted alpha` 精确变为 ` > quoted alphaXY`；
- BOM、CRLF、前后 bullet 和其它字节不变；
- 两条路径均零 integrity failure、零 warning toast；
- 源码模式、保存磁盘字节和全新 profile 冷重开一致。

既有 quote 结构回归进一步证明本 owner未抢占：

- 空 blockquote 删除；
- 空 blockquote IME 填充；
- generated scratch 中 Enter 创建临时空第二段；
- 文档中间 blockquote Enter 后继续填第二段。

## 7. 下一迁移顺序

下一步建立独立结构 family，不扩大本 owner：

1. blockquote Backspace join；
2. blockquote 退出引用；
3. table cell 文字与 row structural change；
4. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 必须独立完成 transaction/stepDoc 分类、bounded source patch、纯正反合同、真实 callback、立即 forced flush、保存与全新 profile 冷重开后，才允许注册 production authority。
