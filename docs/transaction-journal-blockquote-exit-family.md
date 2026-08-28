# Transaction Journal：Blockquote Paragraph Exit Family

> 状态：HorseMD `0.13.138` 已迁移并通过生产门禁。
> Family：`blockquote-paragraph-exit`
> Publication boundaries：`transaction-blockquote-exit-markdown-updated`、`transaction-blockquote-exit-forced-flush`

## 1. 范围

本 family 只认领：

- 已有 blockquote 的最后一个直接子是非空、无 mark、纯文字 paragraph；
- 光标位于该段落末尾，第一次 Enter 在引用内新增 trailing empty paragraph；
- 第二次 Enter 将该空段提升为 blockquote 后同级 paragraph；
- 同一 delayed callback 到达前，对退出段发生一个或多个快速纯文字 ReplaceStep；
- parent 是 `doc` 或 `list_item`，blockquote 是 parent 的直接 child；
- callback、第一拍 staged checkpoint 和立即切源码 forced flush；
- 作者 quote prefix、BOM、LF/CRLF、parent/list marker、siblings 和邻块可精确证明。

它不认领：

- 空退出段尚未输入任何真实文字；
- 引用末段为空、带 mark/atom 或不是普通 paragraph；
- parent 是 nested blockquote、table cell 或其它未迁移容器；
- lift、join、split 以外的结构链，或同时修改两个引用/邻块；
- quote/parent/ancestor attrs 或其它 children 变化；
- raw source 无法映射、semantic/list-slot 不等价或 revision/source/doc stale。

## 2. 两阶段真实 Transaction 合同

第一次 Enter 在引用末段末尾生成：

```text
ReplaceStep
from = to = last paragraph text end
slice = two paragraph nodes
openStart = 1
openEnd = 1
```

Step apply 后，稳定 quote path 只多一个 trailing empty paragraph；其它 quote children、祖先和 siblings 不变。

第二次 Enter 在该空段内生成：

```text
ReplaceAroundStep
from = empty paragraph boundary before
  to = from + 3
gapFrom = from
gapTo = from + 2
insert = 1
slice = one empty blockquote wrapper
openStart = 1
openEnd = 0
```

Step apply 后：

- 原 blockquote 恢复到第一拍之前的非空 children；
- parent 在 quote 后恰新增一个空 paragraph；
- parent attrs 和其它 children 保持；
- 后续 ReplaceStep 只能修改该新增 paragraph。

## 3. Pending / Coalesced / Staged 生命周期

### Pending 第一拍

若第一次 Enter 的 callback 先到达，owner 证明仅新增一个 trailing empty quote paragraph，并返回：

```text
reason = trailing-empty-blockquote-paragraph-created
source = 原作者 source（逐字不变）
proof.kind = transaction-blockquote-exit-pending-proof
```

该 reason 已有严格 semantic transient 合同；0.13.138 没有新增 allowlist。Coordinator 提交 canonical baseline 与 trusted checkpoint，清理已消费 journal。

### Coalesced

若两次 Enter 和快速正文在同一个 delayed callback 前完成，journal 包含：

```text
ReplaceStep
ReplaceAroundStep
ReplaceStep...
```

owner 从原 source/canonical 一次生成最终退出段 patch。

### Staged

若第一拍 pending 已提交，第二本 journal 从：

```text
ReplaceAroundStep
ReplaceStep...
```

开始。oldDoc 已含 trailing empty quote paragraph，source仍是第一拍之前的作者字节。owner识别 staged baseline，并生成与 coalesced 完全相同的最终 source。

因此 callback 到达时序不会改变磁盘结果，也不会出现“第一拍 legacy 红灯、第二拍从 stale baseline继续”的链式分叉。

## 4. Stable Parent / Quote / Inserted Paths

owner 不从 canonical 的 `> <br />` 或缩进行猜 family，而比较 oldDoc/expectedDoc parent children：

```text
before parent:
  ... blockquote(sourceQuote) ...

after parent:
  ... blockquote(sourceQuote), paragraph(exitedText) ...
```

唯一候选必须同时给出：

- `parentPath`；
- `nodePath = parentPath + quoteIndex`；
- `insertedPath = parentPath + quoteIndex + 1`；
- `parentType` 为 `doc` 或 `list_item`；
- quote 与 inserted paragraph 之外的 parent children逐节点 `eq`；
- parent attrs 不变。

coalesced oldDoc 的 quote没有空段；staged oldDoc 的 quote恰多一个 trailing empty paragraph，移除该空段后必须等于 final quote。候选不是恰好 1 时 fail closed。

## 5. Raw Source Patch

owner映射 sourceQuote 最后一个非空 paragraph 的 PM text range，并要求 raw slice 与 PM text 精确相等、正文结束于物理行末、前缀为合法 quote prefix。

输出不删除或重写原 quote line，只在该行后插入：

```text
EOL
exitedPrefix + exitedText
EOL
```

其中：

- 顶层 parent：`exitedPrefix = ''`；
- list item parent：`exitedPrefix = quote indentation`，例如作者 `  >   alpha` 退出为 `  XY`；
- quote marker 后 spacing 只属于原 quote line，保持不变；
- EOL 复用原行 LF/CRLF/lone-CR；
- BOM、父 list marker、后继 item 和其它字节不变；
- transient empty quote paragraph 从不写入 source。

候选随后必须通过完整 semantic/list-slot validator。

## 6. Production Registry

`Editor.jsx` 只在既有 structural registry 追加：

```text
blockquote-exit
```

它与 list/code/blockquote text/split/join owners 共用：

- 唯一 revision-bound journal；
- callback document proof；
- callback/forced-flush publication loop；
- semantic/list-slot integrity gate；
- `SourceSyncCoordinator.publishOwned()`；
- 只有成功或 stale 才清 journal 的生命周期。

pending 第一拍和 final exit 都由同一 owner处理，没有额外 checkpoint、direct refs publication 或 canonical fallback authority。

## 7. 永久回归

纯合同：

```bash
npm run test:blockquote-exit-transaction-owner
```

覆盖：

- 顶层/nested pending 第一拍；
- 顶层/nested coalesced exit；
- 顶层/nested staged exit；
- BOM + CRLF 与作者 quote spacing；
- 空退出、marks、邻块、unsupported parent；
- source mismatch、semantic false/throw；
- callback mismatch、stale revision、constructor contract。

真实 Electron：

```bash
npm run test:blockquote-exit-transaction-ui
```

nested-list fixture 执行：

```text
引用末尾第一次物理 Enter
→ 可选等待 pending callback
→ 第二次物理 Enter
→ callback 前快速输入 X / Y
→ callback publication
或立即切源码 forced flush
→ source 检查
→ save
→ 完整退出
→ 全新 profile 冷重开
```

三个场景全部证明：

- coalesced callback：4 个 transaction；
- staged callback：第一拍 pending source-unchanged transaction publication，第二本 journal 3 个 transaction；
- coalesced forced flush：同一 proof 在源码切换前发布；
- proof paths `[1,0]` / `[1,0,1]` / `[1,0,2]`；
- `semanticOk=true`、`listSlotsMatch=true`、`ok=true`；
- 零 warning toast；
- 作者 `  >   alpha`、退出段 `  XY`、BOM/CRLF、前后 list items 保持；
- source/save/disk/cold reopen 精确。

## 8. 下一迁移顺序

引用 text/split/join/exit 已形成完整 focused set。下一阶段不扩大这些 owners，依次迁移：

1. table column insert/delete；
2. table alignment changes 与复杂 span/topology；
3. code-block 创建/删除/拆分/合并与围栏结构。

每个 family继续使用 transaction journal、stable path、bounded raw patch、semantic/structure validation 和 Coordinator 原子发布合同。
