# Transaction Journal：Blockquote Paragraph Split Family

> 状态：HorseMD `0.13.136` 已迁移并通过生产门禁。
> Family：`blockquote-paragraph-split`
> Publication boundaries：`transaction-blockquote-split-markdown-updated`、`transaction-blockquote-split-forced-flush`

## 1. 范围

本 family 只认领：

- 已有 blockquote 中一个直接子、非空、无 mark、纯文字 paragraph；
- 光标位于该段落中间，真实结构性 `ReplaceStep` 将它拆为两个非空 plain paragraphs；
- 同一 delayed callback 到达前，对右侧新段落发生的一个或多个快速纯文字 `ReplaceStep`；
- 目标 blockquote 位于稳定 ProseMirror node path，可在文档顶层或列表项等容器内；
- callback 和立即切源码 forced flush；
- 作者 quote indentation、`>` 后 spacing、BOM、LF/CRLF、祖先容器和邻块逐字保持。

它不认领：

- 段首或段尾 Enter 产生空 paragraph；
- Backspace/Delete join、lift 或退出引用；
- marks、heading、list、nested blockquote 等目标引用内部结构；
- 同时拆分两个引用或同时修改引用外邻块；
- quote/ancestor attrs 或 child topology 的无关变化；
- raw source 无法唯一映射、semantic/list-slot 不等价或 stale revision。

## 2. Stable Descendant-Path Ownership

原 owner 只接受顶层 `blockquote`。真实 Electron fixture 中引用合法嵌套在 bullet list item，oldDoc→finalDoc 的顶层变化类型是 `bullet_list`；继续要求 top-level node type 会把完整 transaction journal 错交给 legacy。

0.13.136 不增加 `-`、缩进或 `>` 的 Markdown 形状特判，而是引入通用 path 证明：

```text
oldDoc / expectedDoc
  -> exactly one changed top-level subtree
  -> exactly one changed descendant of expected PM type `blockquote`
  -> every change is contained by the same stable child-index path
  -> each transaction Step resolves back to that path in its captured stepDoc
```

共享 helper：

- `sourceSyncNodeEntryAtPath(doc, path)`：按 child-index path 计算目标节点、beforePos、contentStart 与 top-level index；
- `sourceSyncResolvedPositionMatchesPath($pos, path)`：验证 Step from/to 在每一层祖先上的 child ordinal；
- `onlySourceSyncNodePathChanged(beforeDoc, afterDoc, path)`：保证 path 外的祖先兄弟逐节点 `eq`；
- `classifySingleAnchoredSubtreeChange()`：目标候选必须恰好为 1，多引用同时变化或 path 不稳定时 fail closed。

该抽象同时被 blockquote paragraph text owner 使用，并作为后续 table cell/row owner 的基础；它不解析 Markdown family。

## 3. Transaction 与 Step 合同

journal 中每个 entry、Step 必须满足：

1. `entry.beforeDoc` 与上一 entry 的 `afterDoc` 连续；
2. Step 在捕获时 `stepDoc` 上可重放；
3. split Step 是结构性 `ReplaceStep`，from/to 同父，落在目标引用的一个直接子 paragraph；
4. Step apply 后目标引用 childCount 恰增加 1，split ordinal 前后的 children 与 attrs 都匹配；
5. 左右结果均为非空、无 mark plain paragraphs，拼接文字等于原段落；
6. 后续非结构 ReplaceStep 只能修改新右段，不能触及左段、其它 quote child、祖先或邻块；
7. 最终 document 必须等于 journal expectedDoc；
8. callback canonical parse 必须与 expectedDoc 等价。

## 4. Raw Source Patch

owner 用 split 前 paragraph 的 PM text range 映射作者 source，并要求：

- raw slice 精确等于 split 前 paragraph text；
- text 结束位置恰为同一物理行末；
- 该行在正文前只有合法 quote prefix：0–3 空格、`>` 与作者 spacing；
- semantic validator 对最终 candidate 与 expectedDoc 返回 true。

例如作者 source：

```markdown
  >   quotedalpha
```

在 `quoted|alpha` 按 Enter 后立刻输入 `XY`，只生成：

```markdown
  >   quoted
  >
  >   XYalpha
```

其中：

- 左右正文复用完整作者 prefix；
- 中间空引用行只保留 indentation + `>`；
- EOL 复用原行的 LF 或 CRLF；
- BOM、列表 marker、父 list item、后继 item 和全部其它字节不变；
- 不复制 canonical serializer 的 marker/spacing。

## 5. Production Registry

`Editor.jsx` 只把 owner 注册到现有 structural registry：

```text
list-subtree
code-block-content
code-block-info
blockquote-paragraph
blockquote-split
```

所有 family 共用：

- 唯一 `pendingSourceSyncTransactionJournal`；
- revision/source/canonical/doc stale guard；
- callback document proof；
- `SourceSyncCoordinator.publishOwned()`；
- callback 与 forced-flush publication loop；
- 成功或 stale 才清 journal 的生命周期。

blockquote paragraph owner先明确拒绝 `child-count-changed`，split owner随后消费同一本 journal；没有独立 checkpoint，也没有 canonical fallback authority。

## 6. 永久回归

纯合同：

```bash
npm run test:blockquote-split-transaction-owner
npm run test:blockquote-paragraph-transaction-owner
```

覆盖：

- 顶层引用中间 split；
- 列表项内引用路径 `[1,0,1]`；
- split 后快速多字符输入；
- BOM + CRLF 与作者 quote spacing；
- 既有多段 quote 中指定 child；
- 空结果、跨 child、marks、attrs、邻块、source mismatch；
- 同一顶层容器内多个引用同时变化的 anchored-target ambiguity；
- semantic validator false/throw；
- callback mismatch 与 stale revision。

真实 Electron：

```bash
npm run test:blockquote-split-transaction-ui
npm run test:blockquote-paragraph-transaction-ui
```

split fixture 真实位于 bullet list item 内，并执行：

```text
物理 Enter
→ callback 前快速输入 X / Y
→ callback publication
或立即切源码 forced flush
→ source 检查
→ save
→ 完整退出
→ 全新 profile 冷重开
```

最终证明：

- journal 保留 3 个 transaction；
- proof `nodePath=[1,0,1]`；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- 零 warning toast；
- exact source、磁盘和 cold reopen；
- callback/forced-flush 均由 transaction owner 发布。

## 7. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. blockquote Backspace join；
2. blockquote 退出引用；
3. table cell plain text；
4. table row insert/delete；
5. table column/alignment changes。

每个 family 都必须沿用 transaction journal、stable path、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
