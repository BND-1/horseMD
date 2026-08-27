# Transaction Journal：已有代码块正文 Family

> 状态：HorseMD `0.13.133` 已迁移并通过生产门禁。
> Family：`code-block-content-replace`
> Publication boundaries：`transaction-code-block-markdown-updated`、`transaction-code-block-forced-flush`

## 1. 范围

本 family 只认领**已有顶层 fenced code block 内部的纯文本变化**：

- 空代码块首次填入正文；
- 代码正文插入、删除和同块选区替换；
- 同一个 delayed callback 窗口内连续发生的多笔 `ReplaceStep`；
- callback 正常发布与立即切换源码触发的 forced flush；
- 作者源码的 BOM、CRLF、围栏字符、围栏长度、info string 和邻块字节保持不变。

它不认领：

- 修改语言或其他 `code_block` attrs；
- 改变开闭围栏字符或长度；
- 创建、删除、拆分、合并或 unwrap 整个代码块；
- 跨代码块/跨父节点选区；
- 新正文中出现会提前关闭作者围栏的独立 closing-fence 行；
- Slash 创建代码块。Slash 创建仍由现有命令级 owner 负责。

这些结构事务继续 fail closed，并留给后续独立 family；不能因为代码块正文 family 已完成，就宣称所有代码块操作已经迁移。

## 2. 为什么不能继续依赖 canonical 形状

旧路径从 delayed canonical diff 推断“哪里发生了变化”。已有文档前方只要存在列表 marker、空行或 serializer 拼写差异，空代码块的首批正文就可能被普通中间段落 mapper 认领，最终写到 opening fence 之前：

```markdown
新代码正文

~~~js

~~~
```

这不是正文内容的特殊情况，而是 transaction 所有权丢失：代码块节点、逐 Step 文档链和物理 source range 已经存在，但旧路径只看到一段新增可见文字。

0.13.133 改为：

```text
PM dispatch batch
  -> SourceSyncTransactionJournal
  -> code-block focused owner
  -> exact fenced content raw patch
  -> semantic/list-slot validation
  -> SourceSyncCoordinator atomic publication
```

family 分类只读取 ProseMirror 文档和 transaction：

1. oldDoc → finalDoc 恰好一个顶层 `code_block` 变化；
2. 邻接顶层子树逐节点 `eq`；
3. attrs 完全不变；
4. journal 每个 Step 都是非结构性、closed plain-text `ReplaceStep`；
5. 每个 Step 的 from/to 位于同一个深度为 1 的目标 `code_block`；
6. 每个 Step 在捕获时对应的 stepDoc 上重新 apply 后，完整文档链连续；
7. 最终 expectedDoc 与 journal finalDoc 相同。

canonical 只用于证明 callback 对应当前 expectedDoc，以及最终 semantic validation；它不负责识别 family，也不生成局部 raw patch。

## 3. 原始源码范围与字节合同

owner 分别解析：

- journal 绑定的作者 source；
- journal 绑定的 previous canonical；
- 当前 expectedDoc 的 next canonical。

三个范围必须都落在同一顶层代码块序号。previous/next canonical 的 opening/closing fence 必须保持一致；作者 source 可以继续使用与 canonical 不同的合法拼写，例如：

```markdown
~~~js
正文
~~~
```

而 serializer 输出：

````markdown
```js
正文
```
````

owner 只替换作者围栏内部的 content range。作者的：

- `~~~` / backtick 选择；
- 围栏长度；
- `js` 等 info string；
- BOM；
- CRLF；
- 前后列表与空行；

全部保持 byte-stable。

若新正文中出现与作者 closing fence 冲突的独立行，owner 返回 `code-block-source-fence-collision`，不自动延长围栏，也不根据 canonical 猜测新的围栏形状。

## 4. 本轮发现并修复的通用 BOM 坐标根因

真实 Electron 回归首次运行时，journal 已连续捕获 14 个逐字 `ReplaceStep`，但 owner 返回 `code-block-range-unmapped`。诊断显示：

- canonical 无 BOM，空代码块 PM 位置正确落到 opening fence；
- 作者 source 有 BOM，remark AST offset 比物理源码少 1；
- 非空节点过去会在 AST 范围内再次搜索 `node.value`，偶然抵消这一字节；
- 空代码块没有 value span，直接暴露 off-by-one，位置落在 opening fence 前的换行。

修复位于通用 `editor-source-map.js`，不是代码块 owner 补丁：所有 remark AST block、text span 和 atom offset 都统一恢复前导 BOM 的物理字节偏移。永久回归覆盖 BOM + CRLF + 空 `~~~js` 代码块的双向 PM ↔ Markdown 映射。

## 5. 生产 registry

`Editor.jsx` 现在维护一个 structural transaction owner registry。当前注册：

- `list-subtree-replace`；
- `code-block-content-replace`。

两者共用：

- 唯一 `pendingSourceSyncTransactionJournal`；
- 相同 snapshot/revision/source/canonical/doc stale guard；
- 相同 callback document proof；
- 相同 `SourceSyncCoordinator.publishOwned()`；
- 相同成功后 journal 清理规则。

某个 family 的普通拒绝不会销毁 journal；只有 stale snapshot 或成功 publication 才会清理。后续引用和表格 family 应注册到同一 registry，不再增加新的 `markdownUpdated`/forced-flush 分支。

## 6. 验证证据

通过的 focused 与相邻门禁：

```text
npm run build
npm run test:source-map
npm run test:code-block-transaction-owner
npm run test:middle-codeblock-source-ui
npm run test:list-subtree-transaction-owner
npm run test:list-subtree-transaction-ui
npm run test:markdown-preservation
npm run test:source-fidelity-probes
npm run test:source-sync-coordinator
npm run test:source-transaction-sync
```

真实 UI 同时证明：

- callback：14 个逐字 transaction 使用同一 journal，边界为 `transaction-code-block-markdown-updated`；
- forced flush：18 个逐字 transaction 使用同一 journal，边界为 `transaction-code-block-forced-flush`；
- 两条路径均零 integrity failure、零 warning toast；
- 作者 `~~~js`、BOM、CRLF、前后列表保持不变；
- 源码模式逻辑文本正确；
- 保存磁盘逐字等于 transaction-owned candidate；
- 全新 profile 冷重开仍是一个代码块，源码和磁盘一致；
- 列表 structural owner callback/forced-flush 继续通过；
- source fidelity probes 为 `39/39`。

## 7. 下一迁移顺序

下一步不是扩大本 owner，而是建立新的 family：

1. `code-block-info-string-change`：根据 `SetNodeMarkupStep`/attrs 变化定位 opening-fence info range；
2. blockquote split/join：根据结构 Step 链和 quote raw prefix 认领；
3. table row structural change：根据 row-level Step 链、delimiter row 和单元格 source slots 认领。

每个 family 都必须独立完成纯合同、真实 callback、立即 forced flush、保存和全新 profile 冷重开后再注册生产 authority。
