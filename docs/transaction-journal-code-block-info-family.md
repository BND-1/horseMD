# Transaction Journal：已有代码块 Info String Family

> 状态：HorseMD `0.13.134` 已迁移并通过生产门禁。
> Family：`code-block-info-string-change`
> Publication boundaries：`transaction-code-block-info-markdown-updated`、`transaction-code-block-info-forced-flush`

## 1. 范围

本 family 只认领**已有顶层 fenced code block 的语言 attr 变化**：

- 为空 info string 添加语言；
- 在已有语言之间切换；
- 清除已有语言；
- 同一个 delayed callback 窗口内连续发生的多笔 `AttrStep(language)`；
- callback 正常发布与立即切换源码触发的 forced flush；
- 作者 source 的围栏、info 前后 padding、BOM、EOL、正文和邻块保持逐字不变。

它不认领：

- 同时修改代码正文；
- 修改 `language` 之外的其它 `code_block` attrs；
- 包含 metadata 或多个 token 的 info string；
- 带空白、换行或反引号的不可安全表示语言；
- 创建、删除、拆分、合并或 unwrap 整个代码块；
- 改变开闭围栏字符或长度；
- 跨代码块、跨父节点或同时修改邻块；
- Slash 创建代码块。

这些事务继续 fail closed，并留给已有专用 owner 或后续独立 family。语言 family 完成不代表代码块结构生命周期已全部迁移。

## 2. Family 分类只使用 transaction 证据

旧路径只能在 delayed serializer 输出中看到：

````diff
- ```JavaScript
+ ```TypeScript
````

但 canonical 形状不能证明用户改的是哪一个代码块，也不能证明正文、其它 attrs 或邻块没有同时变化。本 family 改为：

```text
PM dispatch batch
  -> SourceSyncTransactionJournal
  -> code-block info focused owner
  -> exact opening-fence info raw patch
  -> semantic/list-slot validation
  -> SourceSyncCoordinator atomic publication
```

认领条件为：

1. oldDoc → finalDoc 恰好一个顶层 `code_block` 变化；
2. 目标前后正文完全相同；
3. 除 `language` 外的 attrs 完全相同；
4. previous language 与 next language 不同且均可安全表示；
5. journal 每个 Step 都是 `AttrStep`，attr 恰为 `language`；
6. Step 的 `pos` 等于目标顶层节点的物理 PM offset；
7. 每个 Step 在对应 stepDoc 上重新 apply 后，只有同一个顶层序号变化，正文、其它 attrs 和邻块不变；
8. 完整 oldDoc → finalDoc 链连续，最终 expectedDoc 与 journal finalDoc 相同。

canonical 只证明 callback 与 expectedDoc 对应，并参与最终语义验证；它不决定 family，也不生成作者源码补丁。

## 3. Opening Fence 的物理字节合同

通用 fenced scanner 现在为 opening line 暴露：

- `fenceStart` / `fenceEnd`；
- `infoStart` / `infoEnd`；
- `infoRaw`；
- 原有 `openStart`、`openEnd`、`contentStart`、closing range。

owner 分别解析：

- journal 绑定的作者 source；
- journal 绑定的 previous canonical；
- 当前 expectedDoc 的 next canonical。

三个范围必须对应同一顶层代码块。source、previous canonical 和 next canonical 的 info 都必须是“可选水平空白 + 单一 language token + 可选水平空白”；metadata、多 token 或 source language 与 PM baseline 不一致时立即拒绝。

成功时只执行：

```text
source[0..infoStart]
+ authored leading padding
+ next language
+ authored trailing padding
+ source[infoEnd..end]
```

例如作者源码：

```markdown
~~~···JavaScript··
const value = 1
~~~
```

其中 `·` 仅表示一个实际空格。选择 TypeScript 后得到：

```markdown
~~~···TypeScript··
const value = 1
~~~
```

以下字节保持稳定：

- `~~~` / backtick 选择；
- 围栏长度和缩进；
- info token 前后的空格或 Tab；
- BOM；
- LF / CRLF；
- 代码正文；
- closing fence；
- 前后列表、空行和所有其它文档字节。

补丁后再次用 expectedDoc 的 PM 位置映射回作者 Markdown，证明新 info token、围栏、closing line 与正文均正确；无法映射则拒绝，不回退为 canonical 全块替换。

## 4. Production Structural Registry

`Editor.jsx` 的 structural transaction owner registry 当前注册：

- `list-subtree-replace`；
- `code-block-content-replace`；
- `code-block-info-string-change`。

三个 family 共用：

- 唯一 `pendingSourceSyncTransactionJournal`；
- 相同 revision/source/canonical/doc stale guard；
- 相同 callback document proof；
- 相同 `SourceSyncCoordinator.publishOwned()`；
- 相同 callback 与 forced-flush 循环；
- 相同成功后 journal 清理规则。

注册顺序先让正文 owner检查；语言事务会因 attrs 变化被正文 owner明确拒绝，再由 info owner认领。普通 family rejection 不清空 journal，保证后续 owner仍能消费同一份证据。

## 5. Fail-Closed 边界

永久负向合同覆盖：

- language 与正文同一 batch 改动；
- 非 language attr 改动；
- language 含空格、换行或反引号；
- source info 含 metadata；
- source language 与 PM baseline 不一致；
- 同一 batch 修改邻块；
- callback document 不匹配；
- stale revision/source/canonical/doc；
- Step 类型、attr、位置、stepDoc 链或 apply 结果不符合合同。

这些情况不会根据 canonical 猜测 opening line，也不会覆盖作者整块源码。

## 6. 验证证据

通过的 focused 与相邻门禁：

```text
npm run test:code-block-info-transaction-owner
npm run test:code-block-info-transaction-ui
npm run test:code-block-transaction-owner
npm run test:list-subtree-transaction-owner
npm run test:source-sync-transaction-journal
npm run test:source-sync-coordinator
npm run build
```

纯合同证明：

- 多个连续 `AttrStep` 共用一个 journal，并只发布最终语言；
- 添加、替换和清除语言均正确；
- 作者 `~~~`、padding、BOM 与 CRLF 保留；
- 正文、metadata、其它 attr、非法 language、邻块和 stale snapshot 全部拒绝。

真实 Electron 语言选择器回归证明：

- callback 命中 `transaction-code-block-info-markdown-updated`；
- 立即切换源码命中 `transaction-code-block-info-forced-flush`；
- 两条路径均由真实 picker 点击产生 `AttrStep`，不是测试直接调用 source mapper；
- 作者 `~~~   JavaScript  ` 精确变为 `~~~   TypeScript  `；
- BOM、CRLF、正文和前后 bullet 保持不变；
- 两条路径均零 integrity failure、零 warning toast；
- 源码模式、保存磁盘字节和全新 profile 冷重开全部一致。

## 7. 下一迁移顺序

下一步不是扩大本 owner，而是建立新的 focused family：

1. blockquote 同段文字变化；
2. blockquote Enter split、Backspace join 与退出引用；
3. table cell 文字、row structural change，再到 column/alignment；
4. code-block 创建/删除/拆分/合并与围栏结构。

每个 family 必须独立完成 transaction/stepDoc 证明、bounded raw patch、纯正反合同、真实 callback、立即 forced flush、保存与全新 profile 冷重开后再注册生产 authority。
