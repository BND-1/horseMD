# Transaction Journal：Blockquote Paragraph Join Family

> 状态：HorseMD `0.13.137` 已迁移并通过生产门禁。
> Family：`blockquote-paragraph-join`
> Publication boundaries：`transaction-blockquote-join-markdown-updated`、`transaction-blockquote-join-forced-flush`

## 1. 范围

本 family 只认领：

- 已有 blockquote 中两个相邻、直接子、非空、无 mark、纯文字 paragraphs；
- 光标位于右段开头，物理 Backspace 将两个段落合并；
- 同一 delayed callback 到达前，对合并点发生的一个或多个快速纯文字 ReplaceStep；
- blockquote 位于稳定 ProseMirror node path，可在文档顶层或列表项等容器内；
- callback 和立即切源码 forced flush；
- 作者 quote indentation、`>` 后 spacing、quote-only separator、BOM、LF/CRLF、祖先容器和邻块均可精确证明。

它不认领：

- 右段为空、带 mark/atom 或不是普通 paragraph；
- lift、退出引用、跨 blockquote/跨 child 删除；
- 同时合并两个引用或修改引用外邻块；
- quote/ancestor attrs 或其它 child topology 变化；
- 作者源码没有可证明的两段正文和 quote-only separator；
- source/canonical/doc stale 或最终 semantic/list-slot 不等价。

## 2. 真实 Transaction 合同

纯 ProseMirror `joinBackward` command 生成：

```text
ReplaceStep
from = left paragraph content end
  to = right paragraph content start
range width = 2
slice = empty / closed
structure = true
```

真实 Milkdown DOM Backspace 生成同一位置、范围、slice 和结果，但 `structure=false`。该布尔位是 ReplaceStep 的结构保护提示，不是用户操作语义；因此 owner 不依赖它，而同时要求：

1. oldDoc→finalDoc 只有一个 changed top-level subtree；
2. 其中恰有一个 stable blockquote descendant path 承担全部变化；
3. before quote 比 after quote 恰多一个 child；
4. 唯一候选是相邻两个 non-empty plain paragraphs 被一个 paragraph 取代；
5. 结果 attrs 不变、正文精确等于左右正文拼接；
6. join Step from/to 分别 resolve 到左段末尾和右段开头，直接子 ordinal 相邻；
7. Step width 恰为 2、slice size/openStart/openEnd 均为 0；
8. Step apply 后只有同一 quote path 变化，祖先和邻块保持 eq；
9. 后续 Step 只能是同一 merged paragraph 内的 closed plain-text ReplaceStep；
10. 完整 journal 最终等于 expectedDoc。

proof 同时记录 `joinStructure`，用于观测不同输入路径，但不以 true/false 决定所有权。

## 3. Raw Source Patch

owner 分别映射 join 前左右 paragraph 的 PM text range 到作者源码，并要求 raw slice 与 PM 文本逐字符一致。两段必须是单物理行，且中间精确存在：

```text
left line EOL
quote-only separator line EOL
right quote prefix
```

quote prefix 允许作者使用 0–3 空格、`>` 和任意合法 spacing；左右 indentation 必须一致。owner 将：

```text
leftText + separator + rightText
```

整个 raw span替换为 final merged paragraph text。左段原 prefix 位于 patch 前，所以自然保持；右 prefix、separator 和两个 EOL 被删除。BOM、LF/CRLF、父 list marker、前后 siblings 和其它所有字节不变。

例如：

```markdown
  >   quoted
  >
  >   alpha
```

Backspace 后立即输入 `XY`，精确得到：

```markdown
  >   quotedXYalpha
```

候选随后必须通过完整 semantic validator；不是靠 canonical 中 quote 行数量变化决定 patch。

## 4. Stable Descendant Path 与 Registry

owner 复用 0.13.136 引入的：

- `classifySingleAnchoredSubtreeChange()`；
- `sourceSyncNodeEntryAtPath()`；
- `sourceSyncResolvedPositionMatchesPath()`；
- `onlySourceSyncNodePathChanged()`。

生产只在现有 structural registry 中新增一项：

```text
blockquote-join
```

它与 list/code/blockquote text/split owners 共用：

- 唯一 revision-bound journal；
- callback document proof；
- 同一 callback/forced-flush publication loop；
- semantic/list-slot integrity gate；
- `SourceSyncCoordinator.publishOwned()`；
- 只有成功或 stale 才清 journal 的生命周期。

没有单独 checkpoint、reason allowlist 或 canonical fallback authority。

## 5. 永久回归

纯合同：

```bash
npm run test:blockquote-join-transaction-owner
```

覆盖：

- 真实 `joinBackward` structure=true；
- 真实 Milkdown 等价的 structure=false ReplaceStep；
- join 后快速多字符输入；
- 顶层引用和列表项内 path `[1,0,1]`；
- BOM + CRLF 与左右不同 quote spacing；
- 三段引用中合并后两段；
- 缺失 separator、marks、邻块、两个引用同时 join、source mismatch；
- semantic false、callback mismatch、stale revision；
- constructor 缺失 mapper/validator。

真实 Electron：

```bash
npm run test:blockquote-join-transaction-ui
```

fixture 位于 bullet list item 内，执行：

```text
右段开头物理 Backspace
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
- 真实 join Step `structure=false`、range width 2；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- 零 warning toast；
- 作者 `  >   ` prefix、BOM/CRLF、前后 list items 保持；
- callback/forced-flush、source/save/cold reopen 全部精确。

## 6. 下一迁移顺序

不扩大本 owner，后续独立 family 依次为：

1. table cell plain text；
2. table row insert/delete；
3. table column/alignment changes。

每个 family 继续使用 transaction journal、stable path、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
