# Transaction Journal：isolated empty ordered lift

> 源码版本：HorseMD 0.13.154
> Family：`list-isolated-empty-ordered-lift`
> Owner：`createListIsolatedEmptyOrderedLiftTransactionSourceSyncOwner`
> Boundary：`transaction-list-isolated-empty-ordered-lift`

## 1. 迁移范围

本 family 只处理一个非常窄的顶层结构：

```text
plain bullet list
→ single empty ordered list
→ unchanged nonempty bullet list
```

旧拓扑中，前一 bullet list 的最后一个 item 必须只有一个非空 plain paragraph；中间 ordered list 必须只有一个非 task 空 paragraph item；后继 bullet list 的第一项必须是非 task、单一非空 plain paragraph。显式 `list_item.attrs.listType` 存在时，三者必须分别与 `bullet / ordered / bullet` 容器一致。

本 family 不处理：

- RS-72 同一 ordered list 内的 successor 补位；
- 多 item ordered list；
- task list；
- nested list；
- ordered lift 后的第二次 Backspace。

## 2. 真实 ProseMirror Step

最小 headless `joinBackward` 合同得到：

```text
ReplaceStep
from      = 24
to        = 26
structure = true
sliceSize = 0
```

真实 generated-input 长文档中同形 Step 为 `40→42`。

这不是删除 ordered paragraph；它删除的是两个相邻容器的 wrapper boundary：

```text
step.from === isolatedOrdered.beforePos - 1
step.to   === isolatedOrdered.contentStart
```

即前一 bullet list 的 closing wrapper 与 isolated ordered list 的 opening wrapper 被删除，ordered item 本身保留，并成为前一 bullet list 新增的最后一个 item。

owner 要求整个 journal 只有一个 transaction 与一个 Step，捕获 `stepDoc` 必须等于 journal oldDoc，Step apply 后必须精确得到 live expectedDoc。其余 top-level prefix/suffix、后继 bullet list和既有 bullet item stream均必须不变。

## 3. consumed input-intent lifecycle

真实用户路径常由 `1.` input rule 创建空 ordered list。过去 callback 已经消费该 input intent 后，intent 仍在短 TTL 内存在，结构 Journal 仅凭“存在 pending intent”继续阻断，因此紧随的物理 Backspace无法进入 Transaction owner。

0.13.154 新增 `list-input-intent-lifecycle`：

```text
active + unconsumed intent      → 阻断 structural Journal
active + consumed callback-tail → 不阻断后续真实结构事务
expired / absent                → 不阻断
```

consumed intent仍可为原 callback 尾部提供兼容上下文，但不会被用来推断后续源码操作。family 归属仍完全由新的 PM transaction/Step/topology证明。

## 4. 为什么不用空 ordered paragraph 做 source anchor

空 paragraph没有正文字符，真实生产中对 `[ordered, item, paragraph]` 做 PM→Markdown offset，可能落到前一个 literal bullet行，而不是作者 `1. ` 空 ordered row。这个诊断已在真实 generated-input 场景复现。

因此 owner 不直接映射空 ordered paragraph，而使用两个稳定非空锚点：

1. 前一 bullet list 的最后一个非空 paragraph；
2. 后继 bullet list 的第一个非空 paragraph。

它们分别定位 source 与 previous canonical 中的左右 list block。两个 block边界之间必须只有一条非空 top-level ordered row：

```text
left bullet block end
    ↓
唯一 ordered row
    ↑
right bullet block start
```

任何第二条非空行、无法定位的边界或 row-count不一致都 fail closed。

## 5. authored raw patch

成功时 source ordered row必须满足：

- top-level ordered token：`1.` / `1)` 等；
-正文为空；
- token数字必须等于旧 PM `ordered_list.attrs.order`；
- previous canonical 在同一物理槽位的 ordered数字也必须等于该 `order`，正文为 `<br />`。

owner 只替换 ordered token本身，替换值来自前一作者 bullet list 的实际 marker：

```text
1.  → -
1)  → +
```

因此 delimiter不会被 canonical风格猜测，真正持久化的是“转换后的 item继承前一作者 bullet token”。BOM、LF/CRLF、空行、后继 list marker与邻块全部逐字保持。

## 6. legacy retirement

生产 structural registry顺序：

```text
list-isolated-empty-ordered-lift
→ list-empty-item-first-lift
→ list-empty-item-tail-remove
→ list-empty-item-remove
→ list-subtree
→ list-item-paragraph
```

本 family设置 `legacyRetired:true`。

PM topology/Step尚未完整证明时返回 `recognized:false`。一旦 family已证明，source边界、row count、作者 ordered row、order或token形状无法证明时返回 `recognized:true`，从而阻断旧 `diverged-isolated-empty-ordered-backspace-lift` 和 generic fallback。

永久负例使用一空格作者 ordered marker：

```text
- literal

␠1.␠

- right
```

其中 `␠` 表示一个作者空格；真实测试夹具仍是行首一个空格、marker后一个空格。

它仍能形成目标 rich PM lift，但 source-side列表槽位不能与旧 PM一一证明，owner在 `isolated-ordered-lift-row-count` 处 `recognized:true + legacyBlocked:true`；rich编辑保留、显示warning、无legacy/Coordinator publication且disk原字节不变。

## 7. 第二 Backspace 的边界

第一拍 lift后，PM可暂时出现：

```text
bullet_list
  list_item listType=bullet
  list_item listType=ordered   ← lifted empty item
```

这不是 plain tail family。前置提交 `5c91042` 已要求 tail owner与generic list-subtree owner在显式 item `listType` 与容器冲突时不认领，所以第二 Backspace不会先生成错误 Transaction候选再由legacy自愈。

0.13.154 中第二 Backspace仍由既有 `empty-list-item-removed` legacy路径处理；真实 generated-input两拍回归要求整个周期零 integrity false。它会在后续独立 family中继续迁移，不能通过扩大当前 isolated owner完成。

## 8. 永久门禁

focused：

- `test:list-isolated-empty-ordered-lift-transaction-owner`
- `test:list-input-intent-lifecycle`
- `test:list-isolated-empty-ordered-lift-transaction-ui`
- `test:list-isolated-empty-ordered-lift-legacy-retirement-ui`

真实路径：

- `test-isolated-empty-ordered-backspace-lift-ui.mjs`：从 input rule 创建到第一拍 transaction、第二拍 legacy；
- direct authored callback / forced-flush；
- BOM+CRLF source/save/disk/fresh-profile reopen；
- `1)` 与 `+` marker保真；
- fail-closed负例。

相邻门禁覆盖 first/tail/interior正负、RS-72、RS-63 nested、task、RS-84两拍、rapid double Enter、nested Enter、generic list-subtree callback/forced；全局覆盖 Journal、Coordinator、source transaction sync、完整 preservation、39/39 source-fidelity probes、mixed rich/source、异构 source fidelity和desktop/mobile build。

## 9. 下一 family：RS-72 ordered successor / multi-step

RS-72 当前仍由 `list-subtree-replace` transaction owner处理，真实 journal是：

```text
ReplaceStep
+
ReplaceAroundStep
```

下一 family必须独立证明：

- 两Step逐步 `stepDoc` topology；
- 被删空 ordered item与 successor 的稳定 paths；
- ordered `start/order` 语义；
- 作者 `.` / `)` delimiter；
- successor numbering是否以及如何改写；
- editor-only transient paragraph的精确 path；
- raw patch只拥有哪些 ordered rows。

在这些证据完成前，RS-72不得并入当前 isolated owner。
